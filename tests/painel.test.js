'use strict';
// O painel REAL (public/dashboard.html) em jsdom, com uma API falsa: garante que a página inicia sem erro
// de script e que cada fluxo do dia a dia funciona (gerar, duplicado, áudio/print, números, acessos).
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { esperar, dormir } = require('./helpers/dom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const CHAVE_ANA = 'pnx_AnaAna1234567890abcdWXYZ';

// ---------------------------------------------------------------- API falsa
function criarApi(padroes = {}) {
  const pedidos = [];
  const handlers = new Map();
  const api = {
    pedidos,
    /** Registra/troca o handler de "METODO /caminho". O handler recebe {corpo, url, query} e devolve {status?, corpo}. */
    quando(chave, fn) {
      handlers.set(chave, fn);
      return api;
    },
    contar: (chave) => pedidos.filter((p) => p.chave === chave).length,
    corpos: (chave) => pedidos.filter((p) => p.chave === chave).map((p) => p.corpo),
    async rota(url, opts = {}) {
      const u = new URL(url, 'https://report-closer.vercel.app');
      const chave = `${(opts.method || 'GET').toUpperCase()} ${u.pathname}`;
      const corpo = opts.body ? JSON.parse(opts.body) : undefined;
      pedidos.push({ chave, corpo, query: u.searchParams });
      const h = handlers.get(chave) || [...handlers].find(([k]) => new RegExp('^' + k + '$').test(chave))?.[1];
      if (!h) return resposta(404, { erro: 'rota sem handler no teste: ' + chave });
      const r = await h({ corpo, url: u, query: u.searchParams });
      return resposta(r.status || 200, r.corpo);
    },
  };
  Object.entries(padroes).forEach(([k, fn]) => api.quando(k, fn));
  return api;
}
const resposta = (status, corpo) => ({
  ok: status < 400,
  status,
  headers: { get: () => '' },
  json: async () => corpo,
  blob: async () => ({}),
});

const statsVazio = (extra = {}) => ({
  total: 0, custo: 0, custoMedio: 0, consumoExcluido: { total: 0, custo: 0 },
  porUsuario: [], porCloser: [], porDia: [], ultimos: [],
  geral: { hoje: 0, custoMes: 0, total: 0, custo: 0, mediaDiaria: 0, mediaMensal: 0, porMes: [], sdrs: [], consumoExcluido: { total: 0, custo: 0 } },
  ...extra,
});
const reportNaTabela = (extra = {}) => ({
  id: 'r1', lead: 'Marcos', usuarioNome: 'Ana', origem: 'extensao', quando: '2026-09-10T15:00:00.000Z', custo: 0.05,
  closerId: '', resultado: '', leadEmail: '', dataReuniao: '', dataFechamento: '', diasParaFechar: null, versao: 2, ...extra,
});

/** API base: /api/eu (papel configurável) e listas vazias — cada teste sobrescreve o que precisa. */
function apiBase({ papel = 'admin', nome = 'Chefe', usuarios = [], closers = [], stats = statsVazio() } = {}) {
  return criarApi({
    'GET /api/eu': () => ({ corpo: { ok: true, nome, id: '1', papel } }),
    'GET /api/admin/usuarios': () => ({ corpo: { usuarios } }),
    'GET /api/admin/closers': () => ({ corpo: { closers } }),
    'GET /api/admin/stats': () => ({ corpo: stats }),
    'GET /api/admin/base': () => ({ corpo: {} }),
    'POST /api/estimar-custo': () => ({ corpo: { custoUsdEstimado: 0.01, custoBrlEstimado: 0.05 } }),
  });
}

// ---------------------------------------------------------------- páginas
function abrirPainel(api, { hash = '', chave = CHAVE_ANA, session = {} } = {}) {
  const erros = [];
  const downloads = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => erros.push(e.message));
  const dom = new JSDOM(HTML, {
    url: 'https://report-closer.vercel.app/' + hash,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('crChave', chave);
      Object.entries(session).forEach(([k, v]) => w.sessionStorage.setItem(k, v));
      const st = w.setTimeout.bind(w);
      w.setTimeout = (fn, ms, ...a) => st(fn, Math.min(ms || 0, 20), ...a); // debounces/toasts viram rápidos
      w.fetch = (url, opts) => api.rota(url, opts);
      if (!w.AbortSignal.timeout) w.AbortSignal.timeout = () => new w.AbortController().signal;
      w.confirm = () => true;
      w.URL.createObjectURL = () => 'blob:teste';
      w.HTMLElement.prototype.scrollIntoView = function () {};
      Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
      });
      w.HTMLAnchorElement.prototype.click = function () {
        downloads.push({ href: this.href, nome: this.download });
      };
    },
  });
  const w = dom.window;
  return { w, document: w.document, erros, downloads, fechar: () => w.close(), $: (id) => w.document.getElementById(id) };
}

