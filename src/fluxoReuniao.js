'use strict';
// Escritas do painel lateral no Pronix CRM:
//  - "Perder como duplicado": o card mais antigo de um lead com dois em aberto vira perda, com o motivo de duplicidade.
//  - "Reunião realizada": leva o card até a etapa de reunião realizada pelo MESMO caminho que os cards que já chegaram
//    lá percorreram (aprendido do histórico de etapas do CRM, funil por funil), define o closer e grava o handoff — o
//    texto do último report do lead — na passagem que o CRM exige.
// Etapa é reconhecida pela CATEGORIA que o CRM dá a ela ("resposta", "reuniao_agendada", "reuniao_realizada"...),
// igual em todos os funis, qualquer que seja o nome. Nada é adivinhado: sem caminho conhecido, o botão diz o porquê.

const db = require('./db');
const crm = require('./crm');
const limpezaRd = require('./limpezaRd');
const closers = require('./closers');

const idOk = (v) => (/^[A-Za-z0-9_-]{1,40}$/.test(String(v || '')) ? String(v) : '');
const idDe = (d) => String((d && (d.id || d._id)) || '');
const aberto = (d) => Boolean(d) && !d.closed_at && d.win !== true && d.win !== false;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

/** Categorias de DEPOIS da reunião: card que está nelas já passou da realizada. */
const DEPOIS = new Set(['fup', 'negociacao_avancada', 'venda', 'perda']);
/** Etapas do caminho que sempre entram (o que o time conta: respondeu, agendou). */
const MARCOS = new Set(['resposta', 'reuniao_agendada']);
const ehRealizada = (e) => Boolean(e) && e.categoria === 'reuniao_realizada';
const fechada = (e) => Boolean(e) && (e.perdido || e.ganho || DEPOIS.has(e.categoria));

const DIAS_APRENDIZADO = 120;
const AMOSTRA_POR_FUNIL = 60;
const TTL_HANDOFF = 60 * 24 * 3600;

function exigirCrm() {
  if (!crm.configurado()) throw new Error('O CRM não está configurado no servidor.');
  if (!crm.ehPronix()) throw new Error('Este botão funciona só com o Pronix CRM.');
  if (!crm.moverLigado()) throw new Error('A escrita no CRM está desligada no servidor (CRM_MOVER_ETAPA=0).');
}

async function lerCard(id) {
  const d = await crm.rd(`/deals/${encodeURIComponent(id)}`);
  if (!d) throw new Error('Não achei este card no CRM.');
  return d;
}

function localizar(cat, etapaId) {
  for (const f of cat) {
    const e = f.etapas.find((x) => x.id === String(etapaId || ''));
    if (e) return { funil: f, etapa: e };
  }
  return null;
}

// ---------------------------------------------------------------- handoff (o texto do report)

/** O report em texto, nos tópicos que o closer lê no CRM. */
function textoDoHandoff(dados, { sdr = '', quando = '' } = {}) {
  const d = dados || {};
  const linhas = [];
  if (d.lead) linhas.push(`Nome: ${d.lead}`);
  (Array.isArray(d.resumo) ? d.resumo : []).forEach((r) => {
    if (r && r.rotulo && r.valor) linhas.push(`${r.rotulo}: ${r.valor}`);
  });
  const dores = (Array.isArray(d.dores) ? d.dores : []).map((x) => (x && x.dor ? x.dor + (x.porque ? ` (${x.porque})` : '') : '')).filter(Boolean);
  if (dores.length) linhas.push(`Dor / momento do lead: ${dores.join('; ')}`);
  (Array.isArray(d.secoes) ? d.secoes : []).forEach((s) => {
    if (!s || !s.titulo || !Array.isArray(s.itens) || !s.itens.length) return;
    linhas.push('', String(s.titulo).toUpperCase());
    s.itens.forEach((x, i) => linhas.push(`${s.numerada ? `${i + 1}.` : '-'} ${x}`));
  });
  if (Array.isArray(d.sinais_compra) && d.sinais_compra.length) {
    linhas.push('', 'SINAIS DE COMPRA');
    d.sinais_compra.forEach((x) => linhas.push(`- ${x}`));
  }
  if (d.abertura) linhas.push('', 'ABERTURA SUGERIDA', d.abertura);
  linhas.push('', `Report PRONIX${sdr ? ` de ${sdr}` : ''}${quando ? ` em ${quando}` : ''}.`);
  return linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
}

