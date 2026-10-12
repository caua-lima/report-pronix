'use strict';

// Limpeza do funil no RD Station CRM: card parado há mais de N dias vira PERDA em "Desqualificados".
//   - em "Contato iniciado" -> motivo de perda "Nunca respondeu";
//   - em "Respondeu"         -> motivo de perda "Parou de responder".
// O campo "SDR" do card (obrigatório ao desqualificar) recebe o nome de quem pediu a limpeza.
//
// É a escrita mais pesada que o sistema faz no CRM, então tudo aqui é feito para não errar:
//   1. PRÉVIA: lista o que seria mexido, sem alterar nada;
//   2. execução em LOTES pequenos, e cada card é lido de novo antes de mudar (se saiu da etapa, teve
//      atividade ou foi fechado nesse meio-tempo, é pulado);
//   3. os outros campos personalizados do card são reenviados como estavam (nada é apagado);
//   4. cada card mexido fica num registro, com a etapa de onde saiu — é ele que permite DESFAZER e
//      que gera o relatório por motivo.
// "Parado" = dias desde o que for mais recente entre a última atividade, a última atualização e a
// criação do card. É uma leitura conservadora do "esfriando" da tela do RD: na dúvida, não mexe.

const db = require('./db');
const crm = require('./crm');
const { emDiaLocal } = require('./stats');

const DIAS_PADRAO = 15;
const LOTE_MAX = 20; // cards por chamada: cada um custa 2 consultas ao RD, e a Vercel corta em 60s
const MAX_PAGINAS = 40; // 8.000 cards por etapa
const MAX_NA_TELA = 300;
const CHAVE_LOG = 'rd_limpeza_log';
const LIMITE_LOG = 8000;

const norm = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const idDe = (d) => String((d && (d.id || d._id)) || '');
const lista = (r, ...chaves) => (Array.isArray(r) ? r : chaves.map((k) => r && r[k]).find(Array.isArray) || []);

// De qual etapa sai, e com qual motivo de perda. Os nomes podem ser trocados por variável de ambiente.
const REGRAS = [
  { chave: 'nunca', rotulo: 'Nunca respondeu', etapa: () => norm(process.env.CRM_LIMPEZA_ETAPA_CONTATO || 'contato iniciado'), motivo: () => norm(process.env.CRM_LIMPEZA_MOTIVO_NUNCA || 'nunca respondeu') },
  { chave: 'parou', rotulo: 'Parou de responder', etapa: () => norm(process.env.CRM_LIMPEZA_ETAPA_RESPONDEU || 'respondeu'), motivo: () => norm(process.env.CRM_LIMPEZA_MOTIVO_PAROU || 'parou de responder') },
];
const destino = () => norm(process.env.CRM_LIMPEZA_ETAPA_DESTINO || 'desqualificad');
const campoSdr = () => norm(process.env.CRM_LIMPEZA_CAMPO_SDR || 'sdr');

const diasValidos = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : DIAS_PADRAO;
};

/** Há quantos dias o card está parado (o mais recente entre atividade, atualização e criação). */
function diasParado(deal, agora = Date.now()) {
  const datas = [deal.last_activity_at, deal.updated_at, deal.created_at].map((d) => Date.parse(d || '')).filter(Number.isFinite);
  if (!datas.length) return null; // sem data nenhuma não dá para afirmar que está parado
  return Math.floor((agora - Math.max(...datas)) / 86400000);
}
const aberto = (d) => !d.closed_at && d.win !== true && d.win !== false;

async function emCache(chave, buscar) {
  const g = await db.cacheGet(chave);
  if (g) {
    try {
      return JSON.parse(g);
    } catch (_) {
      /* refaz */
    }
  }
  const v = await buscar();
  await db.cacheSet(chave, JSON.stringify(v), 600);
  return v;
}

/**
 * Tudo que a limpeza precisa achar no RD antes de começar: o funil com as três etapas, os dois motivos
 * de perda, o campo SDR com a opção de quem pediu e o usuário do RD. Faltou algo essencial: erro que
 * diz o quê. O que é só recomendável vira aviso.
 */
