'use strict';
// Trazer as vendas de um closer direto do RD: cards ganhos em que o SDR é o usuário. RD SIMULADO, banco em
// pasta temporária, leads inventados.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-vendas-do-rd-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'tok-rd',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;

const app = require('../server');
const crm = require('../src/crm');
const stats = require('../src/stats');
const closers = require('../src/closers');
const vendasDoRd = require('../src/vendasDoRd');

const dia = (d) => `2026-10-${String(d).padStart(2, '0')}T15:00:00.000Z`;
const PH = { _id: 'u-ph', name: 'Paulo Henrique Pagoti' };
const OUTRO = { _id: 'u-vi', name: 'Vitor Augusto' };
const sdr = (valor) => (valor ? [{ value: valor, custom_field: { label: 'SDR' } }] : []);
const card = (id, nome, extra = {}) => ({
  _id: id, name: 'PRXC | ' + nome, win: true, closed_at: dia(8), user: PH, amount_total: 18624, deal_custom_fields: sdr('Cauã'),
  deal_products: [{ name: 'Pronix Performance' }], contacts: [{ _id: 'c-' + id, name: nome, emails: [{ email: id + '@exemplo.com' }], phones: [{ phone: '+55 71 98888-0001' }] }], ...extra,
});
let cards = [];
let consultas = [];
crm.configurado = () => true;
crm.usuariosRd = async () => [{ id: 'u-ph', nome: 'Paulo Henrique Pagoti' }, { id: 'u-vi', nome: 'Vitor Augusto' }];
crm.rd = async (caminho, params = {}) => {
  if (caminho !== '/deals') throw new Error('chamada ao RD não prevista no teste: ' + caminho);
  consultas.push(params);
  return { deals: JSON.parse(JSON.stringify(cards)), has_more: false };
};
test.after(() => fs.rmSync(DADOS, { recursive: true, force: true }));
const CAUA = { id: 'u-caua', nome: 'Cauã Lima' };

test('vendas do PH em que o Cauã é o SDR: cria o report da venda com closer, ticket, produto e data; de outro SDR, sem SDR ou de outro closer ficam de fora', async () => {
  const ph = await closers.criar('Paulo Henrique');
  cards = [
    card('d1', 'Jorge Luiz Marins'),
    card('d2', 'Marina Souza', { closed_at: dia(10), amount_total: 9000, deal_products: [{ name: 'PRONIX Acelera' }] }),
    card('d3', 'Lead de Outro SDR', { deal_custom_fields: sdr('Samuel Filipe') }),
    card('d4', 'Lead Sem SDR', { deal_custom_fields: [] }),
    card('d5', 'Venda do Vitor', { user: OUTRO }),
    card('d6', 'Venda de Setembro', { closed_at: '2026-09-28T15:00:00.000Z' }),
    card('d7', 'Card Aberto', { win: null, closed_at: null }),
  ];
  const r = await vendasDoRd.trazer({ usuario: CAUA, desde: '2026-10-01', closer: 'Paulo Henrique' });
  assert.deepEqual(r, { vistos: 4, criados: 2, completados: 0, jaEstavam: 0, semSdr: 1, deOutroSdr: 1, paginas: 1, truncado: false });
  assert.deepEqual([consultas[0].win, consultas[0].user_id, consultas[0].start_date], ['true', 'u-ph', '2026-10-01'], 'o RD já recebe o closer e o período');

  const d1 = await stats.buscarPorId('rdd1');
  assert.deepEqual(
    [d1.usuarioId, d1.lead, d1.closerId, d1.closerNome, d1.resultado, d1.ticket, d1.produto, d1.dataFechamento, d1.origem, d1.rdDealId, d1.leadEmail, d1.dia],
    ['u-caua', 'Jorge Luiz Marins', ph.id, 'Paulo Henrique', 'venda_call', 18624, 'performance', '2026-10-08', 'rd', 'd1', 'd1@exemplo.com', '2026-10-08'],
  );
  assert.equal((await stats.buscarPorId('rdd2')).produto, 'acelera');
  assert.ok(!(await stats.buscarPorId('rdd3')), 'de outro SDR não entra');

  // de novo: nada se repete
  const de_novo = await vendasDoRd.trazer({ usuario: CAUA, desde: '2026-10-01', closer: 'Paulo Henrique' });
  assert.deepEqual([de_novo.criados, de_novo.completados, de_novo.jaEstavam], [0, 0, 2]);
});

test('quem já tem report aqui é completado sem trocar o que foi marcado à mão', async () => {
  await stats.registrar({ id: 'meu1', usuarioId: CAUA.id, usuarioNome: CAUA.nome, lead: 'Ana Prado', contato: 'Ana Prado', origem: 'extensao' });
  await stats.registrar({ id: 'meu2', usuarioId: CAUA.id, usuarioNome: CAUA.nome, lead: 'Bruno Lima', contato: 'Bruno Lima', origem: 'extensao' });
  await stats.atualizarResultado('meu2', { resultado: 'sem_venda', ticket: 5000, produto: 'acelera' }); // marcado à mão
  const hoje = stats.hojeStr();
  cards = [card('x1', 'Ana Prado', { closed_at: new Date().toISOString() }), card('x2', 'Bruno Lima', { closed_at: new Date().toISOString() })];
  const r = await vendasDoRd.trazer({ usuario: CAUA, desde: hoje, closer: 'Paulo Henrique' });
  assert.deepEqual([r.criados, r.completados], [0, 2]);
  const a = await stats.buscarPorId('meu1');
  assert.deepEqual([a.resultado, a.ticket, a.produto, a.closerNome, a.rdDealId, Boolean(a.vendidoNoRd)], ['venda_call', 18624, 'performance', 'Paulo Henrique', 'x1', true]);
  const b = await stats.buscarPorId('meu2');
  assert.deepEqual([b.resultado, b.ticket, b.produto, b.rdDealId], ['sem_venda', 5000, 'acelera', 'x2'], 'o que foi marcado à mão fica');
});

test('rota: só o master; pede o closer e a data', async () => {
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const admin = { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' };
    const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', { method: 'POST', headers: admin, body: JSON.stringify({ nome, papel }) })).json()).usuario;
    const master = await criar('Cauã Silva', 'master');
    const sdrU = await criar('Bia SDR', 'sdr');
    const chamar = async (corpo, u) => {
      const r = await fetch(base + '/api/master/trazer-vendas-rd', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cr-key': u.chave }, body: JSON.stringify(corpo) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    cards = [];
    assert.equal((await chamar({ closer: 'Paulo Henrique', desde: '2026-10-01' }, sdrU)).status, 403);
    assert.equal((await chamar({ closer: '', desde: '2026-10-01' }, master)).status, 400);
    assert.equal((await chamar({ closer: 'Paulo Henrique', desde: 'ontem' }, master)).status, 400);
    const ok = await chamar({ closer: 'Paulo Henrique', desde: '2026-10-01' }, master);
    assert.deepEqual([ok.status, ok.json.vistos, ok.json.criados], [200, 0, 0]);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});
