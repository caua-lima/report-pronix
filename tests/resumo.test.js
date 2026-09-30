'use strict';
// Resumo rápido da conversa (botão do cartão do WhatsApp): IA simulada, banco temporário, sem rede.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-resumo-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS,
  ADMIN_PASSWORD: 'senha-de-teste',
  ANTHROPIC_API_KEY: 'chave-falsa',
  KV_REST_API_URL: '',
  KV_REST_API_TOKEN: '',
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  LLM_PROVIDER: 'anthropic',
  TZ_RELATORIO: 'America/Sao_Paulo',
});
delete process.env.VERCEL;
const app = require('../server');

const fetchReal = global.fetch;
const chamadas = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return fetchReal(url, opts);
  if (u.includes('api.anthropic.com')) {
    chamadas.push(JSON.parse(opts.body));
    return {
      ok: true, status: 200,
      json: async () => ({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 800, output_tokens: 150 },
        content: [{ type: 'tool_use', input: {
          cenario: 'Marcos tem loja de moto peças e quer vender no Mercado Livre; reunião marcada para quinta.',
          pe_que_parou: 'Você perguntou se ele consegue investir R$3 mil e ele ainda não respondeu.',
          ultima_pergunta: 'Você: Consegue investir a partir de R$3 mil?',
          proximo_passo: 'Retomar confirmando o investimento e o horário da reunião.',
        } }],
      }),
    };
  }
  throw new Error('chamada externa inesperada: ' + u);
};

let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const criar = async (nome, papel) => (await (await fetchReal(base + '/api/admin/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ nome, papel }),
  })).json()).usuario.chave;
  E.admin = await criar('Cauã Admin', 'master');
  E.sdr = await criar('SDR Sem Ficha', 'sdr');
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});

const post = async (rota, corpo, chave) => {
  const r = await fetchReal(base + rota, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cr-key': chave }, body: JSON.stringify(corpo) });
  return { status: r.status, json: await r.json() };
};
const stats = async () => (await (await fetchReal(base + '/api/admin/stats', { headers: { 'x-admin-pass': 'senha-de-teste' } })).json());

const CONVERSA = [
  { from: 'eles', type: 'texto', content: 'Oi, tenho uma loja de moto peças', timestamp: '2026-09-21T13:00:00.000Z' },
  { from: 'eles', type: 'audio', content: 'Quero começar a vender no Mercado Livre ainda este mês', timestamp: null },
  { from: 'eu', type: 'texto', content: 'Consegue investir a partir de R$3 mil?', timestamp: '2026-09-21T13:05:00.000Z' },
];

test('resumo rápido: sem chave não usa', async () => {
  const r = await post('/api/resumo-rapido', { mensagens: CONVERSA, nome: 'Marcos' }, 'chave-errada');
  assert.equal(r.status, 401);
  assert.equal(chamadas.length, 0);
});

test('resumo rápido: cenário, onde parou, última pergunta, próximo passo e quem deve responder', async () => {
  const r = await post('/api/resumo-rapido', { mensagens: CONVERSA, nome: 'Marcos' }, E.admin);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.resumo, {
    cenario: 'Marcos tem loja de moto peças e quer vender no Mercado Livre; reunião marcada para quinta.',
    peQueParou: 'Você perguntou se ele consegue investir R$3 mil e ele ainda não respondeu.',
    ultimaPergunta: 'Você: Consegue investir a partir de R$3 mil?',
    proximoPasso: 'Retomar confirmando o investimento e o horário da reunião.',
    aguardando: 'lead', // a última mensagem é do vendedor
    ultimaMensagem: '21/09 10:05',
  });
  assert.equal(r.json.cache, false);
  const c = chamadas[0];
  assert.equal(c.tool_choice.name, 'resumo_rapido');
  assert.match(c.system[0].text, /reouvir os áudios/);
  assert.match(c.messages[0].content, /<conversa>\n[\s\S]*LEAD \(áudio transcrito\): Quero começar a vender[\s\S]*<\/conversa>/);
});

test('resumo rápido: mesma conversa vem do cache (sem chamar a IA nem cobrar de novo)', async () => {
  const antes = chamadas.length;
  const r = await post('/api/resumo-rapido', { mensagens: CONVERSA, nome: 'Marcos' }, E.admin);
  assert.equal(r.json.cache, true);
  assert.equal(chamadas.length, antes);
});

test('resumo rápido: o custo entra no gasto, mas não vira report nem "report excluído"', async () => {
  const s = await stats();
  assert.equal(s.geral.resumosRapidos.total, 1, 'só a chamada que foi à IA');
  assert.ok(s.geral.resumosRapidos.custo > 0);
  assert.equal(s.geral.total, 0, 'não entra na lista de reports (nem no .zip do dia)');
  assert.equal(s.geral.consumoExcluido.total, 0);
});

test('resumo rápido: lead respondeu por último → "você deve responder"; sem mensagens → 400', async () => {
  const r = await post('/api/resumo-rapido', { mensagens: CONVERSA.concat([{ from: 'eles', type: 'texto', content: 'Consigo sim', timestamp: '2026-09-22T12:00:00.000Z' }]) }, E.admin);
  assert.equal(r.json.resumo.aguardando, 'voce');
  assert.equal((await post('/api/resumo-rapido', { mensagens: [] }, E.admin)).status, 400);
});

test('resumo rápido: disponível para SDR também', async () => {
  const outra = CONVERSA.concat([{ from: 'eles', type: 'texto', content: 'Pode ser na quinta', timestamp: '2026-09-23T12:00:00.000Z' }]);
  const r = await post('/api/resumo-rapido', { mensagens: outra, nome: 'Marcos' }, E.sdr);
  assert.equal(r.status, 200);
  assert.ok(r.json.resumo.peQueParou);
});
