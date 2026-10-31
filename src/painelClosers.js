'use strict';

// Aba "Meus closers": com que closer o SDR se dá melhor. Para o mês escolhido (padrão: o atual), lê no CRM os cards em
// que o SDR é o SDR e que mudaram no mês, fica com os que foram para um closer (o dono do card) e soma, por closer:
// reuniões realizadas no mês, vendas no mês, faturamento, ticket médio, conversão (vendas ÷ reuniões) e no-show.
// As regras de "a reunião aconteceu", da data da reunião e da venda são as do Match (src/matchCloser.js), para os dois
// mostrarem os mesmos números. Só leitura no CRM; lê em partes (a Vercel corta em 60 s) e a tela continua sozinha.

const db = require('./db');
const crm = require('./crm');
const stats = require('./stats');
const match = require('./matchCloser');
const closersCadastro = require('./closers');
const { leadDoCard } = require('./vendasDoRd');

const ORCAMENTO_MS = () => Number(process.env.CLOSERS_ORCAMENTO_MS) || 45000;
const CACHE_SEG = 20 * 60;
// Os closers do time (o calendário dos closers, 31/10/2026), como o CRM os chama. Somam-se aos da aba Closers;
// CLOSERS_PADRAO (nomes separados por vírgula) troca a lista sem mexer no código.
const CLOSERS_PADRAO = 'Paulo Henrique Pagoti, Amarildo Queiroz, Giovane Ribeiro Romano, Raphael Cassiano Ribeiro, Daniel Camargo de Andrade, Gabrielle Machado Silveira, Igor Martins, Jenniffer Lauany Barros, Pedro Henrique Melo Palermo, Pedro Pasin, Roselaynne Lima Costa Cabral, Vitor Santos, Zayra';
const closersPadrao = () => String(process.env.CLOSERS_PADRAO || CLOSERS_PADRAO).split(',').map((x) => x.trim()).filter(Boolean);
const LISTA_SEG = 10 * 60;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idDe = (d) => String((d && (d.id || d._id)) || '');
const slug = (s) => norm(s).replace(/ /g, '-') || 'x';
/** O nome do dono do card é o desta pessoa? Nome inteiro ou o primeiro nome igual. */
const mesmaPessoa = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y) && (x === y || x.split(' ')[0] === y.split(' ')[0]);
};
const ultimoDiaDoMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

/** Os SDRs que dá para escolher: você e o time do Match (MATCH_SDRS_TIME). */
const sdrsDisponiveis = (usuario) => [usuario.nome].concat(match.timeDeSdrs().filter((n) => !mesmaPessoa(n, usuario.nome)));

/**
 * Os cards do(s) SDR(s) que mudaram no período, só os que estão com um closer (o dono não é um SDR), com o detalhe.
 * Cada lista SDR × funil fica guardada 10 min; o que não couber no tempo fica para a próxima rodada (pendentes).
 */
