'use strict';
// Aviso no celular a cada lead novo no funil Pronix Club: o agendador chama a rota do segredo, o servidor guarda o
// lead (nome, telefone) no banco e manda UM push pelo ntfy SEM dado do lead. CRM e ntfy simulados; leads inventados.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pclub-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS,
  ADMIN_PASSWORD: 'senha-de-teste',
  RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;
delete process.env.NTFY_URL;

const app = require('../server');

const FUNIS = [
  { id: 'f-outro', name: 'Aplicação Direta', deal_stages: [{ id: 'o1', name: 'Novo', order: 1 }] },
  { id: 'f-club', name: 'PRONIX CLUB', deal_stages: [{ id: 'c1', name: 'Novo lead', order: 1 }] },
];
const DEALS = [];
const deal = (id, criado, contato) => ({ id, name: 'PRXC | ' + contato, created_at: criado, deal_pipeline: { id: 'f-club' }, deal_stage: { id: 'c1', name: 'Novo lead' }, contacts: [{ id: 'k-' + id, name: contato }] });
const TELEFONES = { 'k-n1': '5511987654321', 'k-n2': '(21) 99876-5432' };
const pushes = [];
const fetchReal = global.fetch;
const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return fetchReal(url, opts);
  if (u.startsWith('https://ntfy.sh')) { pushes.push(JSON.parse(opts.body)); return ok({ id: 'p' }); }
  const url2 = new URL(u);
  const p = url2.pathname.replace('/api/v1', '');
  if (p === '/deal_pipelines') return ok(FUNIS);
  if (p === '/deals') return ok({ deals: DEALS.filter((d) => d.deal_pipeline.id === url2.searchParams.get('deal_pipeline_id')) });
  const det = p.match(/^\/deals\/([^/]+)$/);
  if (det) return DEALS.find((d) => d.id === det[1]) ? ok(DEALS.find((d) => d.id === det[1])) : ok({}, 404);
  const m = p.match(/^\/contacts\/(.+)$/);
  if (m) return ok({ id: m[1], phones: TELEFONES[m[1]] ? [{ phone: TELEFONES[m[1]] }] : [] });
  return ok({}, 404);
};

let servidor;
let base;
const master = { 'Content-Type': 'application/json' };
const acao = async (a) => (await fetchReal(base + '/api/master/pronix-club/' + a, { method: 'POST', headers: master, body: '{}' })).json();

test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const r = await fetchReal(base + '/api/admin/usuarios', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ nome: 'Dono Master', papel: 'master' }) });
  master['x-cr-key'] = (await r.json()).usuario.chave;
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});

test('lead novo no Pronix Club: guarda nome e telefone, avisa uma vez e o push não leva dado do lead', async () => {
  DEALS.push(deal('velho', new Date(Date.now() - 3600e3).toISOString(), 'Lead Antigo')); // já estava antes de ligar
  const ligado = await acao('ativar');
  assert.equal(ligado.ativo, true);
  assert.match(ligado.topico, /^pronix-club-[0-9a-f]{18}$/);
  const segredo = ligado.urlVerificar.split('/').pop();

  // segredo errado: nada
  assert.equal((await fetchReal(base + '/api/pronix-club/verificar/errado')).status, 404);

  // colado com espaço e ponto no fim: ainda vale
  assert.equal((await fetchReal(base + '/api/pronix-club/verificar/' + segredo + '%20.')).status, 200);

  // nada novo ainda: sem push (o antigo não avisa)
  let r = await (await fetchReal(base + '/api/pronix-club/verificar/' + segredo)).json();
  assert.equal(r.avisados, 0);
  assert.equal(pushes.length, 0);

  const agora = new Date(Date.now() + 1000).toISOString();
  DEALS.push(deal('n1', agora, 'Lead Novo Um'), deal('n2', agora, 'Lead Novo Dois'));
  r = await (await fetchReal(base + '/api/pronix-club/verificar/' + segredo, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"evento":"deal_created"}' })).json();
  assert.equal(r.avisados, 2);
  assert.equal(pushes.length, 1, 'um push só para os dois');
  assert.equal(pushes[0].topic, ligado.topico);
  assert.equal(pushes[0].title, '2 leads novos no Pronix Club');
  assert.match(pushes[0].click, /\/#pronixclub$/);
  const corpo = JSON.stringify(pushes[0]);
  for (const proibido of ['Lead Novo', '98765', '99876', 'Antigo']) assert.ok(!corpo.includes(proibido), 'o push não leva ' + proibido);

  // lead MOVIDO de outro funil para o Pronix Club: criado há dias, entrou no funil agora (histórico de etapas) — avisa
  const antes = new Date(Date.now() - 5 * 24 * 3600e3).toISOString();
  const movido = { ...deal('m1', antes, 'Lead Movido'), updated_at: agora, deal_stage_histories: [{ deal_stage_id: 'o1', start_date: antes }, { deal_stage_id: 'c1', start_date: agora }] };
  // e um que já estava no funil e só mudou um campo agora: não avisa
  const parado = { ...deal('p1', antes, 'Lead Parado'), updated_at: agora, deal_stage_histories: [{ deal_stage_id: 'c1', start_date: antes }] };
  DEALS.push(movido, parado);
  r = await (await fetchReal(base + '/api/pronix-club/verificar/' + segredo)).json();
  assert.equal(r.avisados, 1);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].title, 'Novo lead no Pronix Club');

  // de novo: já avisados, sem push novo
  r = await (await fetchReal(base + '/api/pronix-club/verificar/' + segredo)).json();
  assert.equal(r.avisados, 0);
  assert.equal(pushes.length, 2);

  // a aba do dashboard tem os leads com telefone e o link do WhatsApp
  const painel = await (await fetchReal(base + '/api/master/pronix-club', { headers: master })).json();
  assert.deepEqual(painel.leads.map((l) => [l.nome, l.telefone, l.whatsapp]).sort(), [
    ['Lead Movido', '', ''],
    ['Lead Novo Dois', '(21) 99876-5432', '5521998765432'],
    ['Lead Novo Um', '(11) 98765-4321', '5511987654321'],
  ]);
  assert.equal(painel.status.ultimoErro, '');
});

test('teste manda push; desligado não confere; SDR não vê a aba', async () => {
  await acao('teste');
  assert.equal(pushes.at(-1).title, 'Teste: aviso do Pronix Club');
  const desligado = await acao('desativar');
  assert.equal(desligado.ativo, false);
  const segredo = desligado.urlVerificar.split('/').pop();
  const r = await (await fetchReal(base + '/api/pronix-club/verificar/' + segredo)).json();
  assert.equal(r.motivo, 'desligado');
  const semChave = await fetchReal(base + '/api/master/pronix-club');
  assert.ok(semChave.status === 401 || semChave.status === 403);
});
