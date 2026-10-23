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
// Um relatório por execução (o "Testar com 5" é uma, o "Executar todos" é outra): fica guardado à parte
// do registro card a card, então continua lá mesmo depois que o registro girar.
const CHAVE_RELATORIOS = 'rd_limpeza_relatorios';
const LIMITE_RELATORIOS = 400;

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

/** Os motivos de perda cadastrados no RD. */
const motivosDePerda = () =>
  emCache('crm:motivos-perda2', async () =>
    // tipo (Pronix CRM): "perda" ou "desqualificacao" — este pede a anotação do que o lead disse (50+ caracteres)
    lista(await crm.rd('/deal_lost_reasons', { limit: 200 }), 'deal_lost_reasons', 'lost_reasons').map((m) => ({ id: idDe(m), nome: crm.consertarAcentos(m.name || ''), tipo: String(m.type || '') }))
  );

const acharEtapa = (f, alvo) => f.etapas.find((e) => norm(e.nome).startsWith(alvo));
const elegivel = (f) => REGRAS.every((r) => acharEtapa(f, r.etapa())) && Boolean(acharEtapa(f, destino()));

/** Os funis em que a limpeza pode rodar: os que têm as duas etapas de origem e a de destino. */
async function funisElegiveis() {
  if (!crm.configurado()) throw new Error('O RD Station CRM não está configurado no servidor (RDSTATION_CRM_TOKEN).');
  return (await crm.funis()).filter(elegivel).map((f) => ({ id: f.id, nome: f.nome }));
}

/**
 * Tudo que a limpeza precisa achar no RD antes de começar: o funil com as três etapas, os dois motivos
 * de perda, o campo SDR com a opção de quem pediu e o usuário do RD. Faltou algo essencial: erro que
 * diz o quê. O que é só recomendável vira aviso.
 */
async function contexto(usuario, funilId) {
  if (!crm.configurado()) throw new Error('O RD Station CRM não está configurado no servidor (RDSTATION_CRM_TOKEN).');
  const elegiveis = (await crm.funis()).filter(elegivel);
  if (!elegiveis.length) {
    throw new Error('Não achei no RD um funil que tenha as etapas "Contato iniciado", "Respondeu" e "Desqualificados".');
  }
  // Com mais de um funil possível, a limpeza nunca escolhe sozinha em qual rodar.
  const pedido = String(funilId || '');
  const funil = pedido ? elegiveis.find((f) => f.id === pedido) : elegiveis.length === 1 ? elegiveis[0] : null;
  if (!funil) {
    throw new Error(pedido
      ? 'O funil escolhido não existe mais no RD (ou não tem as etapas da limpeza). Atualize a página e escolha de novo.'
      : `Escolha em qual funil fazer a limpeza. Funis possíveis: ${elegiveis.map((f) => f.nome).join(', ')}.`);
  }
  const motivos = await motivosDePerda();
  const regras = REGRAS.map((r) => {
    const m = motivos.find((x) => norm(x.nome).startsWith(r.motivo()));
    if (!m) throw new Error(`Não achei no RD o motivo de perda "${r.rotulo}". Motivos que existem: ${motivos.map((x) => x.nome).join(', ') || 'nenhum'}.`);
    const e = acharEtapa(funil, r.etapa());
    return { chave: r.chave, rotulo: r.rotulo, etapa: { id: e.id, nome: e.nome }, motivo: m };
  });
  const dest = acharEtapa(funil, destino());

  const avisos = [];
  const { sdr, aviso } = await sdrDoUsuario(usuario);
  if (aviso) avisos.push(aviso);
  const primeiro = norm(usuario.nome).split(' ')[0];
  // Usuário do RD de quem pediu: é o filtro de "só os meus".
  const usuariosRd = await crm.usuariosRd().catch(() => []);
  const eu = usuariosRd.find((u) => norm(u.nome) === norm(usuario.nome)) || (usuariosRd.filter((u) => norm(u.nome).split(' ')[0] === primeiro).length === 1 ? usuariosRd.find((u) => norm(u.nome).split(' ')[0] === primeiro) : null);
  return { funil: { id: funil.id, nome: funil.nome }, regras, destino: { id: dest.id, nome: dest.nome }, sdr, usuarioRd: eu ? { id: String(eu.id), nome: eu.nome } : null, avisos };
}

/**
 * O campo "SDR" do card (obrigatório ao desqualificar) com a opção de quem pede: o nome inteiro ou o
 * primeiro nome ("Cauã"). Sem o campo no RD, segue sem ele (com aviso); com opções e nenhuma dele, erro.
 */