const visivel = (el) => !el.classList.contains('hidden');
const aberto = async (p) => esperar(() => /Conectado como/.test(p.$('statusChave').textContent), { motivo: 'chave validada' });

// ---------------------------------------------------------------- inicialização
test('o painel inicia sem erro de script e um SDR não dispara nenhuma rota de admin', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' });
  const p = abrirPainel(api);
  await aberto(p);
  await dormir(60);
  assert.deepEqual(p.erros, []);
  assert.equal(api.pedidos.filter((x) => x.chave.includes('/api/admin/')).length, 0);
  assert.ok(visivel(p.$('aba-report')));
  p.fechar();
});

test('A12: nome com HTML vindo do servidor nunca vira elemento na tela', async () => {
  const api = apiBase({ papel: 'admin', nome: '<img src=x onerror=alert(1)>' });
  const p = abrirPainel(api);
  await aberto(p);
  assert.equal(p.$('statusChave').querySelector('img'), null);
  assert.equal(p.$('quem').querySelector('img'), null);
  assert.match(p.$('statusChave').textContent, /<img src=x/);
  p.fechar();
});

test('A14: a senha reserva de admin não fica no sessionStorage (e valor antigo é apagado)', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/admin/login', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos', session: { adminPass: 'velha-senha' } });
  await aberto(p);
  assert.equal(p.w.sessionStorage.getItem('adminPass'), null, 'valor de versões antigas removido');
  p.document.querySelector('.senha-admin').value = 'senha-reserva';
  p.document.querySelector('.entrar-admin').click();
  await esperar(() => api.contar('POST /api/admin/login') === 1, { motivo: 'login reserva' });
  await dormir(40);
  assert.equal(p.w.sessionStorage.getItem('adminPass'), null);
  p.fechar();
});

