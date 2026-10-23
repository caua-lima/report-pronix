'use strict';

// "Match com o closer": as reuniões realizadas e as vendas de um closer (Paulo Henrique, por padrão) em que o
// usuário foi o SDR, mês a mês, com conversão, faturamento e a meta do mês — quanto falta e quanto precisa
// por dia útil. Ideia das metas do zxp-market (meta 1/2/3, meta diária acumulada, medidor) e do
// dashboard-pessoal (reuniões, vendas, conversão e faturamento por mês; mesmo período do mês passado).
//
// De onde vem cada número (só leitura no RD):
//  - Cards do closer (responsável) com o campo "SDR" do card com o nome do usuário.
//  - Reunião realizada: o card ganhou; foi perdido por outro motivo que não falta (no-show); ou está numa etapa
//    do funil dos closers que só existe depois da reunião (Reunião realizada, FUP agendado, Em contato, Fluxo
//    de FUP, Negociação avançada, Não compraram, Vendido). Card ainda em "Reunião agendada" não conta.
//  - Data da reunião: um campo de data do card com "reunião"/"call" no nome; sem ele, a criação do card.
//    O painel mostra de onde veio cada data, para conferir.
//  - Venda: card ganho, com o valor do card (faturamento) e o dia em que foi ganho (mês da venda).
//  - Reports do usuário com esse closer e um resultado de reunião (venda, não fechou, follow-up) que não
//    apareçam no RD também entram — o RD é a fonte, o report cobre o card sem o campo SDR.
// Conversão do mês = vendas do mês ÷ reuniões realizadas do mês (como no dashboard-pessoal).
//
// Escopo: "minhas" (o campo SDR do card é você) ou "time" (é você ou um dos SDRs do time — MATCH_SDRS_TIME,
// por padrão Ágatha Vielmi, Nicoly Beatriz, Reinaldo Junior, Samuel Filipe, Luiza Lemes, Juliana Ferreira e
// Isamara). O RD é lido UMA vez: cada reunião leva o nome do SDR e se é sua, e o painel recorta. A comparação
// (você x time, por SDR e por profissão) vem sempre, qualquer que seja o escopo escolhido.

const db = require('./db');
const crm = require('./crm');
const stats = require('./stats');
const { produtoPeloNome } = require('./vendasRd');
const { sdrDoCard, leadDoCard } = require('./vendasDoRd');
const analises = require('./matchAnalises');

const DESDE_PADRAO = () => process.env.MATCH_DESDE || '2026-06-01'; // o CRM novo tem o histórico desde junho
const CLOSER_PADRAO = () => process.env.MATCH_CLOSER || 'Paulo Henrique';
const TIME_PADRAO = 'Ágatha Vielmi, Nicoly Beatriz, Reinaldo Junior, Samuel Filipe, Luiza Lemes, Juliana Ferreira, Isamara';
/** Os SDRs do time (nomes como aparecem no campo SDR do card, ou o primeiro nome). */
const timeDeSdrs = () => String(process.env.MATCH_SDRS_TIME || TIME_PADRAO).split(',').map((x) => x.trim()).filter(Boolean);
const MAX_PAGINAS = 15;
const FOLGA_CRIACAO_DIAS = 75; // card criado até isso antes do início ainda pode ter a reunião no período
const CACHE_SEG = 20 * 60;
// A Vercel corta o pedido em 60 s e devolve uma página de erro (a tela só mostrava "Falha na requisição.").
// O pedido inteiro — listas, detalhes, formulários e reports — tem este orçamento; o que não couber fica para a
// próxima rodada (a aba continua sozinha), e o que já foi lido fica guardado.
const ORCAMENTO_MS = () => Number(process.env.MATCH_ORCAMENTO_MS) || 45000;
const LISTA_SEG = 10 * 60; // a lista (só id + versão das negociações do closer) vale para as rodadas seguidas

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idDe = (d) => String((d && (d.id || d._id)) || '');
const lista = (r, ...chaves) => (Array.isArray(r) ? r : chaves.map((k) => r && r[k]).find(Array.isArray) || []);
const palavrasBatem = (nome, alvo) => {
  const p = new Set(norm(nome).split(' ').filter(Boolean));
  const a = norm(alvo).split(' ').filter(Boolean);
  return a.length > 0 && a.every((x) => p.has(x));
};
const slug = (s) => norm(s).replace(/ /g, '-') || 'closer';

/** O nome bate com o valor do campo SDR? O nome inteiro, o primeiro nome, ou o valor começando pelo primeiro nome. */
function nomeBate(valor, nome) {
  const v = norm(valor);
  const n = norm(nome);
  if (!v || !n) return false;
  const primeiro = n.split(' ')[0];
  return v === n || v === primeiro || v.split(' ')[0] === primeiro;
}

