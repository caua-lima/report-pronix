'use strict';
// Aba "Match com PH": reuniões realizadas, vendas, conversão e faturamento por mês do closer com o SDR, meta e
// plano do mês. RD SIMULADO, banco em pasta temporária, leads inventados.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-match-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'tok-rd', TZ_RELATORIO: 'America/Sao_Paulo',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.MATCH_DESDE;
delete process.env.MATCH_CLOSER;

const app = require('../server');
const crm = require('../src/crm');
const stats = require('../src/stats');
const match = require('../src/matchCloser');

const PH = { _id: 'u-ph', name: 'Paulo Henrique Pagoti' };
const OUTRO = { _id: 'u-vi', name: 'Vitor Augusto' };
const campos = (sdr, extra = []) => (sdr ? [{ value: sdr, custom_field: { label: 'SDR' } }] : []).concat(extra);
const card = (id, extra = {}) => ({
  _id: id, name: 'PRXC | Lead ' + id, win: null, closed_at: null, user: PH, amount_total: 0, deal_custom_fields: campos('Cauã'),
  deal_stage: { name: 'Reunião Realizada' }, created_at: '2026-07-10T15:00:00.000Z', contacts: [{ _id: 'c-' + id, name: 'Lead ' + id }], ...extra,
});
const CARDS = [
  card('c1', { win: true, closed_at: '2026-07-15T18:00:00.000Z', amount_total: 18000, deal_stage: { name: 'Vendido' }, deal_products: [{ name: 'Pronix Performance' }] }),
  card('c2', { win: false, closed_at: '2026-07-22T18:00:00.000Z', created_at: '2026-07-20T15:00:00.000Z', deal_stage: { name: 'Não compraram' }, deal_lost_reason: { name: 'Sem dinheiro agora' } }),
  card('c3', { win: false, closed_at: '2026-07-25T18:00:00.000Z', deal_lost_reason: { name: 'No-show' } }),
  card('c4', { deal_stage: { name: 'Reunião agendada' }, created_at: '2026-10-18T15:00:00.000Z' }),
  card('c5', { deal_stage: { name: 'Fluxo de FUP' }, created_at: '2026-07-30T15:00:00.000Z', deal_custom_fields: campos('Cauã', [{ value: '05/08/2026', custom_field: { label: 'Data da reunião' } }]) }),
  card('c6', { win: true, closed_at: '2026-10-08T18:00:00.000Z', created_at: '2026-05-10T15:00:00.000Z', amount_total: 20000 }),
  card('c7', { deal_custom_fields: campos('Samuel Filipe') }),
  card('c8', { deal_custom_fields: [] }),
  card('c9', { user: OUTRO }),
  card('c10', { created_at: '2026-10-14T15:00:00.000Z' }),
];
const consultas = [];
crm.configurado = () => true;
crm.usuariosRd = async () => [{ id: 'u-ph', nome: 'Paulo Henrique Pagoti' }, { id: 'u-vi', nome: 'Vitor Augusto' }];
crm.rd = async (caminho, params = {}) => {
  if (caminho !== '/deals') throw new Error('chamada ao RD não prevista no teste: ' + caminho);
  consultas.push(params);
  return { deals: JSON.parse(JSON.stringify(CARDS)), has_more: false };
};

