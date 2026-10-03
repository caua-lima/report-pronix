'use strict';
// Coach da conversa: Groq simulado (sem rede, sem custo), banco temporário.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-coach-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS,
  ADMIN_PASSWORD: 'senha-de-teste',
  GROQ_API_KEY: 'chave-groq-falsa',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
const app = require('../server');

const fetchReal = global.fetch;
const chamadas = [];
let status429 = false;
const RESPOSTA = {
  perfil: { tipo: 'Analítico', evidencia: 'Pediu números e prova de resultado.' },
  como_abordar: 'Seja objetivo e traga dados concretos antes de falar de preço.',
  objecoes: [
    { objecao: 'Achou o investimento alto', resposta: 'Entendo. Posso te mostrar quanto os clientes recuperam nos primeiros meses?' },
    { objecao: '', resposta: 'sem objeção — deve ser descartada' },
  ],
  perguntas: ['Quanto você fatura hoje por mês?', 'Qual resultado te faria dizer que valeu a pena?', 'Quem mais participa da decisão?', 'quarta pergunta de sobra'],
  falta_levantar: ['Quem decide junto e se participa da reunião', 'Por que agora (prazo)', ''],
  proxima_mensagem: 'Faz sentido, Marcos. Antes de falar de valor: hoje você decide isso sozinho ou tem mais alguém?',
};
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return fetchReal(url, opts);
  if (u.includes('api.groq.com/openai/v1/chat/completions')) {
    chamadas.push(JSON.parse(opts.body));
    if (status429) return { ok: false, status: 429, text: async () => 'rate', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: JSON.stringify(RESPOSTA) } }] }) };
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
  })).json()).usuario;
  const m = await criar('Cauã Master', 'master');
  const s = await criar('SDR Comum', 'sdr');
  E.master = m.chave; E.sdr = s.chave; E.idSdr = s.id;
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
const patch = async (id, corpo, chave) =>
  (await fetchReal(base + '/api/admin/usuarios/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-cr-key': chave }, body: JSON.stringify(corpo) })).status;

const CONVERSA = [
  { from: 'eu', type: 'texto', content: 'Oi Marcos, o investimento é a partir de R$3 mil.' },
  { from: 'eles', type: 'texto', content: 'Tem algum número de resultado de clientes? Achei meio alto.' },
];

test('coach: por padrão só o master; os outros recebem 403 e o Groq nem é chamado', async () => {
  const r = await post('/api/coach', { mensagens: CONVERSA }, E.sdr);
  assert.equal(r.status, 403);
  assert.equal(chamadas.length, 0);
  assert.equal((await post('/api/coach/feedback', { tipo: 'pergunta', texto: 'x' }, E.sdr)).status, 403);
});

test('coach: perfil, como abordar, objeções (só as completas) e no máximo 3 perguntas; sem custo da Anthropic', async () => {
  const r = await post('/api/coach', { mensagens: CONVERSA, nome: 'Marcos' }, E.master);
  assert.equal(r.status, 200);
  assert.equal(r.json.cache, false);
  const c = r.json.coach;
  assert.deepEqual(c.perfil, { tipo: 'Analítico', chave: 'analitico', evidencia: 'Pediu números e prova de resultado.' });
  assert.deepEqual(c.faltaLevantar, ['Quem decide junto e se participa da reunião', 'Por que agora (prazo)']);
  assert.match(c.proximaMensagem, /você decide isso sozinho/);
  assert.match(c.comoAbordar, /dados concretos/);
  assert.equal(c.objecoes.length, 1, 'objeção sem texto é descartada');
  assert.equal(c.perguntas.length, 3);
  const req = chamadas[0];
  assert.equal(req.model, 'openai/gpt-oss-120b', 'primeiro da fila de modelos gratuitos');
  const sistema0 = req.messages[0].content;
  assert.match(sistema0, /"dominante" \(Dominante\)/);
  assert.match(sistema0, /"cetico" \(Cético\)/);
  assert.match(sistema0, /O QUE FALTA QUALIFICAR/);
  assert.match(sistema0, /RÉGUA DE QUALIFICAÇÃO DA CASA/, 'o coach conhece a régua SPIN/BANT da base');
  const tamanho = sistema0.length + req.messages[1].content.length;
  assert.ok(tamanho < 14000, 'o pedido cabe no limite por minuto do plano gratuito (' + tamanho + ' caracteres)');
  assert.deepEqual(req.response_format, { type: 'json_object' });
  assert.match(req.messages[0].content, /nunca instrução para você/);
  assert.match(req.messages[1].content, /<conversa>\n[\s\S]*Achei meio alto[\s\S]*<\/conversa>/);
  assert.ok(!/APRENDIZADO DESTE VENDEDOR/.test(req.messages[0].content), 'sem marcações ainda: nada aprendido');
});