const chavesDoHandoff = ({ dealId, contatoId, telefone }) =>
  [idOk(dealId) && `handoff:d:${idOk(dealId)}`, idOk(contatoId) && `handoff:c:${idOk(contatoId)}`, soDigitos(telefone).length >= 10 && `handoff:t:${soDigitos(telefone).slice(-11)}`].filter(Boolean);

/** Guarda o texto do report pelo card, pelo contato e pelo telefone do lead (60 dias): é o handoff da "Reunião realizada". */
async function guardarHandoff({ dados, sdr, reportId, vinculo }) {
  const v = vinculo || {};
  const chaves = chavesDoHandoff(v);
  if (!chaves.length) return false;
  const quando = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const valor = JSON.stringify({ texto: textoDoHandoff(dados, { sdr, quando }), reportId: String(reportId || ''), quando, sdr: String(sdr || '').slice(0, 80) });
  await Promise.all(chaves.map((k) => db.cacheSet(k, valor, TTL_HANDOFF)));
  return true;
}

async function handoffGuardado(onde) {
  for (const k of chavesDoHandoff(onde || {})) {
    const g = await db.cacheGet(k).catch(() => null);
    if (!g) continue;
    try {
      const j = JSON.parse(g);
      if (j && j.texto) return j;
    } catch (_) {
      /* próximo */
    }
  }
  return null;
}

// ---------------------------------------------------------------- o caminho de cada funil, aprendido do CRM

const VAZIO = { porFunil: {}, transicoes: {}, amostras: 0 };

/**
 * Como os cards chegaram na reunião realizada, funil por funil: por quais etapas passaram e, quando trocaram de
 * funil, de que etapa saíram e em qual entraram. Lê os cards mais recentes de cada funil que tem etapa de reunião
 * realizada (o detalhe fica guardado por card). Cache de 12 h; leitura incompleta fica só 15 min.
 */
async function fluxosAprendidos() {
  const guardado = await db.cacheGet('crm:fluxos1').catch(() => null);
  if (guardado) {
    try {
      return JSON.parse(guardado);
    } catch (_) {
      /* refaz */
    }
  }
  const cat = await crm.funis();
  const funilDaEtapa = new Map();
  cat.forEach((f) => f.etapas.forEach((e) => funilDaEtapa.set(e.id, f.id)));
  const etapa = (id) => {
    const o = localizar(cat, id);
    return o ? o.etapa : null;
  };
  const comRealizada = cat.filter((f) => f.etapas.some(ehRealizada));
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const desde = new Date(Date.now() - DIAS_APRENDIZADO * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const t0 = Date.now();
  let incompleto = false;
  const saida = { porFunil: {}, transicoes: {}, amostras: 0, quando: new Date().toISOString() };
  const vistos = new Set();
  for (const f of comRealizada) {
    if (Date.now() - t0 > 35000) { incompleto = true; break; }
    const lista = await crm.listarNegociacoes(
      { deal_pipeline_id: f.id, updated_at_period: 'true', start_date: crm.instanteDoDia(desde), end_date: crm.instanteDoDia(hoje, true) },
      { maxPaginas: 3 }
    );
    const recentes = lista.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, AMOSTRA_POR_FUNIL);
    const dets = await crm.detalhesDe(recentes, { prazoMs: Math.max(1000, 35000 - (Date.now() - t0)) });
    if (dets.pendentes) incompleto = true;
    for (const d of dets) {
      if (vistos.has(idDe(d))) continue;
      vistos.add(idDe(d));
      const hist = (Array.isArray(d.deal_stage_histories) ? d.deal_stage_histories : [])
        .filter((h) => h && h.deal_stage_id)
        .sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));
      const iReal = hist.findIndex((h) => ehRealizada(etapa(h.deal_stage_id)));
      if (iReal < 0) continue;
      const caminho = hist.slice(0, iReal + 1).map((h) => ({ etapa: String(h.deal_stage_id), funil: String(h.deal_pipeline_id || funilDaEtapa.get(String(h.deal_stage_id)) || '') }));
      saida.amostras++;
      const funisDoCaminho = new Set();
      caminho.forEach((p) => {
        if (!p.funil) return;
        const pf = (saida.porFunil[p.funil] = saida.porFunil[p.funil] || { amostras: 0, visitas: {} });
        if (!funisDoCaminho.has(p.funil)) { funisDoCaminho.add(p.funil); pf.amostras++; }
        pf.visitas[p.etapa] = (pf.visitas[p.etapa] || 0) + 1;
      });
      for (let i = 1; i < caminho.length; i++) {
        const a = caminho[i - 1];
        const b = caminho[i];
        if (!a.funil || !b.funil || a.funil === b.funil) continue;
        const porOrigem = (saida.transicoes[a.funil] = saida.transicoes[a.funil] || {});
        const t = (porOrigem[b.funil] = porOrigem[b.funil] || { n: 0, saidas: {}, entradas: {} });
        t.n++;
        t.saidas[a.etapa] = (t.saidas[a.etapa] || 0) + 1;
        t.entradas[b.etapa] = (t.entradas[b.etapa] || 0) + 1;
      }
    }
  }
  // as visitas contam uma vez por card (um card que voltou para a mesma etapa não pesa dobrado)
  await db.cacheSet('crm:fluxos1', JSON.stringify(saida), incompleto ? 900 : 12 * 3600).catch(() => {});
  return saida;
}