async function contexto(usuario) {
  if (!crm.configurado()) throw new Error('O RD Station CRM não está configurado no servidor (RDSTATION_CRM_TOKEN).');
  const funis = await crm.funis();
  const acharEtapa = (f, alvo) => f.etapas.find((e) => norm(e.nome).startsWith(alvo));
  const funil = funis.find((f) => REGRAS.every((r) => acharEtapa(f, r.etapa())) && acharEtapa(f, destino()));
  if (!funil) {
    throw new Error('Não achei no RD um funil que tenha as etapas "Contato iniciado", "Respondeu" e "Desqualificados".');
  }
  const motivos = await emCache('crm:motivos-perda', async () =>
    lista(await crm.rd('/deal_lost_reasons', { limit: 200 }), 'deal_lost_reasons', 'lost_reasons').map((m) => ({ id: idDe(m), nome: crm.consertarAcentos(m.name || '') }))
  );
  const regras = REGRAS.map((r) => {
    const m = motivos.find((x) => norm(x.nome).startsWith(r.motivo()));
    if (!m) throw new Error(`Não achei no RD o motivo de perda "${r.rotulo}". Motivos que existem: ${motivos.map((x) => x.nome).join(', ') || 'nenhum'}.`);
    const e = acharEtapa(funil, r.etapa());
    return { chave: r.chave, rotulo: r.rotulo, etapa: { id: e.id, nome: e.nome }, motivo: m };
  });
  const dest = acharEtapa(funil, destino());

  const avisos = [];
  // Campo SDR: a opção com o nome de quem pediu (o primeiro nome basta: "Cauã").
  const campos = await emCache('crm:campos-negociacao', async () =>
    lista(await crm.rd('/custom_fields', { for: 'deal' }), 'custom_fields').map((c) => ({
      id: idDe(c), rotulo: crm.consertarAcentos(c.label || ''), opcoes: lista(c.opts || c.options || []).map((o) => crm.consertarAcentos(String(o))),
    }))
  );
  const campo = campos.find((c) => norm(c.rotulo) === campoSdr());
  const primeiro = norm(usuario.nome).split(' ')[0];
  let sdr = null;
  if (!campo) avisos.push('Não achei o campo "SDR" nas negociações do RD: os cards serão movidos sem preencher esse campo.');
  else {
    const opcao = campo.opcoes.find((o) => norm(o) === norm(usuario.nome)) || campo.opcoes.find((o) => norm(o) === primeiro) || campo.opcoes.find((o) => norm(o).startsWith(primeiro));
    if (opcao) sdr = { id: campo.id, valor: opcao };
    else if (!campo.opcoes.length) sdr = { id: campo.id, valor: String(usuario.nome).split(' ')[0] };
    else throw new Error(`O campo SDR do RD não tem uma opção com o seu nome ("${usuario.nome}"). Opções: ${campo.opcoes.join(', ')}.`);
  }
  // Usuário do RD de quem pediu: é o filtro de "só os meus".
  const usuariosRd = await crm.usuariosRd().catch(() => []);
  const eu = usuariosRd.find((u) => norm(u.nome) === norm(usuario.nome)) || (usuariosRd.filter((u) => norm(u.nome).split(' ')[0] === primeiro).length === 1 ? usuariosRd.find((u) => norm(u.nome).split(' ')[0] === primeiro) : null);
  return { funil: { id: funil.id, nome: funil.nome }, regras, destino: { id: dest.id, nome: dest.nome }, sdr, usuarioRd: eu ? { id: String(eu.id), nome: eu.nome } : null, avisos };
}

/** Os cards em aberto de uma etapa (todas as páginas). */
async function cardsDaEtapa(etapaId, usuarioRdId) {
  const todos = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const r = await crm.rd('/deals', { deal_stage_id: etapaId, win: 'null', limit: 200, page, user_id: usuarioRdId || undefined });
    const pagina = lista(r, 'deals');
    todos.push(...pagina);
    if (pagina.length < 200 || (r && r.has_more === false)) break;
  }
  return todos;
}

const cardPublico = (d, regra, dias) => ({
  id: idDe(d), nome: crm.consertarAcentos(d.name || '').slice(0, 120), etapa: regra.etapa.nome, motivo: regra.rotulo, dias,
  responsavel: crm.consertarAcentos((d.user && d.user.name) || '').slice(0, 60),
});

/**
 * O que a limpeza faria, sem alterar nada.
 * @param {{usuario: object, dias?: number, escopo?: 'meus'|'todos'}} o
 */