async function sdrDoUsuario(usuario) {
  // No PronixCRM o SDR é uma coluna da negociação, gravada pelo próprio CRM: não se escreve pelo campo.
  if (crm.ehPronix()) return { sdr: null, aviso: '' };
  const campos = await emCache('crm:campos-negociacao', async () =>
    lista(await crm.rd('/custom_fields', { for: 'deal' }), 'custom_fields').map((c) => ({
      id: idDe(c), rotulo: crm.consertarAcentos(c.label || ''), opcoes: lista(c.opts || c.options || []).map((o) => crm.consertarAcentos(String(o))),
    }))
  );
  const campo = campos.find((c) => norm(c.rotulo) === campoSdr());
  if (!campo) return { sdr: null, aviso: 'Não achei o campo "SDR" nas negociações do RD: os cards serão movidos sem preencher esse campo.' };
  const primeiro = norm(usuario.nome).split(' ')[0];
  const opcao = campo.opcoes.find((o) => norm(o) === norm(usuario.nome)) || campo.opcoes.find((o) => norm(o) === primeiro) || campo.opcoes.find((o) => norm(o).startsWith(primeiro));
  if (opcao) return { sdr: { id: campo.id, valor: opcao }, aviso: '' };
  if (!campo.opcoes.length) return { sdr: { id: campo.id, valor: String(usuario.nome).split(' ')[0] }, aviso: '' };
  throw new Error(`O campo SDR do RD não tem uma opção com o seu nome ("${usuario.nome}"). Opções: ${campo.opcoes.join(', ')}.`);
}

// ---------------------------------------------------------------- desqualificar pelo WhatsApp
/**
 * O botão "Desqualificar" do cartão do lead no WhatsApp: o card vira PERDA com o motivo que o
 * pré-vendedor escolheu, vai para "Desqualificados" (se o funil dele tiver essa etapa) e o campo SDR é
 * preenchido. O card é lido de novo antes (fechado nesse meio-tempo não é mexido) e a mudança entra no
 * mesmo registro da limpeza: aparece no relatório e dá para desfazer pelo painel.
 * @returns {Promise<{motivo: string, etapa: string, dealId: string}>}
 */
const NOTA_MINIMA = 50; // o CRM recusa a desqualificação com anotação menor
async function desqualificarCard({ usuario, dealId, motivoId, nota = '' }) {
  if (!crm.configurado()) throw new Error('O RD Station CRM não está configurado no servidor (RDSTATION_CRM_TOKEN).');
  if (!crm.moverLigado()) throw new Error('A escrita no RD está desligada no servidor (CRM_MOVER_ETAPA=0).');
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(String(dealId || '')) ? String(dealId) : '';
  if (!id) throw new Error('Não sei qual é o card deste lead. Abra a conversa de novo.');
  const motivo = (await motivosDePerda()).find((m) => m.id === String(motivoId || ''));
  if (!motivo) throw new Error('Escolha um dos motivos de perda da lista.');
  const anotacao = String(nota || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (motivo.tipo === 'desqualificacao' && anotacao.length < NOTA_MINIMA) {
    throw new Error(`Escreva o que o lead disse: pelo menos ${NOTA_MINIMA} caracteres (faltam ${NOTA_MINIMA - anotacao.length}).`);
  }
  const deal = await crm.rd(`/deals/${encodeURIComponent(id)}`);
  if (!deal) throw new Error('Não achei este card no RD.');
  if (!aberto(deal)) throw new Error(deal.win === false ? 'Este card já está como perdido no RD.' : 'Este card já foi fechado no RD.');
  const de = { id: idDe(deal.deal_stage), nome: crm.consertarAcentos((deal.deal_stage && deal.deal_stage.name) || '') };
  const funil = (await crm.funis()).find((f) => f.etapas.some((e) => e.id === de.id));
  const dest = funil ? acharEtapa(funil, destino()) : null;
  // O campo SDR (obrigatório ao desqualificar em alguns funis) recebe o nome de quem pede. Se o campo não tem uma opção
  // com o nome dele, segue sem mexer nele: o botão tem de funcionar para qualquer SDR, em qualquer funil — o RD
  // responde se faltar algo e o cartão mostra o motivo.
  const { sdr } = await sdrDoUsuario(usuario).catch(() => ({ sdr: null }));

  const resp = await crm.perderCard(deal, { motivoId: motivo.id, etapaId: dest && dest.id !== de.id ? dest.id : '', camposRd: camposComSdr(deal, sdr), nota: anotacao });
  if (!resp) throw new Error('O RD não achou o card na hora de gravar.');
  if (resp.win !== undefined && resp.win !== false) throw new Error('O RD respondeu, mas não marcou a perda.');

  const nome = crm.consertarAcentos(deal.name || '').slice(0, 120);
  const dia = emDiaLocal(new Date().toISOString());
  await db.push(CHAVE_LOG, {
    dealId: id, nome, funil: funil ? funil.nome : '', de, motivo: motivo.nome, dias: diasParado(deal),
    em: new Date().toISOString(), por: String(usuario.nome || '').slice(0, 80), usuarioId: usuario.id, execucao: `wpp-${String(usuario.id || '').slice(0, 20)}-${dia}`,
  }, LIMITE_LOG);
  return { motivo: motivo.nome, etapa: dest ? dest.nome : de.nome, dealId: id };
}

/** Os cards em aberto de uma etapa (todas as páginas). */
async function cardsDaEtapa(etapaId, usuarioRdId) {
  const todos = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const r = await crm.rd('/deals', { deal_stage_id: etapaId, win: 'null', limit: 200, page, user_id: usuarioRdId || undefined });
    const pagina = lista(r, 'deals');
    // O PronixCRM ignora win e user_id na lista: em aberto e o dono são conferidos aqui (no RD já vêm assim).
    todos.push(...(crm.ehPronix() ? pagina.filter((d) => aberto(d) && (!usuarioRdId || idDe(d.user) === String(usuarioRdId))) : pagina));
    if (pagina.length < 200 || (r && r.has_more === false)) break;
  }
  return todos;
}

