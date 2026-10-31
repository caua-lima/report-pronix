'use strict';
// Lista para recontato: leads do mês em "Respondeu" — Aplicação Direta (todos) e SMQLs Automáticos (só os do SDR).
// Pronix CRM simulado; leads inventados.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-respondeu-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;

const respondeu = require('../src/leadsRespondeu');

const etapa = (id, name, order, categoria) => ({ id, _id: id, name, order, categoria });
const FUNIS = [
  { id: 'f-ap', _id: 'f-ap', name: 'Aplicação Direta', deal_stages: [etapa('a-cont', 'Contato iniciado', 1, 'contato'), etapa('a-resp', 'Respondeu', 2, 'resposta')] },
  { id: 'f-sm', _id: 'f-sm', name: 'SMQLs Automaticos', deal_stages: [etapa('s-cont', 'Contato iniciado', 1, 'contato'), etapa('s-resp', 'Respondeu', 2, 'resposta')] },
  { id: 'f-ss', _id: 'f-ss', name: 'IA Social Selling', deal_stages: [etapa('i-novo', 'Novo', 0, 'contato'), etapa('i-cont', 'Contato iniciado', 1, 'contato'), etapa('i-resp', 'Respondeu', 2, 'resposta')] },
  { id: 'f-rc', _id: 'f-rc', name: 'Funil de Recuperação', deal_stages: [etapa('r-cont', 'Contato iniciado', 1, 'contato'), etapa('r-resp', 'Respondeu', 2, 'resposta')] },
  { id: 'f-mq', _id: 'f-mq', name: 'Funil MQL', deal_stages: [etapa('m-cont', 'Contato iniciado', 1, 'contato'), etapa('m-resp', 'Respondeu', 2, 'resposta')] },
];
const deal = (id, funil, stage, extra = {}) => ({ id, _id: id, name: 'PRXC | Lead ' + id, win: null, closed_at: null, created_at: '2026-10-05T15:00:00.000Z', deal_pipeline: { id: funil }, deal_stage: { id: stage, name: stage.endsWith('resp') ? 'Respondeu' : stage.endsWith('novo') ? 'Novo' : 'Contato iniciado' }, contacts: [{ id: 'k-' + id, name: 'Lead ' + id.toUpperCase() }], ...extra });
const DEALS = [
  deal('a1', 'f-ap', 'a-resp', { created_at: '2026-10-20T15:00:00.000Z' }),
  deal('a2', 'f-ap', 'a-resp'),
  deal('a3', 'f-ap', 'a-resp', { created_at: '2026-09-28T15:00:00.000Z' }), // setembro: fora
  deal('a4', 'f-ap', 'a-cont'), // outra etapa: fora
  deal('a5', 'f-ap', 'a-resp', { win: false, closed_at: '2026-10-25T10:00:00.000Z' }), // perdido: fora
  deal('s1', 'f-sm', 's-resp', { sdr: 'u-caua' }),
  deal('s2', 'f-sm', 's-resp', { sdr: 'u-outro' }), // de outro SDR: a lista do CRM nem traz
  deal('i1', 'f-ss', 'i-cont', { sdr: 'u-nicoly' }),
  deal('i2', 'f-ss', 'i-resp', { sdr: 'u-nicoly' }),
  deal('i3', 'f-ss', 'i-novo', { sdr: 'u-nicoly' }), // outra etapa: fora
  deal('i4', 'f-ss', 'i-resp', { sdr: 'u-outro' }), // de outra SDR: fora
  deal('m1', 'f-mq', 'm-resp', { sdr: 'u-luiza' }),
  deal('m2', 'f-mq', 'm-cont', { sdr: 'u-luiza' }),
  deal('r1', 'f-rc', 'r-resp', { sdr: 'u-reinaldo' }),
  deal('s3', 'f-sm', 's-resp', { sdr: 'u-luiza' }), // outro funil: fora para a Luiza
];
const TELEFONES = { 'k-a1': '5511987654321', 'k-a2': '(21) 99876-5432', 'k-s1': '11 91234-0000' };
const fetchReal = global.fetch;
global.fetch = async (url) => {
  const u = new URL(String(url));
  const p = u.pathname.replace('/api/v1', '');
  const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (p === '/deal_pipelines') return ok(FUNIS);
  if (p === '/users') return ok({ users: [{ id: 'u-caua', name: 'Cauã Lima' }, { id: 'u-outro', name: 'Outra SDR' }, { id: 'u-nicoly', name: 'Nicoly Beatriz' }, { id: 'u-luiza', name: 'Luiza Lemes' }, { id: 'u-reinaldo', name: 'Reinaldo Junior' }] });
  if (p === '/deals') {
    const f = u.searchParams.get('deal_pipeline_id');
    const sdr = u.searchParams.get('sdr_id');
    return ok({ deals: DEALS.filter((d) => d.deal_pipeline.id === f && (!sdr || d.sdr === sdr)) });
  }
  const m = p.match(/^\/contacts\/(.+)$/);
  if (m) return ok({ id: m[1], phones: TELEFONES[m[1]] ? [{ phone: TELEFONES[m[1]] }] : [] });
  return ok({}, 404);
};
test.after(() => { global.fetch = fetchReal; fs.rmSync(DADOS, { recursive: true, force: true }); });

