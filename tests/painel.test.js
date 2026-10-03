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
      return resposta(r.status || 200, r.corpo, r.headers);
    },
  };
  Object.entries(padroes).forEach(([k, fn]) => api.quando(k, fn));
  return api;
}
const resposta = (status, corpo, headers = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] || '' },
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
function apiBase({ papel = 'master', nome = 'Chefe', usuarios = [], closers = [], stats = statsVazio() } = {}) {
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
  const api = apiBase({ papel: 'master', nome: '<img src=x onerror=alert(1)>' });
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
  await esperar(() => /Base carregada|base recomendada|Última atualização/.test(p.$('statusBase').textContent), { motivo: 'base carregada' });
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
  stats.qualidade = { taxaCache: 0.634, comCaptura: 10, capturaParcial: 2, citacoesRemovidas: 1 };
  const p = abrirPainel(apiBase({ stats }), { hash: '#numeros' });
  await esperar(() => p.$('ultimos').textContent.includes('captura parcial'), { motivo: 'chip de captura' });
  assert.ok(visivel(p.$('consumoExcluido')));
  assert.match(p.$('consumoExcluido').textContent, /2 report\(s\) excluído\(s\)/);
  assert.match(p.$('consumoExcluido').textContent, /\$0[.,]12/);
  assert.match(p.$('ultimos').querySelector('.tag[title]').title, /1 de 3/);
  assert.match(p.$('baselineInfo').textContent, /63% da entrada veio do cache/);
  assert.match(p.$('baselineInfo').textContent, /captura parcial em 2 de 10/);
  assert.match(p.$('baselineInfo').textContent, /1 citação\(ões\) removida/);
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

// ---------------------------------------------------------------- Reports do dia (.zip para o líder)
const DIA = {
  dia: '2026-09-28', total: 4, leads: 2,
  reports: [
    { id: 'a1', lead: 'Rafael', contato: '+55 11 98888-7777', quando: '2026-09-28T13:00:00.000Z', origem: 'extensao', usar: false, substituidoPor: 'a3', geracoes: 3 },
    { id: 'a2', lead: 'Rafael', contato: '+55 11 98888-7777', quando: '2026-09-28T14:00:00.000Z', origem: 'extensao', usar: false, substituidoPor: 'a3', geracoes: 3 },
    { id: 'a3', lead: 'Rafael', contato: '+55 11 98888-7777', quando: '2026-09-28T15:30:00.000Z', origem: 'extensao', usar: true, substituidoPor: null, geracoes: 3 },
    { id: 'b1', lead: 'Júlia <b>', contato: 'Júlia', quando: '2026-09-28T16:00:00.000Z', origem: 'manual', usar: true, substituidoPor: null, geracoes: 1 },
  ],
};
const apiDoDia = () =>
  apiBase({ papel: 'sdr', nome: 'Ana' })
    .quando('GET /api/meus-reports', () => ({ corpo: DIA }))
    .quando('POST /api/meus-reports/zip', () => ({
      corpo: {},
      headers: { 'content-disposition': 'attachment; filename="Reports_Ana_28-09-2026.zip"', 'x-reports-no-zip': '2', 'x-reports-sem-pdf': '0' },
    }));
const caixa = (p, id) => p.document.querySelector(`[data-meu="${id}"]`);

test('Reports do dia: a aba aparece para o SDR e marca só o último de cada lead', async () => {
  const api = apiDoDia();
  const p = abrirPainel(api, { hash: '#dia' });
  await esperar(() => p.$('listaMeus').querySelectorAll('tr').length === 4, { motivo: 'lista do dia' });
  assert.ok(visivel(p.$('aba-dia')), 'SDR (não admin) abre a aba');
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="dia"]')));
  assert.deepEqual(['a1', 'a2', 'a3', 'b1'].map((id) => caixa(p, id).checked), [false, false, true, true]);
  assert.match(p.$('listaMeus').textContent, /refeito — vale o das/);
  assert.match(p.$('listaMeus').textContent, /o último de 3 gerados/);
  assert.equal(p.$('listaMeus').querySelector('b'), null, 'nome do lead não vira HTML');
  assert.match(p.$('statusMeus').textContent, /4 report\(s\) gerado\(s\) · 2 lead\(s\) · o \.zip leva 2 \(2 refeito\(s\) ficam de fora\)/);
  assert.equal(api.pedidos.filter((x) => x.chave.includes('/api/admin/')).length, 0);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Reports do dia: baixar manda os marcados e baixa o .zip com o nome do servidor', async () => {
  const api = apiDoDia();
  const p = abrirPainel(api, { hash: '#dia' });
  await esperar(() => p.$('listaMeus').querySelectorAll('tr').length === 4, { motivo: 'lista do dia' });

  // O SDR prefere a 2ª versão do Rafael: marca a2 e desmarca a3.
  caixa(p, 'a2').checked = true;
  caixa(p, 'a2').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  caixa(p, 'a3').checked = false;
  caixa(p, 'a3').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.match(p.$('statusMeus').textContent, /o \.zip leva 2/);

  p.$('baixarMeus').click();
  await esperar(() => p.downloads.length === 1, { motivo: 'download do .zip' });
  assert.deepEqual(api.corpos('POST /api/meus-reports/zip'), [{ dia: '2026-09-28', ids: ['a2', 'b1'] }]);
  assert.equal(p.downloads[0].nome, 'Reports_Ana_28-09-2026.zip');
  assert.match(p.$('statusMeus').textContent, /\.zip baixado com 2 report\(s\)/);
  assert.equal(p.$('baixarMeus').disabled, false);
  p.fechar();
});