let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ nome, papel }),
  })).json()).usuario;
  E.caua = await criar('Cauã Lima', 'master');
  E.sdr = await criar('Outra SDR', 'sdr');
  // Venda que só existe no report (card sem o campo SDR no RD) e um report do mesmo lead de um card (não duplica).
  await stats.importar({ origem: 'rd', id: 'x1', quando: '2026-09-10T15:00:00.000Z', usuarioId: E.caua.id, usuarioNome: 'Cauã Lima', lead: 'Lead Só no Report', contato: 'Lead Só no Report', closerNome: 'Paulo Henrique', resultado: 'venda_fup', ticket: 9000, dataReuniao: '2026-09-10', dataFechamento: '2026-09-12' });
  await stats.importar({ origem: 'rd', id: 'x2', quando: '2026-07-10T15:00:00.000Z', usuarioId: E.caua.id, usuarioNome: 'Cauã Lima', lead: 'Lead c1', contato: 'Lead c1', closerNome: 'Paulo Henrique', resultado: 'venda_call', ticket: 18000, dataReuniao: '2026-07-10' });
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  fs.rmSync(DADOS, { recursive: true, force: true });
});
const api = async (metodo, rota, chave, corpo) => {
  const r = await fetch(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', 'x-cr-key': chave }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test('reuniões realizadas e vendas do PH com o Cauã de SDR, mês a mês desde julho; no-show, agendada, outro SDR e outro closer ficam de fora', async () => {
  const r = await match.levantar({ usuario: { id: E.caua.id, nome: 'Cauã Lima' }, closer: 'Paulo Henrique', desde: '2026-07-01', atualizar: true });
  const meses = Object.fromEntries(r.meses.map((m) => [m.mes, m]));
  assert.ok(r.meses[0].mes === '2026-07' && meses['2026-10'], 'de julho até o mês atual, um por um');
  assert.deepEqual([meses['2026-07'].reunioes, meses['2026-07'].vendas, meses['2026-07'].faturamento], [2, 1, 18000]);
  assert.equal(meses['2026-07'].conversao, 0.5);
  assert.deepEqual([meses['2026-08'].reunioes, meses['2026-08'].vendas], [1, 0], 'a data da reunião veio do campo do card (05/08), não da criação (30/07)');
  assert.deepEqual([meses['2026-09'].reunioes, meses['2026-09'].vendas, meses['2026-09'].faturamento], [1, 1, 9000], 'a venda que só está no report entra');
  assert.deepEqual([meses['2026-10'].reunioes, meses['2026-10'].vendas, meses['2026-10'].faturamento], [1, 1, 20000], 'venda de outubro de card antigo conta no mês da venda');

  const d = r.diagnostico;
  assert.deepEqual([d.noShow, d.aindaNaoAconteceu, d.deOutroSdr, d.semSdr, d.deOutroCloser, d.doReport], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(d.etapasSemReuniao, { 'Reunião agendada': 1 });
  assert.equal(d.dataPeloCampo, 1);
  assert.equal(r.reunioes.filter((x) => x.lead === 'Lead c1').length, 1, 'report do mesmo lead de um card não conta duas vezes');
  const c5 = r.reunioes.find((x) => x.id === 'c5');
  assert.deepEqual([c5.dataReuniao, c5.origemData, c5.estado], ['2026-08-05', 'campo', 'fup']);
  assert.equal(r.reunioes.find((x) => x.id === 'c1').produto, 'performance');
  // O RD recebe o closer: todos os cards dele (do mais novo ao mais antigo) e as vendas do período.
  assert.deepEqual([consultas[0].user_id, consultas[0].order, consultas[0].direction], ['u-ph', 'created_at', 'desc']);
  assert.deepEqual([consultas[1].win, consultas[1].start_date, consultas[1].user_id], ['true', '2026-07-01', 'u-ph']);
});

test('plano do mês: quanto falta para cada meta, por dia útil, quantas vendas e reuniões isso pede e a projeção no ritmo', () => {
  const historico = [
    { mes: '2026-07', reunioes: 2, vendas: 1, faturamento: 18000 }, { mes: '2026-08', reunioes: 1, vendas: 0, faturamento: 0 },
    { mes: '2026-09', reunioes: 1, vendas: 1, faturamento: 9000 }, { mes: '2026-10', reunioes: 1, vendas: 1, faturamento: 20000 },
  ];
  const p = match.plano({ mes: '2026-10', hoje: '2026-10-20', meta: { meta1: 100000, meta2: 150000 }, feito: { reunioes: 1, vendas: 1, faturamento: 20000 }, historico });
  assert.deepEqual([p.diasUteis, p.diasPassados, p.diasRestantes, p.ultimoSabado], [23, 14, 10, '2026-10-31'], 'out/2026: 22 dias de semana + o último sábado (31); do dia 20 ao 31 faltam 10 (hoje incluído)');
  assert.deepEqual([p.conversao, p.conversaoHistorica, p.conversaoAlvo, p.conversaoMes], [0.6, 0.6, 0, 1]);
  assert.equal(Math.round(p.ticketMedio), 15667);
  const [m1, m2] = p.metas;
  assert.deepEqual([m1.falta, m1.porDia, m1.vendas, m1.reunioes], [80000, 8000, 6, 10]);
  assert.equal(Math.round(m1.esperadoHoje), 60870, 'meta diária acumulada: onde deveria estar hoje');
  assert.equal(m2.falta, 130000);
  assert.equal(Math.round(p.projecao), 32857);
  // com a conversão alvo, as reuniões que faltam saem dela (e não da conversão do período)
  const comAlvo = match.plano({ mes: '2026-10', hoje: '2026-10-20', meta: { meta1: 100000, conversaoAlvo: 25 }, feito: { reunioes: 4, vendas: 1, faturamento: 20000 }, historico });
  assert.deepEqual([comAlvo.conversao, comAlvo.conversaoAlvo, comAlvo.metas[0].reunioes, comAlvo.vendasEsperadas], [0.25, 0.25, 24, 1]);
  // só o último sábado conta: nov/2026 tem 21 dias de semana + o sábado 28
  assert.equal(match.ultimoSabado('2026-11'), '2026-11-28');
  assert.deepEqual(match.diasUteis('2026-11', '2026-11-27'), { total: 22, passados: 19, restantes: 3 }, 'faltam a sexta 27, o sábado 28 e a segunda 30');
  assert.deepEqual(match.diasUteis('2026-11', '2026-11-21'), { total: 22, passados: 15, restantes: 7 }, 'o sábado 21 não conta');
  // mês que já passou: nada a fazer por dia
  assert.equal(match.plano({ mes: '2026-09', hoje: '2026-10-20', meta: { meta1: 50000 }, feito: { reunioes: 1, vendas: 1, faturamento: 9000 }, historico }).diasRestantes, 0);
});

test('rotas: só o master; a meta fica salva por mês e entra no plano; a segunda abertura vem do cache e "atualizar" relê o RD', async () => {
  assert.equal((await api('GET', '/api/master/match', E.sdr.chave)).status, 403);
  consultas.length = 0;
  let r = await api('GET', '/api/master/match?desde=2026-07-01', E.caua.chave);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.closer, 'Paulo Henrique');
  assert.ok(r.json.plano && r.json.mesmoPeriodo && r.json.meses.length >= 4);
  const lidas = consultas.length;

  const mes = r.json.ate.slice(0, 7);
  assert.equal((await api('PUT', '/api/master/match/meta', E.caua.chave, { mes: 'outubro', meta1: 1 })).status, 400);
  assert.equal((await api('PUT', '/api/master/match/meta', E.caua.chave, { mes, meta1: 1, conversaoAlvo: '150' })).status, 400);
  const s = await api('PUT', '/api/master/match/meta', E.caua.chave, { mes, desde: '2026-07-01', meta1: '100.000', meta2: 150000, conversaoAlvo: '25' });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.meta, { meta1: 100000, meta2: 150000, meta3: 0, conversaoAlvo: 25 });
  assert.deepEqual([s.json.plano.metas[0].alvo, s.json.plano.conversaoAlvo], [100000, 0.25], 'a resposta já traz o painel com a meta nova');
  // alterar a meta salva troca de verdade
  const s2 = await api('PUT', '/api/master/match/meta', E.caua.chave, { mes, desde: '2026-07-01', meta1: '120.000', meta2: '', conversaoAlvo: '30' });
  assert.deepEqual(s2.json.meta, { meta1: 120000, meta2: 0, meta3: 0, conversaoAlvo: 30 });
  assert.deepEqual(s2.json.plano.metas.map((m) => m.alvo), [120000]);
  await api('PUT', '/api/master/match/meta', E.caua.chave, { mes, meta1: '100.000', meta2: 150000, conversaoAlvo: '25' });

  r = await api('GET', '/api/master/match?desde=2026-07-01', E.caua.chave);
  assert.equal(consultas.length, lidas, 'abrir de novo não relê o RD');
  assert.equal(r.json.cache, true);
  assert.equal(r.json.plano.metas[0].alvo, 100000);
  assert.equal(r.json.plano.conversaoAlvo, 0.25);
  r = await api('GET', '/api/master/match?desde=2026-07-01&atualizar=1', E.caua.chave);
  assert.ok(consultas.length > lidas, '"Atualizar do RD" relê');
  assert.equal(r.json.cache, false);
});