/** O e-mail do contato do card (o primeiro válido): é por ele que se acha o lead no RD para conferir. */
function emailDoCard(deal) {
  const todos = (Array.isArray(deal && deal.contacts) ? deal.contacts : [])
    .flatMap((c) => (Array.isArray(c && c.emails) ? c.emails : []))
    .map((e) => String((e && (e.email || e)) || '').trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  return todos[0] || '';
}
/** Endereço do card no RD, para abrir direto. */
const linkDoCard = (id) => crm.linkDoCard(id);

const cardPublico = (d, regra, dias) => ({
  id: idDe(d), nome: crm.consertarAcentos(d.name || '').slice(0, 120), etapa: regra.etapa.nome, motivo: regra.rotulo, dias,
  responsavel: crm.consertarAcentos((d.user && d.user.name) || '').slice(0, 60),
  email: emailDoCard(d), link: linkDoCard(idDe(d)),
});

/**
 * O que a limpeza faria, sem alterar nada.
 * @param {{usuario: object, dias?: number, escopo?: 'meus'|'todos', funil?: string}} o  funil = id do funil no RD
 */
async function previa({ usuario, dias, escopo, funil }) {
  const ctx = await contexto(usuario, funil);
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
    dias: minimo, escopo: soMeus ? 'meus' : 'todos', funilId: ctx.funil.id,
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
 * `execucao` identifica a rodada: os lotes de uma mesma rodada somam no mesmo relatório salvo.
 * @returns {Promise<{feitos: object[], pulados: object[], erros: object[], limite: boolean, execucao: string}>}
 */
async function executar({ usuario, ids, dias, escopo, funil, execucao }) {
  if (!crm.moverLigado()) throw new Error('A escrita no RD está desligada no servidor (CRM_MOVER_ETAPA=0).');
  const pedidos = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '')).filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x)))].slice(0, LOTE_MAX);
  if (!pedidos.length) throw new Error('Nenhum card para mover.');
  const ctx = await contexto(usuario, funil);
  const minimo = diasValidos(dias);
  const soMeus = escopo !== 'todos';
  if (soMeus && !ctx.usuarioRd) throw new Error('Não achei o seu usuário no RD para conferir o responsável de cada card.');
  const rodada = idDaExecucao(execucao);
  const saida = { feitos: [], pulados: [], erros: [], limite: false, execucao: rodada };
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

      const resp = await crm.perderCard(deal, { motivoId: regra.motivo.id, etapaId: ctx.destino.id, camposRd: camposComSdr(deal, ctx.sdr) });
      if (!resp) throw new Error('o RD não achou o card na hora de gravar');
      const etapaNova = idDe(resp.deal_stage);
      if (etapaNova && etapaNova !== ctx.destino.id) throw new Error('o RD respondeu, mas o card não mudou de etapa');
      if (resp.win !== undefined && resp.win !== false) throw new Error('o RD moveu o card, mas não marcou a perda');

      const nome = crm.consertarAcentos(deal.name || '').slice(0, 120);
      await db.push(CHAVE_LOG, {
        dealId: id, nome, funil: ctx.funil.nome, de: { id: regra.etapa.id, nome: regra.etapa.nome }, motivo: regra.rotulo, dias: parado,
        em: new Date().toISOString(), por: String(usuario.nome || '').slice(0, 80), usuarioId: usuario.id, execucao: rodada,
      }, LIMITE_LOG);
      saida.feitos.push({ id, nome, motivo: regra.rotulo, email: emailDoCard(deal), link: linkDoCard(id) });
    } catch (e) {
      saida.erros.push({ id, erro: e.message });
      // O RD limitou as consultas: para o lote aqui, e o painel espera antes de continuar.
      if (/limitou as consultas/.test(e.message)) {
        saida.limite = true;
        break;
      }
    }
  }
  // O relatório da rodada é gravado a cada lote: se a tela fechar no meio, o que já foi feito está salvo.
  await somarNoRelatorio(rodada, { funil: ctx.funil.nome, dias: minimo, escopo: soMeus ? 'meus' : 'todos', por: String(usuario.nome || '').slice(0, 80), usuarioId: usuario.id }, saida)
    .catch((err) => console.error('Falha ao salvar o relatório da limpeza:', err.message));
  return saida;
}