// ---------------------------------------------------------------- A16: abas sob demanda
test('A16: abrir Números carrega só closers e números; cada aba carrega o que é dela', async () => {
  const api = apiBase({ stats: statsVazio({ ultimos: [reportNaTabela()] }) });
  const p = abrirPainel(api, { hash: '#numeros' });
  await esperar(() => p.$('ultimos').textContent.includes('Marcos'), { motivo: 'tabela de números' });
  await dormir(40);
  assert.equal(api.contar('GET /api/admin/closers'), 1);
  assert.equal(api.contar('GET /api/admin/stats'), 1);
  assert.equal(api.contar('GET /api/admin/usuarios'), 0);
  assert.equal(api.contar('GET /api/admin/base'), 0);

  p.document.querySelector('.tab[data-aba="acessos"]').click();
  await esperar(() => api.contar('GET /api/admin/usuarios') === 1, { motivo: 'aba acessos' });
  assert.equal(api.contar('GET /api/admin/stats'), 1, 'números não são baixados de novo');
  assert.equal(api.contar('GET /api/admin/base'), 0);

  p.document.querySelector('.tab[data-aba="base"]').click();
  await esperar(() => api.contar('GET /api/admin/base') === 1, { motivo: 'aba base' });
  await esperar(() => /Nada cadastrado|Última atualização/.test(p.$('statusBase').textContent), { motivo: 'base carregada' });
  assert.equal(api.contar('GET /api/admin/usuarios'), 1);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

// ---------------------------------------------------------------- A14: chaves mascaradas
test('A14: a lista de acessos mostra a chave mascarada; clicar mostra/oculta; copiar usa a inteira', async () => {
  const chaveSdr = 'pnx_SdrSdr1234567890abcdefgh';
  const api = apiBase({ usuarios: [{ id: 'u1', nome: 'Bia', papel: 'sdr', chave: chaveSdr, criadoEm: '2026-09-01T10:00:00Z' }] });
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Bia'), { motivo: 'lista de acessos' });
  assert.ok(!p.$('lista').textContent.includes(chaveSdr), 'a chave inteira não aparece na tela');
  const span = p.$('lista').querySelector('.chave');
  assert.equal(span.textContent, 'pnx_Sd…efgh');
  span.click();
  assert.equal(span.textContent, chaveSdr);
  span.click();
  assert.equal(span.textContent, 'pnx_Sd…efgh');
  assert.equal(p.$('lista').querySelector('[data-copiar]').dataset.copiar, chaveSdr);
  p.fechar();
});

// ---------------------------------------------------------------- A15 / A21: números
test('A21: mostra o consumo dos reports excluídos e marca captura parcial', async () => {
  const stats = statsVazio({
    ultimos: [reportNaTabela({ captura: { plataforma: 'whatsapp', mensagens: 10, audios: 3, audiosTranscritos: 1, incompleta: true } })],
  });
  stats.geral.consumoExcluido = { total: 2, custo: 0.1234 };
  stats.geral.custo = 1;
  const p = abrirPainel(apiBase({ stats }), { hash: '#numeros' });
  await esperar(() => p.$('ultimos').textContent.includes('captura parcial'), { motivo: 'chip de captura' });
  assert.ok(visivel(p.$('consumoExcluido')));
  assert.match(p.$('consumoExcluido').textContent, /2 report\(s\) excluído\(s\)/);
  assert.match(p.$('consumoExcluido').textContent, /\$0[.,]12/);
  assert.match(p.$('ultimos').querySelector('.tag[title]').title, /1 de 3/);
  p.fechar();
});

test('A21: sem reports excluídos, a linha de consumo fica escondida', async () => {
  const p = abrirPainel(apiBase(), { hash: '#numeros' });
  await esperar(() => p.$('statusFiltro').textContent.includes('report(s)'), { motivo: 'números carregados' });
  assert.ok(!visivel(p.$('consumoExcluido')));
  p.fechar();
});

test('A15: editar um campo envia só ele + a versão; duas edições seguidas esperam a versão nova', async () => {
  let versao = 2;
  const api = apiBase({ closers: [{ id: 'c1', nome: 'Closer Um', email: '' }] });
  api.quando('GET /api/admin/stats', () => ({ corpo: statsVazio({ ultimos: [reportNaTabela({ versao })] }) }));
  api.quando('PATCH /api/admin/reports/r1/resultado', async () => {
    await dormir(30); // o servidor demora: a 2ª edição precisa esperar a 1ª terminar
    versao++;
    return { corpo: { ok: true, versao } };
  });
  const p = abrirPainel(api, { hash: '#numeros' });
  await esperar(() => p.$('ultimos').textContent.includes('Marcos'), { motivo: 'tabela' });

  const escolher = (campo, valor) => {
    const el = p.document.querySelector(`tr[data-linha-report="r1"] [data-campo="${campo}"]`);
    el.value = valor;
    el.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  };
  escolher('closerId', 'c1');
  escolher('resultado', 'venda_call'); // no mesmo instante
  await esperar(() => api.contar('PATCH /api/admin/reports/r1/resultado') === 2, { motivo: 'dois PATCH' });

  assert.deepEqual(api.corpos('PATCH /api/admin/reports/r1/resultado'), [
    { closerId: 'c1', versao: 2 },
    { resultado: 'venda_call', versao: 3 },
  ]);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('A15: conflito (409) avisa e recarrega a tela em vez de sobrescrever', async () => {
  const api = apiBase({ stats: statsVazio({ ultimos: [reportNaTabela()] }) });
  api.quando('PATCH /api/admin/reports/r1/resultado', () => ({ status: 409, corpo: { erro: 'alterado por outra pessoa', atual: {} } }));
  const p = abrirPainel(api, { hash: '#numeros' });
  await esperar(() => p.$('ultimos').textContent.includes('Marcos'), { motivo: 'tabela' });
  const antes = api.contar('GET /api/admin/stats');
  const el = p.document.querySelector('tr[data-linha-report="r1"] [data-campo="resultado"]');
  el.value = 'venda_fup';
  el.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('GET /api/admin/stats') > antes, { motivo: 'recarga após conflito' });
  assert.match(p.$('toast').textContent, /Outra pessoa alterou/);
  p.fechar();
});

// ---------------------------------------------------------------- gerar: A08 / A09
const RELATORIO = {
  lead: 'Marcos',
  resumo: [{ rotulo: 'Investimento', valor: 'Fatura 20 mil' }],
  secoes: [{ titulo: 'O que o closer deve bater', numerada: true, itens: ['Mostrar o caminho'] }],
  citacoes: [], abertura: 'Oi Marcos', frase_impacto: 'Ele decidiu',
};
const EXISTENTE = { id: 'abc123', quando: '2026-09-10T15:00:00.000Z', lead: 'Marcos', arquivo: 'Report_Marcos.pdf', podeAbrir: true };

async function painelSdrComTexto(api, texto = 'VENDEDOR: oi\nLEAD: quero escalar') {
  const p = abrirPainel(api);
  await aberto(p);
  p.$('texto').value = texto;
  return p;
}

test('A08: clique duplo em "Gerar" faz uma requisição só, e o botão trava até terminar', async () => {
  let liberar;
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/report-texto', () => new Promise((r) => { liberar = () => r({ corpo: { dados: RELATORIO } }); }));
  const p = await painelSdrComTexto(api);

  p.$('gerar').click();
  await esperar(() => api.contar('POST /api/report-texto') === 1, { motivo: 'geração iniciada' });
  assert.equal(p.$('gerar').disabled, true);
  p.$('gerar').click();
  p.$('gerar').click();
  await dormir(30);
  assert.equal(api.contar('POST /api/report-texto'), 1);

  liberar();
  await esperar(() => visivel(p.$('resultado')), { motivo: 'report na tela' });
  assert.equal(p.$('gerar').disabled, false);
  assert.match(p.$('report').textContent, /Mostrar o caminho/);
  p.fechar();
});

test('A08: falha de rede reativa o botão e mostra o erro', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/report-texto', () => ({ status: 500, corpo: { erro: 'A IA caiu' } }));
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => /A IA caiu/.test(p.$('status').textContent), { motivo: 'erro na tela' });
  assert.equal(p.$('gerar').disabled, false);
  p.fechar();
});

test('A19: se o servidor estoura o tempo, aparece uma mensagem clara e o botão volta', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/report-texto', () => { const e = new Error('x'); e.name = 'TimeoutError'; throw e; });
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => /demorou demais/.test(p.$('status').textContent), { motivo: 'mensagem de tempo esgotado' });
  assert.equal(p.$('gerar').disabled, false);
  p.fechar();
});

