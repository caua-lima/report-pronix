'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { normalizar, pesquisas } = require('../public/js/contexto-lead-model');
const { gerarContextoPdf } = require('../src/contextoLeadPdf');
const base = () => ({ nome: 'João da Silva', email: 'joao@example.com', revisado: true, visao: 'Validar atuação com o lead.', fontes: [{ url: 'https://example.com/equipe', nota: 'Sócio da empresa, segundo a página.', data: '2026-01-01', confirmada: false }] });

test('pesquisas codificam entradas e não inventam perfis ou empresa pelo e-mail', () => {
  const links = pesquisas({ nome: 'João & Maria', email: 'nome@gmail.com' });
  assert.equal(links.length, 3);
  assert.ok(links.every((x) => new URL(x.url).origin === 'https://www.google.com'));
  assert.match(new URL(links[0].url).searchParams.get('q'), /João & Maria/);
  assert.equal(normalizar({ nome: 'Pessoa', email: 'p@gmail.com' }).empresa, '');
});

test('fontes inseguras, campos longos e datas inválidas são rejeitados', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,a', 'https://user:password@example.com']) {
    const d = base(); d.fontes[0].url = url; assert.throws(() => normalizar(d));
  }
  for (const data of ['2026-02-30', '2099-01-01', 'ontem']) {
    const d = base(); d.fontes[0].data = data; assert.throws(() => normalizar(d));
  }
  assert.throws(() => normalizar({ nome: 'a'.repeat(181) }));
  assert.throws(() => normalizar({ nome: 'Pessoa', fontes: Array(13).fill(base().fontes[0]) }));
});

test('não presume confirmação de identidade e exige revisão para o PDF', () => {
  assert.equal(normalizar(base()).fontes[0].confirmada, false);
  assert.throws(() => gerarContextoPdf({ ...base(), revisado: false }), /Revise/);
  assert.throws(() => normalizar({ nome: 'Lead', revisado: true }, true), /Adicione/);
});

test('PDF preserva textos longos em múltiplas páginas sem IA', async () => {
  const d = base(); d.visao = 'Detalhe importante para a reunião. '.repeat(170);
  const buffer = await gerarContextoPdf(d, 'Cauã Lima');
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok((buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 3);
});

test('painel gera links, escapa conteúdo da prévia e invalida revisão após alterações', () => {
  const html = fs.readFileSync('public/dashboard.html', 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://report-pronix.vercel.app/' });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(fs.readFileSync('public/js/contexto-lead-model.js', 'utf8'));
  w.eval(fs.readFileSync('public/js/contexto-lead.js', 'utf8'));
  const root = w.document.getElementById('aba-contexto');
  const form = root.querySelector('form');
  form.elements.nome.value = 'Lead <img src=x onerror=alert(1)>';
  form.elements.visao.value = 'Confirmar atuação.';
  root.querySelector('[data-buscar]').click();
  assert.equal(root.querySelectorAll('[data-pesquisas] a').length, 2);
  root.querySelector('[data-visualizar]').click();
  assert.equal(root.querySelector('[data-previa] img'), null);
  form.elements.revisado.checked = true;
  form.elements.revisado.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(root.querySelector('[data-pdf]').disabled, false);
  form.elements.visao.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(root.querySelector('[data-pdf]').disabled, true);
  assert.equal(form.elements.revisado.checked, false);
  assert.ok(html.includes("a === 'contexto' ||"));
  dom.window.close();
});

test('rota exige autenticação, devolve PDF e não faz consultas externas', async () => {
  const usuarios = require('../src/usuarios');
  const original = usuarios.porChave;
  const originalFetch = global.fetch;
  usuarios.porChave = async (key) => key === 'chave-teste' ? { nome: 'Cauã Lima' } : null;
  global.fetch = async () => { throw new Error('Consulta externa não permitida neste recurso'); };
  try {
    const app = require('../server');
    const route = app._router.stack.find((r) => r.route?.path === '/api/contexto-lead/pdf').route;
    async function call(key, body) {
      const req = { get: () => key, query: {}, body };
      const res = { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; }, set(k,v) { this.headers[k] = v; return this; }, json(v) { this.body = v; return this; } };
      let allowed = false;
      await route.stack[0].handle(req, res, () => { allowed = true; });
      if (allowed) await route.stack[1].handle(req, res);
      return res;
    }
    assert.equal((await call('', base())).statusCode, 401);
    assert.equal((await call('chave-teste', { ...base(), revisado: false })).statusCode, 400);
    const response = await call('chave-teste', base());
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.match(response.body.arquivo, /^contexto-pronix-/);
    assert.equal(Buffer.from(response.body.arquivoBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  } finally { usuarios.porChave = original; global.fetch = originalFetch; }
});

test('dashboard completo abre e alterna a nova aba sem quebrar o report', async () => {
  const html = fs.readFileSync('public/dashboard.html', 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://report-pronix.vercel.app/#contexto' });
  const w = dom.window;
  w.fetch = async () => ({ ok: true, json: async () => ({}) });
  w.AbortSignal.timeout = () => new w.AbortController().signal;
  try {
    for (const script of w.document.querySelectorAll('script')) {
      if (script.src) {
        const path = new URL(script.src).pathname;
        if (path.startsWith('/js/contexto-lead')) w.eval(fs.readFileSync('public' + path, 'utf8'));
      } else w.eval(script.textContent);
    }
    assert.equal(w.document.getElementById('aba-contexto').classList.contains('hidden'), false);
    w.document.querySelector('[data-aba="report"]').click();
    assert.equal(w.document.getElementById('aba-report').classList.contains('hidden'), false);
    w.document.querySelector('[data-aba="contexto"]').click();
    assert.equal(w.document.getElementById('tituloPagina').textContent, 'Pesquisar contexto do lead');
    assert.equal(typeof w.api, 'function');
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { dom.window.close(); }
});