const idDaExecucao = (v) =>
  (/^[A-Za-z0-9_-]{6,40}$/.test(String(v || '')) ? String(v) : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

// ---------------------------------------------------------------- cadastros duplicados
// O mesmo lead com mais de um card EM ABERTO no funil, no nome de quem pediu (inscreveu-se de novo,
// contato criado duas vezes). Um card fica; os outros vão para "Desqualificados" com a perda "Duplicado".
//   - É o mesmo lead quando dois cards têm um e-mail ou um telefone em comum (DDD + 8 últimos dígitos).
//   - Fica o card na etapa mais adiantada; empate, o de movimento mais recente.
//   - Card já fechado não entra: lead perdido que se inscreveu de novo NÃO é duplicado, é lead de volta.
//   - E-mail ou telefone repetido em cards demais é dado genérico (teste, número de preenchimento): não mexe.
// A execução confere tudo de novo, card a card, e usa o mesmo registro (desfazer e relatório).
const ROTULO_DUPLICADO = 'Duplicado';
const motivoDuplicado = () => norm(process.env.CRM_LIMPEZA_MOTIVO_DUPLICADO || 'duplic');
const LOTE_DUPLICADOS = 10; // cada card custa 3 chamadas ao RD: o duplicado, o que fica e a escrita
const MAX_NO_GRUPO = 6;

/** Telefone -> DDD + 8 últimos dígitos ("5571999998888" e "(71) 9999-8888" são o mesmo). '' se não der para confiar. */
function chaveDoTelefone(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length < 10 || d.length > 11) return '';
  if (/^(\d)\1+$/.test(d.slice(-8))) return ''; // 9999-9999, 0000-0000: número de preenchimento
  return d.slice(0, 2) + d.slice(-8);
}

const contatosDe = (deal) => (Array.isArray(deal && deal.contacts) ? deal.contacts : []);
const telefonesDoCard = (deal) =>
  contatosDe(deal).flatMap((c) => (Array.isArray(c && c.phones) ? c.phones : [])).map((p) => String((p && (p.phone || p)) || '').trim()).filter(Boolean);

/** O que identifica o lead no card: os e-mails e os telefones de todos os contatos dele. */
function chavesDoCard(deal) {
  const emails = contatosDe(deal)
    .flatMap((c) => (Array.isArray(c && c.emails) ? c.emails : []))
    .map((e) => String((e && (e.email || e)) || '').trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const fones = telefonesDoCard(deal).map(chaveDoTelefone).filter(Boolean);
  return [...new Set(emails.map((e) => 'e:' + e).concat(fones.map((f) => 't:' + f)))];
}

const ultimoMovimento = (d) => Math.max(0, ...[d.last_activity_at, d.updated_at, d.created_at].map((x) => Date.parse(x || '')).filter(Number.isFinite));

/** O contexto da limpeza mais o que os duplicados precisam: o motivo "Duplicado" e a ordem das etapas do funil. */
async function contextoDuplicados(usuario, funilId) {
  const ctx = await contexto(usuario, funilId);
  if (!ctx.usuarioRd) throw new Error(`Não achei no RD um usuário com o seu nome ("${usuario.nome}"): a busca de duplicados olha só os cards em que você é o responsável.`);
  const motivos = await motivosDePerda();
  const motivo = motivos.find((x) => norm(x.nome).includes(motivoDuplicado()));
  if (!motivo) throw new Error(`Não achei no RD o motivo de perda "Duplicado". Motivos que existem: ${motivos.map((x) => x.nome).join(', ') || 'nenhum'}.`);
  const funil = (await crm.funis()).find((f) => f.id === ctx.funil.id);
  const etapas = new Map(((funil && funil.etapas) || []).map((e) => [e.id, e]));
  return { ...ctx, motivoDuplicado: motivo, etapas };
}

/** Os cards em aberto do funil no nome de um usuário (todas as páginas). */
async function cardsDoFunil(funilId, usuarioRdId) {
  const todos = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const r = await crm.rd('/deals', { deal_pipeline_id: funilId, win: 'null', limit: 200, page, user_id: usuarioRdId });
    const pagina = lista(r, 'deals');
    todos.push(...(crm.ehPronix() ? pagina.filter((d) => aberto(d) && (!usuarioRdId || idDe(d.user) === String(usuarioRdId))) : pagina));
    if (pagina.length < 200 || (r && r.has_more === false)) break;
  }
  return todos;
}