test('A09: duplicado mostra as opções; "Abrir o existente" baixa o PDF sem chamar a IA', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' })
    .quando('POST /api/report-texto', () => ({ corpo: { duplicado: true, existente: EXISTENTE } }))
    .quando('GET /api/reports/abc123/pdf', () => ({ corpo: { arquivo: 'Report_Marcos.pdf', arquivoBase64: 'QUJD' } }));
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => visivel(p.$('duplicadoBox')), { motivo: 'aviso de duplicado' });
  assert.match(p.$('duplicadoTexto').textContent, /Já existe um report igual pra Marcos/);
  assert.equal(p.$('gerar').disabled, false, 'o botão não fica travado esperando');
  assert.ok(visivel(p.$('dupAbrir')));

  p.$('dupAbrir').click();
  await esperar(() => p.downloads.length === 1, { motivo: 'download do existente' });
  assert.equal(p.downloads[0].href, 'data:application/pdf;base64,QUJD');
  assert.equal(p.downloads[0].nome, 'Report_Marcos.pdf');
  assert.equal(api.contar('POST /api/report-texto'), 1, 'nenhuma nova geração');
  assert.ok(!visivel(p.$('duplicadoBox')));
  p.fechar();
});

test('A09: duplicado de outra pessoa não oferece abrir; "Gerar de novo" manda forcarNovo', async () => {
  let primeira = true;
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/report-texto', ({ corpo }) => {
    if (primeira && !corpo.forcarNovo) { primeira = false; return { corpo: { duplicado: true, existente: { ...EXISTENTE, podeAbrir: false } } }; }
    return { corpo: { dados: RELATORIO } };
  });
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => visivel(p.$('duplicadoBox')), { motivo: 'aviso de duplicado' });
  assert.ok(!visivel(p.$('dupAbrir')));

  p.$('dupGerar').click();
  await esperar(() => visivel(p.$('resultado')), { motivo: 'report novo' });
  assert.deepEqual(api.corpos('POST /api/report-texto').map((c) => !!c.forcarNovo), [false, true]);
  assert.ok(!visivel(p.$('duplicadoBox')));
  p.fechar();
});