const maisComum = (contagem) => Object.entries(contagem || {}).sort((a, b) => b[1] - a[1])[0] || null;

/** Para qual funil (e em qual etapa) vão os cards de um funil que não tem etapa de reunião realizada. */
function funilDeDestino(cat, origem, fluxos) {
  const porDestino = (fluxos.transicoes || {})[origem.id] || {};
  const total = Object.values(porDestino).reduce((s, t) => s + t.n, 0);
  const melhor = Object.entries(porDestino).sort((a, b) => b[1].n - a[1].n)[0];
  if (melhor && melhor[1].n >= 2 && melhor[1].n / total >= 0.6) {
    const funil = cat.find((f) => f.id === melhor[0]);
    if (funil && funil.etapas.some(ehRealizada)) {
      const e = maisComum(melhor[1].entradas);
      const entrada = e && funil.etapas.find((x) => x.id === e[0] && !fechada(x));
      const s = maisComum(melhor[1].saidas);
      const saida = s && origem.etapas.find((x) => x.id === s[0] && !fechada(x));
      if (entrada) return { funil, entrada, saida: saida || null, n: melhor[1].n, total, como: 'historico' };
    }
  }
  const candidatos = cat.filter((f) => f.id !== origem.id && f.etapas.some(ehRealizada));
  if (candidatos.length === 1) {
    const funil = candidatos[0];
    const entrada = funil.etapas.find((x) => x.categoria === 'reuniao_agendada' && !fechada(x)) || funil.etapas.find((x) => !fechada(x));
    if (entrada) return { funil, entrada, saida: null, n: 0, total: 0, como: 'unico' };
  }
  return null;
}

/** As etapas entre "de" (exclusive) e "ate" (inclusive) que o card deve percorrer neste funil. */
function caminhoNoFunil(funil, de, ate, fluxos) {
  const aprendido = (fluxos.porFunil || {})[funil.id] || { amostras: 0, visitas: {} };
  const qualificado = (e) => crm.ehEtapaQualificado(e.nome);
  return funil.etapas
    .filter((e) => e.ordem > de.ordem && e.ordem <= ate.ordem && !fechada(e))
    .filter((e) => {
      if (e.id === ate.id || MARCOS.has(e.categoria) || qualificado(e)) return true;
      // etapa de trabalho: entra se a maioria dos cards que chegaram na reunião passou por ela
      return aprendido.amostras >= 5 && (aprendido.visitas[e.id] || 0) / aprendido.amostras >= 0.5;
    })
    .map((e) => ({
      tipo: 'etapa', funilId: funil.id, funilNome: funil.nome, etapaId: e.id, etapaNome: e.nome, exigeCloser: e.exigeCloser === true,
      vistos: aprendido.visitas[e.id] || 0, amostras: aprendido.amostras,
    }));
}

// ---------------------------------------------------------------- closers e permissões

async function usuariosDoCrm() {
  const g = await db.cacheGet('crm:usuarios-email').catch(() => null);
  if (g) {
    try {
      return JSON.parse(g);
    } catch (_) {
      /* relê */
    }
  }
  const r = await crm.rd('/users');
  const lista = ((r && r.users) || (Array.isArray(r) ? r : []))
    .map((u) => ({ id: idDe(u), nome: crm.consertarAcentos(u.name || ''), email: String(u.email || '').trim().toLowerCase() }))
    .filter((u) => u.id && u.nome);
  await db.cacheSet('crm:usuarios-email', JSON.stringify(lista), 3600).catch(() => {});
  return lista;
}