/** Entre os cards do mesmo lead, qual fica: etapa mais adiantada; empate, movimento mais recente; empate, o mais antigo. */
function escolherQuemFica(cards, etapas) {
  const ordem = (d) => { const e = etapas.get(idDe(d.deal_stage)); return e ? e.ordem : -1; };
  return cards.slice().sort((a, b) =>
    ordem(b) - ordem(a) || ultimoMovimento(b) - ultimoMovimento(a) || (Date.parse(a.created_at || '') || 0) - (Date.parse(b.created_at || '') || 0) || idDe(a).localeCompare(idDe(b)))[0];
}

const dataBR = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleDateString('pt-BR', { timeZone: process.env.TZ_RELATORIO || 'America/Sao_Paulo' }) : ''; };
const cardDuplicado = (d, etapas, agora) => ({
  id: idDe(d), nome: crm.consertarAcentos(d.name || '').slice(0, 120), etapa: (etapas.get(idDe(d.deal_stage)) || {}).nome || crm.consertarAcentos((d.deal_stage && d.deal_stage.name) || ''),
  email: emailDoCard(d), telefone: (telefonesDoCard(d)[0] || '').slice(0, 30), criadoEm: dataBR(d.created_at), dias: diasParado(d, agora), link: linkDoCard(idDe(d)),
});

/**
 * Os cadastros duplicados do funil, sem alterar nada: para cada lead com mais de um card em aberto,
 * qual fica e quais sairiam como "Duplicado".
 * @param {{usuario: object, funil?: string}} o  funil = id do funil no RD
 */
