'use strict';
// Match com o closer no Pronix CRM SIMULADO (leads inventados): desde junho, em todo funil que tem etapa de reunião
// realizada (pela CATEGORIA da etapa, não pelo nome), com o SDR da coluna "sdr" do card.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-match-pronix-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;
delete process.env.MATCH_DESDE;
delete process.env.MATCH_SDRS_TIME;

const match = require('../src/matchCloser');

const etapa = (id, name, order, categoria) => ({ id, _id: id, name, order, categoria, eh_perdido: categoria === 'perda', eh_ganho: categoria === 'venda', exige_closer: false });
const FUNIS = [
  { id: 'f-mql', _id: 'f-mql', name: 'Funil MQL', deal_stages: [etapa('m-resp', 'Respondeu', 1, 'resposta'), etapa('m-qual', 'Qualificado', 2, null), etapa('m-perda', 'Perdido', 3, 'perda')] },
  {
    id: 'f-smql', _id: 'f-smql', name: 'SMQLs Automaticos',
    deal_stages: [etapa('s-resp', 'Respondeu', 1, 'resposta'), etapa('s-agendou', 'Agendou', 2, 'reuniao_agendada'), etapa('s-call', 'Call feita', 3, 'reuniao_realizada'), etapa('s-fup', 'Retomar contato', 4, 'fup'), etapa('s-perda', 'Perdido', 5, 'perda')],
  },
  {
    id: 'f-clo', _id: 'f-clo', name: 'Closers',
    deal_stages: [etapa('c-agend', 'Reunião Agendada', 1, 'reuniao_agendada'), etapa('c-real', 'Reunião Realizada', 2, 'reuniao_realizada'), etapa('c-vend', 'Vendido', 3, 'venda'), etapa('c-perda', 'Perdido', 4, 'perda')],
  },
];
const nomeDe = (id) => FUNIS.flatMap((f) => f.deal_stages).find((e) => e.id === id).name;
const hist = (...pares) => pares.map(([id, dia]) => ({ deal_stage_id: id, deal_stage_name: nomeDe(id), start_date: `${dia}T15:00:00.000Z`, end_date: null }));
const PH = { id: 'u-ph', name: 'Paulo Henrique Pagoti' };
const SDR = { id: 'u-caua', name: 'Cauã Lima' };
const card = (id, funil, stageId, extra = {}) => ({
  id, _id: id, name: `PRXC | Lead ${id}`, win: null, closed_at: null, created_at: '2026-06-02T12:00:00.000Z', updated_at: '2026-09-20T12:00:00.000Z',
  deal_pipeline: { id: funil, name: FUNIS.find((f) => f.id === funil).name }, deal_stage: { id: stageId, name: nomeDe(stageId) },
  user: PH, sdr: SDR, deal_custom_fields: [], deal_products: [], amount_total: 0, ...extra,
});
const CARDS = {
  // reunião feita no próprio funil SMQLs (etapa "Call feita" = categoria reunião realizada), sem o campo personalizado SDR
  s1: card('s1', 'f-smql', 's-fup', { deal_stage_histories: hist(['s-resp', '2026-06-03'], ['s-agendou', '2026-06-04'], ['s-call', '2026-06-05'], ['s-fup', '2026-06-06']) }),
  // perdido depois de agendar, sem nunca passar pela reunião: não é reunião (no-show)
  s2: card('s2', 'f-smql', 's-perda', { win: false, closed_at: '2026-07-02T12:00:00.000Z', deal_lost_reason: { name: 'Parou de responder' }, deal_stage_histories: hist(['s-resp', '2026-06-20'], ['s-agendou', '2026-06-22'], ['s-perda', '2026-07-02']) }),
  // venda no funil Closers
  c1: card('c1', 'f-clo', 'c-vend', { win: true, closed_at: '2026-06-15T18:00:00.000Z', amount_total: 5000, deal_stage_histories: hist(['c-agend', '2026-06-08'], ['c-real', '2026-06-10'], ['c-vend', '2026-06-15']) }),
  // ainda agendado
  c2: card('c2', 'f-clo', 'c-agend', { deal_stage_histories: hist(['c-agend', '2026-09-18']) }),
  // de outro closer: nem tem o detalhe lido
  c3: card('c3', 'f-clo', 'c-real', { user: { id: 'u-x', name: 'Outra Pessoa' } }),
};
const listas = [];
const fetchReal = global.fetch;
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'crm.pronixhub.com.br') throw new Error('chamada externa inesperada: ' + u.href);
  const p = u.pathname.replace('/api/v1', '');
  const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (p === '/deal_pipelines') return ok(FUNIS);
  if (p === '/users') return ok({ users: [SDR, PH, { id: 'u-x', name: 'Outra Pessoa' }] });
  if (p === '/deals') {
    listas.push(Object.fromEntries(u.searchParams));
    const f = u.searchParams.get('deal_pipeline_id');
    if (u.searchParams.get('sdr_id') !== 'u-caua') return ok({ deals: [] });
    return ok({ deals: Object.values(CARDS).filter((c) => c.deal_pipeline.id === f).map(({ deal_stage_histories, ...lista }) => lista) });
  }
  const m = p.match(/^\/deals\/([^/]+)(\/activities)?$/);
  if (m && m[2]) return ok({ activities: [] });
  if (m && CARDS[m[1]]) return ok(CARDS[m[1]]);
  return ok({ codigo: 'NAO_ENCONTRADO', mensagem: 'não existe' }, 404);
};
test.after(() => { global.fetch = fetchReal; fs.rmSync(DADOS, { recursive: true, force: true }); });

test('Match no Pronix CRM: desde junho, nos funis com reunião realizada (pela categoria), com o SDR da coluna do card', async () => {
  const r = await match.levantar({ usuario: { id: 'eu', nome: 'Cauã Lima' }, closer: 'Paulo Henrique', atualizar: true });
  assert.equal(r.desde, '2026-06-01', 'o padrão é junho');
  assert.ok(listas.every((q) => q.start_date === '2026-06-01T00:00:00-03:00'));
  // só os funis que têm etapa de reunião realizada: o MQL (sem ela) nem é listado
  assert.deepEqual([...new Set(listas.map((q) => q.deal_pipeline_id))].sort(), ['f-clo', 'f-smql']);
  assert.deepEqual(r.diagnostico.funis.sort(), ['Closers', 'SMQLs Automaticos']);

  const porId = Object.fromEntries(r.reunioes.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(porId).sort(), ['c1', 's1']);
  assert.equal(porId.s1.estado, 'fup', '"Call feita" é reunião realizada pela categoria');
  assert.equal(porId.s1.dataReuniao, '2026-06-05');
  assert.equal(porId.s1.origemData, 'historico');
  assert.equal(porId.s1.minha, true, 'o SDR veio da coluna do card');
  assert.equal(porId.c1.estado, 'venda');
  assert.equal(porId.c1.dataReuniao, '2026-06-10');
  assert.equal(porId.c1.ticket, 5000);
  assert.equal(r.diagnostico.noShow, 1, 'perdido sem passar pela reunião não é reunião');
  assert.equal(r.diagnostico.aindaNaoAconteceu, 1);
  assert.equal(r.diagnostico.deOutroCloser, 0, 'card de outro closer nem é lido');
  const junho = r.meses.find((m) => m.mes === '2026-06');
  assert.ok(junho, 'junho aparece no mês a mês');
});
