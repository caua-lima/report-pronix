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
async function abrirPopup(storageInicial, { nomePorChave = {}, zip = null } = {}) {
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
  // Conta o trabalho assíncrono em andamento (rede e hash da chave): o teste só fecha a janela
  // quando o popup terminou — fechar no meio deixava promessas órfãs e o teste falhava às vezes.
  let pendentes = 0;
  const rastrear = (p) => {
    pendentes++;
    return p.finally(() => { pendentes--; });
  };
  Object.defineProperty(w, 'crypto', {
    value: { subtle: { digest: (...a) => rastrear(webcrypto.subtle.digest(...a)) } },
    configurable: true,
  });
  w.TextEncoder = TextEncoder;
  if (!w.AbortSignal.timeout) w.AbortSignal.timeout = () => new w.AbortController().signal;
  const downloads = [];
  w.URL.createObjectURL = () => 'blob:teste';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, nome: this.download }); };
  w.fetch = (url, opts) =>
    rastrear((async () => {
      if (String(url).includes('/api/meus-reports/zip')) return zip(url, opts);
      const chave = opts && opts.headers && opts.headers['x-cr-key'];
      const nome = nomePorChave[chave];
      return { ok: !!nome, json: async () => (nome ? { ok: true, nome } : { erro: 'Chave inválida.' }) };
    })());
  w.eval(fs.readFileSync(path.join(RAIZ, 'extension', 'popup.js'), 'utf8'));
  return { w, document: w.document, storage, downloads, pendentes: () => pendentes };
}

/** Popup ocioso: nada de rede pendente e a validação da chave já terminou. */
const pronto = (p) => esperar(
  () => p.pendentes() === 0 && !/Validando/.test(p.document.getElementById('status').textContent),
  { motivo: 'popup ocioso' }
);

/** Espera o popup terminar o que está fazendo (validação da chave, hash) e só então fecha. */
async function fechar(p) {
  await pronto(p);
  await dormir(30);
  return p.w.close();
}

test('A11: mostra o último report só para o dono da chave, no mesmo servidor', async () => {
  const dono = await impressao('pnx_ana');
  const guardado = { dados: REPORT, nome: 'Marcos', server: SERVER, dono, quando: 111, versao: 0 };

  const ana = await abrirPopup({ chave: 'pnx_ana', server: SERVER, ultimoReport: guardado }, { nomePorChave: { pnx_ana: 'Ana' } });
  await esperar(() => !ana.document.getElementById('report').classList.contains('hidden'), { motivo: 'report da Ana' });
  assert.match(ana.document.getElementById('report').textContent, /Mostrar o caminho/);
  await fechar(ana);

  const bia = await abrirPopup({ chave: 'pnx_bia', server: SERVER, ultimoReport: guardado }, { nomePorChave: { pnx_bia: 'Bia' } });
  await dormir(80);
  assert.ok(bia.document.getElementById('report').classList.contains('hidden'), 'report da Ana não pode aparecer para a Bia');
  await fechar(bia);

  const outroServidor = await abrirPopup({ chave: 'pnx_ana', server: 'https://outro.exemplo.com', ultimoReport: guardado }, { nomePorChave: { pnx_ana: 'Ana' } });
  await dormir(80);
  assert.ok(outroServidor.document.getElementById('report').classList.contains('hidden'));
  await fechar(outroServidor);

  // Report antigo (versão anterior da extensão, sem "dono"): não mostra.
  const semDono = await abrirPopup({ chave: 'pnx_ana', server: SERVER, ultimoReport: { ...guardado, dono: undefined } });
  await dormir(80);
  assert.ok(semDono.document.getElementById('report').classList.contains('hidden'));
  await fechar(semDono);
});

test('A11: validar outra chave apaga o report guardado da pessoa anterior', async () => {
  const dono = await impressao('pnx_ana');
  const p = await abrirPopup(
    { chave: 'pnx_bia', server: SERVER, ultimoReport: { dados: REPORT, nome: 'Marcos', server: SERVER, dono, quando: 1, versao: 0 } },
    { nomePorChave: { pnx_bia: 'Bia' } }
  );
  await esperar(() => !p.storage.ultimoReport, { motivo: 'report removido ao validar outra chave' });
  assert.ok(p.document.getElementById('report').classList.contains('hidden'));
  await fechar(p);
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
  await fechar(p);

  // Popup reaberto: a versão editada é a que aparece.
  const reaberto = await abrirPopup(p.storage, { nomePorChave: { pnx_ana: 'Ana' } });
  await esperar(() => !reaberto.document.getElementById('report').classList.contains('hidden'), { motivo: 'report reaberto' });
  assert.match(reaberto.document.getElementById('report').textContent, /Mercado Livre/);
  await fechar(reaberto);
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
  await fechar(p);
});