test('A09: "Cancelar" esconde o aviso e não gera nada', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/report-texto', () => ({ corpo: { duplicado: true, existente: EXISTENTE } }));
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => visivel(p.$('duplicadoBox')), { motivo: 'aviso' });
  p.$('dupCancelar').click();
  assert.ok(!visivel(p.$('duplicadoBox')));
  assert.equal(api.contar('POST /api/report-texto'), 1);
  p.fechar();
});

// ---------------------------------------------------------------- A07 / A17: áudio e print
function soltarArquivos(p, idInput, arquivos) {
  const input = p.$(idInput);
  Object.defineProperty(input, 'files', { configurable: true, value: arquivos });
  input.dispatchEvent(new p.w.Event('change', { bubbles: true }));
}

test('A07: enquanto lê o áudio o botão fica travado; a transcrição entra com quem falou', async () => {
  let liberar;
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/transcrever', () => new Promise((r) => { liberar = () => r({ corpo: { texto: 'quero começar em outubro' } }); }));
  const p = abrirPainel(api);
  await aberto(p);
  p.$('quemAudio').value = 'VENDEDOR';
  soltarArquivos(p, 'audio', [new p.w.File([new Uint8Array([1, 2, 3])], 'voz.ogg', { type: 'audio/ogg' })]);
  await esperar(() => api.contar('POST /api/transcrever') === 1, { motivo: 'transcrição iniciada' });

  assert.equal(p.$('gerar').disabled, true);
  assert.match(p.$('gerar').textContent, /Aguarde/);
  p.$('texto').value = 'LEAD: oi';
  p.$('gerar').click(); // desativado: nada acontece
  assert.equal(api.contar('POST /api/report-texto'), 0);

  liberar();
  await esperar(() => p.$('texto').value.includes('quero começar em outubro'), { motivo: 'áudio na conversa' });
  assert.match(p.$('texto').value, /VENDEDOR \(áudio\): quero começar em outubro/);
  assert.equal(p.$('gerar').disabled, false);
  assert.equal(p.$('gerar').textContent, 'Gerar Report');
  await esperar(() => api.contar('POST /api/estimar-custo') >= 1, { motivo: 'estimativa recalculada (A17)' });
  p.fechar();
});

test('A07: por padrão o áudio é do lead', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/transcrever', () => ({ corpo: { texto: 'oi tudo bem' } }));
  const p = abrirPainel(api);
  await aberto(p);
  soltarArquivos(p, 'audio', [new p.w.File([new Uint8Array([1])], 'voz.ogg', { type: 'audio/ogg' })]);
  await esperar(() => p.$('texto').value.includes('oi tudo bem'), { motivo: 'áudio na conversa' });
  assert.match(p.$('texto').value, /^LEAD \(áudio\): oi tudo bem/);
  p.fechar();
});

test('A17: uma estimativa antiga que volta depois não sobrescreve a mais nova', async () => {
  const respostas = [];
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/estimar-custo', () => new Promise((r) => respostas.push(r)));
  const p = abrirPainel(api);
  await aberto(p);
  const digitar = (v) => { p.$('texto').value = v; p.$('texto').dispatchEvent(new p.w.Event('input', { bubbles: true })); };
  digitar('primeira versão');
  await esperar(() => respostas.length === 1, { motivo: '1ª estimativa' });
  digitar('segunda versão');
  await esperar(() => respostas.length === 2, { motivo: '2ª estimativa' });

  respostas[1]({ corpo: { custoUsdEstimado: 0.0002, custoBrlEstimado: 0.001 } }); // a nova chega primeiro
  await esperar(() => /0\.0002/.test(p.$('estimativaCusto').textContent), { motivo: 'estimativa nova' });
  respostas[0]({ corpo: { custoUsdEstimado: 9.9999, custoBrlEstimado: 50 } }); // a velha chega atrasada
  await dormir(40);
  assert.match(p.$('estimativaCusto').textContent, /0\.0002/);
  assert.doesNotMatch(p.$('estimativaCusto').textContent, /9\.9999/);
  p.fechar();
});

