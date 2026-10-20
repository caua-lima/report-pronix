'use strict';
// Custo do report sem mexer no que a IA lê de regra: prompt em dois blocos de cache, conversa com a hora
// local compacta e o aquecimento do cache entre um report e outro. IA SIMULADA, banco temporário, sem rede.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-custo-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', ANTHROPIC_API_KEY: 'chave-falsa', LLM_PROVIDER: 'anthropic',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
  TZ_RELATORIO: 'America/Sao_Paulo', PDF_SEM_COMPRESSAO: '1',
});
delete process.env.VERCEL;
delete process.env.AQUECER_CACHE;

const app = require('../server');
const report = require('../src/report');
const aprendizado = require('../src/aprendizado');
const aquecimento = require('../src/aquecimento');
const db = require('../src/db');

const chamadas = [];
const fetchReal = global.fetch;
const REPORT_FALSO = {
  lead: 'Marcos',
  resumo: [{ rotulo: 'Investimento', valor: 'R$3 mil' }, { rotulo: 'Motivação', valor: 'Vender no Mercado Livre' }, { rotulo: 'Decisor(es)', valor: 'Decide com a esposa' }],
  secoes: [{ titulo: 'Momento', itens: ['Loja de moto peças.'] }, { titulo: 'O que o closer deve bater', numerada: true, itens: ['Mostrar o plano.'] }],
  citacoes: [], abertura: 'Oi Marcos, é isso mesmo?',
};
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return fetchReal(url, opts);
  if (u.includes('api.anthropic.com')) {
    const corpo = JSON.parse(opts.body);
    chamadas.push(corpo);
    const aquecendo = corpo.max_tokens === 1;
    return {
      ok: true, status: 200,
      json: async () => ({
        model: 'claude-sonnet-5',
        usage: aquecendo
          ? { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 18000, cache_creation_input_tokens: 0 }
          : { input_tokens: 4000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 18000 },
        stop_reason: aquecendo ? 'max_tokens' : 'tool_use',
        content: aquecendo ? [{ type: 'tool_use', input: {} }] : [{ type: 'tool_use', input: REPORT_FALSO }],
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
  const r = await fetchReal(base + '/api/admin/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ nome: 'Cauã', papel: 'master' }),
  });
  E.chave = (await r.json()).usuario.chave;
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});
const api = async (metodo, rota, corpo, cab = { 'x-cr-key': E.chave }) => {
  const r = await fetchReal(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', ...cab }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const CONVERSA = [
  { from: 'eu', type: 'texto', content: 'Oi Marcos, tudo bem?', timestamp: '2026-10-14T13:00:00.000Z' },
  { from: 'eles', type: 'audio', content: 'Tudo, quero vender no Mercado Livre e consigo investir 3 mil.', timestamp: '2026-10-14T13:05:00.000Z' },
  { from: 'eu', type: 'texto', content: 'Fechado, reunião amanhã às 15h?', timestamp: '2026-10-15T02:30:00.000Z' },
];

test('o prompt do report vai em dois blocos de cache e, emendado, é o mesmo texto; corrigir um report só muda o 2º', async () => {
  const antes = await report.montarSystem();
  assert.equal(antes.length, 2);
  assert.ok(antes[0].startsWith(report.SYSTEM_PROMPT), 'o 1º bloco começa pelas regras');
  assert.match(antes[1], /EXEMPLO A[\s\S]*EXEMPLO B/, 'os exemplos ficam no 2º bloco');

  await aprendizado.registrarAjusteConsciencia({ reportId: 'r1', de: 'problema', para: 'solucao', evidencia: 'Perguntou como funciona a mentoria' });
  const depois = await report.montarSystem();
  assert.equal(depois[0], antes[0], 'a correção do gestor não reescreve o prefixo grande');
  assert.match(depois[1], /^\n\n---\n\nCALIBRAGEM DO NÍVEL DE CONSCIÊNCIA[\s\S]*EXEMPLO A/);

  chamadas.length = 0;
  const r = await api('POST', '/api/report-direto', { mensagens: CONVERSA, nome: 'Marcos' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = chamadas[0];
  assert.equal(c.system.length, 2);
  for (const b of c.system) assert.deepEqual(b.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(c.system.map((b) => b.text).join(''), depois.join(''));
});

test('a conversa vai com um cabeçalho por dia (com o dia da semana) e só a hora local em cada mensagem', async () => {
  chamadas.length = 0;
  await api('POST', '/api/report-direto', { mensagens: CONVERSA.concat([{ from: 'eles', type: 'texto', content: 'Pode ser', timestamp: '2026-10-15T12:00:00.000Z' }]), nome: 'Marcos' });
  const user = chamadas[0].messages[0].content;
  assert.match(user, /— 14\/10\/2026, quarta-feira —\n\[10:00\] VENDEDOR: Oi Marcos, tudo bem\?\n\[10:05\] LEAD \(áudio transcrito\): Tudo, quero vender/);
  assert.match(user, /\[23:30\] VENDEDOR: Fechado, reunião amanhã às 15h\?\n— 15\/10\/2026, quinta-feira —\n\[09:00\] LEAD: Pode ser/, '23:30 de Brasília ainda é dia 14; o dia muda no cabeçalho');
  assert.ok(!/T\d\d:\d\d:\d\d\.\d{3}Z/.test(user), 'nada de carimbo ISO em UTC');
  // carimbo que não é data segue como veio
  assert.equal(report.montarHistoricoFormatado([{ from: 'eu', type: 'texto', content: 'oi', timestamp: 'ontem' }]), '[ontem] VENDEDOR: oi');
});

test('aquecimento: renova o cache só perto de vencer, enquanto houve report nas últimas 2h; nunca depois de vencido', async () => {
  const MIN = 60000;
  await db.setJson(aquecimento.CHAVE, {});
  assert.equal((await aquecimento.aquecer()).motivo, 'sem-report');

  const T = Date.parse('2026-10-20T13:00:00.000Z');
  await aquecimento.marcarReport(T);
  chamadas.length = 0;
  let r = await aquecimento.aquecer({ agora: T + 10 * MIN });
  assert.deepEqual([r.feito, r.motivo, r.proximoEmMs], [false, 'recente', 45 * MIN], 'cache novo: volta perto dos 55min');

  r = await aquecimento.aquecer({ agora: T + 55 * MIN, usuarioNome: 'Cauã' });
  assert.deepEqual([r.feito, r.motivo, r.proximoEmMs], [true, 'renovado', 55 * MIN]);
  assert.equal(chamadas.length, 1);
  const c = chamadas[0];
  assert.equal(c.max_tokens, 1, 'um token de saída');
  assert.equal(c.model, 'claude-sonnet-5', 'o mesmo modelo do report padrão');
  assert.equal(c.system.map((b) => b.text).join(''), (await report.montarSystem()).join(''), 'o mesmo prefixo do report');
  assert.equal(c.tools[0].name, 'gerar_relatorio');
  assert.deepEqual(c.tool_choice, { type: 'tool', name: 'gerar_relatorio' });

  r = await aquecimento.aquecer({ agora: T + 110 * MIN });
  assert.deepEqual([r.feito, r.proximoEmMs], [true, null], 'última batida da janela: o cache vale até ~2h50 depois do report');
  r = await aquecimento.aquecer({ agora: T + 170 * MIN });
  assert.deepEqual([r.feito, r.motivo, r.proximoEmMs], [false, 'parado', null]);
  assert.equal(chamadas.length, 2);

  // a batida atrasou (Chrome dormindo): o cache já venceu e a batida pagaria a escrita — não bate
  await aquecimento.marcarReport(T);
  r = await aquecimento.aquecer({ agora: T + 59 * MIN });
  assert.deepEqual([r.feito, r.motivo, r.proximoEmMs], [false, 'expirado', null]);
  assert.equal(chamadas.length, 2);

  process.env.AQUECER_CACHE = 'nao';
  assert.equal((await aquecimento.aquecer({ agora: T + 55 * MIN })).motivo, 'desligado');
  delete process.env.AQUECER_CACHE;
});

test('rota da batida, o report marca o uso do cache e o gasto do aquecimento aparece à parte nos números', async () => {
  await db.setJson(aquecimento.CHAVE, {});
  await api('POST', '/api/report-direto', { mensagens: CONVERSA.concat([{ from: 'eles', type: 'texto', content: 'Combinado', timestamp: '2026-10-15T13:00:00.000Z' }]), nome: 'Marcos' });
  const s = await db.getJson(aquecimento.CHAVE, {});
  assert.ok(Date.now() - Date.parse(s.report) < 60000, 'o report marcou o uso do cache');

  const r = await api('POST', '/api/cache/aquecer', {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.feito, r.json.motivo], [true, false, 'recente']);
  assert.ok(r.json.proximoEmMs > 50 * 60000);
  assert.equal((await api('POST', '/api/cache/aquecer', {}, {})).status, 401);

  const st = await api('GET', '/api/admin/stats', null, { 'x-admin-pass': 'senha-de-teste' });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal(st.json.geral.aquecimentos.total, 2, 'as duas batidas do teste anterior');
  assert.ok(st.json.geral.aquecimentos.custo > 0 && st.json.geral.aquecimentos.custo < 0.02);
  assert.equal(st.json.qualidade.reportsComCache, st.json.total);
  assert.equal(st.json.qualidade.reportsCacheQuente, 0, 'no teste todo report escreveu o cache');
});

test('extensão: depois de um report marca a batida de ~55min; ao tocar, bate no servidor e remarca só se ele pedir', async () => {
  const vm = require('vm');
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'extension/background.js'), 'utf8');
  const criados = [];
  const urls = [];
  let aoTocar = null;
  let aoMensagem = null;
  let respostaServidor = {};
  const chrome = {
    storage: { local: { get: (padrao, cb) => cb(Object.assign({}, padrao, { chave: 'pnx_abc', server: 'https://report-pronix.vercel.app' })) } },
    runtime: { onMessage: { addListener: (fn) => { aoMensagem = fn; } } },
    alarms: {
      get: (nome, cb) => cb({ name: nome }),
      create: (nome, o) => criados.push([nome, o]),
      onAlarm: { addListener: (fn) => { aoTocar = fn; } },
    },
  };
  const fetch = async (url) => {
    urls.push(url);
    const corpo = url.endsWith('/api/report-direto') ? { dados: { lead: 'Marcos' }, arquivo: 'r.pdf', arquivoBase64: 'AAAA', id: 'x1' } : respostaServidor;
    return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) };
  };
  vm.runInNewContext(fonte, { chrome, fetch, URL, JSON, Promise, console, AbortSignal, Date, Math, Number, setTimeout, clearTimeout });

  const antes = Date.now();
  await new Promise((resolve) => aoMensagem({ action: 'reportFetch', mensagens: [], nome: 'Marcos' }, {}, resolve));
  const aquecer = criados.filter(([n]) => n === 'aquecer-cache');
  assert.equal(aquecer.length, 1);
  assert.ok(Math.abs(aquecer[0][1].when - (antes + 55 * 60000)) < 5000, 'marca para ~55min depois do report');

  respostaServidor = { ok: true, feito: true, proximoEmMs: 55 * 60000 };
  aoTocar({ name: 'aquecer-cache' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(urls[urls.length - 1], 'https://report-pronix.vercel.app/api/cache/aquecer');
  assert.equal(criados.filter(([n]) => n === 'aquecer-cache').length, 2, 'o servidor pediu outra batida');

  respostaServidor = { ok: true, feito: false, motivo: 'parado', proximoEmMs: null };
  aoTocar({ name: 'aquecer-cache' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(criados.filter(([n]) => n === 'aquecer-cache').length, 2, 'parou: não marca mais');
});