/**
 * De quem é o card: { tipo: 'sem' } (campo SDR vazio), { tipo: 'eu' }, { tipo: 'time', nome } ou { tipo: 'outro', nome }.
 * Você vem antes do time: um card seu nunca é contado como de outra pessoa.
 */
function quemEhOSdr(deal, usuario, time) {
  const campo = (Array.isArray(deal.deal_custom_fields) ? deal.deal_custom_fields : [])
    .find((c) => norm(c && c.custom_field && c.custom_field.label) === 'sdr');
  // Pronix CRM: a coluna "sdr" do card é a fonte; o campo personalizado "SDR" fica de reserva (cards antigos do RD).
  const bruto = String((deal.sdr && deal.sdr.name) || (campo && campo.value) || '').trim();
  if (!norm(bruto)) return { tipo: 'sem', nome: '' };
  if (nomeBate(bruto, usuario.nome)) return { tipo: 'eu', nome: usuario.nome };
  const doTime = time.find((n) => nomeBate(bruto, n));
  return doTime ? { tipo: 'time', nome: doTime } : { tipo: 'outro', nome: bruto };
}
const mesDe = (dia) => String(dia || '').slice(0, 7);
const somaDias = (dia, n) => new Date(Date.parse(dia + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Etapas do funil dos closers que só existem depois de a reunião acontecer.
const ETAPAS_REALIZADA = /^(reuniao realizada|fup agendado|em contato|fluxo de fup|negociacao avanc|nao compraram|vendido)/;
const ETAPAS_ANTES = /(agendad|no ?show|reagend|aguardando reuniao|confirmar)/;
const NO_SHOW = /no ?show|nao (compareceu|apareceu|veio|entrou)|faltou|ausente na reuniao/;
const RESULTADOS_REUNIAO = new Set(['venda_call', 'venda_fup', 'pix_compromisso', 'sem_venda', 'em_followup']);

/** "12/10/2026", "2026-10-12" ou "2026-10-12T15:00:00-03:00" -> "2026-10-12" (no fuso do relatório). */
function diaDoValor(v) {
  const s = String(Array.isArray(v) ? v[0] : v == null ? '' : v).trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  return Number.isFinite(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s) ? stats.emDiaLocal(s) : '';
}

/** Etapa de reunião realizada: pela categoria do Pronix CRM (catalogo: id da etapa -> categoria) ou pelo nome. */
const ehEtapaRealizada = (h, catalogo) =>
  Boolean(h) && ((catalogo && catalogo.get(String(h.deal_stage_id || '')) === 'reuniao_realizada') || /^reuniao realizada/.test(norm(h.deal_stage_name)));
const passouPelaRealizada = (deal, catalogo) => (Array.isArray(deal.deal_stage_histories) ? deal.deal_stage_histories : []).some((h) => ehEtapaRealizada(h, catalogo));

/** Dia da reunião do card: campo de data com "reunião"/"call" no nome; senão, a criação do card. */
function dataDaReuniao(deal, catalogo = null) {
  for (const c of Array.isArray(deal.deal_custom_fields) ? deal.deal_custom_fields : []) {
    const rotulo = norm(c && c.custom_field && c.custom_field.label);
    if (!/(reuniao|call)/.test(rotulo) || !/(data|dia|quando)/.test(rotulo)) continue;
    const dia = diaDoValor(c.value);
    if (dia) return { dia, origem: 'campo' };
  }
  // PronixCRM: o histórico de etapas diz quando o card ENTROU na etapa de reunião realizada (a primeira vez).
  const passagens = (Array.isArray(deal.deal_stage_histories) ? deal.deal_stage_histories : [])
    .filter((h) => h && h.start_date && ehEtapaRealizada(h, catalogo))
    .map((h) => stats.emDiaLocal(h.start_date))
    .sort();
  if (passagens.length) return { dia: passagens[0], origem: 'historico' };
  return deal.created_at ? { dia: stats.emDiaLocal(deal.created_at), origem: 'criacao' } : { dia: '', origem: '' };
}

/** O que o card diz da reunião: 'venda' | 'nao_comprou' | 'fup' | 'no_show' | 'antes' (ainda não aconteceu). */
function estadoDoCard(deal, catalogo = null) {
  if (deal.win === true) return 'venda';
  const etapa = norm(deal.deal_stage && deal.deal_stage.name);
  const hist = Array.isArray(deal.deal_stage_histories) ? deal.deal_stage_histories : [];
  if (deal.win === false) {
    if (NO_SHOW.test(norm(deal.deal_lost_reason && deal.deal_lost_reason.name))) return 'no_show';
    // Pronix CRM com histórico: perdido sem nunca ter passado pela reunião realizada = a reunião não aconteceu.
    if (catalogo && catalogo.size && hist.length > 1 && !passouPelaRealizada(deal, catalogo)) return 'no_show';
    return 'nao_comprou';
  }
  // Pela categoria da etapa atual (em qualquer funil): reunião realizada, follow-up e negociação avançada vêm depois da reunião.
  const cat = catalogo && catalogo.get(String((deal.deal_stage && (deal.deal_stage.id || deal.deal_stage._id)) || ''));
  if (cat === 'venda') return 'venda';
  if (cat === 'reuniao_realizada' || cat === 'fup' || cat === 'negociacao_avancada') return 'fup';
  if (cat === 'reuniao_agendada' || cat === 'contato' || cat === 'resposta') return passouPelaRealizada(deal, catalogo) ? 'fup' : 'antes';
  if (/^vendido/.test(etapa)) return 'venda';
  if (/^nao compraram/.test(etapa)) return 'nao_comprou';
  if (ETAPAS_REALIZADA.test(etapa)) return 'fup';
  if (/no ?show/.test(etapa)) return 'no_show';
  return 'antes';
}

/**
 * PronixCRM: as negociações em que você (ou alguém do time) é o SDR e que mudaram desde o início do período —
 * toda reunião realizada ou venda depois dele mexeu no card — só as do closer, com o detalhe (campos, datas,
 * motivo, produtos). A lista do PronixCRM ignora user_id e win: o closer e o desfecho são conferidos aqui.
 */
async function buscarCardsPronix({ usuario, time, nomeCloser, desde, hoje, prazoFinal = Date.now() + ORCAMENTO_MS() }) {
  const diag = { paginas: 0, truncado: false, listasPendentes: 0 };
  const nomes = [usuario.nome].concat((time || []).filter((n) => !nomeBate(n, usuario.nome)));
  const ids = [];
  // Os funis em que existe reunião realizada (pela categoria da etapa, em qualquer funil) e os de closer pelo nome.
  // Listar todos os funis do SDR passa de 8 mil cards; a lista é barata, o detalhe é que custa — e só os do closer são lidos.
  const todos = await crm.funis().catch(() => []);
  const comRealizada = todos.filter((f) => f.etapas.some((e) => e.categoria === 'reuniao_realizada'));
  const funis = [...new Map(comRealizada.concat(await crm.funisDosClosers()).map((f) => [f.id, f])).values()];
  diag.funis = funis.map((f) => f.nome);
  // Cada par SDR x funil vira uma lista (paginada pelo cursor). Eram lidas uma a uma, sem olhar o relógio: com o time
  // todo desde junho isso sozinho passava de 60 s. Agora vão 4 de cada vez, cada lista pronta fica guardada (só o
  // id e a versão das negociações do closer) e, quando o tempo das listas acaba, o resto fica para a próxima rodada.
  const pares = [];
  for (const nome of nomes) {
    const u = await crm.usuarioDoCrm(nome);
    if (!u) continue;
    for (const funil of funis.length ? funis : [null]) pares.push({ sdrId: String(u.id), funil });
  }
  const prazoListas = prazoFinal - Number(process.env.MATCH_RESERVA_DETALHE_MS || 15000);
  const listas = new Array(pares.length).fill(null);
  const lerPar = async ({ sdrId, funil }) => {
    const chave = `match_lista1_${sdrId}_${funil ? funil.id : 'todos'}_${slug(nomeCloser)}_${desde}_${hoje}`;
    const guardada = await db.cacheGet(chave).catch(() => null);
    if (guardada) { try { return JSON.parse(guardada); } catch (_) { /* relê */ } }
    const deals = await crm.listarNegociacoes({ sdr_id: sdrId, ...(funil ? { deal_pipeline_id: funil.id } : {}), updated_at_period: 'true', start_date: crm.instanteDoDia(desde), end_date: crm.instanteDoDia(hoje, true) });
    diag.paginas += Math.max(1, Math.ceil(deals.length / 200));
    const doCloser = deals.filter((d) => palavrasBatem((d.user && d.user.name) || '', nomeCloser)).map((d) => ({ id: idDe(d), updated_at: d.updated_at || '', user: d.user }));
    await db.cacheSet(chave, JSON.stringify(doCloser), LISTA_SEG).catch(() => {});
    return doCloser;
  };
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < pares.length && Date.now() < prazoListas) {
      const i = proximo++;
      listas[i] = await lerPar(pares[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pares.length) }, trabalhador));
  diag.listasPendentes = listas.filter((l) => l === null).length;
  listas.forEach((l) => (l || []).forEach((d) => ids.push(d))); // na ordem dos pares: as suas primeiro, são lidas antes
  // O CRM aceita 600 consultas por minuto: lê o detalhe no tempo que sobrar (deixando folga para montar a resposta).
  const sobra = prazoFinal - Date.now() - Number(process.env.MATCH_FOLGA_MS || 7000);
  const cards = sobra > 1500 ? await crm.detalhesDe(ids, { prazoMs: Math.min(Number(process.env.MATCH_PRAZO_MS) || 38000, sobra) }) : Object.assign([], { pendentes: ids.length });
  // Lista ainda não lida conta como pendente (com pelo menos 1): a tela continua sozinha e o resultado não é guardado.
  diag.pendentes = (cards.pendentes || 0) + diag.listasPendentes;
  return { cards, diag };
}