async function previaDuplicados({ usuario, funil }) {
  const ctx = await contextoDuplicados(usuario, funil);
  const agora = Date.now();
  const cards = (await cardsDoFunil(ctx.funil.id, ctx.usuarioRd.id))
    .filter((d) => aberto(d) && idDe(d.user) === ctx.usuarioRd.id && ctx.etapas.has(idDe(d.deal_stage)) && idDe(d.deal_stage) !== ctx.destino.id);

  // E-mail ou telefone que aparece em cards demais não identifica ninguém: fica de fora da comparação.
  const porChave = new Map();
  cards.forEach((d, i) => chavesDoCard(d).forEach((k) => { if (!porChave.has(k)) porChave.set(k, []); porChave.get(k).push(i); }));
  const suspeitos = [];
  // Junta os cards que dividem alguma chave (um lead pode ter dois e-mails e um telefone em comum).
  const pai = cards.map((_, i) => i);
  const raiz = (i) => { while (pai[i] !== i) { pai[i] = pai[pai[i]]; i = pai[i]; } return i; };
  porChave.forEach((indices, chave) => {
    if (indices.length < 2) return;
    if (indices.length > MAX_NO_GRUPO) { suspeitos.push({ dado: chave.slice(2), tipo: chave[0] === 'e' ? 'e-mail' : 'telefone', cards: indices.length }); return; }
    indices.slice(1).forEach((i) => { pai[raiz(i)] = raiz(indices[0]); });
  });
  const montes = new Map();
  cards.forEach((_, i) => { const r = raiz(i); if (!montes.has(r)) montes.set(r, []); montes.get(r).push(i); });

  const grupos = [];
  montes.forEach((indices) => {
    if (indices.length < 2) return;
    const doGrupo = indices.map((i) => cards[i]);
    if (doGrupo.length > MAX_NO_GRUPO) { suspeitos.push({ dado: crm.consertarAcentos(doGrupo[0].name || '').slice(0, 60), tipo: 'grupo', cards: doGrupo.length }); return; }
    const fica = escolherQuemFica(doGrupo, ctx.etapas);
    const saem = doGrupo.filter((d) => d !== fica).sort((a, b) => ultimoMovimento(b) - ultimoMovimento(a));
    const comum = new Set(chavesDoCard(fica));
    const tipos = new Set(saem.flatMap((d) => chavesDoCard(d).filter((k) => comum.has(k)).map((k) => k[0])));
    // Cadastro mais novo que o card que fica: o lead se inscreveu de novo — vale olhar o card que fica.
    const maisNovo = Math.max(...saem.map((d) => Date.parse(d.created_at || '') || 0));
    const reinscrito = maisNovo > (Date.parse(fica.created_at || '') || 0) ? Math.floor((agora - maisNovo) / 86400000) : null;
    grupos.push({
      fica: cardDuplicado(fica, ctx.etapas, agora), saem: saem.map((d) => cardDuplicado(d, ctx.etapas, agora)),
      por: tipos.has('e') && tipos.has('t') ? 'e-mail e telefone' : tipos.has('t') ? 'telefone' : tipos.has('e') ? 'e-mail' : 'contato em comum com outro card do grupo',
      reinscritoHaDias: reinscrito,
    });
  });
  grupos.sort((a, b) => b.saem.length - a.saem.length || a.fica.nome.localeCompare(b.fica.nome));
  // Card ligado ao que fica só por meio de um terceiro (c1-c2 pelo e-mail, c2-c3 pelo telefone) leva a
  // "ponte" no par: na hora de fechar, é por ela que se confere que continua sendo o mesmo lead.
  const porId = new Map(cards.map((d) => [idDe(d), d]));
  const divide = (a, b) => { const ka = new Set(chavesDoCard(a)); return chavesDoCard(b).some((k) => ka.has(k)); };
  const pares = grupos.flatMap((g) => g.saem.map((s) => {
    const fica = porId.get(g.fica.id);
    const dup = porId.get(s.id);
    if (divide(dup, fica)) return { id: s.id, fica: g.fica.id };
    const ponte = g.saem.map((x) => porId.get(x.id)).find((x) => x !== dup && divide(x, dup) && divide(x, fica));
    return ponte ? { id: s.id, fica: g.fica.id, via: idDe(ponte) } : { id: s.id, fica: g.fica.id };
  }));
  return {
    funilId: ctx.funil.id,
    contexto: { funil: ctx.funil.nome, destino: ctx.destino.nome, motivo: ctx.motivoDuplicado.nome, sdr: ctx.sdr ? ctx.sdr.valor : '', responsavel: ctx.usuarioRd.nome, avisos: ctx.avisos },
    analisados: cards.length, totalGrupos: grupos.length, total: pares.length, pares, grupos: grupos.slice(0, MAX_NA_TELA), suspeitos: suspeitos.slice(0, 20),
  };
}

/**
 * Fecha como "Duplicado" os cards de um lote (no máximo LOTE_DUPLICADOS pares {id, fica}). Cada par é
 * lido de novo: só fecha se o duplicado e o que fica continuam em aberto, neste funil, no nome de quem
 * pediu e com e-mail ou telefone em comum — e se o que fica não ficou para trás na etapa.
 */