// ---------------------------------------------------------------- .zip de hoje pelo popup
const respostaZip = (p, cabecalhos, status = 200, corpo = {}) => ({
  ok: status < 400,
  status,
  blob: async () => new p.w.Blob(['PK']),
  json: async () => corpo,
  headers: { get: (k) => cabecalhos[String(k).toLowerCase()] || null },
});

test('popup: "Baixar meus reports de hoje" baixa o .zip que o servidor montou (último de cada lead)', async () => {
  const pedidos = [];
  let p;
  p = await abrirPopup({ chave: 'pnx_ana', server: SERVER }, {
    nomePorChave: { pnx_ana: 'Ana' },
    zip: async (url, opts) => {
      pedidos.push({ url, opts });
      return respostaZip(p, { 'content-disposition': 'attachment; filename="Reports_Ana_28-09-2026.zip"', 'x-reports-no-zip': '3' });
    },
  });
  await pronto(p);
  p.document.getElementById('zipDia').click();
  await esperar(() => p.downloads.length === 1, { motivo: 'download do .zip' });
  assert.equal(pedidos[0].url, SERVER + '/api/meus-reports/zip');
  assert.equal(pedidos[0].opts.method, 'POST');
  assert.equal(pedidos[0].opts.headers['x-cr-key'], 'pnx_ana');
  assert.deepEqual(JSON.parse(pedidos[0].opts.body), {}, 'sem seleção: o servidor usa o último de cada lead');
  assert.equal(p.downloads[0].nome, 'Reports_Ana_28-09-2026.zip');
  await esperar(() => /baixado com 3 report/.test(p.document.getElementById('status').textContent), { motivo: 'status' });
  assert.equal(p.document.getElementById('zipDia').disabled, false);
  await fechar(p);
});

test('popup: sem report no dia, mostra o motivo e libera o botão', async () => {
  let p;
  p = await abrirPopup({ chave: 'pnx_ana', server: SERVER }, {
    nomePorChave: { pnx_ana: 'Ana' },
    zip: async () => respostaZip(p, {}, 400, { erro: 'Você não gerou nenhum report neste dia.' }),
  });
  await pronto(p);
  p.document.getElementById('zipDia').click();
  await esperar(() => /nenhum report neste dia/.test(p.document.getElementById('status').textContent), { motivo: 'erro na tela' });
  assert.equal(p.downloads.length, 0);
  assert.equal(p.document.getElementById('zipDia').disabled, false);
  await fechar(p);
});

test('popup: sem chave, nem chama o servidor', async () => {
  let chamou = false;
  const p = await abrirPopup({ chave: '', server: SERVER }, { zip: async () => { chamou = true; } });
  p.document.getElementById('zipDia').click();
  await dormir(30);
  assert.equal(chamou, false);
  assert.match(p.document.getElementById('status').textContent, /Cole a sua chave/);
  await fechar(p);
});

test('popup: clicar no .zip enquanto a chave ainda valida não perde a mensagem do .zip', async () => {
  let p;
  p = await abrirPopup({ chave: 'pnx_ana', server: SERVER }, {
    nomePorChave: { pnx_ana: 'Ana' },
    zip: async () => respostaZip(p, {}, 400, { erro: 'Você não gerou nenhum report neste dia.' }),
  });
  // Clica na hora, sem esperar o "Validando…" terminar.
  p.document.getElementById('zipDia').click();
  await pronto(p);
  await dormir(50);
  assert.match(p.document.getElementById('status').textContent, /nenhum report neste dia/);
  assert.equal(p.document.getElementById('sdrNome').textContent, 'Ana', 'o nome no topo continua sendo atualizado');
  await fechar(p);
});

test('popup: liga/desliga da ficha do RD Station fica salvo (ligado por padrão)', async () => {
  const p = await abrirPopup({ chave: 'pnx_ana', server: SERVER }, { nomePorChave: { pnx_ana: 'Ana' } });
  const caixa = p.document.getElementById('fichaCrm');
  assert.equal(caixa.checked, true);
  caixa.checked = false;
  caixa.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.equal(p.storage.fichaCrm, false);
  await fechar(p);

  const reaberto = await abrirPopup(p.storage, { nomePorChave: { pnx_ana: 'Ana' } });
  assert.equal(reaberto.document.getElementById('fichaCrm').checked, false);
  await fechar(reaberto);
});