async function buscarCards({ closerRd, desde, hoje, usuario, time, nomeCloser, prazoFinal }) {
  if (crm.ehPronix()) return buscarCardsPronix({ usuario, time, nomeCloser, desde, hoje, prazoFinal });
  const porId = new Map();
  const diag = { paginas: 0, truncado: false };
  const corte = somaDias(desde, -FOLGA_CRIACAO_DIAS);
  const guardar = (d) => porId.set(idDe(d), d);
  // 1) Todos os cards do closer, do mais novo para o mais antigo, até passar bem do início do período.
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const r = await crm.rd('/deals', {
      limit: 200, page: pagina, order: 'created_at', direction: 'desc', ...(closerRd ? { user_id: String(closerRd.id) } : {}),
    });
    diag.paginas++;
    const deals = lista(r, 'deals');
    deals.forEach(guardar);
    const maisAntigo = deals.reduce((m, d) => (d.created_at && (!m || d.created_at < m) ? d.created_at : m), '');
    if (!(r && r.has_more) && deals.length < 200) break;
    if (maisAntigo && stats.emDiaLocal(maisAntigo) < corte) break;
    if (pagina === MAX_PAGINAS) diag.truncado = true;
  }
  // 2) As vendas do período, mesmo de card antigo (ganho agora, criado há muito tempo).
  for (let pagina = 1; pagina <= 8; pagina++) {
    const r = await crm.rd('/deals', {
      win: 'true', closed_at: 'true', closed_at_period: 'true', start_date: desde, end_date: hoje, limit: 200, page: pagina,
      ...(closerRd ? { user_id: String(closerRd.id) } : {}),
    });
    diag.paginas++;
    const deals = lista(r, 'deals');
    deals.forEach(guardar);
    if (!(r && r.has_more) && deals.length < 200) break;
  }
  return { cards: [...porId.values()], diag };
}