async function fecharDuplicados({ usuario, pares, funil, execucao }) {
  if (!crm.moverLigado()) throw new Error('A escrita no RD está desligada no servidor (CRM_MOVER_ETAPA=0).');
  const idOk = (x) => /^[A-Za-z0-9_-]{1,40}$/.test(String(x || ''));
  const vistos = new Set();
  const pedidos = (Array.isArray(pares) ? pares : [])
    .map((p) => ({ id: String((p && p.id) || ''), fica: String((p && p.fica) || ''), via: idOk(p && p.via) ? String(p.via) : '' }))
    .filter((p) => idOk(p.id) && idOk(p.fica) && p.id !== p.fica && !vistos.has(p.id) && vistos.add(p.id))
    .slice(0, LOTE_DUPLICADOS);
  if (!pedidos.length) throw new Error('Nenhum card duplicado para fechar.');
  const ctx = await contextoDuplicados(usuario, funil);
  const rodada = idDaExecucao(execucao);
  const saida = { feitos: [], pulados: [], erros: [], limite: false, execucao: rodada };
  const noFunil = (d) => ctx.etapas.has(idDe(d.deal_stage));
  const ordem = (d) => (ctx.etapas.get(idDe(d.deal_stage)) || { ordem: -1 }).ordem;
  const emComum = (a, b) => { const ka = new Set(chavesDoCard(a)); return chavesDoCard(b).some((k) => ka.has(k)); };
  for (const { id, fica: idFica, via } of pedidos) {
    try {
      const deal = await crm.rd(`/deals/${encodeURIComponent(id)}`);
      const pular = (porque) => saida.pulados.push({ id, nome: (deal && deal.name) || '', porque });
      if (!deal) { pular('o card não existe mais'); continue; }
      if (!aberto(deal)) { pular('já foi fechado'); continue; }
      if (!noFunil(deal) || idDe(deal.deal_stage) === ctx.destino.id) { pular('mudou de etapa ou de funil'); continue; }
      if (idDe(deal.user) !== ctx.usuarioRd.id) { pular('é de outro responsável'); continue; }
      // Nunca fecha o duplicado sem ter certeza de que sobra um card vivo do mesmo lead.
      const fica = await crm.rd(`/deals/${encodeURIComponent(idFica)}`);
      if (!fica || !aberto(fica) || !noFunil(fica) || idDe(fica.deal_stage) === ctx.destino.id) { pular('o card que ficaria não está mais em aberto neste funil'); continue; }
      if (idDe(fica.user) !== ctx.usuarioRd.id) { pular('o card que ficaria mudou de responsável'); continue; }
      // Mesmo lead: contato em comum com o que fica, direto ou pela ponte (outro card do lead, que pode até
      // ter sido fechado agora há pouco nesta mesma rodada: o que vale é o contato dele).
      let mesmoLead = emComum(deal, fica);
      if (!mesmoLead && via && via !== id && via !== idFica) {
        const ponte = await crm.rd(`/deals/${encodeURIComponent(via)}`);
        mesmoLead = Boolean(ponte) && idDe(ponte.user) === ctx.usuarioRd.id && emComum(ponte, deal) && emComum(ponte, fica);
      }
      if (!mesmoLead) { pular('os dois cards não têm mais e-mail ou telefone em comum'); continue; }
      if (ordem(deal) > ordem(fica)) { pular('passou a ser o card mais adiantado do lead'); continue; }

      const resp = await crm.perderCard(deal, { motivoId: ctx.motivoDuplicado.id, etapaId: ctx.destino.id, camposRd: camposComSdr(deal, ctx.sdr) });
      if (!resp) throw new Error('o RD não achou o card na hora de gravar');
      const etapaNova = idDe(resp.deal_stage);
      if (etapaNova && etapaNova !== ctx.destino.id) throw new Error('o RD respondeu, mas o card não mudou de etapa');
      if (resp.win !== undefined && resp.win !== false) throw new Error('o RD moveu o card, mas não marcou a perda');

      const nome = crm.consertarAcentos(deal.name || '').slice(0, 120);
      const de = ctx.etapas.get(idDe(deal.deal_stage));
      await db.push(CHAVE_LOG, {
        dealId: id, nome, funil: ctx.funil.nome, de: { id: de.id, nome: de.nome }, motivo: ROTULO_DUPLICADO, fica: idFica,
        em: new Date().toISOString(), por: String(usuario.nome || '').slice(0, 80), usuarioId: usuario.id, execucao: rodada,
      }, LIMITE_LOG);
      saida.feitos.push({
        id, nome, motivo: ROTULO_DUPLICADO, email: emailDoCard(deal), link: linkDoCard(id),
        fica: { id: idFica, nome: crm.consertarAcentos(fica.name || '').slice(0, 120), etapa: (ctx.etapas.get(idDe(fica.deal_stage)) || {}).nome || '', link: linkDoCard(idFica) },
      });
    } catch (e) {
      saida.erros.push({ id, erro: e.message });
      if (/limitou as consultas/.test(e.message)) {
        saida.limite = true;
        break;
      }
    }
  }
  await somarNoRelatorio(rodada, { funil: ctx.funil.nome, dias: null, escopo: 'meus', por: String(usuario.nome || '').slice(0, 80), usuarioId: usuario.id }, saida)
    .catch((err) => console.error('Falha ao salvar o relatório da limpeza:', err.message));
  return saida;
}

/** As linhas "motivo - total" de um relatório: as duas da limpeza de parados e, quando houve, a de duplicados. */
function linhasPorMotivo(totalDe) {
  const linhas = REGRAS.map((regra) => ({ rotulo: regra.rotulo, total: totalDe(regra.rotulo) || 0 }));
  const dup = totalDe(ROTULO_DUPLICADO) || 0;
  return dup ? linhas.concat([{ rotulo: ROTULO_DUPLICADO, total: dup }]) : linhas;
}
/** No texto, rodada só de duplicados não mostra as linhas zeradas dos outros motivos. */
const linhasDoTexto = (linhas) => (linhas.some((l) => l.rotulo === ROTULO_DUPLICADO) ? linhas.filter((l) => l.total > 0) : linhas);