test('Reports do dia: nada marcado não chama o servidor; erro do servidor aparece e o botão volta', async () => {
  const api = apiDoDia();
  const p = abrirPainel(api, { hash: '#dia' });
  await esperar(() => p.$('listaMeus').querySelectorAll('tr').length === 4, { motivo: 'lista do dia' });
  p.document.querySelectorAll('[data-meu]').forEach((c) => { c.checked = false; });
  p.$('baixarMeus').click();
  assert.match(p.$('statusMeus').textContent, /Marque pelo menos um/);
  assert.equal(api.contar('POST /api/meus-reports/zip'), 0);

  caixa(p, 'b1').checked = true;
  api.quando('POST /api/meus-reports/zip', () => ({ status: 404, corpo: { erro: 'O PDF desses reports não está guardado.' } }));
  p.$('baixarMeus').click();
  await esperar(() => /não está guardado/.test(p.$('statusMeus').textContent), { motivo: 'erro na tela' });
  assert.equal(p.$('baixarMeus').disabled, false);
  assert.equal(p.downloads.length, 0);
  p.fechar();
});

test('Reports do dia: trocar a data recarrega a lista daquele dia', async () => {
  const api = apiDoDia();
  const p = abrirPainel(api, { hash: '#dia' });
  await esperar(() => api.contar('GET /api/meus-reports') === 1, { motivo: 'primeira carga' });
  p.$('diaMeus').value = '2026-09-25';
  p.$('diaMeus').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('GET /api/meus-reports') === 2, { motivo: 'recarga' });
  const ultimo = api.pedidos.filter((x) => x.chave === 'GET /api/meus-reports').at(-1);
  assert.equal(ultimo.query.get('dia'), '2026-09-25');
  await esperar(() => p.$('listaMeus').querySelectorAll('tr').length === 4, { motivo: 'lista renderizada' });
  await esperar(() => p.$('statusMeus').textContent.includes('report(s) gerado'), { motivo: 'última carga terminou' });
  await dormir(40);
  p.fechar();
});

test('Arquivos (admin): o .zip vai com "só o último de cada lead" por padrão, e dá pra desligar', async () => {
  const api = apiBase({ stats: statsVazio({ porUsuario: [{ nome: 'Ana', total: 3, custo: 0.1, entrada: 1, saida: 1 }] }) });
  api.quando('GET /api/admin/reports/pdf-zip', () => ({ corpo: {} }));
  const p = abrirPainel(api, { hash: '#arquivos' });
  await esperar(() => p.$('porSdrArquivos').textContent.includes('Ana'), { motivo: 'aba arquivos' });
  assert.equal(p.$('soUltimoArq').checked, true);

  p.$('baixarZipTudo').click();
  await esperar(() => api.contar('GET /api/admin/reports/pdf-zip') === 1, { motivo: 'zip com ultimo' });
  p.document.querySelector('[data-baixar-zip-sdr]').click();
  await esperar(() => api.contar('GET /api/admin/reports/pdf-zip') === 2, { motivo: 'zip do SDR' });
  p.$('soUltimoArq').checked = false;
  await esperar(() => !p.$('baixarZipTudo').disabled, { motivo: 'botão livre depois do 1º download' });
  p.$('baixarZipTudo').click();
  await esperar(() => api.contar('GET /api/admin/reports/pdf-zip') === 3, { motivo: 'zip sem ultimo' });

  const queries = api.pedidos.filter((x) => x.chave === 'GET /api/admin/reports/pdf-zip').map((x) => x.query);
  assert.deepEqual(queries.map((q) => q.get('ultimo')), ['1', '1', null]);
  assert.equal(queries[1].get('sdr'), 'Ana');
  await esperar(() => !p.$('baixarZipTudo').disabled, { motivo: 'botão livre' });
  p.fechar();
});

// ---------------------------------------------------------------- Ficha do RD Station: teste do admin
test('Extensão (admin): testar a ficha do RD mostra o que o SDR vai ver e quais formatos de telefone foram tentados', async () => {
  const api = apiBase().quando('POST /api/admin/crm/teste', ({ corpo }) => ({
    corpo: {
      configurado: true, encontrado: true,
      ficha: {
        nome: 'Marcos <b>Pereira</b>',
        negociacao: { etapa: 'MQL', funil: 'Funil MQL', responsavel: 'Cauã Lima' },
        formulario: { campos: [{ rotulo: 'Investimento', valor: '+ de R$5.000' }] },
        campos: [{ rotulo: 'Cidade', valor: 'Salvador' }],
      },
      diagnostico: { tentativas: [{ variante: '71999998888', resultados: 0, bateu: false }, { variante: '(71) 99999-8888', resultados: 1, bateu: true }] },
      pedido: corpo,
    },
  }));
  const p = abrirPainel(api, { hash: '#extensao' });
  await aberto(p);
  p.$('crmTeste').value = '(71) 99999-8888';
  p.$('crmTestar').click();
  await esperar(() => !p.$('resultadoCrm').classList.contains('hidden'), { motivo: 'resultado do teste' });
  assert.deepEqual(api.corpos('POST /api/admin/crm/teste'), [{ telefone: '71999998888' }]);
  const t = p.$('resultadoCrm').textContent;
  assert.match(t, /Telefone "\(71\) 99999-8888": 1 resultado\(s\)  ← achou por este/);
  assert.match(t, /Etapa: MQL · Funil MQL/);
  assert.match(t, /Investimento: \+ de R\$5\.000/);
  assert.match(t, /Cidade: Salvador/);
  assert.equal(p.$('resultadoCrm').querySelector('b'), null, 'dado do CRM não vira HTML');
  assert.match(p.$('statusCrm').textContent, /Encontrado/);
  p.fechar();
});