/**
 * Levanta tudo do RD (e dos reports) e devolve os meses, a lista de reuniões e o diagnóstico.
 * @param {{usuario: {id, nome}, closer?: string, desde?: string, atualizar?: boolean}} pedido
 */
async function levantar({ usuario, closer, desde, atualizar = false } = {}) {
  const prazoFinal = Date.now() + ORCAMENTO_MS();
  if (!crm.configurado()) throw new Error('O RD Station não está configurado no servidor.');
  const nomeCloser = String(closer || CLOSER_PADRAO()).trim();
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(String(desde || '')) ? desde : DESDE_PADRAO();
  const time = timeDeSdrs();
  const chaveCache = `match3_${usuario.id}_${slug(nomeCloser)}_${inicio}_${slug(time.join(' '))}`;
  if (!atualizar) {
    const guardado = await db.cacheGet(chaveCache).catch(() => null);
    if (guardado) {
      try {
        return { ...JSON.parse(guardado), cache: true };
      } catch (_) {
        /* refaz */
      }
    }
  }
  const hoje = stats.emDiaLocal(new Date().toISOString());
  const rdUsers = await crm.usuariosRd().catch(() => []);
  const closerRd = rdUsers.find((u) => palavrasBatem(u.nome, nomeCloser)) || null;
  const { cards, diag } = await buscarCards({ closerRd, desde: inicio, hoje, usuario, time, nomeCloser, prazoFinal });
  // Pronix CRM: id da etapa -> categoria ("reuniao_realizada", "fup"...), para reconhecer a reunião em qualquer funil.
  const catalogo = new Map();
  if (crm.ehPronix()) (await crm.funis().catch(() => [])).forEach((f) => f.etapas.forEach((e) => e.categoria && catalogo.set(e.id, e.categoria)));

  const diagnostico = {
    closerNoRd: closerRd ? closerRd.nome : '', funis: diag.funis || [], cardsLidos: cards.length, paginas: diag.paginas, truncado: diag.truncado, pendentesDoCrm: diag.pendentes || 0,
    deOutroCloser: 0, semSdr: 0, deOutroSdr: 0, doTime: 0, noShow: 0, aindaNaoAconteceu: 0, foraDoPeriodo: 0, dataPeloCampo: 0, dataPeloHistorico: 0, dataPelaCriacao: 0,
    etapasSemReuniao: {}, doReport: 0,
  };
  const reunioes = [];
  for (const d of cards) {
    if (!palavrasBatem((d.user && d.user.name) || '', nomeCloser)) { diagnostico.deOutroCloser++; continue; }
    const quem = quemEhOSdr(d, usuario, time);
    if (quem.tipo === 'sem') { diagnostico.semSdr++; continue; }
    if (quem.tipo === 'outro') { diagnostico.deOutroSdr++; continue; }
    const estado = estadoDoCard(d, catalogo);
    if (estado === 'no_show') { diagnostico.noShow++; continue; }
    if (estado === 'antes') {
      diagnostico.aindaNaoAconteceu++;
      const etapa = (d.deal_stage && d.deal_stage.name) || '(sem etapa)';
      diagnostico.etapasSemReuniao[etapa] = (diagnostico.etapasSemReuniao[etapa] || 0) + 1;
      continue;
    }
    const venda = estado === 'venda';
    const diaVenda = venda && d.closed_at ? stats.emDiaLocal(d.closed_at) : '';
    let { dia, origem } = dataDaReuniao(d, catalogo);
    if (diaVenda && (!dia || dia > diaVenda)) { dia = diaVenda; origem = origem || 'venda'; } // reunião não vem depois da venda
    const contaReuniao = dia >= inicio && dia <= hoje;
    const contaVenda = venda && diaVenda >= inicio && diaVenda <= hoje;
    if (!contaReuniao && !contaVenda) { diagnostico.foraDoPeriodo++; continue; }
    if (contaReuniao) diagnostico[origem === 'campo' ? 'dataPeloCampo' : origem === 'historico' ? 'dataPeloHistorico' : 'dataPelaCriacao']++;
    if (quem.tipo === 'time') diagnostico.doTime++;
    reunioes.push({
      id: idDe(d), fonte: 'rd', lead: leadDoCard(d), dataReuniao: dia, origemData: origem, contaReuniao,
      sdr: quem.nome, minha: quem.tipo === 'eu',
      estado, etapa: (d.deal_stage && d.deal_stage.name) || '', motivo: (d.deal_lost_reason && d.deal_lost_reason.name) || '',
      venda, diaVenda: contaVenda ? diaVenda : '', ticket: contaVenda ? Number(d.amount_total) || 0 : 0,
      // Para as análises: a venda em qualquer data (a conversão de um tipo de lead é das reuniões dele) e o formulário.
      diaVendaReal: diaVenda, ticketTotal: venda ? Number(d.amount_total) || 0 : 0, lead_: analises.doCard(d),
      produto: venda ? produtoPeloNome((d.deal_products || []).map((p) => (p && (p.name || (p.product && p.product.name))) || '')) : '',
    });
  }

  // Reports do usuário com esse closer e resultado de reunião que o RD não trouxe (card sem o campo SDR, p.ex.).
  const ids = new Set(reunioes.map((r) => r.id));
  const leads = new Set(reunioes.map((r) => norm(r.lead)).filter(Boolean));
  const todosReports = await stats.listar({}).catch(() => []);
  const meus = todosReports.filter((r) => r.usuarioId === usuario.id);
  // Reports do time: de quem tem o nome de um SDR da lista (o seu já está em "meus").
  const sdrDoReport = (r) => (r.usuarioId === usuario.id ? usuario.nome : time.find((n) => nomeBate(r.usuarioNome || '', n)) || '');
  const doTime = todosReports.filter((r) => r.usuarioId !== usuario.id && sdrDoReport(r));
  for (const r of meus.concat(doTime)) {
    if (!RESULTADOS_REUNIAO.has(r.resultado) || !palavrasBatem(r.closerNome || '', nomeCloser)) continue;
    if ((r.rdDealId && ids.has(String(r.rdDealId))) || ids.has(String(r.id).replace(/^rd/, '')) || leads.has(norm(r.lead))) continue;
    const venda = stats.ehVenda(r.resultado);
    const dia = r.dataReuniao || r.dia || '';
    const diaVenda = venda ? r.dataFechamento || dia : '';
    const contaReuniao = dia >= inicio && dia <= hoje;
    const contaVenda = venda && diaVenda >= inicio && diaVenda <= hoje;
    if (!contaReuniao && !contaVenda) continue;
    diagnostico.doReport++;
    reunioes.push({
      id: 'r_' + r.id, fonte: 'report', lead: r.lead || r.contato || '', dataReuniao: dia, origemData: r.dataReuniao ? 'report' : 'dia-do-report', contaReuniao,
      sdr: sdrDoReport(r), minha: r.usuarioId === usuario.id,
      estado: venda ? 'venda' : r.resultado === 'em_followup' ? 'fup' : 'nao_comprou', etapa: '', motivo: '',
      venda, diaVenda: contaVenda ? diaVenda : '', ticket: contaVenda ? Number(r.ticket) || 0 : 0, produto: r.produto || '',
      diaVendaReal: diaVenda, ticketTotal: venda ? Number(r.ticket) || 0 : 0, lead_: {},
    });
  }
  reunioes.sort((a, b) => String(b.dataReuniao || b.diaVenda).localeCompare(String(a.dataReuniao || a.diaVenda)));

  // Perfil e nível de consciência do report desse lead (a correção do master vale mais que a leitura da IA).
  const leitura = new Map();
  for (const r of meus.concat(doTime)) {
    const v = { perfil: r.perfilReal || r.perfil || '', consciencia: r.conscienciaReal || r.consciencia || '' };
    if (!v.perfil && !v.consciencia) continue;
    if (r.rdDealId) leitura.set('d' + r.rdDealId, v);
    if (norm(r.lead)) leitura.set('n' + norm(r.lead), v);
  }
  for (const x of reunioes) {
    const v = leitura.get('d' + String(x.id).replace(/^r_/, '')) || leitura.get('n' + norm(x.lead));
    x.perfil = (v && v.perfil) || '';
    x.consciencia = (v && v.consciencia) || '';
  }
  // Profissão e investimento que não estão nos campos do card: da anotação do formulário (uma vez por card).
  const form = await analises.completarPeloFormulario(reunioes, { prazoFinal: prazoFinal + 5000 }).catch(() => ({ lidos: 0, pendentes: 0 }));
  diagnostico.formulariosLidos = form.lidos;
  diagnostico.formulariosPendentes = form.pendentes;

  // `meses` continua sendo o SEU mês a mês (quem chama levantar() sozinho espera isso); `reunioes` traz o time, com `minha`.
  const saida = { closer: nomeCloser, sdr: usuario.nome, time, desde: inicio, ate: hoje, atualizadoEm: new Date().toISOString(), meses: porMes(reunioes.filter((r) => r.minha), inicio, hoje), reunioes, diagnostico };
  // Leitura incompleta (faltou ler parte do CRM) não fica guardada: a próxima abertura continua de onde parou.
  if (!diagnostico.pendentesDoCrm) await db.cacheSet(chaveCache, JSON.stringify(saida), CACHE_SEG).catch(() => {});
  return { ...saida, cache: false };
}

