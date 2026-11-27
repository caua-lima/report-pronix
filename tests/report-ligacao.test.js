// A aba "Report da ligação" no painel real: lê o .txt da extensão, avisa quando só tem a voz do vendedor e manda
// para o servidor no formato da conversa, marcado como ligação.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const esperar = () => new Promise((r) => setTimeout(r, 60));

async function abrir() {
  const pedidos = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://painel.test/#ligacao', pretendToBeVisual: true,
    beforeParse(w) {
      w.localStorage.setItem('crChave', 'pnx_AnaAna1234567890abcdWXYZ');
      w.AbortSignal.timeout = () => undefined;
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
      w.fetch = async (url, opts = {}) => {
        if (String(url) === '/api/report-texto') pedidos.push(JSON.parse(opts.body));
        const corpo = String(url) === '/api/report-texto' ? { erro: 'parou no teste' } : { ok: true, reports: [], usuario: { id: 'u1', nome: 'Ana' } };
        return { ok: String(url) !== '/api/report-texto', status: 200, headers: { get: () => '' }, json: async () => corpo, blob: async () => null };
      };
    },
  });
  await esperar();
  const w = dom.window;
  w.document.querySelector('.tab[data-aba="ligacao"]').click();
  return { w, $: (id) => w.document.getElementById(id), pedidos };
}

test('lê o .txt da extensão: nome do cabeçalho, EU vira VENDEDOR e os tempos saem', async () => {
  const p = await abrir();
  const t = p.w.lerTranscricaoDeLigacao('﻿Ligação com Gilvan Souza - 2026-11-26 14h02\n\n[0:00] EU: Fala, Gilvan\n\n[0:07] LEAD: Tudo bem, quero vender\n');
  assert.deepEqual({ ...t }, { nome: 'Gilvan Souza', conversa: 'VENDEDOR: Fala, Gilvan\nLEAD: Tudo bem, quero vender', soMinhaVoz: false });
  assert.equal(p.w.lerTranscricaoDeLigacao('Ligação com online - 2026-11-26 14h02\n[0:00] EU: oi').nome, '', 'status do WhatsApp não é nome');
  assert.equal(p.w.lerTranscricaoDeLigacao('Ligação com +55 44 8829-3564 - 2026-11-27 09h14\n[0:00] EU: oi').nome, '', 'número não é nome');
  assert.ok(!p.$('aba-ligacao').classList.contains('hidden'));
});

test('só a voz do vendedor: avisa e manda o aviso para a IA, marcado como ligação', async () => {
  const p = await abrir();
  p.$('ligTexto').value = 'Ligação com Rui - 2026-11-26 14h02\n[0:00] EU: Rui, você tem quanto para investir no projeto?';
  p.$('ligTexto').dispatchEvent(new p.w.Event('input'));
  assert.equal(p.$('ligNome').value, 'Rui');
  assert.match(p.$('ligAviso').textContent, /só tem a sua voz/);
  p.$('ligNotas').value = 'Tem 5 mil e decide sozinho.';
  p.$('ligGerar').click();
  await esperar();
  assert.equal(p.pedidos.length, 1);
  assert.equal(p.pedidos[0].ligacao, true);
  assert.equal(p.pedidos[0].nome, 'Rui');
  assert.match(p.pedidos[0].texto, /Só a voz do vendedor foi gravada/);
  assert.match(p.pedidos[0].texto, /VENDEDOR: Rui, você tem quanto/);
  assert.match(p.pedidos[0].texto, /ANOTAÇÕES DO VENDEDOR[\s\S]*Tem 5 mil/);
});

test('transcrição da ligação: tira o que foi inventado no silêncio e o laço, mantém a fala', () => {
  const { limparSegmentos } = require('../src/groq');
  const s = (text, extra) => ({ start: 0, end: 2, text, avg_logprob: -0.2, no_speech_prob: 0.05, compression_ratio: 1.2, ...extra });
  const r = limparSegmentos([
    s('Quero vender no Mercado Livre.'),
    s('Obrigado.', { no_speech_prob: 0.9, avg_logprob: -1.1 }),
    s('O que você vai fazer? O que você vai fazer?', { compression_ratio: 3.1, avg_logprob: -0.9 }),
    s('Sim. Sim. Sim. Sim. Sim.'),
    s('Fala baixa, mas clara.', { no_speech_prob: 0.7, avg_logprob: -0.3 }),
  ]);
  assert.deepEqual(r.map((x) => x.texto), ['Quero vender no Mercado Livre.', 'Sim. Sim.', 'Fala baixa, mas clara.']);
});

test('transcrição da ligação: tira as invenções vistas numa ligação real (lista em laço e legenda)', () => {
  const { limparSegmentos } = require('../src/groq');
  const textos = (lista) => limparSegmentos(lista.map((text) => ({ start: 0, end: 1, text, avg_logprob: -0.3, no_speech_prob: 0.1, compression_ratio: 1.5 }))).map((x) => x.texto);
  assert.deepEqual(textos(['Legenda por Sônia Ruberti']), []);
  assert.deepEqual(textos(['Mercado Livre, Shopee, Mercado Pago, CNPJ, Mercado Pago, CNPJ, Mercado Pago, CNPJ, Mercado Pago, CNPJ.']), ['Mercado Livre, Shopee, Mercado Pago, CNPJ.']);
  assert.deepEqual(textos(['consultoria, consultoria, consultoria, consultoria,']), ['consultoria,']);
  // fala normal não é mexida, inclusive repetição curta de verdade
  assert.deepEqual(textos(['Exato, exato, exato.', 'Mercado Livre, Shopee e Mercado Pago, você usa?']), ['Exato, exato, exato.', 'Mercado Livre, Shopee e Mercado Pago, você usa?']);
});

test('transcrição da ligação: trecho que volta sem os acentos é pedido de novo', async () => {
  const { transcreverGroq, faltamAcentos } = require('../src/groq');
  assert.ok(faltamAcentos('se eu e voc vendemos o mesmo produto'));
  assert.ok(faltamAcentos('Cara basicamente a gente vai te ajudar em tudo L Desde a cria de conta'));
  assert.ok(!faltamAcentos('Cara, basicamente a gente vai te ajudar em tudo.'));
  assert.ok(!faltamAcentos('sim sim sim'));
  const real = global.fetch;
  const chaveAntes = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'teste';
  const usados = [];
  const respostas = ['se eu e voc vendemos o mesmo produto n dois vamos vender', 'Se eu e você vendemos o mesmo produto, nós dois vamos vender.'];
  global.fetch = async (_u, o) => {
    usados.push(o.body.get('model') + ' ' + o.body.get('temperature') + ' ' + o.body.get('prompt'));
    const text = respostas[usados.length - 1];
    return { ok: true, json: async () => ({ text, segments: [{ start: 0, end: 3, text, avg_logprob: -0.2, no_speech_prob: 0.1, compression_ratio: 1.2 }] }) };
  };
  try {
    const r = await transcreverGroq(Buffer.from('x'), 'a.wav', { segmentos: true });
    assert.equal(r.texto, respostas[1]);
    assert.deepEqual(usados, ['whisper-large-v3 0 null', 'whisper-large-v3 0.2 null']);
  } finally {
    global.fetch = real;
    if (chaveAntes === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = chaveAntes;
  }
});