test('Respondeu de outubro: Aplicação Direta (todos) e SMQLs (só os seus) — nome, telefone e inscrição', async () => {
  const r = await respondeu.gerar({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-10' });
  assert.deepEqual(r.avisos, []);
  assert.equal(r.pendentes, 0);
  assert.equal(r.texto, [
    'Lead A2 - (21) 99876-5432 - inscrito em 05/10/2026',
    'Lead A1 - (11) 98765-4321 - inscrito em 20/10/2026',
    'Lead S1 - (11) 91234-0000 - inscrito em 05/10/2026',
  ].join('\r\n') + '\r\n');
  assert.deepEqual(r.linhas.map((l) => l.funil), ['Aplicação Direta', 'Aplicação Direta', 'SMQLs Automáticos']);
});

test('CSV do WhatsApp: Nome,Telefone com +55, sem a data', async () => {
  const r = await respondeu.gerar({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-10' });
  assert.equal(r.csv, '﻿Nome,Telefone\r\n"Lead A2","+5521998765432"\r\n"Lead A1","+5511987654321"\r\n"Lead S1","+5511912340000"\r\n');
});

test('outro SDR: só os cards dele, nos dois funis', async () => {
  DEALS.push(deal('a6', 'f-ap', 'a-resp', { sdr: 'u-outro' }));
  try {
    const r = await respondeu.gerar({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-10', sdr: 'Outra SDR' });
    assert.equal(r.sdr, 'Outra SDR');
    assert.deepEqual(r.linhas.map((l) => [l.funil, l.nome]), [['Aplicação Direta', 'Lead A6'], ['SMQLs Automáticos', 'Lead S2']]);
  } finally {
    DEALS.pop();
  }
});

test('cada SDR no funil dele: Nicoly na IA Social Selling (Contato iniciado e Respondeu), Luiza no Funil MQL', async () => {
  const n = await respondeu.gerar({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-10', sdr: 'Nicoly Beatriz' });
  assert.deepEqual(n.avisos, []);
  assert.deepEqual(n.linhas.map((l) => [l.funil, l.nome]), [['IA Social Selling · Contato iniciado', 'Lead I1'], ['IA Social Selling · Respondeu', 'Lead I2']]);
  const l = await respondeu.gerar({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-10', sdr: 'Luiza Lemes' });
  assert.deepEqual(l.linhas.map((x) => [x.funil, x.nome]), [['Funil MQL · Contato iniciado', 'Lead M2'], ['Funil MQL · Respondeu', 'Lead M1']]);
  const r = await respondeu.gerar({ usuario: { id: 'eu', nome: 'Cauã Lima' }, mes: '2026-10', sdr: 'Reinaldo Junior' });
  assert.deepEqual(r.linhas.map((x) => [x.funil, x.nome]), [['Funil de Recuperação · Respondeu', 'Lead R1']]);
});

test('telefone em qualquer formato vira (DD) 9XXXX-XXXX', () => {
  assert.equal(respondeu.telefoneBonito('+55 (47) 99900-6343'), '(47) 99900-6343');
  assert.equal(respondeu.telefoneBonito('4733221100'), '(47) 3322-1100');
});
