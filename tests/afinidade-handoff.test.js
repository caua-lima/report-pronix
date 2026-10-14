'use strict';
// Match quando a conversa foi por LIGAÇÃO: a análise lê o PDF do handoff (o que o sistema gera, comprimido
// como em produção) ou o texto do report colado. IA SIMULADA, banco em pasta temporária, lead inventado.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-afinidade-handoff-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', GROQ_API_KEY: 'gsk_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.PDF_SEM_COMPRESSAO;

const app = require('../server');
const closers = require('../src/closers');
const { gerarPdfBuffer } = require('../src/generatePdf');
const { textoDoPdf } = require('../src/textoDoPdf');

// ---------------------------------------------------------------- IA gratuita simulada (as duas etapas)
const pedidosIa = [];
const AVALIACAO = {
  nota: 8, veredito: 'Casal decidido, os dois na call.', composicao: 'casal', momento: 'loja física', decisores_na_call: 'sim',
  pontos_match: [{ ponto: 'Casal que decide junto', prova: 'A esposa participa da reunião', historico: 'Casal com os dois na call fecha mais.' }],
  pontos_atencao: [{ ponto: 'Pagamento não conversado', prova: 'Não falou de cartão', contornar: 'Perguntar antes.' }],
  como_conduzir: ['Abrir pela loja.'], falta_saber: ['Limite do cartão.'],
};
const PLANO = {
  abertura: 'Abra pelos 8 anos de loja.', decisores: 'Confirme a esposa.', perguntas: ['Quanto fatura?'], dor: 'Devolva a queda.', prova: 'Caso parecido.',
  proposta: 'Para os dois.', pagamento: 'Cartão.', objecoes: [{ objecao: 'Vamos pensar', sinal: 'Decidem juntos', resposta: 'Resolver na call.' }],
  fechamento: 'Peça a decisão.', nao_fazer: ['Acelerar'],
  // a primeira está entre aspas no PDF ("Nas palavras do lead"); a segunda está no relato, mas é do pré-vendedor; a terceira foi inventada
  falas_do_lead: ['Minha esposa participa comigo da reunião', 'Decide com a esposa; os dois vão à call', 'Quero começar amanhã mesmo'],
};
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchReal(url, opts);
  if (u.hostname === 'api.groq.com') {
    const corpo = JSON.parse(opts.body);
    pedidosIa.push(corpo);
    const plano = /PLANO DA CALL/.test(corpo.messages[0].content);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(plano ? PLANO : AVALIACAO) } }] }) };
  }
  throw new Error('chamada externa inesperada: ' + u.href);
};

const HANDOFF = {
  lead: 'Lead Fictício de Teste', sdr: 'Cauã Lima', company: 'PRONIX',
  resumo: [
    { rotulo: 'Decisor(es)', valor: 'Decide com a esposa; os dois vão à call. Ela cuida do financeiro da loja e quer entender o retorno antes.' },
    { rotulo: 'Momento', valor: 'Loja física há 8 anos, vendas no balcão caindo 40% & aluguel alto' },
    { rotulo: 'Investimento', valor: 'Tem R$ 20 mil separados — "não é problema"' },
  ],
  citacoes: ['O movimento caiu uns 40% do ano passado pra cá e o aluguel não espera.', 'Minha esposa participa comigo da reunião.'],
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
  E.sdr = await criar('Bia SDR', 'sdr');
  E.ph = await closers.criar('Paulo Henrique Pagoti');
  await closers.definirInteligencia(E.ph.id, { apelido: 'PH', inteligencia: 'Fecha mais com casal quando os dois estão na call.' });
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});
const chamar = async (rota, corpo, u = E.sdr) => {
  const r = await fetchReal(base + rota, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cr-key': u.chave }, body: JSON.stringify(corpo) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test('o texto sai do PDF do handoff comprimido: rótulo e valor na mesma linha, acentos, travessão e as falas entre aspas', async () => {
  const buf = await gerarPdfBuffer(HANDOFF);
  assert.match(buf.toString('latin1'), /FlateDecode/, 'o PDF de produção é comprimido');
  const t = textoDoPdf(buf);
  assert.match(t, /^HANDOFF DE PRÉ-VENDAS$/m);
  assert.match(t, /^Lead: Lead Fictício de Teste$/m);
  assert.match(t, /^Decisor\(es\): Decide com a esposa; os dois vão à call\./m);
  assert.match(t, /^Momento: Loja física há 8 anos, vendas no balcão caindo 40% & aluguel alto$/m);
  assert.match(t, /^Investimento: Tem R\$ 20 mil separados — "não é problema"$/m);
  assert.match(t, /^“Minha esposa participa comigo da reunião\.”$/m);
  assert.equal(textoDoPdf(Buffer.from('não é PDF')), '');
});