test('Extensão (admin): sem token no servidor, avisa o que falta; nome vai como nome', async () => {
  const api = apiBase().quando('POST /api/admin/crm/teste', () => ({ corpo: { configurado: false } }));
  const p = abrirPainel(api, { hash: '#extensao' });
  await aberto(p);
  p.$('crmTeste').value = 'Marcos Pereira';
  p.$('crmTestar').click();
  await esperar(() => /RDSTATION_CRM_TOKEN/.test(p.$('statusCrm').textContent), { motivo: 'aviso de token' });
  assert.deepEqual(api.corpos('POST /api/admin/crm/teste'), [{ nome: 'Marcos Pereira' }]);
  assert.equal(p.$('crmTestar').disabled, false);
  p.fechar();
});

// ---------------------------------------------------------------- report enriquecido na tela
const RELATORIO_RICO = {
  ...RELATORIO,
  consciencia: { nivel: 'produto', porque: 'Perguntou como funciona o acompanhamento' },
  sinais_compra: ['Confirmou o investimento'],
  conversa: ['Ana explicou que a entrega é a conta completa; Marcos disse que faz sentido.'],
};

test('report rico no painel: mostra consciência, sinais e a conversa; editar vai para o PDF', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' })
    .quando('POST /api/report-texto', () => ({ corpo: { dados: RELATORIO_RICO } }))
    .quando('POST /api/pdf', () => ({ corpo: { arquivo: 'r.pdf', arquivoBase64: 'QQ==' } }));
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => visivel(p.$('resultado')), { motivo: 'report na tela' });
  const t = p.$('report').textContent;
  for (const x of ['Temperatura do lead', 'Nível de consciência: Consciente da nossa entrega', 'Perguntou como funciona o acompanhamento',
    'Sinais de compra', 'Confirmou o investimento', 'Como foi a conversa', 'Ana explicou que a entrega é a conta completa']) {
    assert.ok(t.includes(x), 'faltou na tela: ' + x);
  }
  assert.ok(t.indexOf('Como foi a conversa') < t.indexOf('O que o closer deve bater'));

  const campo = p.document.querySelector('[data-edit="conversa.0"]');
  campo.textContent = 'Ana explicou a entrega (editado)';
  campo.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  const porque = p.document.querySelector('[data-edit="consciencia.porque"]');
  porque.textContent = 'Já pediu para começar (editado)';
  porque.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.$('dl').click();
  await esperar(() => api.contar('POST /api/pdf') === 1, { motivo: 'PDF pedido' });
  const enviado = api.corpos('POST /api/pdf')[0].dados;
  assert.deepEqual(enviado.conversa, ['Ana explicou a entrega (editado)']);
  assert.equal(enviado.consciencia.porque, 'Já pediu para começar (editado)');
  assert.equal(enviado.consciencia.nivel, 'produto');
  await esperar(() => p.downloads.length === 1, { motivo: 'download do PDF terminar' });
  p.fechar();
});

test('report rico no painel: consciência baixa não aparece na tela', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' })
    .quando('POST /api/report-texto', () => ({ corpo: { dados: { ...RELATORIO_RICO, consciencia: { nivel: 'problema', porque: 'x' }, sinais_compra: [] } } }));
  const p = await painelSdrComTexto(api);
  p.$('gerar').click();
  await esperar(() => visivel(p.$('resultado')), { motivo: 'report na tela' });
  assert.ok(!p.$('report').textContent.includes('Nível de consciência'));
  assert.ok(!p.$('report').textContent.includes('Temperatura do lead'));
  assert.ok(p.$('report').textContent.includes('Como foi a conversa'));
  p.fechar();
});

// ---------------------------------------------------------------- papel Gestor
const DIA_EQUIPE = {
  dia: '2026-09-30', total: 3, leads: 2, sdrs: 2,
  reports: [
    { id: 'e1', lead: 'Rafael', contato: 'Rafael', usuarioNome: 'Ana SDR', quando: '2026-09-30T13:00:00.000Z', origem: 'extensao', usar: false, substituidoPor: 'e2', geracoes: 2 },
    { id: 'e2', lead: 'Rafael', contato: 'Rafael', usuarioNome: 'Ana SDR', quando: '2026-09-30T15:00:00.000Z', origem: 'extensao', usar: true, substituidoPor: null, geracoes: 2 },
    { id: 'e3', lead: 'Júlia', contato: 'Júlia', usuarioNome: 'Bia SDR', quando: '2026-09-30T16:00:00.000Z', origem: 'manual', usar: true, substituidoPor: null, geracoes: 1 },
  ],
};