/** Meses de `inicio` até `hoje`, cada um com reuniões, vendas, faturamento, conversão e ticket médio. */
function porMes(reunioes, inicio, hoje) {
  const meses = [];
  for (let m = mesDe(inicio); m <= mesDe(hoje); m = mesDe(somaDias(m + '-28', 5))) {
    const doMes = (campo) => reunioes.filter((r) => mesDe(r[campo]) === m);
    const realizadas = doMes('dataReuniao').filter((r) => r.contaReuniao).length;
    const vendas = doMes('diaVenda').filter((r) => r.diaVenda);
    const faturamento = vendas.reduce((t, r) => t + r.ticket, 0);
    meses.push({
      mes: m, reunioes: realizadas, vendas: vendas.length, faturamento,
      conversao: realizadas ? vendas.length / realizadas : 0, ticketMedio: vendas.length ? faturamento / vendas.length : 0,
    });
  }
  return meses;
}

// ---------------------------------------------------------------- meta e plano do mês

const chaveMeta = (usuarioId, closer) => `meta_match_${usuarioId}_${slug(closer || CLOSER_PADRAO())}`;
const lerNumero = (v) => {
  // "392.000", "392,000", "R$ 392.000,00", "1.250.000", "25,5": com os dois sinais, o último é o decimal;
  // com um só, grupos de 3 dígitos depois dele são milhar ("392,000" = 392 mil), senão é decimal ("25,5").
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v == null ? '' : v).replace(/[^\d.,]/g, '');
  const ponto = s.lastIndexOf('.');
  const virgula = s.lastIndexOf(',');
  if (ponto >= 0 && virgula >= 0) {
    const dec = Math.max(ponto, virgula);
    s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
  } else if (ponto >= 0 || virgula >= 0) {
    const partes = s.split(virgula >= 0 ? ',' : '.');
    s = partes.slice(1).every((p) => p.length === 3) ? partes.join('') : partes.slice(0, -1).join('') + '.' + partes[partes.length - 1];
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const valor = (v) => {
  const n = lerNumero(v);
  return n > 0 ? Math.round(n * 100) / 100 : 0;
};

async function lerMetas(usuarioId, closer) {
  const m = await db.getJson(chaveMeta(usuarioId, closer), null).catch(() => null);
  return m && typeof m === 'object' ? m : {};
}

/** Guarda a meta de um mês: { meta1, meta2, meta3 } em reais e a conversão alvo (%). */
async function salvarMeta(usuarioId, closer, { mes, meta1, meta2, meta3, conversaoAlvo } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) throw new Error('Informe o mês da meta (AAAA-MM).');
  const conversao = valor(conversaoAlvo);
  if (conversao > 100) throw new Error('A conversão alvo vai de 1 a 100%.');
  const metas = await lerMetas(usuarioId, closer);
  metas[mes] = { meta1: valor(meta1), meta2: valor(meta2), meta3: valor(meta3), conversaoAlvo: conversao };
  await db.setJson(chaveMeta(usuarioId, closer), metas);
  return metas[mes];
}