test('ligação: o PDF do handoff vira a base do match com o PH, e o PDF do match volta pronto', async () => {
  pedidosIa.length = 0;
  const pdf = (await gerarPdfBuffer(HANDOFF)).toString('base64');
  const r = await chamar('/api/afinidade/handoff', { closerId: E.ph.id, pdfBase64: pdf });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.afinidade.nota, r.json.afinidade.apelido, r.json.afinidade.faixa], [8, 'PH', 'alta']);
  assert.equal(Buffer.from(r.json.arquivoBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.match(r.json.arquivo, /^Match_PH_Lead-Ficticio/, 'sem nome no campo, vale o "Lead:" do próprio PDF');
  const avaliacao = pedidosIa.find((p) => !/PLANO DA CALL/.test(p.messages[0].content)).messages[1].content;
  assert.match(avaliacao, /Report de handoff do pré-vendedor \(a conversa com o lead foi por ligação/);
  assert.match(avaliacao, /Decisor\(es\): Decide com a esposa/);
  assert.match(avaliacao, /Lead: Lead Fictício de Teste/);
  assert.ok(!/<conversa>/.test(avaliacao), 'não há conversa escrita');
  // fala do lead só a que está entre aspas no report: a do pré-vendedor e a inventada caem
  assert.deepEqual(r.json.afinidade.plano.falasDoLead, ['Minha esposa participa comigo da reunião']);
});

test('ligação: texto colado também vale; PDF sem texto, arquivo que não é PDF e closer errado são recusados', async () => {
  const relato = 'Lead: Outro Lead Fictício\nDecisor(es): decide sozinho, é o dono da distribuidora.\nMomento: já vende no Mercado Livre e quer escalar; margem apertada pelo frete.\nInvestimento: tem o valor no cartão da empresa.';
  let r = await chamar('/api/afinidade/handoff', { closerId: E.ph.id, texto: relato, nome: 'Outro Lead' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.arquivo, /^Match_PH_Outro-Lead_/);

  const semTexto = await new Promise((resolve) => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.rect(50, 50, 100, 100).fill('#cccccc');
    doc.end();
  });
  r = await chamar('/api/afinidade/handoff', { closerId: E.ph.id, pdfBase64: semTexto.toString('base64') });
  assert.equal(r.status, 400);
  assert.match(r.json.erro, /Não consegui ler o texto deste PDF/);
  r = await chamar('/api/afinidade/handoff', { closerId: E.ph.id, pdfBase64: Buffer.from('isto é uma planilha').toString('base64') });
  assert.deepEqual([r.status, r.json.erro], [400, 'Esse arquivo não é um PDF. Envie o PDF do handoff.']);
  r = await chamar('/api/afinidade/handoff', { closerId: E.ph.id, texto: 'curto' });
  assert.equal(r.status, 400);
  r = await chamar('/api/afinidade/handoff', { closerId: 'nao-existe', texto: relato });
  assert.equal(r.status, 404);
  const semChave = await fetchReal(base + '/api/afinidade/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(semChave.status, 401);
});