/** Os closers que dá para escolher: os cadastrados aqui (aba Closers), achados no CRM pelo e-mail ou pelo nome. */
async function closersDoCrm() {
  const doCrm = await usuariosDoCrm();
  const nossos = await closers.listar().catch(() => []);
  const achados = [];
  for (const c of nossos) {
    const u = doCrm.find((x) => (c.email && x.email === String(c.email).toLowerCase()) || norm(x.nome) === norm(c.nome));
    if (u && !achados.some((a) => a.id === u.id)) achados.push({ id: u.id, nome: u.nome });
  }
  return achados.length ? achados : doCrm.map((u) => ({ id: u.id, nome: u.nome }));
}

function sugerirCloser(lista, nome) {
  const n = norm(nome);
  if (!n) return '';
  const exato = lista.find((c) => norm(c.nome) === n);
  if (exato) return exato.id;
  const primeiro = lista.filter((c) => norm(c.nome).split(' ')[0] === n.split(' ')[0]);
  return primeiro.length === 1 ? primeiro[0].id : '';
}

async function permissoes() {
  const g = await db.cacheGet('crm:me').catch(() => null);
  if (g) {
    try {
      return JSON.parse(g);
    } catch (_) {
      /* relê */
    }
  }
  const me = await crm.rd('/me').catch(() => null);
  const lista = me && Array.isArray(me.permissions) ? me.permissions.map(String) : null;
  if (lista) await db.cacheSet('crm:me', JSON.stringify(lista), 600).catch(() => {});
  return lista; // null = não deu para saber (o CRM responde na hora, se faltar)
}

// ---------------------------------------------------------------- reunião realizada

/**
 * O plano para levar o card até a reunião realizada: as passagens, quem pode ser o closer e de onde vem o handoff.
 * Não escreve nada.
 */