async function previa({ usuario, dias, escopo }) {
  const ctx = await contexto(usuario);
  const minimo = diasValidos(dias);
  const soMeus = escopo !== 'todos';
  if (soMeus && !ctx.usuarioRd) {
    throw new Error(`Não achei no RD um usuário com o seu nome ("${usuario.nome}") para filtrar só os seus cards. Use "Todos da etapa" ou acerte o nome.`);
  }
  const agora = Date.now();
  const cards = [];
  const porMotivo = [];
  for (const regra of ctx.regras) {
    const daEtapa = await cardsDaEtapa(regra.etapa.id, soMeus ? ctx.usuarioRd.id : '');
    const parados = daEtapa
      .filter(aberto)
      .map((d) => ({ d, dias: diasParado(d, agora) }))
      .filter((x) => x.dias !== null && x.dias > minimo)
      .map((x) => cardPublico(x.d, regra, x.dias));
    porMotivo.push({ rotulo: regra.rotulo, etapa: regra.etapa.nome, total: parados.length, naEtapa: daEtapa.length });
    cards.push(...parados);
  }
  cards.sort((a, b) => b.dias - a.dias);
  return {
    dias: minimo, escopo: soMeus ? 'meus' : 'todos',
    contexto: {
      funil: ctx.funil.nome, destino: ctx.destino.nome, sdr: ctx.sdr ? ctx.sdr.valor : '', responsavel: ctx.usuarioRd ? ctx.usuarioRd.nome : '',
      motivos: ctx.regras.map((r) => ({ etapa: r.etapa.nome, motivo: r.motivo.nome })), avisos: ctx.avisos,
    },
    porMotivo, total: cards.length, ids: cards.map((c) => c.id), cards: cards.slice(0, MAX_NA_TELA),
  };
}

/** Os campos personalizados que o card já tem, com o SDR preenchido — para a escrita não apagar nenhum. */
function camposComSdr(deal, sdr) {
  const atuais = (Array.isArray(deal.deal_custom_fields) ? deal.deal_custom_fields : [])
    .map((c) => ({ custom_field_id: String(c.custom_field_id || idDe(c.custom_field) || ''), value: c.value === undefined ? null : c.value }))
    .filter((c) => c.custom_field_id);
  if (!sdr) return atuais;
  const semSdr = atuais.filter((c) => c.custom_field_id !== sdr.id);
  return semSdr.concat([{ custom_field_id: sdr.id, value: sdr.valor }]);
}

/**
 * Move e marca perda em um lote de cards (no máximo LOTE_MAX). Cada card é lido de novo antes: só
 * muda o que continua em aberto, na etapa de origem, parado e (em "só os meus") com o mesmo responsável.
 * @returns {Promise<{feitos: object[], pulados: object[], erros: object[], limite: boolean}>}
 */
async function executar({ usuario, ids, dias, escopo }) {
  if (!crm.moverLigado()) throw new Error('A escrita no RD está desligada no servidor (CRM_MOVER_ETAPA=0).');
  const pedidos = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '')).filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x)))].slice(0, LOTE_MAX);
  if (!pedidos.length) throw new Error('Nenhum card para mover.');
  const ctx = await contexto(usuario);
  const minimo = diasValidos(dias);
  const soMeus = escopo !== 'todos';
  if (soMeus && !ctx.usuarioRd) throw new Error('Não achei o seu usuário no RD para conferir o responsável de cada card.');
  const saida = { feitos: [], pulados: [], erros: [], limite: false };
  for (const id of pedidos) {
    try {
      const deal = await crm.rd(`/deals/${encodeURIComponent(id)}`);
      const pular = (porque) => saida.pulados.push({ id, nome: (deal && deal.name) || '', porque });
      if (!deal) { pular('o card não existe mais'); continue; }
      if (!aberto(deal)) { pular('já foi fechado'); continue; }
      const regra = ctx.regras.find((r) => r.etapa.id === idDe(deal.deal_stage));
      if (!regra) { pular('mudou de etapa'); continue; }
      if (soMeus && idDe(deal.user) !== ctx.usuarioRd.id) { pular('é de outro responsável'); continue; }
      const parado = diasParado(deal);
      if (parado === null || parado <= minimo) { pular('teve movimento recente'); continue; }

      const resp = await crm.rd(`/deals/${encodeURIComponent(id)}`, {}, {
        metodo: 'PUT',
        corpo: { deal_stage_id: ctx.destino.id, deal: { win: false, deal_lost_reason_id: regra.motivo.id, deal_custom_fields: camposComSdr(deal, ctx.sdr) } },
      });
      if (!resp) throw new Error('o RD não achou o card na hora de gravar');
      const etapaNova = idDe(resp.deal_stage);
      if (etapaNova && etapaNova !== ctx.destino.id) throw new Error('o RD respondeu, mas o card não mudou de etapa');
      if (resp.win !== undefined && resp.win !== false) throw new Error('o RD moveu o card, mas não marcou a perda');

      const nome = crm.consertarAcentos(deal.name || '').slice(0, 120);
      await db.push(CHAVE_LOG, {
        dealId: id, nome, de: { id: regra.etapa.id, nome: regra.etapa.nome }, motivo: regra.rotulo, dias: parado,
        em: new Date().toISOString(), por: String(usuario.nome || '').slice(0, 80), usuarioId: usuario.id,
      }, LIMITE_LOG);
      saida.feitos.push({ id, nome, motivo: regra.rotulo });
    } catch (e) {
      saida.erros.push({ id, erro: e.message });
      // O RD limitou as consultas: para o lote aqui, e o painel espera antes de continuar.
      if (/limitou as consultas/.test(e.message)) {
        saida.limite = true;
        break;
      }
    }
  }
  return saida;
}

