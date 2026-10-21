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

const db = require('./db');
const crm = require('./crm');
const stats = require('./stats');
const { produtoPeloNome } = require('./vendasRd');
const { sdrDoCard, leadDoCard } = require('./vendasDoRd');
const analises = require('./matchAnalises');

const DESDE_PADRAO = () => process.env.MATCH_DESDE || '2026-07-01';
const CLOSER_PADRAO = () => process.env.MATCH_CLOSER || 'Paulo Henrique';
const MAX_PAGINAS = 15;
const FOLGA_CRIACAO_DIAS = 75; // card criado até isso antes do início ainda pode ter a reunião no período
const CACHE_SEG = 20 * 60;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idDe = (d) => String((d && (d.id || d._id)) || '');
const lista = (r, ...chaves) => (Array.isArray(r) ? r : chaves.map((k) => r && r[k]).find(Array.isArray) || []);
const palavrasBatem = (nome, alvo) => {
  const p = new Set(norm(nome).split(' ').filter(Boolean));
  const a = norm(alvo).split(' ').filter(Boolean);
  return a.length > 0 && a.every((x) => p.has(x));
};
const slug = (s) => norm(s).replace(/ /g, '-') || 'closer';
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

/** Dia da reunião do card: campo de data com "reunião"/"call" no nome; senão, a criação do card. */
function dataDaReuniao(deal) {
  for (const c of Array.isArray(deal.deal_custom_fields) ? deal.deal_custom_fields : []) {
    const rotulo = norm(c && c.custom_field && c.custom_field.label);
    if (!/(reuniao|call)/.test(rotulo) || !/(data|dia|quando)/.test(rotulo)) continue;
    const dia = diaDoValor(c.value);
    if (dia) return { dia, origem: 'campo' };
  }
  return deal.created_at ? { dia: stats.emDiaLocal(deal.created_at), origem: 'criacao' } : { dia: '', origem: '' };
}

/** O que o card diz da reunião: 'venda' | 'nao_comprou' | 'fup' | 'no_show' | 'antes' (ainda não aconteceu). */
function estadoDoCard(deal) {
  if (deal.win === true) return 'venda';
  const etapa = norm(deal.deal_stage && deal.deal_stage.name);
  if (deal.win === false) {
    return NO_SHOW.test(norm(deal.deal_lost_reason && deal.deal_lost_reason.name)) ? 'no_show' : 'nao_comprou';
  }
  if (/^vendido/.test(etapa)) return 'venda';
  if (/^nao compraram/.test(etapa)) return 'nao_comprou';
  if (ETAPAS_REALIZADA.test(etapa)) return 'fup';
  if (/no ?show/.test(etapa)) return 'no_show';
  return 'antes';
}

