'use strict';
// A conversa do WhatsApp vai para o card do lead no PronixCRM a cada report (POST /deals/:id/whatsapp_transcripts).
// Servidor de verdade; IA e CRM simulados; banco em pasta temporária; leads inventados.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-transcricao-'));
const TOKEN = 'pcrm_teste_transcricao';
Object.assign(process.env, {
  CR_DATA_DIR: DADOS,
  ADMIN_PASSWORD: 'senha-de-teste',
  ANTHROPIC_API_KEY: 'chave-falsa',
  GROQ_API_KEY: 'chave-falsa',
  CRM_API_TOKEN: TOKEN,
  CRM_CACHE_TTL_SEG: '0',
  KV_REST_API_URL: '',
  KV_REST_API_TOKEN: '',
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  LLM_PROVIDER: 'anthropic',
});
delete process.env.VERCEL;
delete process.env.CRM_TRANSCRICAO;
delete process.env.CRM_API_URL;
delete process.env.RDSTATION_CRM_TOKEN;

const app = require('../server');
const db = require('../src/db');
const transcricao = require('../src/transcricaoCrm');

// ---------------------------------------------------------------- IA e PronixCRM simulados
const enviadas = []; // { caminho, auth, corpo }
const notas = []; // anotações no card (o que aparece no Histórico)
let crmRecusa = false;
let notaMaxima = Infinity; // o CRM recusa anotação maior que isto
const fetchReal = global.fetch;
const resposta = (corpo, status = 200) => ({ ok: status < 400, status, json: async () => corpo, text: async () => JSON.stringify(corpo) });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return fetchReal(url, opts);
  if (u.includes('api.anthropic.com')) {
    return resposta({
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', input: { lead: 'Fulano', resumo: [{ rotulo: 'Investimento', valor: 'R$ 5 mil' }], secoes: [{ titulo: 'Perfil', numerada: false, itens: ['Vende online.'] }], citacoes: [], abertura: 'Oi Fulano!', frase_impacto: 'Quer escalar.' } }],
    });
  }
  const m = /crm\.pronixhub\.com\.br\/api\/v1(\/[^?]*)/.exec(u);
  if (m && (opts.method || 'GET') === 'POST' && /\/whatsapp_transcripts$/.test(m[1])) {
    enviadas.push({ caminho: m[1], auth: opts.headers.Authorization, corpo: JSON.parse(opts.body) });
    return crmRecusa ? resposta({ codigo: 'SEM_PERMISSAO', mensagem: 'O token não pode gravar transcrições.' }, 403) : resposta({ id: 't' + enviadas.length });
  }
  if (m && (opts.method || 'GET') === 'POST' && /\/notes$/.test(m[1])) {
    const corpo = JSON.parse(opts.body);
    if (corpo.text.length > notaMaxima) return resposta({ codigo: 'TEXTO_GRANDE', mensagem: 'A anotação passou do tamanho.' }, 422);
    notas.push({ caminho: m[1], texto: corpo.text });
    return resposta({ id: 'n' + notas.length });
  }
  if (m) return resposta({}, 404); // nada mais do CRM é preciso: o report já traz o card
  throw new Error('chamada externa inesperada nos testes: ' + u);
};