const diaDaSemana = (dia) => new Date(dia + 'T12:00:00Z').getUTCDay(); // 0 = domingo
/** O último sábado do mês: é dia de trabalho (os outros sábados e os domingos, não). */
const ehUltimoSabado = (dia) => diaDaSemana(dia) === 6 && mesDe(somaDias(dia, 7)) !== mesDe(dia);
const ehUtil = (dia) => { const s = diaDaSemana(dia); return (s >= 1 && s <= 5) || ehUltimoSabado(dia); };
function ultimoSabado(mes) {
  let d = somaDias(mesDe(somaDias(mes + '-28', 5)) + '-01', -1); // último dia do mês
  while (diaDaSemana(d) !== 6) d = somaDias(d, -1);
  return d;
}

/** Dias úteis do mês (segunda a sexta + o último sábado): total, os que já passaram (antes de hoje) e os que faltam (hoje incluído). */
function diasUteis(mes, hoje) {
  const r = { total: 0, passados: 0, restantes: 0 };
  for (let d = mes + '-01'; mesDe(d) === mes; d = somaDias(d, 1)) {
    if (!ehUtil(d)) continue;
    r.total++;
    if (d < hoje) r.passados++;
    else r.restantes++;
  }
  return r;
}

/**
 * O plano do mês: quanto já foi, quanto falta para cada meta, quanto por dia útil, quantas vendas e reuniões
 * isso pede (pela conversão e pelo ticket médio do período) e a projeção no ritmo atual.
 */