test('Gestor: vê as abas de admin e, em "Reports do dia", começa em "Todos os SDRs" com a coluna SDR', async () => {
  const api = apiBase({ papel: 'gestor', nome: 'Líder' })
    .quando('GET /api/equipe-reports', () => ({ corpo: DIA_EQUIPE }))
    .quando('POST /api/equipe-reports/zip', () => ({
      corpo: {},
      headers: { 'content-disposition': 'attachment; filename="Reports_Equipe_30-09-2026.zip"', 'x-reports-no-zip': '2', 'x-reports-sem-pdf': '0' },
    }));
  const p = abrirPainel(api, { hash: '#dia' });
  await aberto(p);
  assert.match(p.$('quem').textContent, /Gestor: Líder/);
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="acessos"]')), 'gestor tem as abas do admin');
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="arquivos"]')));
  await esperar(() => p.$('listaMeus').querySelectorAll('tr').length === 3, { motivo: 'lista da equipe' });
  assert.ok(visivel(p.$('escopoMeusBox')));
  assert.equal(p.$('escopoMeus').value, 'todos');
  assert.ok(visivel(p.$('thSdrMeus')));
  assert.match(p.$('listaMeus').textContent, /Bia SDR/);
  assert.match(p.$('statusMeus').textContent, /3 report\(s\) gerado\(s\) por 2 SDR\(s\) · 2 lead\(s\) · o \.zip leva 2/);

  p.$('baixarMeus').click();
  await esperar(() => p.downloads.length === 1, { motivo: 'download do .zip da equipe' });
  assert.deepEqual(api.corpos('POST /api/equipe-reports/zip'), [{ dia: '2026-09-30', ids: ['e2', 'e3'] }]);
  assert.equal(p.downloads[0].nome, 'Reports_Equipe_30-09-2026.zip');
  assert.equal(api.contar('GET /api/meus-reports'), 0);
  p.fechar();
});

test('Gestor/admin: trocar para "Meus reports" volta para a lista própria', async () => {
  const api = apiBase({ papel: 'gestor', nome: 'Líder' })
    .quando('GET /api/equipe-reports', () => ({ corpo: DIA_EQUIPE }))
    .quando('GET /api/meus-reports', () => ({ corpo: { dia: '2026-09-30', total: 0, leads: 0, reports: [] } }));
  const p = abrirPainel(api, { hash: '#dia' });
  await esperar(() => p.$('listaMeus').querySelectorAll('tr').length === 3, { motivo: 'lista da equipe' });
  p.$('escopoMeus').value = 'meus';
  p.$('escopoMeus').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('GET /api/meus-reports') === 1, { motivo: 'lista própria' });
  await esperar(() => p.$('listaMeus').querySelectorAll('tr').length === 0, { motivo: 'lista vazia' });
  assert.ok(!visivel(p.$('thSdrMeus')));
  p.fechar();
});

test('Admin começa em "Meus reports"; SDR nem vê a escolha', async () => {
  const adm = apiBase({ papel: 'master', nome: 'Chefe' }).quando('GET /api/meus-reports', () => ({ corpo: { dia: '2026-09-30', total: 0, leads: 0, reports: [] } }));
  const p = abrirPainel(adm, { hash: '#dia' });
  await esperar(() => adm.contar('GET /api/meus-reports') >= 1, { motivo: 'lista própria do admin' });
  assert.ok(visivel(p.$('escopoMeusBox')));
  assert.equal(p.$('escopoMeus').value, 'meus');
  p.fechar();

  const sdr = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('GET /api/meus-reports', () => ({ corpo: { dia: '2026-09-30', total: 0, leads: 0, reports: [] } }));
  const q = abrirPainel(sdr, { hash: '#dia' });
  await aberto(q);
  await dormir(40);
  assert.ok(!visivel(q.$('escopoMeusBox')));
  assert.equal(sdr.contar('GET /api/equipe-reports'), 0);
  q.fechar();
});

