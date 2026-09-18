'use strict';
// Popup real (popup.html + popup.js) em jsdom: último report por dono (A11) e edição guardada (A10).
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
const { esperar, dormir } = require('./helpers/dom');

const RAIZ = path.join(__dirname, '..');
const SERVER = 'https://report-closer.vercel.app';

async function impressao(chave) {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(chave));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const REPORT = {
  lead: 'Marcos',
  resumo: [{ rotulo: 'Investimento', valor: 'Fatura 20 mil' }],
  secoes: [{ titulo: 'O que o closer deve bater', numerada: true, itens: ['Mostrar o caminho'] }],
  citacoes: [],
  abertura: 'Oi Marcos',
  frase_impacto: 'Ele decidiu',
};

/** Abre o popup com o storage inicial dado; `nomePorChave` simula o /api/eu do servidor. */
async function abrirPopup(storageInicial, { nomePorChave = {} } = {}) {
  const html = fs.readFileSync(path.join(RAIZ, 'extension', 'popup.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://teste/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const storage = JSON.parse(JSON.stringify(storageInicial));
  w.chrome = {
    runtime: { lastError: null },
    tabs: { query: async () => [{ id: 1, url: 'https://web.whatsapp.com/' }], sendMessage: () => {} },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        get: (padrao, cb) => cb(Object.assign({}, padrao, JSON.parse(JSON.stringify(storage)))),
        set: (o, cb) => {
          Object.assign(storage, JSON.parse(JSON.stringify(o)));
          if (cb) cb();
        },
        remove: (k, cb) => {
          delete storage[k];
          if (cb) cb();
        },
      },
    },
  };
  Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
  w.TextEncoder = TextEncoder;
  w.fetch = async (url, opts) => {
    const chave = opts && opts.headers && opts.headers['x-cr-key'];
    const nome = nomePorChave[chave];
    return { ok: !!nome, json: async () => (nome ? { ok: true, nome } : { erro: 'Chave inválida.' }) };
  };
  w.eval(fs.readFileSync(path.join(RAIZ, 'extension', 'popup.js'), 'utf8'));
  return { w, document: w.document, storage };
}

test('A11: mostra o último report só para o dono da chave, no mesmo servidor', async () => {
  const dono = await impressao('pnx_ana');
  const guardado = { dados: REPORT, nome: 'Marcos', server: SERVER, dono, quando: 111, versao: 0 };

  const ana = await abrirPopup({ chave: 'pnx_ana', server: SERVER, ultimoReport: guardado }, { nomePorChave: { pnx_ana: 'Ana' } });
  await esperar(() => !ana.document.getElementById('report').classList.contains('hidden'), { motivo: 'report da Ana' });
  assert.match(ana.document.getElementById('report').textContent, /Mostrar o caminho/);
  ana.w.close();

  const bia = await abrirPopup({ chave: 'pnx_bia', server: SERVER, ultimoReport: guardado }, { nomePorChave: { pnx_bia: 'Bia' } });
  await dormir(80);
  assert.ok(bia.document.getElementById('report').classList.contains('hidden'), 'report da Ana não pode aparecer para a Bia');
  bia.w.close();

  const outroServidor = await abrirPopup({ chave: 'pnx_ana', server: 'https://outro.exemplo.com', ultimoReport: guardado }, { nomePorChave: { pnx_ana: 'Ana' } });
  await dormir(80);
  assert.ok(outroServidor.document.getElementById('report').classList.contains('hidden'));
  outroServidor.w.close();

  // Report antigo (versão anterior da extensão, sem "dono"): não mostra.
  const semDono = await abrirPopup({ chave: 'pnx_ana', server: SERVER, ultimoReport: { ...guardado, dono: undefined } });
  await dormir(80);
  assert.ok(semDono.document.getElementById('report').classList.contains('hidden'));
  semDono.w.close();
});

test('A11: validar outra chave apaga o report guardado da pessoa anterior', async () => {
  const dono = await impressao('pnx_ana');
  const p = await abrirPopup(
    { chave: 'pnx_bia', server: SERVER, ultimoReport: { dados: REPORT, nome: 'Marcos', server: SERVER, dono, quando: 1, versao: 0 } },
    { nomePorChave: { pnx_bia: 'Bia' } }
  );
  await esperar(() => !p.storage.ultimoReport, { motivo: 'report removido ao validar outra chave' });
  assert.ok(p.document.getElementById('report').classList.contains('hidden'));
  p.w.close();
});

test('A10: a edição feita no popup é guardada (e sobrevive a fechar o popup)', async () => {
  const dono = await impressao('pnx_ana');
  const p = await abrirPopup({ chave: 'pnx_ana', server: SERVER, ultimoReport: { dados: REPORT, nome: 'Marcos', server: SERVER, dono, quando: 5, versao: 0 } }, { nomePorChave: { pnx_ana: 'Ana' } });
  await esperar(() => !p.document.getElementById('report').classList.contains('hidden'), { motivo: 'report na tela' });

  const campo = p.document.querySelector('[data-edit="secoes.0.itens.0"]');
  campo.innerText = 'Mostrar o caminho do Mercado Livre';
  campo.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  await esperar(() => p.storage.ultimoReport.versao === 1, { motivo: 'edição gravada' });
  assert.equal(p.storage.ultimoReport.dados.secoes[0].itens[0], 'Mostrar o caminho do Mercado Livre');
  assert.equal(p.storage.ultimoReport.dono, dono, 'continua sendo da mesma pessoa');
  p.w.close();

  // Popup reaberto: a versão editada é a que aparece.
  const reaberto = await abrirPopup(p.storage, { nomePorChave: { pnx_ana: 'Ana' } });
  await esperar(() => !reaberto.document.getElementById('report').classList.contains('hidden'), { motivo: 'report reaberto' });
  assert.match(reaberto.document.getElementById('report').textContent, /Mercado Livre/);
  reaberto.w.close();
});

test('A10: edição não sobrescreve um report NOVO que chegou enquanto o popup estava aberto', async () => {
  const dono = await impressao('pnx_ana');
  const p = await abrirPopup({ chave: 'pnx_ana', server: SERVER, ultimoReport: { dados: REPORT, nome: 'Marcos', server: SERVER, dono, quando: 5, versao: 0 } }, { nomePorChave: { pnx_ana: 'Ana' } });
  await esperar(() => !p.document.getElementById('report').classList.contains('hidden'), { motivo: 'report na tela' });

  // Chega um report novo (outra conversa) — o content script grava por cima.
  p.storage.ultimoReport = { dados: { ...REPORT, lead: 'Outro Lead' }, nome: 'Outro', server: SERVER, dono, quando: 99, versao: 0 };

  const campo = p.document.querySelector('[data-edit="secoes.0.itens.0"]');
  campo.innerText = 'texto editado no report antigo';
  campo.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  await dormir(700);
  assert.equal(p.storage.ultimoReport.dados.lead, 'Outro Lead', 'o report novo continua intacto');
  assert.equal(p.storage.ultimoReport.versao, 0);
  p.w.close();
});