async function planejar({ dealId, closerNome = '', busca = {} }) {
  exigirCrm();
  const id = idOk(dealId);
  if (!id) throw new Error('Não sei qual é o card. Abra a conversa de novo.');
  const deal = await lerCard(id);
  if (!aberto(deal)) throw new Error('Este card já está fechado (ganho ou perdido) no CRM.');
  const cat = await crm.funis();
  if (!cat.some((f) => f.etapas.some((e) => e.categoria))) {
    throw new Error('O CRM não disse a categoria das etapas, e sem ela não dá para saber qual é a de reunião realizada. Tente de novo em 1 hora.');
  }
  const onde = localizar(cat, idDe(deal.deal_stage));
  if (!onde) throw new Error('Não reconheci a etapa deste card nos funis do CRM. Tente de novo em 1 hora (a lista de funis é atualizada a cada hora).');
  if (ehRealizada(onde.etapa) || fechada(onde.etapa) || onde.funil.etapas.some((e) => ehRealizada(e) && e.ordem < onde.etapa.ordem)) {
    throw new Error(`Este card já está em "${onde.etapa.nome}", na reunião realizada ou depois dela.`);
  }
  const fluxos = await fluxosAprendidos().catch(() => VAZIO);

  const passos = [];
  let destino = null;
  const alvo = onde.funil.etapas.find((e) => e.ordem > onde.etapa.ordem && ehRealizada(e));
  if (alvo) {
    passos.push(...caminhoNoFunil(onde.funil, onde.etapa, alvo, fluxos));
  } else {
    destino = funilDeDestino(cat, onde.funil, fluxos);
    if (!destino) {
      throw new Error(
        `Não sei para qual funil os cards de "${onde.funil.nome}" vão na reunião: nenhum deles chegou numa etapa de reunião ` +
          `realizada nos últimos ${DIAS_APRENDIZADO} dias e há mais de um funil com essa etapa. Leve este pela tela do CRM; ` +
          'depois disso o caminho fica aprendido.'
      );
    }
    if (destino.saida && destino.saida.ordem > onde.etapa.ordem) passos.push(...caminhoNoFunil(onde.funil, onde.etapa, destino.saida, fluxos));
    const e = destino.entrada;
    passos.push({
      tipo: 'funil', funilId: destino.funil.id, funilNome: destino.funil.nome, etapaId: e.id, etapaNome: e.nome, exigeCloser: e.exigeCloser === true,
      vistos: destino.n, amostras: destino.total, como: destino.como,
    });
    if (!ehRealizada(e)) {
      const fim = destino.funil.etapas.find((x) => x.ordem > e.ordem && ehRealizada(x));
      if (!fim) throw new Error(`No funil "${destino.funil.nome}" não há etapa de reunião realizada depois de "${e.nome}".`);
      passos.push(...caminhoNoFunil(destino.funil, e, fim, fluxos));
    }
  }
  if (!passos.length || !ehRealizada(localizar(cat, passos[passos.length - 1].etapaId).etapa)) {
    throw new Error('Não consegui montar o caminho até a reunião realizada deste card.');
  }

  const listaClosers = await closersDoCrm().catch(() => []);
  const dono = { id: idDe(deal.user), nome: crm.consertarAcentos((deal.user && deal.user.name) || '') };
  const precisaCloser = passos.some((p) => p.exigeCloser);
  const perms = await permissoes();
  const faltando = [];
  if (perms && passos.some((p) => p.tipo === 'funil') && !perms.includes('mover_de_funil')) faltando.push('mover de funil (mover_de_funil)');
  if (perms && !perms.includes('trocar_responsavel')) faltando.push('trocar o responsável para o closer (trocar_responsavel)');
  const contatoId = idDe((deal.contacts || [])[0]) || busca.contatoId || '';
  const guardado = await handoffGuardado({ dealId: id, contatoId, telefone: busca.telefone });
  return {
    card: { id, nome: crm.consertarAcentos(deal.name || ''), funil: onde.funil.nome, etapa: onde.etapa.nome, dono: dono.nome },
    passos,
    assinatura: [onde.etapa.id].concat(passos.map((p) => `${p.tipo}:${p.etapaId}`)).join('>'),
    precisaCloser,
    closers: listaClosers,
    closerSugerido: sugerirCloser(listaClosers, closerNome) || (listaClosers.some((c) => c.id === dono.id) ? dono.id : ''),
    handoff: { noCrm: Boolean(deal.handoff && deal.handoff.text), doReport: guardado ? { quando: guardado.quando, sdr: guardado.sdr } : null },
    aprendizado: { amostras: fluxos.amostras || 0 },
    faltando,
  };
}

/**
 * Executa o plano conferido pelo SDR. Relê o card antes de cada passagem (versão), confere que ele foi para a etapa
 * pedida e para no primeiro erro, dizendo o que já foi feito.
 */