function plano({ mes, hoje, meta = {}, feito, historico }) {
  const dias = diasUteis(mes, hoje);
  const mesPassou = mes < mesDe(hoje);
  const restantes = mesPassou ? 0 : Math.max(dias.restantes, 0);
  const decorridos = mesPassou ? dias.total : dias.passados + (ehUtil(hoje) ? 1 : 0);
  // Conversão e ticket do período inteiro (mais estável que o mês corrente, que ainda está no começo).
  const reunioesHist = historico.reduce((t, m) => t + m.reunioes, 0);
  const vendasHist = historico.reduce((t, m) => t + m.vendas, 0);
  const fatHist = historico.reduce((t, m) => t + m.faturamento, 0);
  const conversaoHistorica = reunioesHist ? vendasHist / reunioesHist : 0;
  const ticketMedio = vendasHist ? fatHist / vendasHist : 0;
  // A conversão que vale para o plano: a alvo, se foi definida; senão, a do período.
  const conversaoAlvo = meta.conversaoAlvo > 0 ? meta.conversaoAlvo / 100 : 0;
  const conversao = conversaoAlvo || conversaoHistorica;
  const metas = ['meta1', 'meta2', 'meta3'].filter((k) => meta[k] > 0).map((k) => {
    const falta = Math.max(0, meta[k] - feito.faturamento);
    const vendas = ticketMedio ? Math.ceil(falta / ticketMedio) : null;
    const reunioes = vendas != null && conversao ? Math.ceil(vendas / conversao) : null;
    return {
      nome: k, alvo: meta[k], falta, pct: meta[k] ? feito.faturamento / meta[k] : 0, batida: falta === 0,
      porDia: restantes ? falta / restantes : falta, vendas, reunioes,
      reunioesPorDia: reunioes != null && restantes ? reunioes / restantes : null,
      // Meta diária acumulada (zxp-market): onde deveria estar hoje para chegar no fim do mês.
      esperadoHoje: dias.total ? (meta[k] / dias.total) * decorridos : 0,
    };
  });
  return {
    mes, ultimoSabado: ultimoSabado(mes), diasUteis: dias.total, diasPassados: decorridos, diasRestantes: restantes,
    feito, conversao, conversaoAlvo, conversaoHistorica, ticketMedio,
    conversaoMes: feito.reunioes ? feito.vendas / feito.reunioes : 0,
    // Com a conversão alvo, quantas vendas as reuniões de até agora já deveriam ter dado.
    vendasEsperadas: conversaoAlvo ? feito.reunioes * conversaoAlvo : null,
    projecao: decorridos ? (feito.faturamento / decorridos) * dias.total : 0,
    projecaoReunioes: decorridos ? (feito.reunioes / decorridos) * dias.total : 0,
    metas,
  };
}

