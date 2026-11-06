'use strict';
// "Visão do <SDR> pro lead": a IA gratuita só arruma a escrita; se falhar ou inventar, vai o texto do SDR.
// Groq simulado; lead inventado.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = 'chave-falsa';
const fetchReal = global.fetch;
let respostaIA = null;
global.fetch = async (url) => {
  if (!String(url).includes('groq.com')) throw new Error('chamada inesperada: ' + url);
  if (respostaIA === 'erro') return { ok: false, status: 500, text: async () => 'fora do ar', json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: respostaIA } }] }), text: async () => '' };
};
test.after(() => { global.fetch = fetchReal; });

const visao = require('../src/visaoSdr');
const TEXTO = 'lead bem quente, ja vende no ML uns 30k por mes e quer escalar. tem grana mas o socio decide junto, chama ele na call';

test('a IA arruma a escrita e a visão vira a 1ª seção do report, com o primeiro nome do SDR', async () => {
  respostaIA = JSON.stringify({ itens: ['Lead bem quente: já vende uns R$ 30 mil por mês no Mercado Livre e quer escalar.', 'Tem dinheiro, mas o sócio decide junto — chame o sócio para a call.'] });
  const dados = { secoes: [{ titulo: 'Perfil', itens: ['Vende online.'] }] };
  await visao.aplicar(dados, { texto: TEXTO, sdr: 'Cauã Lima' });
  assert.equal(dados.secoes[0].titulo, 'Visão do Cauã pro lead');
  assert.equal(dados.secoes[0].itens.length, 2);
  assert.equal(dados.secoes[1].titulo, 'Perfil');
});

test('IA fora do ar, vazia ou inventando demais: entra o texto do SDR, em tópicos', async () => {
  for (const r of ['erro', '{"itens": []}', JSON.stringify({ itens: ['x'.repeat(400), 'y'.repeat(400), 'z'.repeat(400)] })]) {
    respostaIA = r;
    const { itens, reescrita } = await visao.reescrever(TEXTO);
    assert.equal(reescrita, false, 'resposta: ' + r.slice(0, 30));
    assert.deepEqual(itens, ['lead bem quente, ja vende no ML uns 30k por mes e quer escalar.', 'tem grana mas o socio decide junto, chama ele na call']);
  }
});

test('sem texto: nada muda no report', async () => {
  const dados = { secoes: [{ titulo: 'Perfil', itens: ['a'] }] };
  await visao.aplicar(dados, { texto: '   ', sdr: 'Cauã' });
  assert.equal(dados.secoes.length, 1);
});