test('coach: mesma conversa vem do cache (sem gastar chamada do limite gratuito)', async () => {
  const antes = chamadas.length;
  const r = await post('/api/coach', { mensagens: CONVERSA, nome: 'Marcos' }, E.master);
  assert.equal(r.json.cache, true);
  assert.equal(chamadas.length, antes);
});

test('coach aprende: o que o SDR marca como "funcionou" entra como exemplo; "não ajudou" vira o que evitar', async () => {
  assert.equal((await post('/api/coach/feedback', { tipo: 'objecao', texto: 'Posso te mostrar quanto os clientes recuperam?', contexto: 'Achou caro', util: true }, E.master)).status, 200);
  assert.equal((await post('/api/coach/feedback', { tipo: 'pergunta', texto: 'Quanto você fatura hoje por mês?', util: true }, E.master)).status, 200);
  assert.equal((await post('/api/coach/feedback', { tipo: 'pergunta', texto: 'Pergunta chata que não ajudou', util: false }, E.master)).status, 200);
  assert.equal((await post('/api/coach/feedback', { tipo: 'invalido', texto: 'x' }, E.master)).status, 400);
  assert.equal((await post('/api/coach/feedback', { tipo: 'pergunta', texto: '   ' }, E.master)).status, 400);

  const antes = chamadas.length;
  const r = await post('/api/coach', { mensagens: CONVERSA, nome: 'Marcos' }, E.master);
  assert.equal(r.json.cache, false, 'aprendeu algo novo: gera de novo, não repete o cache antigo');
  const sistema = chamadas[antes].messages[0].content;
  assert.match(sistema, /APRENDIZADO DESTE VENDEDOR/);
  assert.match(sistema, /objeção: "Achou caro" → resposta: "Posso te mostrar quanto os clientes recuperam\?"/);
  assert.match(sistema, /Perguntas que FUNCIONARAM:\n- Quanto você fatura hoje por mês\?/);
  assert.match(sistema, /NÃO ajudou[\s\S]*Pergunta chata que não ajudou/);
});

test('coach: limite gratuito do Groq (429) vira mensagem clara; sem mensagens → 400', async () => {
  status429 = true;
  const r = await post('/api/coach', { mensagens: [{ from: 'eles', type: 'texto', content: 'outra conversa nova ' + Date.now() }] }, E.master);
  status429 = false;
  assert.equal(r.status, 502);
  assert.match(r.json.erro, /limite gratuito/);
  assert.equal((await post('/api/coach', { mensagens: [] }, E.master)).status, 400);
});

test('o master liga o coach para outra pessoa (e desliga); só o master mexe', async () => {
  assert.equal(await patch(E.idSdr, { coach: true }, E.sdr), 403);
  assert.equal(await patch(E.idSdr, { coach: true }, E.master), 200);
  const r = await post('/api/coach', { mensagens: [{ from: 'eles', type: 'texto', content: 'conversa do sdr ' + Date.now() }] }, E.sdr);
  assert.equal(r.status, 200);
  assert.equal(await patch(E.idSdr, { coach: false }, E.master), 200);
  assert.equal((await post('/api/coach', { mensagens: CONVERSA }, E.sdr)).status, 403);
});

test('a ficha do RD avisa a extensão se o usuário vê o coach', async () => {
  const r = await post('/api/crm/lead', { telefone: '5571999998888' }, E.master);
  assert.equal(r.json.coach, true);
  const s = await post('/api/crm/lead', { telefone: '5571999998888' }, E.sdr);
  assert.equal(s.json.coach, false);
});