async function buscarCards({ closerRd, desde, hoje }) {
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
  if (!crm.configurado()) throw new Error('O RD Station não está configurado no servidor.');
  const nomeCloser = String(closer || CLOSER_PADRAO()).trim();
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(String(desde || '')) ? desde : DESDE_PADRAO();
  const chaveCache = `match_${usuario.id}_${slug(nomeCloser)}_${inicio}`;
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
  const { cards, diag } = await buscarCards({ closerRd, desde: inicio, hoje });

  const diagnostico = {
    closerNoRd: closerRd ? closerRd.nome : '', cardsLidos: cards.length, paginas: diag.paginas, truncado: diag.truncado,
    deOutroCloser: 0, semSdr: 0, deOutroSdr: 0, noShow: 0, aindaNaoAconteceu: 0, foraDoPeriodo: 0, dataPeloCampo: 0, dataPelaCriacao: 0,
    etapasSemReuniao: {}, doReport: 0,
  };
  const reunioes = [];
  for (const d of cards) {
    if (!palavrasBatem((d.user && d.user.name) || '', nomeCloser)) { diagnostico.deOutroCloser++; continue; }
    const doSdr = sdrDoCard(d, usuario);
    if (doSdr === null) { diagnostico.semSdr++; continue; }
    if (!doSdr) { diagnostico.deOutroSdr++; continue; }
    const estado = estadoDoCard(d);
    if (estado === 'no_show') { diagnostico.noShow++; continue; }
    if (estado === 'antes') {
      diagnostico.aindaNaoAconteceu++;
      const etapa = (d.deal_stage && d.deal_stage.name) || '(sem etapa)';
      diagnostico.etapasSemReuniao[etapa] = (diagnostico.etapasSemReuniao[etapa] || 0) + 1;
      continue;
    }
    const venda = estado === 'venda';
    const diaVenda = venda && d.closed_at ? stats.emDiaLocal(d.closed_at) : '';
    let { dia, origem } = dataDaReuniao(d);
    if (diaVenda && (!dia || dia > diaVenda)) { dia = diaVenda; origem = origem || 'venda'; } // reunião não vem depois da venda
    const contaReuniao = dia >= inicio && dia <= hoje;
    const contaVenda = venda && diaVenda >= inicio && diaVenda <= hoje;
    if (!contaReuniao && !contaVenda) { diagnostico.foraDoPeriodo++; continue; }
    if (contaReuniao) diagnostico[origem === 'campo' ? 'dataPeloCampo' : 'dataPelaCriacao']++;
    reunioes.push({
      id: idDe(d), fonte: 'rd', lead: leadDoCard(d), dataReuniao: dia, origemData: origem, contaReuniao,
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
  const meus = (await stats.listar({}).catch(() => [])).filter((r) => r.usuarioId === usuario.id);
  for (const r of meus) {
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
      estado: venda ? 'venda' : r.resultado === 'em_followup' ? 'fup' : 'nao_comprou', etapa: '', motivo: '',
      venda, diaVenda: contaVenda ? diaVenda : '', ticket: contaVenda ? Number(r.ticket) || 0 : 0, produto: r.produto || '',
      diaVendaReal: diaVenda, ticketTotal: venda ? Number(r.ticket) || 0 : 0, lead_: {},
    });
  }
  reunioes.sort((a, b) => String(b.dataReuniao || b.diaVenda).localeCompare(String(a.dataReuniao || a.diaVenda)));

  // Perfil e nível de consciência do report desse lead (a correção do master vale mais que a leitura da IA).
  const leitura = new Map();
  for (const r of meus) {
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
  const form = await analises.completarPeloFormulario(reunioes).catch(() => ({ lidos: 0, pendentes: 0 }));
  diagnostico.formulariosLidos = form.lidos;
  diagnostico.formulariosPendentes = form.pendentes;

  const saida = { closer: nomeCloser, sdr: usuario.nome, desde: inicio, ate: hoje, atualizadoEm: new Date().toISOString(), meses: porMes(reunioes, inicio, hoje), reunioes, diagnostico };
  await db.cacheSet(chaveCache, JSON.stringify(saida), CACHE_SEG).catch(() => {});
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

/** Tudo da aba: o levantamento, a meta do mês corrente e o plano. */
async function painel({ usuario, closer, desde, atualizar } = {}) {
  const dados = await levantar({ usuario, closer, desde, atualizar });
  const metas = await lerMetas(usuario.id, dados.closer);
  const mesAtual = mesDe(dados.ate);
  const doMes = dados.meses.find((m) => m.mes === mesAtual) || { reunioes: 0, vendas: 0, faturamento: 0 };
  return {
    ...dados,
    metas,
    plano: plano({ mes: mesAtual, hoje: dados.ate, meta: metas[mesAtual] || {}, feito: { reunioes: doMes.reunioes, vendas: doMes.vendas, faturamento: doMes.faturamento }, historico: dados.meses }),
    mesmoPeriodo: mesmoPeriodo(dados.reunioes, dados.ate),
    analises: analises.analisar(dados.reunioes),
  };
}

module.exports = { lerNumero, levantar, painel, plano, diasUteis, ultimoSabado, salvarMeta, lerMetas, estadoDoCard, dataDaReuniao, porMes, mesmoPeriodo, diaDoValor };