/** Soma o resultado de um lote no relatório da rodada (cria na primeira vez que algo foi movido). */
async function somarNoRelatorio(rodada, base, saida) {
  const porMotivo = {};
  saida.feitos.forEach((f) => { porMotivo[f.motivo] = (porMotivo[f.motivo] || 0) + 1; });
  const agora = new Date().toISOString();
  const achou = await db.atualizarNaLista(CHAVE_RELATORIOS, (r) => r && r.id === rodada, (r) => {
    const soma = { ...(r.porMotivo || {}) };
    Object.entries(porMotivo).forEach(([k, v]) => { soma[k] = (soma[k] || 0) + v; });
    return { ...r, fim: agora, total: (r.total || 0) + saida.feitos.length, pulados: (r.pulados || 0) + saida.pulados.length, erros: (r.erros || 0) + saida.erros.length, porMotivo: soma };
  });
  // Rodada que não moveu nada não vira relatório.
  if (achou || !saida.feitos.length) return;
  await db.push(CHAVE_RELATORIOS, {
    id: rodada, inicio: agora, fim: agora, ...base, total: saida.feitos.length, pulados: saida.pulados.length, erros: saida.erros.length, porMotivo, desfeitos: 0,
  }, LIMITE_RELATORIOS);
}

/** O texto do relatório, do jeito que vai para o líder: um motivo por linha e o total. */
function textoDoRelatorio(r) {
  const quando = new Date(r.inicio).toLocaleString('pt-BR', { timeZone: process.env.TZ_RELATORIO || 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const linhas = linhasDoTexto(linhasPorMotivo((rotulo) => r.porMotivo && r.porMotivo[rotulo])).sort((a, b) => b.total - a.total);
  return `Limpeza do funil — ${quando}${r.funil ? ' — ' + r.funil : ''}\n` + linhas.map((m) => `• ${m.rotulo} - ${m.total}`).join('\n') + `\nTotal: ${r.total || 0}`;
}

/** Os relatórios salvos, do mais novo para o mais antigo. */
async function relatoriosSalvos({ limite = 60 } = {}) {
  const todos = await db.range(CHAVE_RELATORIOS);
  return todos.filter((r) => r && r.id).reverse().slice(0, limite).map((r) => ({
    id: r.id, inicio: r.inicio, fim: r.fim, funil: r.funil || '', dias: r.dias, escopo: r.escopo, por: r.por || '',
    total: r.total || 0, pulados: r.pulados || 0, erros: r.erros || 0, desfeitos: r.desfeitos || 0,
    porMotivo: linhasPorMotivo((rotulo) => r.porMotivo && r.porMotivo[rotulo]),
    texto: textoDoRelatorio(r),
  }));
}

/**
 * Desfaz a limpeza de alguns cards: volta para a etapa de onde saíram e reabre (tira a perda).
 * Só desfaz o que está no registro e ainda não foi desfeito.
 */
async function desfazer({ usuario, ids }) {
  if (!crm.moverLigado()) throw new Error('A escrita no RD está desligada no servidor (CRM_MOVER_ETAPA=0).');
  // A API do PronixCRM não reabre negociação perdida (é pela tela do CRM, com permissão própria).
  if (crm.ehPronix()) throw new Error('No CRM novo, reabrir uma negociação perdida é pela tela do CRM (a API não reabre). Abra o card pelo link e use "Reabrir".');
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
      if (ultima.execucao) {
        await db.atualizarNaLista(CHAVE_RELATORIOS, (r) => r && r.id === ultima.execucao, (r) => {
          const soma = { ...(r.porMotivo || {}) };
          if (soma[ultima.motivo] > 0) soma[ultima.motivo]--;
          return { ...r, total: Math.max(0, (r.total || 0) - 1), desfeitos: (r.desfeitos || 0) + 1, porMotivo: soma };
        }).catch(() => {});
      }
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
  const porMotivo = linhasPorMotivo((rotulo) => validos.filter((r) => r.motivo === rotulo).length).sort((a, b) => b.total - a.total);
  const total = validos.length;
  const texto = linhasDoTexto(porMotivo).map((m) => `• ${m.rotulo} - ${m.total}`).join('\n') + `\nTotal: ${total}`;
  return { porMotivo, total, texto };
}

module.exports = {
  previa, executar, desfazer, relatorio, relatoriosSalvos, contexto, funisElegiveis, emailDoCard, diasParado, camposComSdr, DIAS_PADRAO, LOTE_MAX,
  motivosDePerda, desqualificarCard,
  previaDuplicados, fecharDuplicados, chaveDoTelefone, chavesDoCard, escolherQuemFica, LOTE_DUPLICADOS,
};
