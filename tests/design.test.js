'use strict';
// Sistema visual do Report PRONIX (papel, tinta e marca-texto): o que não pode se desencontrar.
// Sem navegador: só confere os arquivos. A descrição do sistema está em docs/design.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8').replace(/\r\n/g, '\n');
const PAGINAS = ['public/dashboard.html', 'public/dia.html', 'public/privacidade.html', 'extension/popup.html'];
const tokensDe = (html) => {
  const m = /\/\* tokens:inicio[\s\S]*?\/\* tokens:fim \*\//.exec(html);
  return m ? m[0] : '';
};

test('as cores e letras do sistema são as mesmas no painel, no Report do Dia, na política e no popup', () => {
  const blocos = PAGINAS.map((f) => tokensDe(ler(f)));
  blocos.forEach((b, i) => assert.ok(b.length > 500, `${PAGINAS[i]} sem o bloco de tokens`));
  blocos.slice(1).forEach((b, i) => assert.equal(b, blocos[0], `${PAGINAS[i + 1]} com tokens diferentes do painel`));
  for (const nome of ['--f-titulo', '--ouro', '--marca', '--bg', '--card', '--text', '--muted', '--ok', '--danger']) {
    assert.ok(blocos[0].includes(nome + ':'), 'falta o token ' + nome);
  }
  assert.match(blocos[0], /:root\[data-tema="escuro"\]/, 'tema escuro escolhido à mão');
  assert.match(blocos[0], /:root:not\(\[data-tema="claro"\]\)/, 'tema claro escolhido à mão vence o do sistema');
});

test('nenhuma página guarda cor fora dos tokens (só a marca e o texto sobre âmbar são fixos)', () => {
  // Cores fixas permitidas: as da marca (logo) e a tinta sobre fundo âmbar.
  const PERMITIDAS = new Set(['#ffb800', '#18171b', '#45424b', '#1fbf5c', '#fff', '#ffffff']);
  for (const f of PAGINAS) {
    const semTokens = ler(f).replace(tokensDe(ler(f)), '');
    // 6 dígitos, ou 3 quando não é começo de um id/âncora (como "#aba-report").
    const achadas = semTokens.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}(?![0-9a-zA-Z_-])/g) || [];
    const fora = [...new Set(achadas.map((c) => c.toLowerCase()))].filter((c) => !PERMITIDAS.has(c));
    assert.deepEqual(fora, [], `${f}: cor solta, use um token`);
  }
});

test('a marca é a folha com o selo: o raio antigo não aparece mais em lugar nenhum', () => {
  const RAIO = 'M18.2 2.5 L8.5 16.8';
  for (const f of [...PAGINAS, 'extension/content.js', 'extension/content-instagram.js']) {
    assert.ok(!ler(f).includes(RAIO), `${f} ainda desenha o raio`);
  }
  for (const f of PAGINAS) assert.match(ler(f), /class="logo-rp"/, `${f} sem a marca`);
  assert.ok(!/RAIO|desenharRaio/.test(ler('src/generatePdf.js')), 'o PDF usa a marca nova');
  assert.match(ler('src/generatePdf.js'), /function desenharMarca/);
});

test('os cartões da extensão usam a paleta tinta — nada do azul-marinho antigo', () => {
  const ANTIGAS = ['#16212e', '#0d141c', '#26333f', '#8b98a5', '#e6edf3', '#ffc400', '#25d366'];
  for (const f of ['extension/content.js', 'extension/content-instagram.js']) {
    const s = ler(f).toLowerCase();
    ANTIGAS.forEach((c) => assert.ok(!s.includes(c), `${f} ainda usa ${c}`));
    assert.ok(s.includes('#1a191c') && s.includes('#ffc233'), `${f} com a paleta nova`);
    assert.ok(!s.includes('border-left:4px solid'), `${f}: a cor do cartão fica na faixa de cima`);
  }
});

test('o painel tem o botão de tema, o título da página e o menu em grupos', () => {
  const html = ler('public/dashboard.html');
  assert.match(html, /id="tema"/);
  assert.match(html, /id="tituloPagina"/);
  assert.equal((html.match(/class="grupo-rotulo"/g) || []).length, 3);
  // Toda aba do menu tem título e descrição para o topo da página.
  const abas = [...html.matchAll(/class="tab[^"]*" data-aba="([a-z]+)"/g)].map((m) => m[1]);
  const paginas = /const PAGINAS = \{([\s\S]*?)\n {4}\};/.exec(html)[1];
  abas.forEach((a) => assert.match(paginas, new RegExp(`\\b${a}: \\['`), 'aba sem título: ' + a));
});

test('o script do painel não tem erro de sintaxe (um erro ali deixa a tela inteira sem funcionar)', () => {
  const vm = require('vm');
  const blocos = [...ler('public/dashboard.html').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocos.length >= 2);
  blocos.forEach((codigo) => assert.doesNotThrow(() => new vm.Script(codigo)));
});
