'use strict';
// Aba "Meus closers": por closer, reuniões realizadas, vendas, ticket médio e conversão dos leads do SDR no mês.
// Pronix CRM SIMULADO, leads inventados, setembro de 2026.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-painel-closers-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;
delete process.env.MATCH_SDRS_TIME;

const painelClosers = require('../src/painelClosers');

const etapa = (id, name, order, categoria) => ({ id, _id: id, name, order, categoria, eh_perdido: categoria === 'perda', eh_ganho: categoria === 'venda', exige_closer: false });
const FUNIS = [
  { id: 'f-mql', _id: 'f-mql', name: 'Funil MQL', deal_stages: [etapa('m-resp', 'Respondeu', 1, 'resposta'), etapa('m-perda', 'Perdido', 2, 'perda')] },
  {
    id: 'f-clo', _id: 'f-clo', name: 'Closers',
    deal_stages: [etapa('c-agend', 'Reunião Agendada', 1, 'reuniao_agendada'), etapa('c-real', 'Reunião Realizada', 2, 'reuniao_realizada'), etapa('c-vend', 'Vendido', 3, 'venda'), etapa('c-perda', 'Perdido', 4, 'perda')],
  },
];
const nomeDe = (id) => FUNIS.flatMap((f) => f.deal_stages).find((e) => e.id === id).name;
const hist = (...pares) => pares.map(([id, dia]) => ({ deal_stage_id: id, deal_stage_name: nomeDe(id), start_date: `${dia}T15:00:00.000Z`, end_date: null }));
const CAUA = { id: 'u-caua', name: 'Cauã Lima' };
const SAMUEL = { id: 'u-sam', name: 'Samuel Filipe' };
const PH = { id: 'u-ph', name: 'Paulo Henrique Pagoti' };
const DANIEL = { id: 'u-dan', name: 'Daniel Camargo' };
const AMARILDO = { id: 'u-ama', name: 'Amarildo Queiroz' };
const card = (id, stageId, closer, extra = {}) => ({
  id, _id: id, name: `PRXC | Lead ${id}`, win: null, closed_at: null, created_at: '2026-09-01T12:00:00.000Z', updated_at: '2026-09-28T12:00:00.000Z',
  deal_pipeline: { id: 'f-clo', name: 'Closers' }, deal_stage: { id: stageId, name: nomeDe(stageId) },
  user: closer, sdr: CAUA, deal_custom_fields: [], deal_products: [], amount_total: 0, ...extra,
});
const CARDS = {
  p1: card('p1', 'c-vend', PH, { win: true, closed_at: '2026-09-12T18:00:00.000Z', amount_total: 5000, deal_stage_histories: hist(['c-agend', '2026-09-08'], ['c-real', '2026-09-10'], ['c-vend', '2026-09-12']) }),
  p2: card('p2', 'c-real', PH, { deal_stage_histories: hist(['c-agend', '2026-09-14'], ['c-real', '2026-09-15']) }),
  d1: card('d1', 'c-perda', DANIEL, { win: false, closed_at: '2026-09-09T12:00:00.000Z', deal_lost_reason: { name: 'Sem dinheiro agora' }, deal_stage_histories: hist(['c-agend', '2026-09-04'], ['c-real', '2026-09-05'], ['c-perda', '2026-09-09']) }),
  d2: card('d2', 'c-vend', DANIEL, { win: true, closed_at: '2026-09-21T18:00:00.000Z', amount_total: 8000, deal_stage_histories: hist(['c-agend', '2026-09-19'], ['c-real', '2026-09-20'], ['c-vend', '2026-09-21']) }),
  d3: card('d3', 'c-vend', DANIEL, { win: true, closed_at: '2026-09-23T18:00:00.000Z', amount_total: 4000, deal_stage_histories: hist(['c-agend', '2026-09-21'], ['c-real', '2026-09-22'], ['c-vend', '2026-09-23']) }),
  // marcou e não aconteceu (perdido sem passar pela reunião): no-show do Daniel
  n1: card('n1', 'c-perda', DANIEL, { win: false, closed_at: '2026-09-26T12:00:00.000Z', created_at: '2026-09-24T12:00:00.000Z', deal_lost_reason: { name: 'Não compareceu' }, deal_stage_histories: hist(['c-agend', '2026-09-24'], ['c-perda', '2026-09-26']) }),
  // reunião ainda marcada: não conta
  a1: card('a1', 'c-agend', AMARILDO, { deal_stage_histories: hist(['c-agend', '2026-09-27']) }),
  // reunião em agosto (o card mexeu em setembro): fora do mês
  o1: card('o1', 'c-real', DANIEL, { deal_stage_histories: hist(['c-agend', '2026-08-19'], ['c-real', '2026-08-20']) }),
  // ainda com o SDR (não foi para closer): nem é lido
  e1: card('e1', 'c-agend', CAUA),
  // o campo SDR é de outra pessoa: não entra
  x1: card('x1', 'c-vend', PH, { sdr: SAMUEL, win: true, closed_at: '2026-09-15T18:00:00.000Z', amount_total: 9000, deal_stage_histories: hist(['c-real', '2026-09-14'], ['c-vend', '2026-09-15']) }),
};
const listas = [];
const detalhes = [];
let lentasRestantes = 0;
const fetchReal = global.fetch;
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'crm.pronixhub.com.br') throw new Error('chamada externa inesperada: ' + u.href);
  const p = u.pathname.replace('/api/v1', '');
  const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (p === '/deal_pipelines') return ok(FUNIS);
  if (p === '/users') return ok({ users: [CAUA, SAMUEL, PH, DANIEL, AMARILDO] });
  if (p === '/deals') {
    listas.push(Object.fromEntries(u.searchParams));
    // o CRM demora demais nesta lista (o tempo de espera estoura) — uma vez
    if (lentasRestantes > 0 && u.searchParams.get('deal_pipeline_id') === 'f-clo') {
      lentasRestantes--;
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    if (u.searchParams.get('sdr_id') !== 'u-caua' || u.searchParams.get('deal_pipeline_id') !== 'f-clo') return ok({ deals: [] });
    return ok({ deals: Object.values(CARDS).map(({ deal_stage_histories, ...lista }) => lista) });
  }
  const m = p.match(/^\/deals\/([^/]+)$/);
  if (m && CARDS[m[1]]) { detalhes.push(m[1]); return ok(CARDS[m[1]]); }
  return ok({ codigo: 'NAO_ENCONTRADO', mensagem: 'não existe' }, 404);
};
test.after(() => { global.fetch = fetchReal; fs.rmSync(DADOS, { recursive: true, force: true }); });

