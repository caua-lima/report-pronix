'use strict';
// Handoffs das reuniões realizadas por closer (src/handoffsRealizadas.js), com o Pronix CRM SIMULADO e leads
// inventados. Só entra quem ENTROU na reunião realizada no período; o handoff vem do card ou, sem ele, do report.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hr-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste', TZ_RELATORIO: 'America/Sao_Paulo',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;

const hr = require('../src/handoffsRealizadas');
const fluxo = require('../src/fluxoReuniao');

const etapa = (id, name, order, categoria) => ({ id, _id: id, name, order, categoria, eh_perdido: categoria === 'perda', eh_ganho: categoria === 'venda' });
const FUNIS = [
  { id: 'f-mql', _id: 'f-mql', name: 'Funil MQL', deal_stages: [etapa('e-resp', 'Respondeu', 1, 'resposta'), etapa('e-agend', 'Reunião Agendada', 2, 'reuniao_agendada'), etapa('e-real', 'Reunião Realizada', 3, 'reuniao_realizada'), etapa('e-fup', 'FUP', 4, 'fup'), etapa('e-perda', 'Perdido', 5, 'perda')] },
  { id: 'f-clo', _id: 'f-clo', name: 'Closers', deal_stages: [etapa('c-agend', 'Reunião Agendada', 1, 'reuniao_agendada'), etapa('c-real', 'Reunião Realizada', 2, 'reuniao_realizada'), etapa('c-venda', 'Vendido', 3, 'venda')] },
];
const h = (id, quando) => ({ deal_stage_id: id, start_date: quando });
const card = (id, stage, funil, { closer = 'Paulo Henrique', historico = [], handoff = null, win = null, contato = 'Lead ' + id } = {}) => ({
  id, _id: id, name: `PRXC | ${contato}`, updated_at: '2026-11-10T12:00:00.000Z', win,
  deal_stage: { id: stage }, deal_pipeline: { id: funil }, user: { id: 'u-' + closer, name: closer }, sdr: { name: 'Cauã Lima' },
  contacts: [{ id: 'ct-' + id, name: contato }], deal_stage_histories: historico, handoff,
});
const CARDS = {
  // entrou na realizada em 03/11 (dentro), está no FUP, handoff no CRM
  a: card('a', 'e-fup', 'f-mql', { historico: [h('e-agend', '2026-11-01T12:00:00Z'), h('e-real', '2026-11-03T15:00:00Z'), h('e-fup', '2026-11-04T12:00:00Z')], handoff: { text: 'Handoff do lead A, escrito no CRM.' }, contato: 'Ana' }),
  // vendido pelo funil Closers, realizada em 05/11 por outro closer, sem handoff no CRM (vem do report guardado)
  b: card('b', 'c-venda', 'f-clo', { closer: 'Zoe Closer', win: true, historico: [h('c-agend', '2026-11-02T12:00:00Z'), h('c-real', '2026-11-05T13:00:00Z')], contato: 'Bruno' }),
  // realizada em 28/10: fora do período
  c: card('c', 'e-real', 'f-mql', { historico: [h('e-real', '2026-10-28T12:00:00Z')], handoff: { text: 'antigo' } }),
  // ainda na reunião agendada: nem é lido em detalhe
  d: card('d', 'e-agend', 'f-mql', { historico: [h('e-agend', '2026-11-05T12:00:00Z')] }),
  // perdido antes da reunião (etapa Perdido, sem passar pela realizada): lido, mas não entra
  e: card('e', 'e-perda', 'f-mql', { win: false, historico: [h('e-resp', '2026-11-02T12:00:00Z'), h('e-perda', '2026-11-06T12:00:00Z')] }),
};
const lidosEmDetalhe = [];
const fetchReal = global.fetch;
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'crm.pronixhub.com.br') throw new Error('chamada externa inesperada: ' + u.href);
  const p = u.pathname.replace('/api/v1', '');
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (p === '/deal_pipelines') return ok(FUNIS);
  if (p === '/deals') {
    const f = u.searchParams.get('deal_pipeline_id');
    return ok({ deals: Object.values(CARDS).filter((c) => c.deal_pipeline.id === f).map((c) => ({ id: c.id, _id: c.id, updated_at: c.updated_at, deal_stage: c.deal_stage, win: c.win, user: c.user })) });
  }
  const m = p.match(/^\/deals\/([^/]+)$/);
  if (m && CARDS[m[1]]) { lidosEmDetalhe.push(m[1]); return ok(CARDS[m[1]]); }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};
test.after(() => { global.fetch = fetchReal; });

test('só os cards que entraram na reunião realizada no período, por closer, com o handoff do CRM ou do report', async () => {
  await fluxo.guardarHandoff({ dados: { lead: 'Bruno', resumo: [{ rotulo: 'Investimento', valor: 'R$ 5 mil' }] }, sdr: 'Cauã Lima', reportId: 'r1', vinculo: { dealId: 'b' } });
  const r = await hr.levantar({ desde: '2026-11-01', ate: '2026-11-12' });
  assert.equal(r.pendentes, 0);
  assert.deepEqual(r.reunioes.map((x) => [x.closer, x.lead, x.dia, x.origem]), [
    ['Paulo Henrique', 'Ana', '2026-11-03', 'crm'],
    ['Zoe Closer', 'Bruno', '2026-11-05', 'report'],
  ]);
  assert.ok(!lidosEmDetalhe.includes('d'), 'card ainda antes da reunião não é lido em detalhe');
  assert.match(r.reunioes[1].handoff, /Investimento: R\$ 5 mil/);
  assert.equal(r.reunioes[1].situacao, 'Venda');

  const resumo = hr.resumo(r);
  assert.deepEqual(resumo.closers, [{ closer: 'Paulo Henrique', reunioes: 1, semHandoff: 0 }, { closer: 'Zoe Closer', reunioes: 1, semHandoff: 0 }]);
  assert.equal(resumo.total, 2);
  assert.equal(JSON.stringify(resumo).includes('Handoff do lead A'), false, 'o resumo da tela não leva o texto');

  const arq = hr.arquivosDoCloser(r, 'Paulo Henrique');
  assert.deepEqual(arq.map((a) => a.nome), ['03-11 - Ana.txt', '_indice.csv']);
  assert.match(arq[0].texto, /^Lead: Ana\nCard: PRXC \| Ana\nCloser: Paulo Henrique\nSDR: Cauã Lima\nReunião realizada em: 03\/11\/2026/);
  assert.match(arq[0].texto, /\n\nHANDOFF\nHandoff do lead A, escrito no CRM\./);
  assert.match(arq[1].texto, /Dia;Lead;SDR/);
});

test('período inválido é recusado', async () => {
  await assert.rejects(hr.levantar({ desde: '2026-11-12', ate: '2026-11-01' }), /Período inválido/);
  await assert.rejects(hr.levantar({ desde: 'ontem', ate: '2026-11-01' }), /Período inválido/);
});