/**
 * Desfaz a limpeza de alguns cards: volta para a etapa de onde saíram e reabre (tira a perda).
 * Só desfaz o que está no registro e ainda não foi desfeito.
 */
async function desfazer({ usuario, ids }) {
  if (!crm.moverLigado()) throw new Error('A escrita no RD está desligada no servidor (CRM_MOVER_ETAPA=0).');
  const pedidos = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, LOTE_MAX);
  const registro = await db.range(CHAVE_LOG);
  const saida = { desfeitos: [], erros: [] };
  for (const id of pedidos) {
    const entradas = registro.filter((r) => r.dealId === id);
    const ultima = entradas[entradas.length - 1];
    if (!ultima || ultima.desfeito) {
      saida.erros.push({ id, erro: 'não está no registro da limpeza (ou já foi desfeito)' });
      continue;
    }
    try {
      const resp = await crm.rd(`/deals/${encodeURIComponent(id)}`, {}, { metodo: 'PUT', corpo: { deal_stage_id: ultima.de.id, deal: { win: null, deal_lost_reason_id: null } } });
      if (!resp) throw new Error('o RD não achou o card');
      await db.push(CHAVE_LOG, { dealId: id, nome: ultima.nome, desfeito: true, motivo: ultima.motivo, em: new Date().toISOString(), por: String(usuario.nome || '').slice(0, 80), usuarioId: usuario.id }, LIMITE_LOG);
      saida.desfeitos.push({ id, nome: ultima.nome, etapa: ultima.de.nome });
    } catch (e) {
      saida.erros.push({ id, erro: e.message });
    }
  }
  return saida;
}

/**
 * Relatório da limpeza num período: quantos cards por motivo (o que foi desfeito não conta).
 * @param {{de?: string, ate?: string}} o datas 'AAAA-MM-DD' no fuso do time; sem datas = tudo
 */
async function relatorio({ de, ate } = {}) {
  const registro = await db.range(CHAVE_LOG);
  // Vale o último estado de cada card: movido (conta) ou desfeito (não conta).
  const ultimo = new Map();
  registro.forEach((r) => { if (r && r.dealId) ultimo.set(r.dealId, r); });
  const validos = [...ultimo.values()].filter((r) => {
    if (r.desfeito) return false;
    const dia = emDiaLocal(r.em);
    return (!de || dia >= de) && (!ate || dia <= ate);
  });
  const porMotivo = REGRAS.map((regra) => ({ rotulo: regra.rotulo, total: validos.filter((r) => r.motivo === regra.rotulo).length }))
    .sort((a, b) => b.total - a.total);
  const total = validos.length;
  const texto = porMotivo.map((m) => `• ${m.rotulo} - ${m.total}`).join('\n') + `\nTotal: ${total}`;
  return { porMotivo, total, texto };
}

module.exports = { previa, executar, desfazer, relatorio, contexto, diasParado, camposComSdr, DIAS_PADRAO, LOTE_MAX };