test('por closer, no mês: reuniões realizadas, vendas, ticket médio, conversão e no-show — o melhor primeiro', async () => {
  const r = await painelClosers.painel({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-09', atualizar: true });
  assert.deepEqual([r.mes, r.inicio, r.fim, r.sdr], ['2026-09', '2026-09-01', '2026-09-30', 'Cauã Lima']);
  assert.ok(listas.every((q) => q.sdr_id === 'u-caua' && q.start_date === '2026-09-01T00:00:00-03:00'), 'só os cards do SDR que mexeram no mês');
  assert.ok(!detalhes.includes('e1'), 'card ainda com o SDR nem tem o detalhe lido');
  const linha = (c) => [c.closer, c.reunioes, c.vendas, c.faturamento, c.ticketMedio, c.conversao, c.noShow];
  assert.deepEqual(r.closers.map(linha), [
    ['Daniel Camargo', 3, 2, 12000, 6000, 66.7, 1],
    ['Paulo Henrique Pagoti', 2, 1, 5000, 5000, 50, 0],
  ]);
  assert.deepEqual([r.total.reunioes, r.total.vendas, r.total.faturamento, r.total.ticketMedio, r.total.conversao, r.total.noShow], [5, 3, 17000, 5667, 60, 1]);
  assert.equal(r.diagnostico.aindaNaoAconteceu, 1, 'reunião ainda marcada não conta');
  assert.equal(r.diagnostico.foraDoMes, 1, 'reunião de agosto fica de fora');
  assert.equal(r.diagnostico.deOutroSdr, 1, 'card com outro SDR no campo não entra');
  const daniel = r.closers[0];
  assert.deepEqual(daniel.leads.map((l) => [l.id, l.estado]), [['n1', 'no_show'], ['d3', 'venda'], ['d2', 'venda'], ['d1', 'nao_comprou']]);
  assert.deepEqual(r.sdrsDisponiveis.slice(0, 2), ['Cauã Lima', 'Ágatha Vielmi']);
});

test('guardado por 20 min; mês que não começou é recusado; conta de conversão sem reunião não divide por zero', async () => {
  const antes = detalhes.length;
  const r = await painelClosers.painel({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-09' });
  assert.equal(r.cache, true);
  assert.equal(detalhes.length, antes, 'não leu o CRM de novo');
  await assert.rejects(painelClosers.painel({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2099-01' }), /ainda não começou/);
  const { closers } = painelClosers.porCloser([{ closer: 'Zé', contaReuniao: false, noShow: true, contaVenda: false, valor: 0, dia: '2026-09-01' }]);
  assert.deepEqual([closers[0].conversao, closers[0].ticketMedio, closers[0].noShow], [0, 0, 1]);
});

test('CRM lento numa lista: a aba não quebra — a lista fica para a próxima rodada, que completa os números', async () => {
  lentasRestantes = 1;
  // agosto: a lista deste mês ainda não foi lida (a de setembro ficou guardada pelo teste de cima)
  const r = await painelClosers.painel({ usuario: { id: 'eu2', nome: 'Cauã Lima' }, mes: '2026-08', atualizar: true });
  assert.equal(r.diagnostico.listasPendentes, 1);
  assert.match(r.diagnostico.erroLista, /demorou/);
  assert.ok(r.diagnostico.pendentesDoCrm >= 1, 'a tela continua sozinha');
  assert.equal(r.total.reunioes, 0, 'nada lido ainda desta lista');
  const depois = await painelClosers.painel({ usuario: { id: 'eu2', nome: 'Cauã Lima' }, mes: '2026-08', atualizar: true });
  assert.equal(depois.diagnostico.pendentesDoCrm, 0);
  assert.deepEqual([depois.total.reunioes, depois.closers.map((c) => c.closer)], [1, ['Daniel Camargo']], 'a rodada seguinte completa (em agosto, só a reunião do card de agosto)');
});

test('SDR que não existe no CRM: avisa (em vez de mostrar tudo zerado sem dizer por quê)', async () => {
  const r = await painelClosers.painel({ usuario: { id: 'eu3', nome: 'Fulano Sem Cadastro' }, mes: '2026-09', atualizar: true });
  assert.deepEqual(r.diagnostico.sdrsSemCrm, ['Fulano Sem Cadastro']);
  assert.equal(r.total.reunioes, 0);
});

test('só o CRM, nas duas abas: a venda que só está no report NÃO entra — Meus closers e Match dão o mesmo número do CRM', async () => {
  const stats = require('../src/stats');
  const match = require('../src/matchCloser');
  const usuario = { id: 'eu4', nome: 'Cauã Lima' };
  // report do Cauã: venda com o PH que o CRM não traz (o card dele não tem o SDR no campo)
  await stats.importar({ origem: 'rd', id: 'rp1', quando: '2026-09-18T15:00:00.000Z', usuarioId: 'eu4', usuarioNome: 'Cauã Lima', lead: 'Lead Só no Report', contato: 'Lead Só no Report', closerNome: 'Paulo Henrique', resultado: 'venda_call', ticket: 29892, dataReuniao: '2026-09-18', dataFechamento: '2026-09-18' });
  // e um report de um lead que o CRM já trouxe: não conta duas vezes
  await stats.importar({ origem: 'rd', id: 'rp2', quando: '2026-09-10T15:00:00.000Z', usuarioId: 'eu4', usuarioNome: 'Cauã Lima', lead: 'PRXC | Lead p1', contato: 'Lead p1', closerNome: 'Paulo Henrique', resultado: 'venda_call', ticket: 5000, dataReuniao: '2026-09-10', rdDealId: 'p1' });
  const r = await painelClosers.painel({ usuario, mes: '2026-09', atualizar: true });
  const ph = r.closers.find((c) => c.closer === 'Paulo Henrique Pagoti');
  assert.deepEqual([ph.reunioes, ph.vendas, ph.faturamento], [2, 1, 5000], 'só o que o CRM tem (como a coluna "Vendido" do CRM)');
  assert.ok(!ph.leads.some((l) => /report/i.test(String(l.id))), 'nada de report na lista');
  // o Match do PH, no mesmo mês, dá o mesmo (também só o CRM)
  const m = await match.levantar({ usuario, closer: 'Paulo Henrique', desde: '2026-09-01', atualizar: true });
  const deSetembro = m.reunioes.filter((x) => x.minha);
  const reunioes = deSetembro.filter((x) => x.contaReuniao && x.dataReuniao.startsWith('2026-09')).length;
  const vendas = deSetembro.filter((x) => x.diaVenda && x.diaVenda.startsWith('2026-09'));
  assert.deepEqual([reunioes, vendas.length, vendas.reduce((s, x) => s + x.ticket, 0)], [ph.reunioes, ph.vendas, ph.faturamento], 'Match e Meus closers batem');
});

test('só quem está na aba Closers é closer: dono de card que não está lá (SDR, gestor) sai da tabela e é listado à parte', async () => {
  const closers = require('../src/closers');
  await closers.criar('Paulo Henrique', 'ph@x.test');
  await closers.criar('Daniel Camargo', '');
  // venda num card cujo dono não é closer (uma SDR), em junho
  CARDS.m1 = card('m1', 'c-vend', { id: 'u-mc', name: 'Maria Clara Soares Zanco' }, { win: true, closed_at: '2026-06-12T18:00:00.000Z', amount_total: 1609, deal_stage_histories: hist(['c-real', '2026-06-10'], ['c-vend', '2026-06-12']) });
  CARDS.p6 = card('p6', 'c-vend', PH, { win: true, closed_at: '2026-06-15T18:00:00.000Z', amount_total: 7000, deal_stage_histories: hist(['c-real', '2026-06-14'], ['c-vend', '2026-06-15']) });
  const r = await painelClosers.painel({ usuario: { id: 'eu5', nome: 'Cauã Lima' }, mes: '2026-06', atualizar: true });
  assert.deepEqual(r.closers.map((c) => c.closer), ['Paulo Henrique Pagoti']);
  assert.deepEqual(r.diagnostico.naoCloser, ['Maria Clara Soares Zanco'], 'os closers do time já vêm na lista; ela não é closer');
  assert.deepEqual([r.diagnostico.foraDaTabela.vendas, r.diagnostico.foraDaTabela.faturamento], [1, 1609], 'o que ela soma aparece à parte');
  assert.deepEqual([r.total.vendas, r.total.faturamento], [1, 7000], 'a venda dela não entra no total');
  delete CARDS.m1;
  delete CARDS.p6;
});

test('Closers do time: o SDR escolhido (Samuel) — os cards dele, não os seus', async () => {
  const r = await painelClosers.painel({ usuario: { id: 'eu6', nome: 'Cauã Lima' }, sdr: 'Samuel Filipe', mes: '2026-09', atualizar: true });
  assert.equal(r.sdr, 'Samuel Filipe');
  assert.ok(listas.some((q) => q.sdr_id === 'u-sam'), 'a lista do CRM é a do Samuel');
});