async function buscarCards({ sdrs, inicio, fim, prazoFinal }) {
  const diag = { listasPendentes: 0, funis: [], sdrsSemCrm: [], erroLista: '' };
  const todos = await crm.funis().catch(() => []);
  const comRealizada = todos.filter((f) => f.etapas.some((e) => e.categoria === 'reuniao_realizada'));
  const funis = [...new Map(comRealizada.concat(await crm.funisDosClosers().catch(() => [])).map((f) => [f.id, f])).values()];
  diag.funis = funis.map((f) => f.nome);
  const pares = [];
  for (const nome of sdrs) {
    const u = await crm.usuarioDoCrm(nome).catch(() => null);
    if (!u) { diag.sdrsSemCrm.push(nome); continue; } // a tela avisa (em vez de mostrar tudo zerado)
    for (const funil of funis.length ? funis : [null]) pares.push({ sdrId: String(u.id), funil });
  }
  const ehSdr = (dono) => sdrs.some((n) => mesmaPessoa(dono, n));
  const prazoListas = prazoFinal - Number(process.env.CLOSERS_RESERVA_DETALHE_MS || 15000);
  const listas = new Array(pares.length).fill(null);
  const lerPar = async ({ sdrId, funil }) => {
    const chave = `closers_lista1_${sdrId}_${funil ? funil.id : 'todos'}_${inicio}_${fim}`;
    const guardada = await db.cacheGet(chave).catch(() => null);
    if (guardada) { try { return JSON.parse(guardada); } catch (_) { /* relê */ } }
    // Lista grande demora: espera até 25 s (dentro do tempo da rodada). Se ainda assim o CRM não responder, esta
    // lista fica para a próxima rodada (pendente) — antes, uma lista lenta derrubava a aba inteira.
    let deals;
    try {
      const espera = Math.max(3000, Math.min(25000, prazoListas - Date.now()));
      deals = await crm.listarNegociacoes({ sdr_id: sdrId, ...(funil ? { deal_pipeline_id: funil.id } : {}), updated_at_period: 'true', start_date: crm.instanteDoDia(inicio), end_date: crm.instanteDoDia(fim, true) }, { timeoutMs: espera });
    } catch (e) {
      diag.erroLista = String((e && e.message) || e).slice(0, 160);
      return null;
    }
    const comCloser = deals.filter((d) => (d.user && d.user.name) && !ehSdr(d.user.name)).map((d) => ({ id: idDe(d), updated_at: d.updated_at || '' }));
    await db.cacheSet(chave, JSON.stringify(comCloser), LISTA_SEG).catch(() => {});
    return comCloser;
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
  const vistos = new Set();
  const ids = [];
  listas.forEach((l) => (l || []).forEach((d) => { if (!vistos.has(d.id)) { vistos.add(d.id); ids.push(d); } }));
  const sobra = prazoFinal - Date.now() - Number(process.env.CLOSERS_FOLGA_MS || 7000);
  const cards = sobra > 1500 ? await crm.detalhesDe(ids, { prazoMs: Math.min(38000, sobra) }) : Object.assign([], { pendentes: ids.length });
  diag.pendentes = (cards.pendentes || 0) + diag.listasPendentes;
  return { cards, diag };
}

/** Os números de cada closer (e o total), das reuniões do mês. */
function porCloser(reunioes) {
  const mapa = new Map();
  const novo = (closer) => ({ closer, reunioes: 0, vendas: 0, faturamento: 0, noShow: 0, ticketMedio: 0, conversao: 0, leads: [] });
  for (const r of reunioes) {
    if (!mapa.has(r.closer)) mapa.set(r.closer, novo(r.closer));
    const c = mapa.get(r.closer);
    if (r.contaReuniao) c.reunioes++;
    if (r.noShow) c.noShow++;
    if (r.contaVenda) { c.vendas++; c.faturamento += r.valor; }
    c.leads.push(r);
  }
  const fechar = (c) => {
    c.ticketMedio = c.vendas ? Math.round(c.faturamento / c.vendas) : 0;
    c.conversao = c.reunioes ? Math.round((c.vendas / c.reunioes) * 1000) / 10 : 0;
    c.leads.sort((a, b) => String(b.dia).localeCompare(String(a.dia)));
    return c;
  };
  const closers = [...mapa.values()].map(fechar);
  // Melhor conversão primeiro (desempate: mais vendas, mais reuniões).
  closers.sort((a, b) => b.conversao - a.conversao || b.vendas - a.vendas || b.reunioes - a.reunioes || a.closer.localeCompare(b.closer, 'pt-BR'));
  const total = fechar(closers.reduce((t, c) => {
    t.reunioes += c.reunioes; t.vendas += c.vendas; t.faturamento += c.faturamento; t.noShow += c.noShow;
    return t;
  }, novo('Total')));
  delete total.leads;
  return { closers, total };
}

/**
 * O painel: o mês (AAAA-MM, padrão o atual), o SDR (nome; 'time' = você e o time do Match) e os números por closer.
 * @param {{ usuario: {id, nome}, sdr?: string, mes?: string, atualizar?: boolean }} p
 */
async function painel({ usuario, sdr, mes, atualizar = false } = {}) {
  if (!crm.configurado()) throw new Error('O CRM não está configurado no servidor.');
  const prazoFinal = Date.now() + ORCAMENTO_MS();
  const hoje = stats.emDiaLocal(new Date().toISOString());
  const mesOk = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || '')) ? mes : hoje.slice(0, 7);
  const inicio = mesOk + '-01';
  const fim = ultimoDiaDoMes(mesOk) < hoje ? ultimoDiaDoMes(mesOk) : hoje;
  if (inicio > hoje) throw new Error('Esse mês ainda não começou.');
  const disponiveis = sdrsDisponiveis(usuario);
  const time = String(sdr || '') === 'time';
  const escolhido = time ? '' : disponiveis.find((n) => mesmaPessoa(n, sdr)) || usuario.nome;
  const sdrs = time ? disponiveis : [escolhido];
  const chave = `closers4_${usuario.id}_${slug(sdrs.join(' '))}_${mesOk}`;
  if (!atualizar) {
    const guardado = await db.cacheGet(chave).catch(() => null);
    if (guardado) { try { return { ...JSON.parse(guardado), cache: true }; } catch (_) { /* refaz */ } }
  }
  const { cards, diag } = await buscarCards({ sdrs, inicio, fim, prazoFinal });
  const catalogo = new Map();
  (await crm.funis().catch(() => [])).forEach((f) => f.etapas.forEach((e) => e.categoria && catalogo.set(e.id, e.categoria)));
  const diagnostico = {
    cardsLidos: cards.length, pendentesDoCrm: diag.pendentes || 0, listasPendentes: diag.listasPendentes || 0, erroLista: diag.erroLista || '',
    sdrsSemCrm: diag.sdrsSemCrm || [], funis: diag.funis, deOutroSdr: 0, aindaNaoAconteceu: 0, foraDoMes: 0,
  };
  // Quem é closer: a lista dos closers do time (CLOSERS_PADRAO) mais os cadastrados na aba Closers. Dono de card que
  // não está nela (SDR, gestor...) fica fora da tabela, e o que ele soma aparece à parte (foraDaTabela).
  const cadastrados = (await closersCadastro.listar().catch(() => [])).map((c) => c.nome).concat(closersPadrao());
  const palavras = (s) => norm(s).split(' ').filter(Boolean);
  const cabe = (curto, longo) => { const p = new Set(palavras(longo)); const c = palavras(curto); return c.length > 0 && c.every((x) => p.has(x)); };
  // o nome do CRM e o da lista: todas as palavras de um estão no outro, ou o mesmo primeiro e último nome
  const pontas = (s) => { const p = palavras(s); return p.length > 1 ? p[0] + ' ' + p[p.length - 1] : ''; };
  const ehCloser = (nome) => cadastrados.some((c) => cabe(c, nome) || cabe(nome, c) || (pontas(c) && pontas(c) === pontas(nome)));
  const naoCloser = new Set();
  const reunioes = [];
  for (const d of cards) {
    const closer = String((d.user && d.user.name) || '').trim();
    if (!closer) continue;
    // o campo SDR do card tem de ser um dos SDRs escolhidos (a lista do CRM já filtra; aqui confere)
    const quem = match.quemEhOSdr(d, { nome: sdrs[0] }, sdrs.slice(1));
    if (quem.tipo === 'outro') { diagnostico.deOutroSdr++; continue; }
    const estado = match.estadoDoCard(d, catalogo);
    if (estado === 'antes') { diagnostico.aindaNaoAconteceu++; continue; }
    const venda = estado === 'venda';
    const diaVenda = venda && d.closed_at ? stats.emDiaLocal(d.closed_at) : '';
    let { dia } = match.dataDaReuniao(d, catalogo);
    if (diaVenda && (!dia || dia > diaVenda)) dia = diaVenda; // a reunião não vem depois da venda
    const noMes = (x) => Boolean(x) && x >= inicio && x <= fim;
    const contaReuniao = estado !== 'no_show' && noMes(dia);
    const noShow = estado === 'no_show' && noMes(dia);
    const contaVenda = venda && noMes(diaVenda);
    if (!contaReuniao && !noShow && !contaVenda) { diagnostico.foraDoMes++; continue; }
    if (!ehCloser(closer)) naoCloser.add(closer);
    reunioes.push({
      id: idDe(d), closer, ehCloser: ehCloser(closer), lead: leadDoCard(d), dia, estado, contaReuniao, noShow, contaVenda,
      valor: contaVenda ? Number(d.amount_total) || 0 : 0, sdr: quem.nome || sdrs[0],
      etapa: (d.deal_stage && d.deal_stage.name) || '',
    });
  }
  // Os números são SÓ do CRM (é o que o CRM mostra na coluna "Vendido"): report que o CRM não traz não entra.
  diagnostico.naoCloser = [...naoCloser].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  const { closers, total } = porCloser(reunioes.filter((r) => r.ehCloser));
  // o que os donos que não são closers somam: para o total da tela + isto bater com o CRM
  const fora = porCloser(reunioes.filter((r) => !r.ehCloser)).total;
  diagnostico.foraDaTabela = { nomes: diagnostico.naoCloser, reunioes: fora.reunioes, vendas: fora.vendas, faturamento: fora.faturamento };
  const saida = { mes: mesOk, inicio, fim, sdr: time ? 'time' : escolhido, sdrsDisponiveis: disponiveis, closers, total, diagnostico, atualizadoEm: new Date().toISOString() };
  // Leitura incompleta não fica guardada: a próxima rodada continua de onde parou (as listas e os detalhes ficam).
  if (!diagnostico.pendentesDoCrm) await db.cacheSet(chave, JSON.stringify(saida), CACHE_SEG).catch(() => {});
  return saida;
}

module.exports = { painel, porCloser, sdrsDisponiveis };
