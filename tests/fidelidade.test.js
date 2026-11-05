'use strict';
// Fidelidade do handoff (auditoria de 04/11/2026): o que pode distorcer o fato entregue ao closer.
// Dados sintéticos; sem rede, sem IA.
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });

const { normalizarConversa } = require('../src/conversation-normalizer');
const { falasDoLeadNoTexto, verificarCitacoes } = require('../src/citacoes');
const db = require('../src/db');

const m = (from, content) => ({ from, type: 'texto', content, timestamp: null });

// ---------------------------------------------------------------- corte de conversa longa
test('corte: a resposta "Não." fica junto da pergunta sobre investimento', () => {
  const h = [
    m('eu', 'Você consegue fazer o investimento de R$ 5 mil para começar?'),
    m('eles', 'Não.'),
    m('eles', 'x'.repeat(160)),
  ];
  const { historico, resumida } = normalizarConversa(h, { maxChars: 160, agrupar: false });
  const textos = historico.map((x) => x.content);
  assert.ok(textos.includes('Não.'), 'a negativa não pode sumir');
  assert.ok(textos[0].startsWith('Você consegue'), 'a pergunta continua');
  assert.equal(resumida, false, 'nada foi cortado neste caso');
});

test('corte: correção posterior leva junto o valor corrigido (e a pergunta antes dele)', () => {
  const h = [
    m('eu', 'Quanto você tem separado para começar?'),
    m('eles', 'uns 20 mil'),
    m('eles', 'na verdade são 2 mil, me enganei'),
    m('eu', 'y'.repeat(300)),
    m('eles', 'z'.repeat(150)),
  ];
  const { historico } = normalizarConversa(h, { maxChars: 200, agrupar: false });
  const textos = historico.map((x) => x.content);
  assert.ok(textos.includes('na verdade são 2 mil, me enganei'));
  assert.ok(textos.includes('uns 20 mil'), 'a mensagem corrigida fica para a IA ver a correção');
  assert.ok(textos.includes('Quanto você tem separado para começar?'), 'a pergunta da resposta curta fica');
});

test('corte: sem estourar o limite nada muda', () => {
  const h = [m('eu', 'oi'), m('eles', 'oi')];
  assert.equal(normalizarConversa(h, { agrupar: false }).historico.length, 2);
});

// ---------------------------------------------------------------- modo manual: só fala do lead valida citação
test('modo manual: linha do vendedor não valida citação do lead', () => {
  const texto = 'Cauã: Você tem 5 mil para investir agora?\nMarcos: tenho sim, quero começar logo\nVENDEDOR: Perfeito';
  const falas = falasDoLeadNoTexto(texto, 'Cauã Lima');
  assert.deepEqual(falas, ['tenho sim, quero começar logo']);
  // A IA atribuiu ao lead a pergunta do vendedor: sai.
  const r = verificarCitacoes(['Você tem 5 mil para investir agora', 'quero começar logo'], falas);
  assert.deepEqual(r.mantidas, ['quero começar logo']);
});

test('modo manual: texto sem autor por linha continua valendo inteiro (não dá para saber quem falou)', () => {
  assert.deepEqual(falasDoLeadNoTexto('quero começar logo\ntenho loja física', 'Cauã'), ['quero começar logo', 'tenho loja física']);
});

test('modo manual: horário e (áudio) no começo da linha são reconhecidos', () => {
  const texto = '[14:32, 04/11/2026] Cauã Lima: e o investimento?\n[14:33, 04/11/2026] Ana (áudio): eu tenho 3 mil guardados';
  assert.deepEqual(falasDoLeadNoTexto(texto, 'Cauã Lima'), ['eu tenho 3 mil guardados']);
});

// ---------------------------------------------------------------- trava com dono
test('trava: quem não pegou a trava não consegue soltar a de outro', async () => {
  const chave = 'teste-trava-' + Date.now();
  const tokenA = await db.travar(chave, 60);
  assert.ok(tokenA, 'A pegou a trava');
  assert.equal(await db.travar(chave, 60), false, 'B não pega enquanto A gera');
  await db.destravar(chave, 'token-de-outro');
  assert.equal(await db.travar(chave, 60), false, 'token errado não solta a trava de A');
  await db.destravar(chave, tokenA);
  const tokenC = await db.travar(chave, 60);
  assert.ok(tokenC && tokenC !== tokenA, 'depois que A soltou, outro pega com token novo');
  await db.destravar(chave, tokenC);
});

test('trava: rotina antiga sem token continua soltando (agendadores de execução única)', async () => {
  const chave = 'teste-trava-legado-' + Date.now();
  assert.ok(await db.travar(chave, 60));
  await db.destravar(chave);
  assert.ok(await db.travar(chave, 60));
  await db.destravar(chave);
});