let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const r = await fetchReal(base + '/api/admin/usuarios', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ nome: 'Ana SDR', papel: 'sdr' }) });
  E.ana = (await r.json()).usuario.chave;
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});
const gerar = async (corpo) => {
  const r = await fetchReal(base + '/api/report-direto', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cr-key': E.ana }, body: JSON.stringify(corpo) });
  return { status: r.status, json: await r.json() };
};

const CONVERSA = [
  { from: 'eu', type: 'texto', content: 'Oi Fulano, tudo bem? Vi seu cadastro.', timestamp: '2026-10-21T13:00:00.000Z' },
  { from: 'eles', type: 'texto', content: 'Tudo! Quero vender no Mercado Livre.', timestamp: '2026-10-21T13:05:00.000Z' },
  { from: 'eles', type: 'audio', content: 'consigo investir uns cinco mil', timestamp: null },
  { from: 'eles', type: 'audio', content: '[áudio]', timestamp: null },
  { from: 'eu', type: 'texto', content: 'Perfeito, vamos marcar?', timestamp: '2026-10-21T14:10:00.000Z' },
];

// ---------------------------------------------------------------- o texto
test('o texto da conversa: data e hora de Brasília, quem falou, áudio transcrito marcado e áudio sem transcrição', () => {
  assert.equal(transcricao.textoDaConversa(CONVERSA, { sdr: 'Ana SDR', lead: 'Fulano' }), [
    '[21/10/2026 10:00] Ana SDR: Oi Fulano, tudo bem? Vi seu cadastro.',
    '[21/10/2026 10:05] Fulano: Tudo! Quero vender no Mercado Livre.',
    'Fulano: (áudio) consigo investir uns cinco mil',
    'Fulano: (áudio sem transcrição)',
    '[21/10/2026 11:10] Ana SDR: Perfeito, vamos marcar?',
  ].join('\n'));
  assert.deepEqual(transcricao.periodo(CONVERSA), { started_at: '2026-10-21T13:00:00.000Z', ended_at: '2026-10-21T14:10:00.000Z' });
  // passou de 200 mil caracteres: fica o fim (o mais recente), com o aviso
  const longa = Array.from({ length: 3000 }, (_, i) => ({ from: i % 2 ? 'eles' : 'eu', type: 'texto', content: `mensagem ${i} ` + 'x'.repeat(80) }));
  const t = transcricao.textoDaConversa(longa, { sdr: 'Ana', lead: 'Fulano' });
  assert.equal(t.length, transcricao.MAX_CARACTERES);
  assert.ok(t.startsWith('(início da conversa cortado'));
  assert.ok(t.endsWith('mensagem 2999 ' + 'x'.repeat(80)));
});

// ---------------------------------------------------------------- o envio a cada report
test('report gerado: a conversa vai para o card do lead, com o token, o período, o telefone e um external_id', async () => {
  enviadas.length = 0;
  const r = await gerar({ mensagens: CONVERSA, nome: 'Fulano', captureQuality: { plataforma: 'whatsapp' }, vinculo: { telefone: '5511912345678', dealId: 'd77' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.arquivoBase64, 'o report saiu');
  assert.equal(enviadas.length, 1);
  const e = enviadas[0];
  assert.equal(e.caminho, '/deals/d77/whatsapp_transcripts');
  assert.equal(e.auth, 'Bearer ' + TOKEN);
  assert.equal(e.corpo.transcript, transcricao.textoDaConversa(CONVERSA, { sdr: 'Ana SDR', lead: 'Fulano' }));
  assert.match(e.corpo.external_id, /^wa-[0-9a-f]{32}$/);
  assert.deepEqual([e.corpo.started_at, e.corpo.ended_at, e.corpo.phone], ['2026-10-21T13:00:00.000Z', '2026-10-21T14:10:00.000Z', '5511912345678']);
  assert.equal(r.json.transcricaoCrm.enviada, true);
  // e como anotação no card: é o que aparece no Histórico
  assert.equal(notas.length, 1);
  assert.equal(notas[0].caminho, '/deals/d77/notes');
  assert.match(notas[0].texto, /^Transcrição da conversa no WhatsApp — Ana SDR \(report de \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\)\n\n/);
  assert.ok(notas[0].texto.endsWith(e.corpo.transcript));
  assert.equal(r.json.transcricaoCrm.anotada, true);
  const log = await db.range('crm_transcricoes');
  assert.equal(log[log.length - 1].dealId, 'd77');
  assert.ok(!JSON.stringify(log).includes('Mercado Livre'), 'o registro não guarda o texto da conversa');

  // a mesma conversa de novo (report já existia): vai de novo, com o MESMO external_id — o CRM não duplica
  const dup = await gerar({ mensagens: CONVERSA, nome: 'Fulano', captureQuality: { plataforma: 'whatsapp' }, vinculo: { telefone: '5511912345678', dealId: 'd77' } });
  assert.equal(dup.json.duplicado, true);
  assert.equal(enviadas.length, 2, 'report repetido também manda: é assim que um lead de antes chega ao CRM');
  assert.equal(enviadas[1].corpo.external_id, e.corpo.external_id);
  assert.equal(dup.json.transcricaoCrm.enviada, true);
  assert.equal(notas.length, 1, 'a mesma conversa não vira outra anotação');
  assert.equal(dup.json.transcricaoCrm.repetida, true);
});

test('sem card do lead, Instagram, CRM recusando ou desligada: o report sai igual e nada quebra', async () => {
  enviadas.length = 0;
  const conversa = (n) => CONVERSA.concat([{ from: 'eles', type: 'texto', content: 'mensagem nova ' + n, timestamp: '2026-10-22T13:00:00.000Z' }]);
  // sem o card (lead fora do CRM)
  let r = await gerar({ mensagens: conversa(1), nome: 'Fulano', captureQuality: { plataforma: 'whatsapp' }, vinculo: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.transcricaoCrm, { enviada: false, motivo: 'sem-card' });
  // Instagram não é WhatsApp
  r = await gerar({ mensagens: conversa(2), nome: 'Fulano', captureQuality: { plataforma: 'instagram' }, vinculo: { dealId: 'd77' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.transcricaoCrm, undefined);
  assert.equal(enviadas.length, 0);
  // o CRM recusa: o report sai e o motivo fica registrado
  crmRecusa = true;
  r = await gerar({ mensagens: conversa(3), nome: 'Fulano', captureQuality: { plataforma: 'whatsapp' }, vinculo: { dealId: 'd77' } });
  crmRecusa = false;
  assert.equal(r.status, 200);
  assert.ok(r.json.arquivoBase64);
  assert.equal(r.json.transcricaoCrm.enviada, false);
  assert.match(r.json.transcricaoCrm.erro, /não pode gravar transcrições/);
  assert.equal(r.json.transcricaoCrm.anotada, true, 'a anotação vai mesmo com a rota de transcrições recusando');
  // CRM_TRANSCRICAO=0 desliga
  process.env.CRM_TRANSCRICAO = '0';
  r = await gerar({ mensagens: conversa(4), nome: 'Fulano', captureQuality: { plataforma: 'whatsapp' }, vinculo: { dealId: 'd77' } });
  delete process.env.CRM_TRANSCRICAO;
  assert.deepEqual(r.json.transcricaoCrm, { enviada: false, motivo: 'desligada' });
  assert.equal(enviadas.length, 1, 'só a tentativa recusada chegou ao CRM');
  // id de card estranho nunca vira caminho no CRM
  assert.deepEqual(await transcricao.enviar({ dealId: '../x', mensagens: CONVERSA }), { enviada: false, motivo: 'sem-card' });
});

test('conversa grande que o CRM não aceita numa anotação só: vai em partes, na ordem', async () => {
  notas.length = 0;
  notaMaxima = 30000;
  const longa = Array.from({ length: 700 }, (_, i) => ({ from: i % 2 ? 'eles' : 'eu', type: 'texto', content: 'linha ' + i + ' ' + 'y'.repeat(80), timestamp: '2026-10-21T13:00:00.000Z' }));
  const r = await transcricao.enviar({ dealId: 'd88', mensagens: longa, sdr: 'Ana SDR', lead: 'Fulano' });
  notaMaxima = Infinity;
  assert.equal(r.anotada, true);
  assert.ok(r.partes >= 3, 'em partes de até 20 mil caracteres');
  assert.equal(notas.length, r.partes);
  notas.forEach((n, i) => assert.ok(n.texto.includes('— parte ' + (i + 1) + ' de ' + r.partes), 'parte ' + (i + 1)));
  const juntas = notas.map((n) => n.texto.split('\n\n').slice(1).join('\n\n')).join('\n');
  assert.equal(juntas, transcricao.textoDaConversa(longa, { sdr: 'Ana SDR', lead: 'Fulano' }), 'nada se perde entre as partes');
});