// ---------------------------------------------------------------- A18: print comprido
test('A18: print normal de celular só é reduzido; página longa é fatiada com sobreposição', async () => {
  const p = abrirPainel(apiBase({ papel: 'sdr', nome: 'Ana' }));
  await aberto(p);
  const { planejarFatias } = p.w;

  assert.equal(planejarFatias(720, 1600), null, 'já cabe');
  assert.equal(planejarFatias(1290, 2796), null, 'iPhone: reduzir ainda fica legível');
  assert.equal(planejarFatias(1179, 2556), null);

  const longo = planejarFatias(1080, 10000);
  assert.ok(longo, 'página longa é fatiada');
  assert.equal(longo.larg, 1080);
  assert.ok(longo.fatias.length >= 7);
  assert.equal(longo.fatias[0].y, 0);
  const ultima = longo.fatias.at(-1);
  assert.equal(ultima.y + ultima.h, 10000, 'cobre a imagem até o fim');
  longo.fatias.slice(1).forEach((f, i) => assert.ok(f.y < longo.fatias[i].y + longo.fatias[i].h, 'cada fatia repete um pedaço da anterior'));
  longo.fatias.forEach((f) => assert.ok(f.h <= 1400));

  const largo = planejarFatias(2160, 12000); // largura maior que 1080 é reduzida a 1080
  assert.equal(largo.larg, 1080);
  assert.equal(largo.escala, 0.5);
  p.fechar();
});

test('A18: junta o texto das fatias sem repetir as linhas da sobreposição', async () => {
  const p = abrirPainel(apiBase({ papel: 'sdr', nome: 'Ana' }));
  await aberto(p);
  const { mesclarLinhas } = p.w;
  const a = 'LEAD: oi\nVENDEDOR: tudo bem?\nLEAD: quero escalar';
  const b = 'VENDEDOR: tudo bem?\nLEAD: quero escalar\nVENDEDOR: quanto fatura?';
  assert.equal(mesclarLinhas(a, b), 'LEAD: oi\nVENDEDOR: tudo bem?\nLEAD: quero escalar\nVENDEDOR: quanto fatura?');
  // Diferença de caixa/pontuação na leitura da mesma linha ainda é reconhecida.
  assert.equal(mesclarLinhas('LEAD: Quero escalar!', 'lead quero escalar\nVENDEDOR: ok'), 'LEAD: Quero escalar!\nVENDEDOR: ok');
  // Sem sobreposição: tudo é mantido.
  assert.equal(mesclarLinhas('LEAD: a', 'VENDEDOR: b'), 'LEAD: a\nVENDEDOR: b');
  p.fechar();
});

// ---------------------------------------------------------------- A10: rascunho
test('A10: o report editado sobrevive a recarregar a página e só volta para a mesma chave', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/report-texto', () => ({ corpo: { dados: RELATORIO } }));
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => visivel(p.$('resultado')), { motivo: 'report na tela' });

  const campo = p.document.querySelector('[data-edit="secoes.0.itens.0"]');
  campo.textContent = 'Mostrar o caminho do Mercado Livre (editado)';
  campo.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  await esperar(() => (p.w.sessionStorage.getItem('crRascunho') || '').includes('(editado)'), { motivo: 'rascunho gravado' });
  const guardado = p.w.sessionStorage.getItem('crRascunho');
  assert.ok(!guardado.includes(CHAVE_ANA), 'a chave nunca vai dentro do rascunho');
  p.fechar();

  const volta = abrirPainel(apiBase({ papel: 'sdr', nome: 'Ana' }), { session: { crRascunho: guardado } });
  await esperar(() => visivel(volta.$('resultado')), { motivo: 'rascunho restaurado' });
  assert.match(volta.$('report').textContent, /\(editado\)/);
  assert.match(volta.$('status').textContent, /restaurado/i);
  await aberto(volta); // não fecha a janela com a validação da chave ainda pendente
  volta.fechar();

  const outra = abrirPainel(apiBase({ papel: 'sdr', nome: 'Bia' }), { chave: 'pnx_OutraPessoa1234567890', session: { crRascunho: guardado } });
  await aberto(outra);
  await dormir(40);
  assert.ok(!visivel(outra.$('resultado')), 'report de outra pessoa não aparece');
  outra.fechar();
});