test('Acessos: dá para criar Gestor, e a lista marca o papel', async () => {
  const api = apiBase({ usuarios: [
    { id: 'u1', nome: 'Líder', papel: 'gestor', chave: 'pnx_Gestor1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z' },
  ] }).quando('POST /api/admin/usuarios', ({ corpo }) => ({ corpo: { usuario: { id: 'u9', nome: corpo.nome, papel: corpo.papel, chave: 'pnx_x' } } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Líder'), { motivo: 'lista de acessos' });
  assert.equal(p.document.querySelector('[data-papel-de="u1"]').value, 'gestor');
  assert.ok(p.document.querySelector('[data-ficha-crm="u1"]'), 'há a caixa do popup do lead por usuário');
  assert.ok([...p.$('papel').options].some((o) => o.value === 'gestor'));
  p.$('nome').value = 'Novo Gestor';
  p.$('papel').value = 'gestor';
  p.$('criar').click();
  await esperar(() => /Novo Gestor \(gestor\) criado/.test(p.$('statusCriar').textContent), { motivo: 'criado' });
  assert.deepEqual(api.corpos('POST /api/admin/usuarios'), [{ nome: 'Novo Gestor', papel: 'gestor' }]);
  p.fechar();
});

// ---------------------------------------------------------------- Master edita o tipo de acesso
test('Master: troca o tipo de acesso na lista e cria acessos; Gestor só vê', async () => {
  const usuarios = [
    { id: 'u1', nome: 'Cauã', papel: 'master', chave: 'pnx_Master1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z' },
    { id: 'u2', nome: 'Bia', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z' },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u2', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Bia'), { motivo: 'lista' });
  assert.ok(visivel(p.$('cardCriar')));
  assert.match(p.$('quem').textContent, /Master: /);
  assert.ok([...p.$('papel').options].map((o) => o.value).join() === 'sdr,gestor,master');
  const sel = p.document.querySelector('[data-papel-de="u2"]');
  sel.value = 'gestor';
  sel.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2'), [{ papel: 'gestor' }]);
  await esperar(() => api.contar('GET /api/admin/usuarios') >= 2, { motivo: 'lista recarregada' });
  await dormir(60);
  p.fechar();

  const g = apiBase({ papel: 'gestor', nome: 'Líder', usuarios });
  const q = abrirPainel(g, { hash: '#acessos' });
  await esperar(() => q.$('lista').textContent.includes('Bia'), { motivo: 'lista do gestor' });
  assert.ok(!visivel(q.$('cardCriar')), 'gestor não cria usuários');
  assert.ok(visivel(q.$('avisoSoMaster')));
  assert.equal(q.document.querySelector('[data-papel-de]'), null, 'nem edita o tipo de acesso');
  assert.equal(q.document.querySelector('[data-remover]'), null, 'nem remove');
  assert.match(q.$('lista').textContent, /master/);
  q.fechar();
});

test('Acessos: o master liga/desliga o popup do lead por pessoa; o gestor vê mas não muda', async () => {
  const usuarios = [
    { id: 'u1', nome: 'Líder', papel: 'gestor', chave: 'pnx_Gestor1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: false },
    { id: 'u2', nome: 'Bia', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u1', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Bia'), { motivo: 'lista' });
  const caixa = (id) => p.document.querySelector('[data-ficha-crm="' + id + '"]');
  assert.equal(caixa('u1').checked, false);
  assert.equal(caixa('u2').checked, true);
  caixa('u1').checked = true;
  caixa('u1').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u1') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u1'), [{ fichaCrm: true }]);
  await esperar(() => /Popup do lead ligado/.test(p.$('toast').textContent), { motivo: 'aviso' });
  await dormir(60);
  p.fechar();

  const q = abrirPainel(apiBase({ papel: 'gestor', nome: 'Líder', usuarios }), { hash: '#acessos' });
  await esperar(() => q.$('lista').textContent.includes('Bia'), { motivo: 'lista do gestor' });
  assert.equal(q.document.querySelector('[data-ficha-crm="u2"]').disabled, true);
  q.fechar();
});

test('Acessos: o master liga/desliga o Coach por pessoa; o gestor vê as caixas desabilitadas', async () => {
  const usuarios = [
    { id: 'u1', nome: 'Cauã', papel: 'master', chave: 'pnx_Master1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, coach: true },
    { id: 'u2', nome: 'Bia', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, coach: false },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u2', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Bia'), { motivo: 'lista' });
  const caixa = (id) => p.document.querySelector('[data-coach="' + id + '"]');
  assert.equal(caixa('u1').checked, true);
  assert.equal(caixa('u2').checked, false);
  caixa('u2').checked = true;
  caixa('u2').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2'), [{ coach: true }]);
  await esperar(() => /Coach ligado/.test(p.$('toast').textContent), { motivo: 'aviso' });
  await dormir(60);
  p.fechar();

  const q = abrirPainel(apiBase({ papel: 'gestor', nome: 'Líder', usuarios }), { hash: '#acessos' });
  await esperar(() => q.$('lista').textContent.includes('Bia'), { motivo: 'lista do gestor' });
  assert.equal(q.document.querySelector('[data-coach="u2"]').disabled, true);
  q.fechar();
});

// ---------------------------------------------------------------- conversa em formato de chat
const bolhas = (p) => [...p.document.querySelectorAll('#chatThread .bolha')].map((b) => ({
  lado: b.classList.contains('eu') ? 'eu' : b.classList.contains('lead') ? 'lead' : 'solto',
  texto: b.querySelector('.bolha-txt').textContent,
  topo: b.querySelector('.bolha-topo span').textContent,
}));
const escrever = (p, texto) => { p.$('chatMsg').value = texto; };

test('chat: escrever e adicionar vira bolha do lado certo; a caixa de texto continua sendo o que vai para a IA', async () => {
  const p = abrirPainel(apiBase({ papel: 'sdr', nome: 'Ana' }));
  await aberto(p);
  assert.ok(visivel(p.$('chatVazio')));
  escrever(p, 'Quero vender no Mercado Livre');
  p.$('chatEnviar').click();
  p.$('quemAudio').value = 'VENDEDOR';
  escrever(p, 'Legal! Você já vende ou está começando?');
  p.$('chatMsg').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(p.$('texto').value, 'LEAD: Quero vender no Mercado Livre\nVENDEDOR: Legal! Você já vende ou está começando?\n');
  assert.deepEqual(bolhas(p), [
    { lado: 'lead', texto: 'Quero vender no Mercado Livre', topo: 'Lead' },
    { lado: 'eu', texto: 'Legal! Você já vende ou está começando?', topo: 'Eu' },
  ]);
  assert.equal(p.$('chatMsg').value, '', 'a caixa limpa depois de adicionar');
  assert.ok(!visivel(p.$('chatVazio')));

  // Shift+Enter não envia
  escrever(p, 'linha 1');
  p.$('chatMsg').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(bolhas(p).length, 2);
  escrever(p, '');
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('chat: conversa colada inteira entra como está; áudio transcrito aparece marcado; o × tira a fala', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/transcrever', () => ({ corpo: { texto: 'tenho uns 5 mil guardados' } }));
  const p = abrirPainel(api);
  await aberto(p);
  escrever(p, 'VENDEDOR: Oi, tudo bem?\nLEAD: Tudo sim\nLEAD: <img src=x onerror=alert(1)>');
  p.$('chatEnviar').click();
  soltarArquivos(p, 'audio', [new p.w.File([new Uint8Array([1, 2])], 'voz.ogg', { type: 'audio/ogg' })]);
  await esperar(() => bolhas(p).length === 4, { motivo: 'áudio virou bolha' });
  assert.deepEqual(bolhas(p).map((b) => [b.lado, b.topo]), [['eu', 'Eu'], ['lead', 'Lead'], ['lead', 'Lead'], ['lead', 'Lead · áudio']]);
  assert.equal(bolhas(p)[2].texto, '<img src=x onerror=alert(1)>', 'texto do lead nunca vira HTML');
  assert.equal(p.document.querySelector('#chatThread img'), null);
  assert.equal(bolhas(p)[3].texto, 'tenho uns 5 mil guardados');

  p.document.querySelectorAll('#chatThread .bolha-x')[1].click(); // tira "Tudo sim"
  assert.deepEqual(bolhas(p).map((b) => b.texto), ['Oi, tudo bem?', '<img src=x onerror=alert(1)>', 'tenho uns 5 mil guardados']);
  assert.ok(!p.$('texto').value.includes('Tudo sim'));

  // editar pelo texto atualiza as bolhas
  p.$('texto').value = 'LEAD: só isto';
  p.$('texto').dispatchEvent(new p.w.Event('input', { bubbles: true }));
  assert.deepEqual(bolhas(p).map((b) => b.texto), ['só isto']);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('chat: um lugar só para anexar — arquivo de texto entra na conversa; PDF/Word avisam e não vão para a transcrição', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' });
  const p = abrirPainel(api);
  await aberto(p);
  soltarArquivos(p, 'audio', [
    new p.w.File(['LEAD: vim pelo anúncio\r\nVENDEDOR: que bom!'], 'conversa.txt', { type: 'text/plain' }),
    new p.w.File([new Uint8Array([37, 80, 68, 70])], 'proposta.pdf', { type: 'application/pdf' }),
  ]);
  await esperar(() => bolhas(p).length === 2, { motivo: 'texto do arquivo na conversa' });
  assert.equal(p.$('texto').value, 'LEAD: vim pelo anúncio\nVENDEDOR: que bom!\n');
  assert.match(p.$('files').textContent, /proposta\.pdf.*não leio este formato/);
  assert.match(p.$('files').textContent, /conversa\.txt.*adicionado/);
  assert.equal(api.contar('POST /api/transcrever'), 0, 'PDF não é mandado como áudio');
  await esperar(() => !p.$('gerar').disabled, { motivo: 'leituras terminaram' });
  p.fechar();
});

test('chat: o que ficou digitado e não foi adicionado também entra no report', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' }).quando('POST /api/report-texto', () => ({
    corpo: { dados: { lead: 'Marcos', resumo: [], secoes: [{ titulo: 'T', itens: ['i'] }], citacoes: [] }, arquivo: 'r.pdf', arquivoBase64: 'AAAA' },
  }));
  const p = abrirPainel(api);
  await aberto(p);
  escrever(p, 'LEAD: primeira');
  p.$('chatEnviar').click();
  escrever(p, 'esqueci de adicionar');
  p.$('gerar').click();
  await esperar(() => api.contar('POST /api/report-texto') === 1, { motivo: 'report pedido' });
  assert.equal(api.corpos('POST /api/report-texto')[0].texto, 'LEAD: primeira\nLEAD: esqueci de adicionar');
  await esperar(() => /Report gerado/.test(p.$('status').textContent), { motivo: 'report na tela' });
  p.fechar();

  const vazio = abrirPainel(apiBase({ papel: 'sdr', nome: 'Ana' }));
  await aberto(vazio);
  vazio.$('gerar').click();
  assert.match(vazio.$('status').textContent, /Monte a conversa/);
  vazio.fechar();
});

// ---------------------------------------------------------------- Resultados da reunião e Closers (só o master)
const LINHAS_RES = {
  closers: [{ id: 'c1', nome: 'Vitor' }, { id: 'c2', nome: 'Rafa' }],
  reports: [
    { id: 'x1', lead: 'Marcos', usuarioNome: 'Ana SDR', dia: '2026-10-02', closerId: 'c1', closerNome: 'Vitor', resultado: '', obsReuniao: '',
      perfil: 'analitico', perfilReal: '', perfilEvidencia: 'Pediu números.', consciencia: 'solucao', conscienciaReal: '', conscienciaPorque: 'Procura passo a passo.', versao: 3 },
    { id: 'x2', lead: '<b>Lead</b>', usuarioNome: 'Bia SDR', dia: '2026-10-02', closerId: '', closerNome: '', resultado: 'venda_call', obsReuniao: 'Fechou Performance',
      perfil: 'relacional', perfilReal: 'cetico', perfilEvidencia: '', consciencia: '', conscienciaReal: '', conscienciaPorque: '', versao: 0 },
  ],
};
const INTEL = {
  minAmostra: 3, reunioesComResultado: 6, vendas: 4, semCloser: 1, calibragens: 2,
  perfis: [{ chave: 'analitico', rotulo: 'Analítico' }, { chave: 'relacional', rotulo: 'Relacional' }],
  matriz: [{ closerId: 'c1', nome: 'Vitor', total: 4, vendas: 3, taxa: 0.75, perfis: { analitico: { total: 4, vendas: 3, taxa: 0.75 } } }],
  porPerfil: [{ chave: 'analitico', rotulo: 'Analítico', total: 4, vendas: 3, taxa: 0.75 }],
  porConsciencia: [{ chave: 'produto', rotulo: 'Consciente da nossa entrega', total: 2, vendas: 2, taxa: 1 }],
  prospeccao: {
    comAnalise: 6, vendas: 4, semVenda: 2, suficiente: true,
    criterios: [{ chave: 'spin.implicacao', rotulo: 'Perguntas de implicação (SPIN)', ganhou: 0.75, perdeu: 0, diferenca: 0.75 }],
    perguntasQueFecharam: [{ pergunta: 'Se nada mudar, como fica?' }, { pergunta: 'Se nada mudar, como fica?' }],
  },
  melhorCloserPorPerfil: [
    { perfil: 'analitico', rotulo: 'Analítico', sugestao: { closerId: 'c1', nome: 'Vitor' }, motivo: 'Vitor fechou 3 de 4 reuniões com lead analítico.' },
    { perfil: 'relacional', rotulo: 'Relacional', sugestao: null, motivo: 'Ainda sem dados suficientes.' },
  ],
  insights: null,
};
const apiMaster = (extra = {}) =>
  apiBase({ papel: 'master', nome: 'Cauã', ...extra })
    .quando('GET /api/master/resultados', () => ({ corpo: LINHAS_RES }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }));

test('Resultados da reunião: o master vê a aba, marca closer/resultado/anotação e corrige o nível (que ensina a IA)', async () => {
  const api = apiMaster().quando('PATCH /api/admin/reports/x1/resultado', ({ corpo }) => ({ corpo: { ok: true, versao: corpo.versao + 1 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  await esperar(() => p.$('listaRes').querySelectorAll('tr').length === 2, { motivo: 'linhas' });
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="resultados"]')));
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="closers"]')));
  const q = api.pedidos.find((x) => x.chave === 'GET /api/master/resultados').query;
  assert.equal(q.get('de'), q.get('ate'), 'começa em "Hoje"');

  const linha = p.document.querySelector('tr[data-res="x1"]');
  const campo = (nome) => linha.querySelector(`[data-res-campo="${nome}"]`);
  assert.equal(campo('perfilReal').options[0].textContent, 'IA: Analítico');
  assert.equal(campo('perfilReal').title, 'Pediu números.');
  assert.equal(campo('conscienciaReal').options[0].textContent, 'IA: 3 · Consciente da solução');
  assert.equal(campo('closerId').value, 'c1');
  assert.deepEqual([...campo('resultado').options].map((o) => o.value), ['', 'venda_call', 'venda_fup', 'pix_compromisso', 'sem_venda', 'no_show', 'em_followup']);
  assert.equal(p.document.querySelector('tr[data-res="x2"] [data-res-campo="perfilReal"]').value, 'cetico', 'correção já feita aparece selecionada');
  assert.equal(p.document.querySelector('#listaRes b b'), null, 'nome do lead não vira HTML');

  const mudar = (nome, valor) => { campo(nome).value = valor; campo(nome).dispatchEvent(new p.w.Event('change', { bubbles: true })); };
  mudar('resultado', 'sem_venda');
  mudar('obsReuniao', 'Travou no sócio');
  mudar('conscienciaReal', 'problema');
  await esperar(() => api.contar('PATCH /api/admin/reports/x1/resultado') === 3, { motivo: 'três salvamentos' });
  assert.deepEqual(api.corpos('PATCH /api/admin/reports/x1/resultado'), [
    { resultado: 'sem_venda', versao: 3 },
    { obsReuniao: 'Travou no sócio', versao: 4 },
    { conscienciaReal: 'problema', versao: 5 },
  ], 'um campo por vez, em fila, cada um com a versão que o anterior devolveu');
  await esperar(() => /A IA vai usar esta correção/.test(p.$('toast').textContent), { motivo: 'aviso do aprendizado' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: a inteligência mostra o closer indicado por perfil, a matriz e o que difere na prospecção; insights sob demanda', async () => {
  const api = apiMaster().quando('POST /api/master/insights', () => ({
    corpo: { insights: { closerPorPerfil: ['Vitor com analítico.'], prospeccaoQueFunciona: [], perguntasParaOPadrao: ['<i>Se nada mudar?</i>'], melhoriasNoScript: [], atencao: ['Amostra pequena.'], geradoEm: '2026-10-02T20:00:00.000Z', baseadoEm: 6 } },
  }));
  const p = abrirPainel(api, { hash: '#resultados' });
  await esperar(() => /Vitor fechou 3 de 4/.test(p.$('intelMelhor').textContent), { motivo: 'indicação' });
  assert.match(p.$('intelResumo').textContent, /6 reunião\(ões\) com resultado marcado · 4 venda\(s\) · 1 sem closer marcado.*2 correção\(ões\) de consciência/);
  assert.match(p.$('intelMelhor').textContent, /Relacional\s*sem dados ainda/);
  assert.match(p.$('intelMatriz').textContent, /Vitor\s*3\/4\s*75%/);
  assert.match(p.$('intelConsc').textContent, /Consciente da nossa entrega\s*2\/2\s*100%/);
  assert.match(p.$('intelProsp').textContent, /Perguntas de implicação \(SPIN\)\s*75%\s*0%/);
  assert.equal(p.$('intelPerguntas').querySelectorAll('li').length, 1, 'pergunta repetida aparece uma vez');

  p.$('gerarInsights').click();
  await esperar(() => /Insights gerados \(sem custo\)/.test(p.$('statusInsights').textContent), { motivo: 'insights' });
  assert.match(p.$('insightsBox').textContent, /Perguntas para a qualificação padrão\s*<i>Se nada mudar\?<\/i>/);
  assert.equal(p.$('insightsBox').querySelector('i[data-ic], li i'), null, 'texto da IA não vira HTML');
  assert.match(p.$('insightsBox').textContent, /confira antes de mudar o script/);
  await dormir(40);
  p.fechar();
});

test('Gestor não vê "Resultados da reunião" nem "Closers" (nem pelo endereço); SDR também não', async () => {
  const g = apiBase({ papel: 'gestor', nome: 'Líder' });
  const p = abrirPainel(g, { hash: '#resultados' });
  await aberto(p);
  await dormir(60);
  assert.ok(!visivel(p.document.querySelector('.tab[data-aba="resultados"]')));
  assert.ok(!visivel(p.document.querySelector('.tab[data-aba="closers"]')));
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="numeros"]')), 'as outras abas de admin continuam');
  assert.ok(!visivel(p.$('aba-resultados')));
  assert.ok(visivel(p.$('aba-report')));
  assert.equal(g.contar('GET /api/master/resultados'), 0);
  p.document.querySelector('.tab[data-aba="closers"]').click();
  assert.ok(!visivel(p.$('aba-closers')));
  p.fechar();
});

test('Closers: aba própria do master para adicionar e remover', async () => {
  let lista = [{ id: 'c1', nome: 'Vitor', email: 'v@x.com' }];
  const api = apiMaster()
    .quando('GET /api/admin/closers', () => ({ corpo: { closers: lista } }))
    .quando('POST /api/admin/closers', ({ corpo }) => { lista = lista.concat([{ id: 'c9', nome: corpo.nome, email: corpo.email }]); return { corpo: { ok: true } }; })
    .quando('DELETE /api/admin/closers/c1', () => { lista = lista.filter((c) => c.id !== 'c1'); return { corpo: { ok: true } }; });
  const p = abrirPainel(api, { hash: '#closers' });
  await esperar(() => p.$('listaClosers').textContent.includes('Vitor'), { motivo: 'lista de closers' });
  assert.ok(visivel(p.$('aba-closers')));
  assert.equal(p.$('aba-numeros').querySelector('#closerNome'), null, 'o cadastro saiu de "Reports gerados"');
  p.$('closerNome').value = 'Rafa';
  p.$('addCloser').click();
  await esperar(() => p.$('listaClosers').textContent.includes('Rafa'), { motivo: 'closer novo' });
  assert.deepEqual(api.corpos('POST /api/admin/closers'), [{ nome: 'Rafa', email: '' }]);
  p.document.querySelector('[data-remover-closer="c1"]').click();
  await esperar(() => !p.$('listaClosers').textContent.includes('Vitor'), { motivo: 'closer removido' });
  await dormir(60);
  p.fechar();
});

test('Base: mostra os seis campos, avisa quando é a recomendada e deixa voltar aos textos anteriores', async () => {
  const cheia = { empresa: 'E', qualificacao: 'Q', script: 'S', oferta: 'O', objecoes: 'OB', perfil: 'P', recomendada: true, temAnterior: true, atualizadoEm: '2026-10-01T10:00:00Z' };
  const api = apiBase()
    .quando('GET /api/admin/base', () => ({ corpo: cheia }))
    .quando('POST /api/admin/base/restaurar', () => ({ corpo: { base: { ...cheia, script: 'ANTIGO', recomendada: false } } }))
    .quando('POST /api/admin/base', ({ corpo }) => ({ corpo: { ok: true, base: corpo } }));
  const p = abrirPainel(api, { hash: '#base' });
  await esperar(() => p.$('bEmpresa').value === 'E', { motivo: 'base carregada' });
  assert.equal(p.$('bQualificacao').value, 'Q');
  assert.match(p.$('statusBase').textContent, /base recomendada/);
  assert.ok(visivel(p.$('baseRestaurar')));
  p.$('baseRestaurar').click();
  await esperar(() => p.$('bScript').value === 'ANTIGO', { motivo: 'restaurada' });
  p.$('bEmpresa').value = 'Nova';
  p.$('salvarBase').click();
  await esperar(() => api.contar('POST /api/admin/base') === 1, { motivo: 'salvar' });
  assert.deepEqual(Object.keys(api.corpos('POST /api/admin/base')[0]).sort(), ['empresa', 'objecoes', 'oferta', 'perfil', 'qualificacao', 'script']);
  await dormir(40);
  p.fechar();
});

test('Closers: um numerozinho mostra quantos estão cadastrados (na aba e no título) e acompanha a lista', async () => {
  let lista = [{ id: 'c1', nome: 'Vitor', email: '' }, { id: 'c2', nome: 'Rafa', email: '' }];
  const api = apiMaster()
    .quando('GET /api/admin/closers', () => ({ corpo: { closers: lista } }))
    .quando('POST /api/admin/closers', ({ corpo }) => { lista = lista.concat([{ id: 'c3', nome: corpo.nome, email: '' }]); return { corpo: { ok: true } }; });
  const p = abrirPainel(api, { hash: '#closers' });
  await esperar(() => p.$('nClosers').textContent === '2', { motivo: 'contagem' });
  assert.equal(p.$('nClosersTab').textContent, '2');
  assert.ok(visivel(p.$('nClosersTab')));
  assert.equal(p.$('nClosers').title, '2 closers cadastrados');
  p.$('closerNome').value = 'Zayra';
  p.$('addCloser').click();
  await esperar(() => p.$('nClosers').textContent === '3', { motivo: 'contagem atualizada' });
  await dormir(60);
  p.fechar();

  // na aba Resultados o número também aparece (vem junto das linhas)
  const q = abrirPainel(apiMaster(), { hash: '#resultados' });
  await esperar(() => q.$('nClosersTab').textContent === '2', { motivo: 'contagem pelos resultados' });
  assert.match(q.$('statusRes').textContent, /2 closer\(s\) cadastrado\(s\)/);
  await dormir(40);
  q.fechar();
});