/** Do dia 1 até hoje x o mesmo intervalo de dias do mês passado (dashboard-pessoal). */
function mesmoPeriodo(reunioes, hoje) {
  const dia = Number(hoje.slice(8, 10));
  const mesAtual = mesDe(hoje);
  const anterior = mesDe(somaDias(mesAtual + '-01', -1));
  const conta = (mes) => {
    const ate = `${mes}-${String(dia).padStart(2, '0')}`;
    const dentro = (d) => mesDe(d) === mes && d <= ate;
    const vendas = reunioes.filter((r) => r.diaVenda && dentro(r.diaVenda));
    return { mes, ate, reunioes: reunioes.filter((r) => r.contaReuniao && dentro(r.dataReuniao)).length, vendas: vendas.length, faturamento: vendas.reduce((t, r) => t + r.ticket, 0) };
  };
  return { atual: conta(mesAtual), anterior: conta(anterior) };
}

/** Totais do período: reuniões realizadas, vendas, conversão (vendas ÷ reuniões) e faturamento — a soma dos meses. */
function totais(meses) {
  const t2 = meses.reduce((a, m) => ({ reunioes: a.reunioes + m.reunioes, vendas: a.vendas + m.vendas, faturamento: a.faturamento + m.faturamento }), { reunioes: 0, vendas: 0, faturamento: 0 });
  return { ...t2, conversao: t2.reunioes ? t2.vendas / t2.reunioes : 0, ticketMedio: t2.vendas ? t2.faturamento / t2.vendas : 0 };
}

/**
 * Você x time, sempre lado a lado: o total do período, por SDR e por profissão (as duas conversões na mesma linha).
 */
function comparar(reunioes, inicio, hoje, usuario) {
  const minhas = reunioes.filter((r) => r.minha);
  const porSdr = new Map();
  for (const r of reunioes) {
    const nome = r.minha ? usuario.nome : r.sdr || 'Sem nome';
    if (!porSdr.has(nome)) porSdr.set(nome, []);
    porSdr.get(nome).push(r);
  }
  const sdrs = [...porSdr.entries()].map(([nome, lista2]) => ({ nome, voce: nome === usuario.nome, ...totais(porMes(lista2, inicio, hoje)) }))
    .filter((x) => x.reunioes || x.vendas)
    .sort((a, b) => b.reunioes - a.reunioes || b.conversao - a.conversao);
  // Profissão: a conversão das SUAS reuniões e a do time, no mesmo grupo (vendas de qualquer data, como nas análises).
  const profMinha = analises.analisar(minhas).cortes.find((c) => c.id === 'profissao');
  const profTime = analises.analisar(reunioes).cortes.find((c) => c.id === 'profissao');
  const chave = (g) => norm(g.rotulo);
  const minhaPor = new Map(((profMinha && profMinha.grupos) || []).map((g) => [chave(g), g]));
  const profissoes = ((profTime && profTime.grupos) || []).map((g) => {
    const m = minhaPor.get(chave(g)) || { reunioes: 0, vendas: 0, conversao: 0 };
    return { rotulo: g.rotulo, time: { reunioes: g.reunioes, vendas: g.vendas, conversao: g.conversao }, minha: { reunioes: m.reunioes, vendas: m.vendas, conversao: m.conversao } };
  });
  return { minha: totais(porMes(minhas, inicio, hoje)), time: totais(porMes(reunioes, inicio, hoje)), sdrs, profissoes };
}

/**
 * Tudo da aba: o levantamento recortado pelo escopo ("minhas" ou "time"), a comparação, a meta e o plano.
 * Meta e plano são SEUS (a meta é pessoal): seguem as suas reuniões em qualquer escopo.
 */
async function painel({ usuario, closer, desde, atualizar, escopo } = {}) {
  const dados = await levantar({ usuario, closer, desde, atualizar });
  const doTime = escopo === 'time';
  const minhas = dados.reunioes.filter((r) => r.minha);
  const base = doTime ? dados.reunioes : minhas;
  const meses = porMes(base, dados.desde, dados.ate);
  const mesesMeus = doTime ? porMes(minhas, dados.desde, dados.ate) : meses;
  const metas = await lerMetas(usuario.id, dados.closer);
  const mesAtual = mesDe(dados.ate);
  const doMes = mesesMeus.find((m) => m.mes === mesAtual) || { reunioes: 0, vendas: 0, faturamento: 0 };
  return {
    ...dados,
    escopo: doTime ? 'time' : 'minhas',
    reunioes: base,
    meses,
    metas,
    plano: plano({ mes: mesAtual, hoje: dados.ate, meta: metas[mesAtual] || {}, feito: { reunioes: doMes.reunioes, vendas: doMes.vendas, faturamento: doMes.faturamento }, historico: mesesMeus }),
    mesmoPeriodo: mesmoPeriodo(base, dados.ate),
    analises: analises.analisar(base),
    comparacao: comparar(dados.reunioes, dados.desde, dados.ate, usuario),
  };
}

module.exports = { quemEhOSdr, timeDeSdrs, comparar, totais, lerNumero, levantar, painel, plano, diasUteis, ultimoSabado, salvarMeta, lerMetas, estadoDoCard, dataDaReuniao, porMes, mesmoPeriodo, diaDoValor };