async function executar({ usuario = {}, dealId, assinatura, closerId, handoff, closerNome = '', busca = {} }) {
  const plano = await planejar({ dealId, closerNome, busca });
  if (plano.assinatura !== String(assinatura || '')) throw new Error('O card mudou desde que o plano foi aberto. Abra "Reunião realizada" de novo para conferir.');
  if (plano.faltando.length) throw new Error(`O token do CRM não tem permissão para: ${plano.faltando.join(' e ')}. Peça ao administrador do CRM.`);
  const closer = closerId ? plano.closers.find((c) => c.id === String(closerId)) : null;
  if (closerId && !closer) throw new Error('Escolha um closer da lista.');
  if (!closer) throw new Error('Escolha o closer da reunião.');
  const id = plano.card.id;
  const rd = crm.rd;
  const feitos = [];
  const registrar = (o) => db.push('crm_movimentos', { quando: new Date().toISOString(), card: id, por: String(usuario.nome || '').slice(0, 80), ...o }, 500).catch(() => {});

  let deal = await lerCard(id);
  let textoHandoff = '';
  if (!(deal.handoff && deal.handoff.text)) {
    const guardado = await handoffGuardado({ dealId: id, contatoId: idDe((deal.contacts || [])[0]) || busca.contatoId, telefone: busca.telefone });
    textoHandoff = String(handoff || '').trim() || (guardado && guardado.texto) || '';
    if (textoHandoff.replace(/\s+/g, ' ').length < 40) throw new Error('Falta o handoff: gere o report desta conversa (ele vira o handoff) ou escreva o texto para o closer.');
    textoHandoff = textoHandoff.slice(0, 6000);
  }
  let closerDefinido = false;
  try {
    // Sem etapa que peça o closer no caminho, o handoff vai pela rota dele antes de mover.
    if (textoHandoff && !plano.precisaCloser) {
      await rd(`/deals/${encodeURIComponent(id)}/handoff`, {}, { metodo: 'PUT', corpo: { versao: deal.versao, handoff: textoHandoff } });
      feitos.push('Handoff gravado');
    }
    for (const p of plano.passos) {
      deal = await lerCard(id);
      const corpo = { versao: deal.versao, deal_stage_id: p.etapaId };
      if (p.exigeCloser && !closerDefinido) {
        corpo.user_id = closer.id;
        if (textoHandoff) corpo.handoff = textoHandoff;
        closerDefinido = true;
      }
      if (p.tipo === 'funil') await rd(`/deals/${encodeURIComponent(id)}/pipeline`, {}, { metodo: 'POST', corpo: { ...corpo, deal_pipeline_id: p.funilId } });
      else await rd(`/deals/${encodeURIComponent(id)}/stage`, {}, { metodo: 'POST', corpo });
      const agora = await lerCard(id);
      if (idDe(agora.deal_stage) !== p.etapaId) throw new Error(`o CRM respondeu, mas o card não foi para "${p.etapaNome}"`);
      feitos.push(p.tipo === 'funil' ? `${p.funilNome} › ${p.etapaNome}` : p.etapaNome);
      await registrar({ de: plano.card.etapa, para: `${p.funilNome} › ${p.etapaNome}` });
    }
    // Nenhuma etapa pediu o closer: ele vira o responsável do card do mesmo jeito (é onde o CRM guarda o closer).
    deal = await lerCard(id);
    if (!closerDefinido && idDe(deal.user) !== closer.id) {
      await rd(`/deals/${encodeURIComponent(id)}`, {}, { metodo: 'PUT', corpo: { deal: { user_id: closer.id, versao: deal.versao } } });
      feitos.push(`Closer: ${closer.nome}`);
    } else if (closerDefinido) {
      feitos.push(`Closer: ${closer.nome}`);
    }
  } catch (e) {
    const msg = String(e.message || e).replace(/^O CRM não aceitou: /, '');
    const erro = new Error(feitos.length ? `Parou no meio: ${msg}. Já feito: ${feitos.join(' › ')}.` : `O CRM não aceitou: ${msg}`);
    erro.feitos = feitos;
    throw erro;
  }
  await crm.esquecerLead(busca).catch(() => {});
  return { ok: true, feitos, card: plano.card };
}

// ---------------------------------------------------------------- card duplicado

/** O card mais antigo vira perda com o motivo de duplicidade; a nota diz em qual card o lead continua. */
async function perderDuplicado({ usuario = {}, dealId, manterId }) {
  exigirCrm();
  const id = idOk(dealId);
  const fica = idOk(manterId);
  if (!id || !fica || id === fica) throw new Error('Não sei qual card é o duplicado. Abra a conversa de novo.');
  const motivos = await limpezaRd.motivosDePerda();
  const motivo = motivos.find((m) => /duplic/.test(norm(m.nome)));
  if (!motivo) throw new Error('Não há motivo de perda de duplicidade no CRM. Cadastre um (ex.: "Duplicado") nos motivos de perda e tente de novo.');
  const deal = await lerCard(id);
  if (!aberto(deal)) throw new Error('Este card já está fechado no CRM.');
  const manter = await lerCard(fica);
  const ondeFica = [manter.deal_pipeline && manter.deal_pipeline.name, manter.deal_stage && manter.deal_stage.name].filter(Boolean).map(crm.consertarAcentos).join(' › ');
  const nota = `Card duplicado: o lead segue no card "${crm.consertarAcentos(manter.name || '')}" (${ondeFica || 'outro funil'}), id ${fica}. Marcado pelo PRONIX${usuario.nome ? ` por ${usuario.nome}` : ''}.`;
  await crm.perderCard(deal, { motivoId: motivo.id, nota });
  await db.push('crm_movimentos', { quando: new Date().toISOString(), card: id, de: crm.consertarAcentos((deal.deal_stage && deal.deal_stage.name) || ''), para: `perda: ${motivo.nome}`, por: String(usuario.nome || '').slice(0, 80) }, 500).catch(() => {});
  return { ok: true, motivo: motivo.nome };
}

module.exports = { planejar, executar, perderDuplicado, guardarHandoff, handoffGuardado, textoDoHandoff, fluxosAprendidos, closersDoCrm };
