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
      const u = new URL(url, 'https://report-pronix.vercel.app');
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
    url: 'https://report-pronix.vercel.app/' + hash,
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

test('primeiro acesso: sem chave nenhuma, a senha do servidor libera o menu e abre Acessos para criar a primeira', async () => {
  const api = criarApi({
    'GET /api/eu': () => ({ status: 401, corpo: { erro: 'Chave inválida.' } }),
    'GET /api/admin/usuarios': () => ({ corpo: { usuarios: [] } }),
  });
  let senhaCerta = false;
  api.quando('POST /api/admin/login', () => (senhaCerta ? { corpo: { ok: true } } : { status: 401, corpo: { erro: 'Senha de admin incorreta.' } }));
  const p = abrirPainel(api, { chave: '' });
  await dormir(60);
  const abaAcessos = p.document.querySelector('.tab[data-aba="acessos"]');
  assert.ok(!visivel(abaAcessos), 'sem chave, a aba Acessos fica escondida');

  // senha errada: fica onde está, com o aviso
  p.$('senhaPrimeiro').value = 'errada';
  p.$('entrarPrimeiro').click();
  await esperar(() => /Senha incorreta/.test(p.$('statusPrimeiro').textContent), { motivo: 'aviso de senha errada' });
  assert.ok(!visivel(abaAcessos));
  assert.ok(visivel(p.$('aba-report')));

  // senha certa: o menu aparece e a aba Acessos abre com o formulário de criar acesso
  senhaCerta = true;
  p.$('senhaPrimeiro').value = 'senha-do-servidor';
  p.$('entrarPrimeiro').click();
  await esperar(() => visivel(p.$('aba-acessos')), { motivo: 'aba Acessos aberta' });
  assert.ok(visivel(abaAcessos), 'a aba aparece no menu');
  assert.ok(visivel(p.$('cardCriar')), 'dá para criar o primeiro acesso');
  assert.equal(p.$('senhaPrimeiro').value, '', 'a senha não fica no campo');
  assert.equal(p.w.sessionStorage.getItem('adminPass'), null);
  assert.equal(p.w.localStorage.getItem('adminPass'), null);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('senha do servidor digitada no campo da chave: vale como primeiro acesso e não fica guardada no navegador', async () => {
  let senhaCerta = true;
  const api = criarApi({
    'GET /api/eu': () => ({ status: 401, corpo: { erro: 'Chave inválida ou ausente.' } }),
    'GET /api/admin/usuarios': () => ({ corpo: { usuarios: [] } }),
    'POST /api/admin/login': () => (senhaCerta ? { corpo: { ok: true } } : { status: 401, corpo: { erro: 'Senha de admin incorreta.' } }),
  });
  // abre com a senha salva no lugar da chave (foi o que aconteceu: digitada no campo errado)
  const p = abrirPainel(api, { chave: 'senha-do-servidor' });
  await esperar(() => visivel(p.$('aba-acessos')), { motivo: 'aba Acessos aberta' });
  assert.ok(visivel(p.$('cardCriar')), 'dá para criar o primeiro acesso');
  assert.equal(p.$('chave').value, '', 'a senha sai do campo da chave');
  assert.equal(p.w.localStorage.getItem('crChave'), null, 'e não fica guardada no navegador');
  assert.match(p.$('statusChave').textContent, /Você entrou com a senha do servidor/);
  assert.deepEqual(p.erros, []);
  p.fechar();

  // texto que não é chave nem a senha certa: explica e abre o caminho do primeiro acesso
  senhaCerta = false;
  const q = abrirPainel(api, { chave: 'qualquer coisa' });
  await esperar(() => /as chaves começam com "pnx_"/.test(q.$('statusChave').textContent), { motivo: 'aviso' });
  assert.equal(q.$('primeiroAcesso').open, true);
  assert.equal(q.w.localStorage.getItem('crChave'), null);
  assert.ok(visivel(q.$('aba-report')));
  q.fechar();

  // chave de verdade (pnx_) recusada: não é tentada como senha
  const tentativas = api.contar('POST /api/admin/login');
  const r = abrirPainel(api, { chave: 'pnx_chave_antiga_que_nao_existe' });
  await esperar(() => /Chave inválida/.test(r.$('statusChave').textContent), { motivo: 'chave recusada' });
  await dormir(60);
  assert.equal(r.$('primeiroAcesso').open, true, 'o caminho do primeiro acesso fica à vista');
  assert.equal(api.contar('POST /api/admin/login'), tentativas, 'chave com cara de chave nunca é enviada como senha');
  assert.equal(r.w.localStorage.getItem('crChave'), 'pnx_chave_antiga_que_nao_existe');
  r.fechar();
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
  for (const x of ['Temperatura do lead', 'Momento do lead: Consciente da nossa entrega', 'Perguntou como funciona o acompanhamento',
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
  assert.ok(!p.$('report').textContent.includes('Momento do lead'), 'report antigo de nível baixo, sem título: nada na tela');
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
  assert.ok(!visivel(p.document.querySelector('.tab[data-aba="acessos"]')), 'Acessos é só do master');
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="numeros"]')), 'gestor tem as outras abas do admin');
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
test('Master: troca o tipo de acesso na lista e cria acessos; o Gestor não tem a aba Acessos', async () => {
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
  await aberto(q);
  await dormir(60);
  assert.ok(!visivel(q.document.querySelector('.tab[data-aba="acessos"]')), 'a aba Acessos é só do master');
  assert.ok(!visivel(q.$('aba-acessos')), 'gestor não entra em Acessos nem pelo endereço');
  assert.ok(visivel(q.$('aba-report')));
  assert.equal(g.contar('GET /api/admin/usuarios'), 0, 'a lista de chaves nem é pedida');
  q.fechar();
});

test('Acessos: o master liga/desliga o popup do lead por pessoa; o gestor não tem a aba', async () => {
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
  await aberto(q);
  await dormir(60);
  assert.ok(!visivel(q.$('aba-acessos')), 'gestor não entra em Acessos nem pelo endereço');
  assert.ok(visivel(q.$('aba-report')));
  q.fechar();
});

test('Acessos: o master liga/desliga a Automação do RD por pessoa; o gestor não tem a aba', async () => {
  const usuarios = [
    { id: 'u1', nome: 'Cauã', papel: 'master', chave: 'pnx_Master1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: true },
    { id: 'u2', nome: 'Bia', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: false },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u2', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Bia'), { motivo: 'lista' });
  const caixa = (id) => p.document.querySelector('[data-automacao="' + id + '"]');
  assert.equal(caixa('u1').checked, true);
  assert.equal(caixa('u2').checked, false);
  caixa('u2').checked = true;
  caixa('u2').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2'), [{ automacao: true }]);
  await esperar(() => /Automação do RD ligada/.test(p.$('toast').textContent), { motivo: 'aviso' });
  assert.equal(p.document.querySelector('[data-coach]'), null, 'o Coach saiu do painel');
  await dormir(60);
  p.fechar();

  const q = abrirPainel(apiBase({ papel: 'gestor', nome: 'Líder', usuarios }), { hash: '#acessos' });
  await aberto(q);
  await dormir(60);
  assert.ok(!visivel(q.$('aba-acessos')), 'gestor não entra em Acessos nem pelo endereço');
  assert.ok(visivel(q.$('aba-report')));
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
  destaques: [{ closerId: 'c1', nome: 'Vitor', perfil: 'analitico', rotulo: 'Analítico', vendas: 3, total: 4, taxa: 0.75, outros: { total: 0, vendas: 0, taxa: 0 }, frase: 'Vitor vai melhor com lead analítico: fechou 3 de 4 (75%).', porQueFechou: ['mostrou a conta de margem <b>na tela</b>'], ondeTravou: ['travou no sócio'] }],
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

  p.$('resVisao').value = 'tudo'; // este teste edita a linha: a visão "Tudo" não tira ela da tela
  p.$('resVisao').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await dormir(60);
  const linhaT = () => p.document.querySelector('tr[data-res="x1"]');
  const mudar = (nome, valor) => { const c = linhaT().querySelector('[data-res-campo="' + nome + '"]'); c.value = valor; c.dispatchEvent(new p.w.Event('change', { bubbles: true })); };
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

test('Limpeza do funil no RD: prévia sem alterar nada, teste com 5, execução em lotes, relatório por motivo e desfazer', async () => {
  const ids = Array.from({ length: 32 }, (_, i) => 'd' + (i + 1));
  const PREVIA = {
    dias: 15, escopo: 'meus', total: 32, ids,
    contexto: { funil: 'Funil SDR', destino: 'Desqualificados', sdr: 'Cauã', responsavel: 'Cauã Lima', avisos: [], motivos: [{ etapa: 'Contato iniciado', motivo: 'Nunca Respondeu (SDR)' }, { etapa: 'Respondeu', motivo: 'Parou de Responder (SDR/Closer)' }] },
    porMotivo: [{ rotulo: 'Nunca respondeu', etapa: 'Contato iniciado', total: 20, naEtapa: 761 }, { rotulo: 'Parou de responder', etapa: 'Respondeu', total: 12, naEtapa: 505 }],
    cards: [{ id: 'd1', nome: 'PRXC | Lead <b>Um</b>', etapa: 'Contato iniciado', motivo: 'Nunca respondeu', dias: 111, responsavel: 'Cauã Lima', email: 'lead.um@exemplo.com', link: 'https://crm.rdstation.com/app/deals/d1' }],
  };
  let relatorio = { total: 0, texto: '' };
  // já existe um relatório de uma limpeza anterior: ele aparece ao abrir a aba
  const salvos = [{ id: 'antigo', inicio: '2026-10-10T15:00:00.000Z', funil: 'SMQLs <b>x</b>', total: 213, desfeitos: 2, porMotivo: [{ rotulo: 'Nunca respondeu', total: 110 }, { rotulo: 'Parou de responder', total: 103 }], texto: 'Limpeza do funil — 10/10/2026 12:00 — SMQLs\n• Nunca respondeu - 110\n• Parou de responder - 103\nTotal: 213' }];
  const lotes = [];
  const api = apiMaster()
    .quando('GET /api/master/google', () => ({ corpo: { configurado: false, conectado: false, agendas: [] } }))
    .quando('GET /api/master/limpeza-rd/funis', () => ({ corpo: { funis: [{ id: 'f1', nome: 'Funil SDR <b>x</b>' }, { id: 'f2', nome: 'SMQLs automáticas' }] } }))
    .quando('GET /api/master/limpeza-rd/previa', () => ({ corpo: { ...PREVIA, funilId: 'f2' } }))
    .quando('GET /api/master/limpeza-rd/relatorio', () => ({ corpo: relatorio }))
    .quando('GET /api/master/limpeza-rd/relatorios', () => ({ corpo: { relatorios: salvos } }))
    .quando('POST /api/master/limpeza-rd/executar', ({ corpo }) => {
      lotes.push(corpo.ids);
      if (!salvos.some((s) => s.id === corpo.execucao)) salvos.unshift({ id: corpo.execucao, inicio: new Date().toISOString(), funil: 'SMQLs automáticas', total: corpo.ids.length, desfeitos: 0, porMotivo: [{ rotulo: 'Nunca respondeu', total: corpo.ids.length }, { rotulo: 'Parou de responder', total: 0 }], texto: 'novo' });
      relatorio = { total: 32, texto: '• Nunca respondeu - 20\n• Parou de responder - 12\nTotal: 32' };
      // d2 vem com um link que não é do RD: a tela não pode transformar isso em link
      const feitos = corpo.ids.map((id) => ({ id, nome: 'Card ' + id, motivo: 'Nunca respondeu', email: id === 'd3' ? '' : id + '@exemplo.com', link: id === 'd2' ? 'javascript:alert(1)' : 'https://crm.rdstation.com/app/deals/' + id }));
      return { corpo: { feitos, pulados: [], erros: [], limite: false } };
    })
    .quando('POST /api/master/limpeza-rd/desfazer', ({ corpo }) => ({ corpo: { desfeitos: corpo.ids.map((id) => ({ id })), erros: [] } }));
  const p = abrirPainel(api, { hash: '#funil' });
  const copiados = [];
  Object.defineProperty(p.w.navigator, 'clipboard', { value: { writeText: async (t) => { copiados.push(t); } }, configurable: true });
  await esperar(() => visivel(p.$('limpezaRd')), { motivo: 'cartão da limpeza' });
  assert.ok(visivel(p.$('aba-funil')), 'tem aba própria');
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="funil"]')), 'e item no menu');
  assert.equal(p.$('tituloPagina').textContent, 'Limpeza do RD');
  assert.equal(api.contar('GET /api/master/limpeza-rd/previa'), 0, 'abrir a aba não consulta os cards sozinho');

  // relatórios salvos: o histórico aparece ao abrir a aba, e cada um pode ser copiado
  await esperar(() => visivel(p.$('lzSalvos')) && p.$('lzSalvosLista').querySelectorAll('tr').length === 1, { motivo: 'histórico de relatórios' });
  const salvo = p.$('lzSalvosLista').querySelector('tr').textContent.replace(/\s+/g, ' ').trim();
  assert.match(salvo, /SMQLs <b>x<\/b> 110 103 0 213 \(2 desfeitos\) Copiar$/);
  assert.equal(p.$('lzSalvosLista').querySelector('b b'), null, 'nome do funil nunca vira HTML');
  p.$('lzSalvosLista').querySelector('[data-copiar-salvo="0"]').click();
  await esperar(() => copiados.length === 1, { motivo: 'relatório salvo copiado' });
  assert.match(copiados[0], /^Limpeza do funil — 10\/10\/2026 12:00 — SMQLs\n• Nunca respondeu - 110/);

  // o funil: lista os possíveis e já vem no de SMQLs automáticas; nome de funil nunca vira HTML
  await esperar(() => p.$('lzFunil').options.length === 3, { motivo: 'funis no seletor' });
  assert.deepEqual([...p.$('lzFunil').options].map((o) => o.textContent), ['Escolha o funil…', 'Funil SDR <b>x</b>', 'SMQLs automáticas']);
  assert.equal(p.$('lzFunil').value, 'f2');
  // sem funil escolhido, a prévia nem é pedida
  p.$('lzFunil').value = '';
  p.$('lzPrevia').click();
  await esperar(() => /Escolha o funil antes/.test(p.$('statusLz').textContent), { motivo: 'aviso de funil' });
  assert.equal(api.contar('GET /api/master/limpeza-rd/previa'), 0);
  p.$('lzFunil').value = 'f2';
  p.$('lzFunil').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.equal(p.w.localStorage.getItem('crLzFunil'), 'f2', 'a escolha fica lembrada');

  p.$('lzPrevia').click();
  await esperar(() => /32 card\(s\) parado/.test(p.$('statusLz').textContent), { motivo: 'prévia' });
  assert.match(p.$('statusLz').textContent, /Nada foi alterado ainda/);
  assert.match(p.$('lzResumo').textContent, /Nunca respondeu: 20 de 761 card\(s\) em "Contato iniciado"/);
  assert.match(p.$('lzResumo').textContent, /Campo SDR: Cauã/);
  assert.equal(p.$('lzLista').querySelector('b b'), null, 'nome do card nunca vira HTML');
  assert.equal(p.$('lzTudo').textContent, 'Executar todos (32)');
  assert.equal(lotes.length, 0);
  const q = api.pedidos.find((x) => x.chave === 'GET /api/master/limpeza-rd/previa').query;
  assert.deepEqual([q.get('dias'), q.get('escopo'), q.get('funil')], ['15', 'meus', 'f2']);

  // teste com 5: só os 5 primeiros da prévia, no funil da prévia
  p.$('lzTeste').click();
  await esperar(() => lotes.length === 1, { motivo: 'lote de teste' });
  assert.deepEqual(lotes[0], ids.slice(0, 5));
  assert.equal(api.corpos('POST /api/master/limpeza-rd/executar')[0].funil, 'f2');
  // a rodada foi salva: o relatório novo entra no topo do histórico, e a tela avisa
  await esperar(() => p.$('lzSalvosLista').querySelectorAll('tr').length === 2, { motivo: 'relatório novo no histórico' });
  assert.match(p.$('lzSalvosLista').querySelector('tr').textContent, /SMQLs automáticas/);

  // os 5 testados aparecem com o e-mail do lead e o link do card, para conferir no RD
  await esperar(() => visivel(p.$('lzFeitos')), { motivo: 'lista dos movidos' });
  const linhasFeitos = [...p.$('lzFeitosLista').querySelectorAll('tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(linhasFeitos.length, 5);
  assert.match(linhasFeitos[0], /^Card d1 d1@exemplo\.com Nunca respondeu Abrir no RD$/);
  assert.match(linhasFeitos[2], /sem e-mail no card/);
  const links = [...p.$('lzFeitosLista').querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(links, ['d1', 'd3', 'd4', 'd5'].map((id) => 'https://crm.rdstation.com/app/deals/' + id), 'endereço que não é do RD não vira link');
  p.$('lzCopiarEmails').click();
  await esperar(() => copiados.some((t) => t.startsWith('d1@exemplo.com')), { motivo: 'e-mails copiados' });
  assert.equal(copiados.find((t) => t.startsWith('d1@exemplo.com')), 'd1@exemplo.com\nd2@exemplo.com\nd4@exemplo.com\nd5@exemplo.com');
  // a prévia também mostra o e-mail
  assert.match(p.$('lzLista').textContent, /lead\.um@exemplo\.com/);
  await esperar(() => visivel(p.$('lzRelatorio')), { motivo: 'relatório' });
  assert.match(p.$('lzTexto').textContent, /• Nunca respondeu - 20\n• Parou de responder - 12\nTotal: 32/);
  p.$('lzCopiar').click();
  await esperar(() => copiados.some((t) => /Nunca respondeu - 20/.test(t)), { motivo: 'relatório copiado' });
  assert.match(copiados.find((t) => /Nunca respondeu - 20/.test(t)), /^Limpeza do funil — \d\d\/\d\d\/\d{4}\n• Nunca respondeu - 20/);

  // executar todos: vai em lotes de 15
  await esperar(() => !p.$('lzTudo').disabled && /32 card/.test(p.$('statusLz').textContent), { motivo: 'prévia refeita' });
  lotes.length = 0;
  p.$('lzTudo').click();
  await esperar(() => lotes.length === 3, { motivo: 'três lotes' });
  assert.deepEqual(lotes.map((l) => l.length), [15, 15, 2]);
  // os três lotes são UMA execução (um relatório só), diferente da do teste com 5
  const rodadas = api.corpos('POST /api/master/limpeza-rd/executar').map((c) => c.execucao);
  assert.equal(new Set(rodadas.slice(1)).size, 1);
  assert.notEqual(rodadas[0], rodadas[1]);
  assert.match(rodadas[1], /^lz[a-z0-9]{6,}$/);

  // desfazer o último lote
  await esperar(() => visivel(p.$('lzDesfazer')) && !p.$('lzDesfazer').disabled, { motivo: 'botão de desfazer' });
  p.$('lzDesfazer').click();
  await esperar(() => api.contar('POST /api/master/limpeza-rd/desfazer') === 3, { motivo: 'desfazer em lotes' });
  await dormir(80);

  // trocar de funil some com a prévia que estava na tela: ninguém executa no funil errado
  await esperar(() => visivel(p.$('lzAcoes')), { motivo: 'prévia na tela' });
  p.$('lzFunil').value = 'f1';
  p.$('lzFunil').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.ok(!visivel(p.$('lzAcoes')) && !visivel(p.$('lzTabela')));
  assert.match(p.$('statusLz').textContent, /Funil trocado/);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Cadastros duplicados: a busca mostra quem fica e quem sai sem alterar nada; teste com 5, fechar em lotes e desfazer', async () => {
  const card = (id, nome, etapa, extra = {}) => ({ id, nome, etapa, email: id + '@exemplo.com', telefone: '', criadoEm: '01/10/2026', dias: 12, link: 'https://crm.rdstation.com/app/deals/' + id, ...extra });
  const pares = Array.from({ length: 23 }, (_, i) => ({ id: 's' + (i + 1), fica: 'f' + (i + 1), ...(i === 1 ? { via: 's1' } : {}) }));
  const BUSCA = {
    funilId: 'f2', analisados: 812, totalGrupos: 21, total: 23, pares, suspeitos: [{ dado: 'teste@<b>teste</b>.com', tipo: 'e-mail', cards: 9 }],
    contexto: { funil: 'SMQLs automáticas', destino: 'Desqualificados', motivo: 'Lead Duplicado', sdr: 'Cauã', responsavel: 'Cauã Lima', avisos: [] },
    grupos: [
      { fica: card('f1', 'Ana <b>Souza</b>', 'Respondeu'), saem: [card('s1', 'Ana', 'Contato iniciado', { dias: 3 }), card('s2', 'Ana 3', 'Contato iniciado', { link: 'javascript:alert(1)' })], por: 'e-mail e telefone', reinscritoHaDias: 3 },
      { fica: card('f3', 'Bruno', 'Contato iniciado', { email: '', telefone: '(71) 98888-2222' }), saem: [card('s3', 'Bruno antigo', 'Contato iniciado')], por: 'telefone', reinscritoHaDias: null },
    ],
  };
  const lotes = [];
  const salvos = [];
  const api = apiMaster()
    .quando('GET /api/master/google', () => ({ corpo: { configurado: false, conectado: false, agendas: [] } }))
    .quando('GET /api/master/limpeza-rd/funis', () => ({ corpo: { funis: [{ id: 'f1', nome: 'Funil SDR' }, { id: 'f2', nome: 'SMQLs automáticas' }] } }))
    .quando('GET /api/master/limpeza-rd/relatorio', () => ({ corpo: { total: lotes.length ? 5 : 0, texto: '• Duplicado - 5\nTotal: 5' } }))
    .quando('GET /api/master/limpeza-rd/relatorios', () => ({ corpo: { relatorios: salvos } }))
    .quando('GET /api/master/limpeza-rd/duplicados', () => ({ corpo: BUSCA }))
    .quando('POST /api/master/limpeza-rd/duplicados', ({ corpo }) => {
      lotes.push(corpo.pares);
      if (!salvos.some((s) => s.id === corpo.execucao)) salvos.unshift({ id: corpo.execucao, inicio: new Date().toISOString(), funil: 'SMQLs automáticas', total: corpo.pares.length, desfeitos: 0, porMotivo: [{ rotulo: 'Nunca respondeu', total: 0 }, { rotulo: 'Parou de responder', total: 0 }, { rotulo: 'Duplicado', total: corpo.pares.length }], texto: 'dup' });
      const feitos = corpo.pares.slice(1).map((x) => ({ id: x.id, nome: 'Card <i>' + x.id + '</i>', motivo: 'Duplicado', email: x.id + '@exemplo.com', link: 'https://crm.rdstation.com/app/deals/' + x.id, fica: { id: x.fica, nome: 'Fica', etapa: 'Respondeu', link: 'https://crm.rdstation.com/app/deals/' + x.fica } }));
      return { corpo: { feitos, pulados: [{ id: corpo.pares[0].id, porque: 'já foi fechado' }], erros: [], limite: false } };
    })
    .quando('POST /api/master/limpeza-rd/desfazer', ({ corpo }) => ({ corpo: { desfeitos: corpo.ids.map((id) => ({ id })), erros: [] } }));
  const p = abrirPainel(api, { hash: '#funil' });
  await esperar(() => visivel(p.$('duplicadosRd')) && p.$('lzFunil').value === 'f2', { motivo: 'cartão dos duplicados e funil escolhido' });
  assert.equal(api.contar('GET /api/master/limpeza-rd/duplicados'), 0, 'abrir a aba não consulta os cards sozinho');

  p.$('dpProcurar').click();
  await esperar(() => /21 lead\(s\) com cadastro duplicado: 23 card\(s\) sairiam como "Duplicado"/.test(p.$('statusDp').textContent), { motivo: 'busca' });
  assert.match(p.$('statusDp').textContent, /A lista mostra 2\. Nada foi alterado ainda\./);
  assert.equal(api.pedidos.find((x) => x.chave === 'GET /api/master/limpeza-rd/duplicados').query.get('funil'), 'f2');
  assert.match(p.$('dpResumo').textContent, /cards de Cauã Lima: 812 em aberto analisado\(s\)\. Perda: "Lead Duplicado", etapa Desqualificados\. Campo SDR: Cauã\./);
  assert.match(p.$('dpResumo').textContent, /E-mail "teste@<b>teste<\/b>\.com" aparece em 9 cards: parece dado genérico, ficou de fora\./);
  const linhas = [...p.$('dpLista').querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(linhas[0], ['Ana <b>Souza</b>f1@exemplo.comcadastrou de novo há 3 dia(s)', 'e-mail e telefone', 'Respondeu · criado em 01/10/2026 · parado há 12 dia(s)', 'Contato iniciado · criado em 01/10/2026 · parado há 3 dia(s)Contato iniciado · criado em 01/10/2026 · parado há 12 dia(s)']);
  assert.match(linhas[1][0], /^Bruno\(71\) 98888-2222$/, 'sem e-mail, mostra o telefone; sem reinscrição, sem aviso');
  assert.equal(p.$('dpLista').querySelector('b b'), null, 'nome do card nunca vira HTML');
  assert.equal(p.$('dpResumo').querySelector('span b'), null, 'dado suspeito nunca vira HTML');
  assert.deepEqual([...p.$('dpLista').querySelectorAll('a')].map((a) => a.getAttribute('href')), ['f1', 's1', 'f3', 's3'].map((id) => 'https://crm.rdstation.com/app/deals/' + id), 'endereço que não é do RD não vira link');
  assert.equal(p.$('dpTudo').textContent, 'Fechar todos como Duplicado (23)');
  assert.equal(lotes.length, 0);

  // teste com 5: os 5 primeiros pares, com a ponte junto, no funil da busca
  p.$('dpTeste').click();
  await esperar(() => lotes.length === 1, { motivo: 'lote de teste' });
  assert.deepEqual(lotes[0], pares.slice(0, 5));
  assert.equal(api.corpos('POST /api/master/limpeza-rd/duplicados')[0].funil, 'f2');
  await esperar(() => visivel(p.$('dpFeitos')), { motivo: 'lista dos fechados' });
  const feitos = [...p.$('dpFeitosLista').querySelectorAll('tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(feitos.length, 4);
  assert.match(feitos[0], /^Card <i>s2<\/i> s2@exemplo\.com Abrir o fechado ficou: Respondeu$/);
  assert.equal(p.$('dpFeitosLista').querySelector('i'), null);
  // o relatório salvo ganha a coluna de duplicados
  await esperar(() => p.$('lzSalvosLista').querySelectorAll('tr').length === 1, { motivo: 'relatório salvo' });
  assert.match(p.$('lzSalvosLista').querySelector('tr').textContent.replace(/\s+/g, ' ').trim(), /SMQLs automáticas 0 0 5 5 Copiar$/);

  // fechar todos: lotes de 10, uma rodada só
  await esperar(() => !p.$('dpTudo').disabled && /23 card/.test(p.$('statusDp').textContent), { motivo: 'busca refeita' });
  lotes.length = 0;
  p.$('dpTudo').click();
  await esperar(() => lotes.length === 3, { motivo: 'três lotes' });
  assert.deepEqual(lotes.map((l) => l.length), [10, 10, 3]);
  const rodadas = api.corpos('POST /api/master/limpeza-rd/duplicados').map((c) => c.execucao);
  assert.equal(new Set(rodadas.slice(1)).size, 1);
  assert.match(rodadas[1], /^dp[a-z0-9]{6,}$/);
  await esperar(() => visivel(p.$('dpDesfazer')) && !p.$('dpDesfazer').disabled, { motivo: 'botão de desfazer' });
  assert.equal(p.$('dpDesfazer').textContent, 'Desfazer o último lote (20)');

  // desfazer usa a mesma rota da limpeza
  p.$('dpDesfazer').click();
  await esperar(() => api.contar('POST /api/master/limpeza-rd/desfazer') === 2, { motivo: 'desfazer em lotes' });
  await esperar(() => /20 card\(s\) reaberto\(s\)/.test(p.$('statusDp').textContent), { motivo: 'aviso do desfazer' });

  // trocar de funil some com a busca
  await esperar(() => visivel(p.$('dpAcoes')), { motivo: 'busca na tela' });
  p.$('lzFunil').value = 'f1';
  p.$('lzFunil').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.ok(!visivel(p.$('dpAcoes')) && !visivel(p.$('dpTabela')));
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Diagnóstico das automações: mostra o que está ok, o que falta e o veredito de cada uma', async () => {
  const DIAG = {
    respondeu: { pronto: true, comprovado: true, falhas: 0 },
    cor: { pronto: false, comprovado: false, falhas: 1 },
    itens: [
      { grupo: 'respondeu', nome: 'Token do RD no servidor', ok: true, detalhe: 'RDSTATION_CRM_TOKEN está configurado.', resolver: '' },
      { grupo: 'respondeu', nome: 'Último card movido de verdade', ok: true, detalhe: '12/10/2026 12:30: de "Contato iniciado" para "Respondeu", por Cauã <b>x</b>.', resolver: '' },
      { grupo: 'cor', nome: 'A conexão pode alterar eventos', ok: false, detalhe: 'A conexão só LÊ as agendas: não consegue mudar a cor.', resolver: 'Google Agenda → "Conectar de novo".' },
      { grupo: 'cor', nome: 'Última reunião pintada de verdade', ok: null, detalhe: 'Este sistema ainda não tentou pintar nenhuma reunião.', resolver: 'A prova real: abra a conversa de um lead com reunião futura.' },
    ],
  };
  const api = apiMaster()
    .quando('GET /api/master/google', () => ({ corpo: { configurado: false, conectado: false, agendas: [] } }))
    .quando('GET /api/master/diagnostico', () => ({ corpo: DIAG }));
  const p = abrirPainel(api, { hash: '#extensao' });
  await esperar(() => visivel(p.$('diagCard')), { motivo: 'cartão do diagnóstico' });
  assert.equal(api.contar('GET /api/master/diagnostico'), 0, 'só confere quando o master pede');
  p.$('diagRodar').click();
  await esperar(() => visivel(p.$('diagResultado')), { motivo: 'resultado' });
  const texto = (g) => p.$('diagResultado').querySelector(`[data-diag="${g}"]`).textContent.replace(/\s+/g, ' ').trim();
  assert.match(texto('respondeu'), /^Mover para "Respondeu" — funcionando \(já aconteceu de verdade\) ok Token do RD no servidor/);
  assert.match(texto('cor'), /^Pintar a reunião na agenda — 1 coisa\(s\) para acertar falta A conexão pode alterar eventos/);
  assert.match(texto('cor'), /Como resolver: Google Agenda → "Conectar de novo"\./);
  assert.match(texto('cor'), /ver Última reunião pintada de verdade/);
  assert.equal(p.$('diagResultado').querySelector('b b'), null, 'nada que vem do servidor vira HTML');
  assert.match(p.$('statusDiag').textContent, /Tem coisa para acertar/);
  assert.equal(p.$('diagResultado').querySelector('[data-diag="closer"]'), null, 'servidor antigo, sem o grupo dos closers: a tela segue');

  // com o grupo dos closers: aparece como terceira lista, e o que falta nele também conta
  DIAG.cor = { pronto: true, comprovado: false, falhas: 0 };
  DIAG.closer = { pronto: false, comprovado: true, falhas: 1 };
  DIAG.itens.push({ grupo: 'closer', nome: 'Cada closer bate com um usuário do RD', ok: false, detalhe: 'NÃO batem com nenhum usuário do RD (nunca serão preenchidos): Zayra <i>B</i>.', resolver: 'Acerte o nome na aba Closers.' });
  p.$('diagRodar').click();
  await esperar(() => !!p.$('diagResultado').querySelector('[data-diag="closer"]'), { motivo: 'grupo dos closers' });
  assert.match(texto('closer'), /^Closer preenchido sozinho — 1 coisa\(s\) para acertar falta Cada closer bate com um usuário do RD ?NÃO batem com nenhum usuário do RD \(nunca serão preenchidos\): Zayra <i>B<\/i>\. ?Como resolver: Acerte o nome na aba Closers\.$/);
  assert.equal(p.$('diagResultado').querySelector('i:not([data-ic])'), null);
  assert.match(p.$('statusDiag').textContent, /Tem coisa para acertar/);
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Closers: o master cadastra o apelido e a inteligência do closer (alimenta "Analisar Match com PH")', async () => {
  let lista = [{ id: 'c1', nome: 'Paulo Henrique Pagoti', email: '' }, { id: 'c2', nome: 'Vitor <b>x</b>', email: '', apelido: 'Vi', inteligencia: 'Fecha com casal. <script>alert(1)</script>', inteligenciaEm: '2026-10-10T12:00:00.000Z' }];
  const api = apiMaster()
    .quando('GET /api/admin/closers', () => ({ corpo: { closers: lista } }))
    .quando('PATCH /api/admin/closers/c1', ({ corpo }) => {
      lista = lista.map((c) => (c.id === 'c1' ? { ...c, ...corpo, inteligenciaEm: '2026-10-11T12:00:00.000Z' } : c));
      return { corpo: { ok: true } };
    });
  const p = abrirPainel(api, { hash: '#closers' });
  await esperar(() => p.$('listaClosers').textContent.includes('Paulo Henrique'), { motivo: 'lista de closers' });
  const editor = (id) => p.$('listaClosers').querySelector(`[data-editor-closer="${id}"]`);
  const tags = () => [...p.$('listaClosers').querySelectorAll('.tag')].map((t) => t.textContent);

  // quem já tem inteligência aparece marcado; o texto guardado nunca vira HTML
  assert.deepEqual(tags(), ['análise: Vi']);
  assert.equal(p.$('listaClosers').querySelector('script'), null);
  assert.equal(editor('c2').querySelector('[data-inteligencia]').value, 'Fecha com casal. <script>alert(1)</script>');
  assert.match(editor('c2').textContent, /Atualizada em 10\/10\/2026/);

  // o editor fica fechado até clicar em "Inteligência"
  assert.ok(!visivel(editor('c1')));
  p.document.querySelector('[data-inteligencia-closer="c1"]').click();
  assert.ok(visivel(editor('c1')));
  assert.match(editor('c1').textContent, /Analisar Match com Paulo/, 'sem apelido, o botão usa o primeiro nome');

  editor('c1').querySelector('[data-apelido]').value = 'PH';
  editor('c1').querySelector('[data-inteligencia]').value = 'Fecha mais com casal na call.';
  editor('c1').querySelector('[data-salvar-inteligencia]').click();
  await esperar(() => tags().includes('análise: PH'), { motivo: 'inteligência salva e lista refeita' });
  assert.deepEqual(api.corpos('PATCH /api/admin/closers/c1'), [{ apelido: 'PH', inteligencia: 'Fecha mais com casal na call.' }]);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Closers: "Desligar análise" tira o botão da extensão sem apagar a inteligência; "Ligar análise" devolve', async () => {
  let lista = [
    { id: 'c1', nome: 'Paulo Henrique Pagoti', email: '', apelido: 'PH', inteligencia: 'Fecha com casal.', inteligenciaEm: '2026-10-12T12:00:00.000Z' },
    { id: 'c2', nome: 'Sem Texto', email: '' },
  ];
  const api = apiMaster()
    .quando('GET /api/admin/closers', () => ({ corpo: { closers: lista } }))
    .quando('PATCH /api/admin/closers/c1', ({ corpo }) => {
      lista = lista.map((c) => (c.id === 'c1' ? { ...c, analiseDesligada: corpo.analiseAtiva ? undefined : true } : c));
      return { corpo: { ok: true } };
    });
  const p = abrirPainel(api, { hash: '#closers' });
  await esperar(() => p.$('listaClosers').textContent.includes('Paulo Henrique'), { motivo: 'lista de closers' });
  const botao = () => p.$('listaClosers').querySelector('[data-alternar-analise="c1"]');
  const tags = () => [...p.$('listaClosers').querySelectorAll('.tag')].map((t) => t.textContent);

  assert.equal(botao().textContent, 'Desligar análise');
  assert.equal(p.$('listaClosers').querySelector('[data-alternar-analise="c2"]'), null, 'sem inteligência não há o que ligar');
  botao().click();
  await esperar(() => tags().includes('análise desligada'), { motivo: 'análise desligada' });
  assert.equal(botao().textContent, 'Ligar análise');
  assert.equal(p.$('listaClosers').querySelector('[data-editor-closer="c1"] [data-inteligencia]').value, 'Fecha com casal.', 'o texto continua lá');
  botao().click();
  await esperar(() => tags().includes('análise: PH'), { motivo: 'análise ligada de novo' });
  assert.deepEqual(api.corpos('PATCH /api/admin/closers/c1'), [{ analiseAtiva: false }, { analiseAtiva: true }]);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Closers: importar o pacote cria o closer com inteligência e casos; o editor mostra o padrão das calls', async () => {
  let lista = [];
  const conta = (total, vendas, acordos = 0) => ({ total, vendas, acordos });
  const PADRAO = {
    geral: conta(10, 4, 1), origem: { transcricao: 9, resultado: 1 },
    quem: { casal: conta(6, 4), familia: conta(2, 0) }, presenca: { todos: conta(6, 4, 1), faltou: conta(4, 0) },
    quemPresenca: {}, momento: { loja: conta(5, 2) }, reunioes: { uma: conta(9, 3), duas: conta(1, 1) }, tempo: {},
  };
  const api = apiMaster()
    .quando('GET /api/admin/closers', () => ({ corpo: { closers: lista } }))
    .quando('POST /api/admin/closers/importar', ({ corpo }) => {
      if (!corpo.nome) return { status: 400, corpo: { erro: 'O pacote não traz o nome do closer.' } };
      lista = [{ id: 'c7', nome: corpo.nome, email: '', apelido: corpo.apelido, inteligencia: corpo.inteligencia, inteligenciaEm: '2026-10-12T12:00:00.000Z' }];
      return { corpo: { ok: true, criado: true, casos: corpo.casos.length, inteligencia: true, closer: { id: 'c7', nome: corpo.nome, apelido: corpo.apelido } } };
    })
    .quando('GET /api/admin/closers/c7/padrao', () => ({ corpo: { ok: true, padrao: PADRAO } }));
  const p = abrirPainel(api, { hash: '#closers' });
  await esperar(() => visivel(p.$('importarPacote')), { motivo: 'aba Closers aberta' });
  const escolher = (texto) => Object.defineProperty(p.$('pacoteCloser'), 'files', { configurable: true, value: texto == null ? [] : [{ name: 'pacote.json', text: async () => texto }] });

  // sem arquivo e com arquivo que não é pacote: avisa e não chama o servidor
  escolher(null);
  p.$('importarPacote').click();
  await esperar(() => /Escolha o arquivo/.test(p.$('statusPacote').textContent), { motivo: 'aviso de arquivo' });
  escolher('isto não é json');
  p.$('importarPacote').click();
  await esperar(() => /não é um pacote de closer/.test(p.$('statusPacote').textContent), { motivo: 'aviso de arquivo inválido' });
  assert.equal(api.contar('POST /api/admin/closers/importar'), 0);
  // erro do servidor aparece como veio
  escolher(JSON.stringify({ casos: [] }));
  p.$('importarPacote').click();
  await esperar(() => /não traz o nome/.test(p.$('statusPacote').textContent), { motivo: 'erro do servidor' });

  const pacote = { nome: 'Closer <b>Fictício</b>', apelido: 'CF', inteligencia: 'Fecha com casal.', casos: [{ resultado: 'venda' }, { resultado: 'nao' }] };
  escolher(JSON.stringify(pacote));
  p.$('importarPacote').click();
  await esperar(() => /Closer criado/.test(p.$('statusPacote').textContent), { motivo: 'pacote importado' });
  assert.match(p.$('statusPacote').textContent, /Inteligência gravada e 2 caso\(s\) das calls\. O botão "Analisar Match com CF"/);
  assert.equal(p.$('statusPacote').querySelector('b'), null, 'nome que vem do pacote nunca vira HTML');
  assert.deepEqual(api.corpos('POST /api/admin/closers/importar').pop(), pacote);
  await esperar(() => p.$('listaClosers').textContent.includes('análise: CF'), { motivo: 'lista refeita com o closer novo' });

  // abrir o editor traz o padrão das calls
  p.document.querySelector('[data-inteligencia-closer="c7"]').click();
  const caixa = () => p.$('listaClosers').querySelector('[data-padrao-closer="c7"]');
  await esperar(() => /Padrão das calls/.test(caixa().textContent), { motivo: 'padrão carregado' });
  assert.match(caixa().textContent, /10 caso\(s\): 9 de transcrições, 1 de reuniões com resultado marcado/);
  const linhas = [...caixa().querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()).join('|'));
  assert.ok(linhas.includes('Todos|10|4 (40%)|1'));
  assert.ok(linhas.includes('Casal|6|4 (67%)|—'));
  assert.ok(linhas.includes('Depende de pai, irmão ou filho|2|0|—'), 'menos de 5 casos: sem porcentagem');
  assert.ok(linhas.includes('Faltou alguém|4|0|—'));
  assert.ok(!linhas.some((l) => l.startsWith('Sócios')), 'recorte sem caso não aparece');
  await dormir(40);
  assert.deepEqual(p.erros, []);
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

test('Closers: pasta do Drive com as transcrições — salvar o link, ler agora, conferir, corrigir e apagar os casos lidos', async () => {
  let lista = [{ id: 'c1', nome: 'Paulo Henrique', email: '', apelido: 'PH', inteligencia: 'Fecha com casal.' }];
  let casosLidos = [];
  let ultima = null;
  let respostaDoLer = null; // o que a leitura achou na pasta, quando não há nada novo
  const api = apiMaster()
    .quando('GET /api/admin/closers', () => ({ corpo: { closers: lista } }))
    .quando('GET /api/admin/closers/c1/padrao', () => ({ corpo: { ok: true, padrao: { geral: { total: 0, vendas: 0, acordos: 0 }, origem: { transcricao: 0, resultado: 0 }, quem: {}, presenca: {}, quemPresenca: {}, momento: {}, reunioes: {}, tempo: {} } } }))
    .quando('PATCH /api/admin/closers/c1', ({ corpo }) => {
      if (/exemplo\.com/.test(corpo.drivePasta)) return { status: 400, corpo: { erro: 'Não reconheci o link da pasta do Drive. Cole o endereço da pasta (…/folders/…).' } };
      lista = [{ ...lista[0], drivePasta: corpo.drivePasta ? 'pasta_das_calls_0001' : '', driveDesde: corpo.driveDesde }];
      return { corpo: { ok: true, closer: lista[0] } };
    })
    .quando('GET /api/admin/closers/c1/drive', () => ({ corpo: { ok: true, pasta: lista[0].drivePasta || '', desde: lista[0].driveDesde || '', ultima, total: casosLidos.length, casos: casosLidos } }))
    .quando('POST /api/admin/closers/c1/drive/ler', () => {
      if (respostaDoLer) return { corpo: { ok: true, lidos: 0, casos: 0, semConversa: 0, erros: [], restantes: 0, ...respostaDoLer } };
      casosLidos = [
        { id: 'd_a', data: '2026-10-12', rotulo: 'Marina e <i>Ricardo</i>', quem: 'casal', todosNaCall: true, momento: 'loja', resultado: 'venda', motivo: 'onboarding iniciado pela casa', perfil: 'casal dono de loja <b>física</b>', reunioes: 1, minutos: 130, revisado: false },
        { id: 'd_b', data: '2026-10-10', quem: '', todosNaCall: null, momento: 'online', resultado: 'nao', motivo: 'foi consultar o sócio', perfil: 'vendedor com sócio fora da call', reunioes: 1, minutos: 80, revisado: true },
      ];
      ultima = { em: '2026-10-13T15:00:00.000Z', lidos: 3, casos: 2, semConversa: 1, restantes: 4, erro: '' };
      return { corpo: { ok: true, lidos: 3, casos: 2, semConversa: 1, erros: [], restantes: 4, total: 7, subpastas: 31, desde: '2026-10-09', maisNova: '2026-10-12', naJanela: 5, dentro: [] } };
    })
    .quando('PATCH /api/admin/closers/c1/casos/d_b', () => ({ corpo: { ok: true, caso: {} } }))
    .quando('DELETE /api/admin/closers/c1/casos/d_a', () => { casosLidos = casosLidos.filter((c) => c.id !== 'd_a'); return { corpo: { ok: true } }; });
  const p = abrirPainel(api, { hash: '#closers' });
  await esperar(() => p.$('listaClosers').textContent.includes('Paulo Henrique'), { motivo: 'lista de closers' });
  p.document.querySelector('[data-inteligencia-closer="c1"]').click();
  const bloco = () => p.$('listaClosers').querySelector('[data-drive-closer="c1"]');
  const status = () => bloco().querySelector('[data-status-drive]').textContent;
  await esperar(() => visivel(bloco()), { motivo: 'bloco do Drive' });
  assert.ok(!visivel(bloco().querySelector('[data-ler-drive]')), 'sem pasta, não há o que ler');

  // link que não é pasta: o erro do servidor aparece; link certo: salva e libera o "Ler agora"
  bloco().querySelector('[data-drive-pasta]').value = 'https://exemplo.com/x';
  bloco().querySelector('[data-salvar-drive]').click();
  await esperar(() => /Não reconheci o link/.test(status()), { motivo: 'erro do link' });
  bloco().querySelector('[data-drive-pasta]').value = 'https://drive.google.com/drive/u/0/folders/pasta_das_calls_0001';
  bloco().querySelector('[data-drive-desde]').value = '2026-10-09';
  bloco().querySelector('[data-salvar-drive]').click();
  await esperar(() => /Pasta salva/.test(status()), { motivo: 'pasta salva' });
  assert.deepEqual(api.corpos('PATCH /api/admin/closers/c1').pop(), { drivePasta: 'https://drive.google.com/drive/u/0/folders/pasta_das_calls_0001', driveDesde: '2026-10-09' });
  assert.ok(visivel(bloco().querySelector('[data-ler-drive]')));

  // ler agora: resumo do que aconteceu e a lista do que a leitura entendeu
  bloco().querySelector('[data-ler-drive]').click();
  await esperar(() => /3 documento\(s\) lido\(s\)/.test(status()), { motivo: 'leitura' });
  assert.match(status(), /3 documento\(s\) lido\(s\): 2 call\(s\) viraram caso, 1 sem conversa \(não compareceu ou caiu\)\. Faltam 4: clique de novo\. \(31 subpasta\(s\) na pasta, a mais nova de 12\/10\/2026; 7 documento\(s\) de 09\/10\/2026 em diante\)$/);
  const casos = () => [...bloco().querySelectorAll('[data-caso]')];
  await esperar(() => casos().length === 2, { motivo: 'casos na tela' });
  const textoCaso = (i) => casos()[i].textContent.replace(/\s+/g, ' ').trim();
  assert.match(textoCaso(0), /^12\/10\/2026 ?Marina e <i>Ricardo<\/i> ?casal dono de loja <b>física<\/b> ?onboarding iniciado pela casa/, 'o nome da call aparece sob a data, e nunca vira HTML');
  assert.equal(bloco().querySelector('[data-caso] i'), null);
  assert.equal(bloco().querySelector('[data-caso] b'), null, 'o que veio da leitura nunca vira HTML');
  assert.deepEqual([casos()[0].querySelector('[data-caso-campo="quem"]').value, casos()[0].querySelector('[data-caso-campo="resultado"]').value], ['casal', 'venda']);
  assert.match(textoCaso(1), /corrigido por você/);
  assert.match(bloco().querySelector('[data-drive-casos]').textContent, /Última leitura: 13\/10[\s\S]*3 documento\(s\), 2 caso\(s\), 4 na fila\./);

  // corrigir como terminou, e apagar um caso
  const resultado = casos()[1].querySelector('[data-caso-campo="resultado"]');
  resultado.value = 'acordo';
  resultado.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/closers/c1/casos/d_b') === 1, { motivo: 'correção enviada' });
  assert.deepEqual(api.corpos('PATCH /api/admin/closers/c1/casos/d_b')[0], { resultado: 'acordo' });
  casos()[0].querySelector('[data-apagar-caso]').click();
  await esperar(() => casos().length === 1, { motivo: 'caso apagado' });

  // "nada novo" se explica: a pasta ainda não tem call da data em diante…
  respostaDoLer = { total: 0, subpastas: 149, desde: '2026-10-09', maisNova: '2026-10-08', naJanela: 0, dentro: [] };
  bloco().querySelector('[data-ler-drive]').click();
  await esperar(() => /Nada novo na pasta/.test(status()), { motivo: 'nada novo' });
  assert.match(status(), /Nada novo na pasta\. \(149 subpasta\(s\) na pasta, a mais nova de 08\/10\/2026; 0 documento\(s\) de 09\/10\/2026 em diante\) Ainda não há call de 09\/10\/2026 em diante nessa pasta\.$/);
  // …ou tem, mas sem documento que dê para ler: diz o que há nas subpastas novas
  respostaDoLer = { total: 0, subpastas: 152, desde: '2026-10-09', maisNova: '2026-10-13', naJanela: 3, dentro: [{ tipo: 'video/mp4', quantos: 3, maisNovo: '2026-10-13' }, { tipo: 'application/pdf', quantos: 2, maisNovo: '2026-10-12' }, { tipo: 'application/x-desconhecido', quantos: 1, maisNovo: '' }] };
  bloco().querySelector('[data-ler-drive]').click();
  await esperar(() => /152 subpasta/.test(status()), { motivo: 'o que há nas subpastas novas' });
  assert.match(status(), /a mais nova de 13\/10\/2026; 0 documento\(s\) de 09\/10\/2026 em diante\) Nas 3 subpasta\(s\) de 09\/10\/2026 em diante há: 3 vídeo \(mais novo de 13\/10\/2026\), 2 PDF \(mais novo de 12\/10\/2026\), 1 application\/x-desconhecido — nenhum texto criado de 09\/10\/2026 em diante\.$/);
  respostaDoLer = { total: 0, subpastas: 152, desde: '2026-10-09', maisNova: '2026-10-13', naJanela: 2, dentro: [] };
  bloco().querySelector('[data-ler-drive]').click();
  await esperar(() => /estão vazias/.test(status()), { motivo: 'subpastas vazias' });
  assert.match(status(), /As 2 subpasta\(s\) de 09\/10\/2026 em diante estão vazias\.$/);
  await dormir(60);
  assert.deepEqual(p.erros, []);
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

test('Acessos: o master liga/desliga a Automação do RD por pessoa (mover para Respondeu, etiqueta e agendamento)', async () => {
  const usuarios = [
    { id: 'u1', nome: 'Cauã', papel: 'master', chave: 'pnx_Master1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: true },
    { id: 'u2', nome: 'Bia', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: false },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u2', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Bia'), { motivo: 'lista' });
  assert.match(p.$('aba-acessos').textContent, /Automação RD/, 'coluna na tabela');
  const caixa = (id) => p.document.querySelector('[data-automacao="' + id + '"]');
  assert.equal(caixa('u1').checked, true);
  assert.equal(caixa('u2').checked, false);
  caixa('u2').checked = true;
  caixa('u2').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2'), [{ automacao: true }]);
  await esperar(() => /Automação do RD ligada/.test(p.$('toast').textContent), { motivo: 'aviso' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Acessos: o master liga/desliga as Etiquetas do formulário por pessoa', async () => {
  const usuarios = [
    { id: 'u1', nome: 'Cauã', papel: 'master', chave: 'pnx_Master1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: true, etiquetas: true },
    { id: 'u2', nome: 'Bia', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: false, etiquetas: false },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u2', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Bia'), { motivo: 'lista' });
  assert.match(p.$('aba-acessos').textContent, /Etiquetas/, 'coluna na tabela');
  const caixa = (id) => p.document.querySelector('[data-etiquetas="' + id + '"]');
  assert.equal(caixa('u1').checked, true);
  assert.equal(caixa('u2').checked, false);
  caixa('u2').checked = true;
  caixa('u2').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2'), [{ etiquetas: true }]);
  await esperar(() => /Etiquetas ligadas/.test(p.$('toast').textContent), { motivo: 'aviso' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: no-show sai da lista (e volta com "Mostrar no-show"); quem já tem closer ou resultado continua', async () => {
  const linhas = { ...LINHAS_RES, reports: [
    ...LINHAS_RES.reports,
    { ...LINHAS_RES.reports[0], id: 'x3', lead: 'Lead Que Faltou', resultado: 'no_show', closerId: '' },
    { ...LINHAS_RES.reports[0], id: 'x4', lead: 'Lead Que Fechou', resultado: 'venda_call' },
  ] };
  const api = apiBase({ papel: 'master', nome: 'Cauã' })
    .quando('GET /api/master/resultados', () => ({ corpo: linhas }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }))
    .quando('PATCH /api/admin/reports/x1/resultado', ({ corpo }) => ({ corpo: { ok: true, versao: corpo.versao + 1 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  const ids = () => [...p.$('listaRes').querySelectorAll('tr')].map((tr) => tr.dataset.res);
  await esperar(() => ids().length === 3, { motivo: 'linhas' });
  assert.ok(!ids().includes('x3'), 'no-show fora da lista');
  assert.ok(ids().includes('x4'), 'quem já tem resultado continua na lista');
  assert.match(p.$('statusRes').textContent, /1 encerrado\(s\)/);

  p.$('resVisao').value = 'encerrados';
  p.$('resVisao').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => ids().includes('x3'), { motivo: 'no-show à vista' });
  p.$('resVisao').value = 'andamento';
  p.$('resVisao').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => !ids().includes('x3'), { motivo: 'no-show escondido de novo' });

  // marcar no-show numa linha: ela sai na hora
  const campo = p.document.querySelector('tr[data-res="x1"] [data-res-campo="resultado"]');
  campo.value = 'no_show';
  campo.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => !ids().includes('x1'), { motivo: 'linha marcada como no-show some' });
  await esperar(() => /No-show: saiu da lista/.test(p.$('toast').textContent), { motivo: 'aviso' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: mostra onde cada closer vai melhor, com o porquê das anotações (como texto, nunca HTML)', async () => {
  const p = abrirPainel(apiMaster(), { hash: '#resultados' });
  await esperar(() => /Vitor vai melhor com lead analítico/.test(p.$('intelDestaques').textContent), { motivo: 'destaques' });
  const t = p.$('intelDestaques').textContent;
  assert.ok(t.includes('Nas que fecharam: mostrou a conta de margem <b>na tela</b>'));
  assert.ok(t.includes('Nas que não fecharam: travou no sócio'));
  assert.equal(p.$('intelDestaques').querySelectorAll('b').length, 1, 'só o negrito da frase: a anotação não vira HTML');
  p.fechar();
});

test('abas por pessoa: usuário com a aba Resultados liberada vê só ela (além das dele); as outras continuam escondidas', async () => {
  const api = criarApi({
    'GET /api/eu': () => ({ corpo: { ok: true, nome: 'Samuel', id: '9', papel: 'sdr', abas: ['resultados'] } }),
    'GET /api/master/resultados': () => ({ corpo: LINHAS_RES }),
    'GET /api/master/inteligencia': () => ({ corpo: INTEL }),
    'GET /api/admin/closers': () => ({ corpo: { closers: [] } }),
    'POST /api/estimar-custo': () => ({ corpo: { custoUsdEstimado: 0.01, custoBrlEstimado: 0.05 } }),
  });
  const p = abrirPainel(api, { hash: '#resultados' });
  await esperar(() => p.$('listaRes').querySelectorAll('tr').length === 2, { motivo: 'resultados do usuário' });
  const abas = [...p.document.querySelectorAll('.tab')].filter((t) => !t.classList.contains('hidden')).map((t) => t.dataset.aba);
  assert.deepEqual(abas, ['report', 'dia', 'resultados']);
  assert.ok(visivel(p.$('aba-resultados')));
  p.document.querySelector('.tab[data-aba="report"]').click();
  p.w.location.hash = '#acessos';
  await dormir(60);
  assert.ok(!visivel(p.$('aba-acessos')), 'Acessos continua só do master');
  assert.equal(api.contar('GET /api/admin/usuarios'), 0);
  assert.equal(api.contar('GET /api/admin/stats'), 0);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Acessos: checklist das abas do painel por pessoa; marcar manda só aquela aba', async () => {
  const todas = { numeros: true, resultados: true, closers: true, arquivos: true, base: true, extensao: true, equipe: true };
  const usuarios = [
    { id: 'u1', nome: 'Cauã', papel: 'master', chave: 'pnx_Master1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, abas: todas },
    { id: 'u2', nome: 'Samuel', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, abas: { ...todas, numeros: false, resultados: false, closers: false, arquivos: false, base: false, extensao: false, equipe: false } },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u2', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Samuel'), { motivo: 'lista' });
  const caixas = [...p.document.querySelectorAll('[data-aba-de="u2"]')];
  assert.deepEqual(caixas.map((c) => c.dataset.aba), ['numeros', 'resultados', 'closers', 'arquivos', 'base', 'extensao', 'equipe']);
  assert.ok(caixas.every((c) => !c.checked));
  assert.equal(p.document.querySelectorAll('[data-aba-de="u1"]').length, 0, 'o master tem todas: sem caixas');
  assert.match(p.$('lista').textContent, /todas \(master\)/);
  const resultados = caixas.find((c) => c.dataset.aba === 'resultados');
  resultados.checked = true;
  resultados.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2'), [{ aba: 'resultados', liberada: true }]);
  await esperar(() => /Aba liberada/.test(p.$('toast').textContent), { motivo: 'aviso' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: certinho verde na venda finalizada, selo "Vendido no RD" esperando o tipo, e o botão que puxa do RD', async () => {
  let linhas = { ...LINHAS_RES, reports: [
    { ...LINHAS_RES.reports[0], id: 'x1', resultado: 'venda_call' },
    { ...LINHAS_RES.reports[0], id: 'x2', resultado: '', vendidoNoRd: false },
    { ...LINHAS_RES.reports[0], id: 'x3', resultado: 'sem_venda' },
  ] };
  const api = apiBase({ papel: 'master', nome: 'Cauã' })
    .quando('GET /api/master/resultados', () => ({ corpo: linhas }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }))
    .quando('POST /api/master/vendas-rd', () => {
      linhas = { ...linhas, reports: linhas.reports.map((r) => (r.id === 'x2' ? { ...r, vendidoNoRd: true } : r)) };
      return { corpo: { conferidos: 2, vendidos: 1, restantes: 0 } };
    })
    .quando('PATCH /api/admin/reports/x2/resultado', ({ corpo }) => ({ corpo: { ok: true, versao: corpo.versao + 1 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  const linha = (id) => p.document.querySelector('tr[data-res="' + id + '"]');
  await esperar(() => !!linha('x2'), { motivo: 'linhas' });
  assert.ok(linha('x1').querySelector('.selo-venda'), 'venda finalizada tem o certinho');
  assert.equal(linha('x1').querySelector('.selo-venda').textContent, '✓');
  assert.equal(linha('x2').querySelector('.selo-venda, .selo-rd'), null);
  assert.equal(linha('x3'), null, 'não fechou: encerrado, fora da lista');

  p.$('resVendasRd').click();
  await esperar(() => linha('x2') && !!linha('x2').querySelector('.selo-rd'), { motivo: 'selo do RD' });
  assert.equal(linha('x2').querySelector('.selo-rd').textContent, 'Vendido no RD');
  await esperar(() => /2 lead\(s\) conferido\(s\) no RD · 1 vendido\(s\)/.test(p.$('toast').textContent), { motivo: 'aviso' });

  // escolher o tipo de venda troca o selo pelo certinho
  const campo = linha('x2').querySelector('[data-res-campo="resultado"]');
  campo.value = 'venda_fup';
  campo.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => !!linha('x2').querySelector('.selo-venda'), { motivo: 'certinho' });
  assert.equal(linha('x2').querySelector('.selo-rd'), null);
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Acessos: as permissões de quem está logado já vêm abertas, para escolher o que usar (Popup do lead, Automação...)', async () => {
  const usuarios = [
    { id: '1', nome: 'Cauã Lima', papel: 'master', chave: 'pnx_MasterMaster1234567890ab', criadoEm: '2026-10-12T10:00:00Z', fichaCrm: true, automacao: true, etiquetas: true, corAgenda: '5', abas: {} },
    { id: 'u2', nome: 'Samuel', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: false, etiquetas: false, abas: {} },
  ];
  const api = apiBase({ papel: 'master', nome: 'Cauã Lima', usuarios }).quando('PATCH /api/admin/usuarios/1', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Samuel'), { motivo: 'lista' });
  const meu = p.document.querySelector('tr[data-perm-de="1"]');
  assert.ok(!meu.classList.contains('hidden'), 'as minhas permissões já vêm abertas');
  assert.ok(p.document.querySelector('tr[data-perm-de="u2"]').classList.contains('hidden'), 'as dos outros continuam recolhidas');
  assert.match(p.document.querySelector('[data-abrir-perm="1"]').textContent, /Cauã Lima \(você\)/);
  assert.ok([...p.document.querySelectorAll('#aba-acessos .head .sub')].some((x) => /clique no nome/.test(x.textContent)), 'a tela diz onde clicar');
  // os itens do WhatsApp estão ali, marcados, e a cor já está na Banana
  assert.deepEqual(['data-ficha-crm', 'data-automacao', 'data-etiquetas'].map((a) => meu.querySelector(`[${a}="1"]`).checked), [true, true, true]);
  assert.equal(meu.querySelector('[data-cor-agenda="1"]').value, '5');
  // desligar as etiquetas para mim mesmo
  const et = meu.querySelector('[data-etiquetas="1"]');
  et.checked = false;
  et.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/1') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/1'), [{ etiquetas: false }]);
  // fechei as minhas: não reabrem sozinhas quando a lista recarrega
  p.document.querySelector('[data-abrir-perm="1"]').click();
  assert.ok(p.document.querySelector('tr[data-perm-de="1"]').classList.contains('hidden'));
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Acessos: sistema vazio (entrando pela senha do servidor) — o primeiro acesso já vem como Master', async () => {
  const api = criarApi({
    'GET /api/eu': () => ({ status: 401, corpo: { erro: 'Chave inválida ou ausente.' } }),
    'GET /api/admin/usuarios': () => ({ corpo: { usuarios: [] } }),
    'POST /api/admin/login': () => ({ corpo: { ok: true } }),
  });
  const p = abrirPainel(api, { chave: '' });
  p.$('senhaPrimeiro').value = 'senha-do-servidor';
  p.$('entrarPrimeiro').click();
  await esperar(() => visivel(p.$('aba-acessos')) && p.$('papel').value === 'master', { motivo: 'tipo Master sugerido' });
  assert.match(p.$('statusCriar').textContent, /primeiro acesso: crie o seu como Master/);
  // se eu trocar o tipo, a escolha é minha: recarregar a lista não volta para Master
  p.$('papel').value = 'sdr';
  p.document.querySelector('.tab[data-aba="acessos"]').click();
  await dormir(80);
  assert.equal(p.$('papel').value, 'sdr');
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Acessos: a tabela fica limpa; clicar no nome abre as permissões da pessoa (WhatsApp e abas) e o resumo acompanha', async () => {
  const semAbas = { numeros: false, resultados: false, closers: false, arquivos: false, base: false, extensao: false, equipe: false };
  const usuarios = [
    { id: 'u2', nome: 'Samuel', papel: 'sdr', chave: 'pnx_SdrSdr1234567890abcdefgh', criadoEm: '2026-09-01T10:00:00Z', fichaCrm: true, automacao: true, etiquetas: false, abas: { ...semAbas, resultados: true } },
  ];
  const api = apiBase({ papel: 'master', usuarios }).quando('PATCH /api/admin/usuarios/u2', () => ({ corpo: { ok: true } }));
  const p = abrirPainel(api, { hash: '#acessos' });
  await esperar(() => p.$('lista').textContent.includes('Samuel'), { motivo: 'lista' });
  const painel = p.document.querySelector('tr[data-perm-de="u2"]');
  const nome = p.document.querySelector('[data-abrir-perm="u2"]');
  assert.ok(painel.classList.contains('hidden'), 'as permissões começam recolhidas');
  assert.equal(p.document.querySelector('[data-resumo-perm="u2"]').textContent, '2 no WhatsApp · 1 aba(s)');
  assert.deepEqual([...p.document.querySelectorAll('#aba-acessos thead th')].map((th) => th.textContent), ['Nome', 'Chave', 'Permissões', 'Criado', '']);

  nome.click();
  assert.ok(!painel.classList.contains('hidden'));
  assert.equal(nome.getAttribute('aria-expanded'), 'true');
  assert.match(painel.textContent, /No WhatsApp \(extensão\)[\s\S]*Popup do lead[\s\S]*Automação RD[\s\S]*Etiquetas[\s\S]*Abas do painel[\s\S]*Resultados da reunião/);

  assert.equal(painel.querySelector('[data-coach]'), null, 'o Coach saiu');
  const et = painel.querySelector('[data-etiquetas="u2"]');
  et.checked = true;
  et.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 1, { motivo: 'PATCH' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2'), [{ etiquetas: true }]);
  assert.equal(p.document.querySelector('[data-resumo-perm="u2"]').textContent, '3 no WhatsApp · 1 aba(s)');

  // Profissão no report: a caixa manda o PATCH próprio e entra na conta
  assert.match(painel.textContent, /Profissão no report/);
  const prof = painel.querySelector('[data-profissao-report="u2"]');
  assert.equal(prof.checked, false);
  prof.checked = true;
  prof.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/usuarios/u2') === 2, { motivo: 'PATCH da profissão' });
  assert.deepEqual(api.corpos('PATCH /api/admin/usuarios/u2')[1], { profissaoNoReport: true });
  assert.equal(p.document.querySelector('[data-resumo-perm="u2"]').textContent, '4 no WhatsApp · 1 aba(s)');

  nome.click();
  assert.ok(painel.classList.contains('hidden'), 'clicar de novo recolhe');
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: cada linha mostra o que o RD disse do lead; quem não foi achado pede o e-mail ou o telefone e vincula na hora', async () => {
  let linhas = { ...LINHAS_RES, reports: [
    { ...LINHAS_RES.reports[0], id: 'v1', resultado: 'venda_call', vendidoNoRd: true, produto: 'performance', ticket: 18624, rdSituacao: 'Vendido (vendido) · CLOSERS · Paulo <b>Henrique</b>', rdConferidoEm: '2026-10-12T19:30:00.000Z', vinculado: true },
    { ...LINHAS_RES.reports[0], id: 'v2', resultado: '', rdSituacao: 'Não achei no RD: 2 contatos com esse nome. Informe o e-mail ou o telefone do lead.', vinculado: false },
    { ...LINHAS_RES.reports[0], id: 'v3', resultado: '', rdSituacao: '' },
  ] };
  const api = apiBase({ papel: 'master', nome: 'Cauã' })
    .quando('GET /api/master/resultados', () => ({ corpo: linhas }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }))
    .quando('PATCH /api/admin/reports/v2/resultado', ({ corpo }) => {
      linhas = { ...linhas, reports: linhas.reports.map((r) => (r.id === 'v2' ? { ...r, rdSituacao: 'Reunião Realizada · CLOSERS · Giovane Ribeiro', vinculado: true } : r)) };
      return { corpo: { ok: true, versao: (corpo.versao || 0) + 1, recarregar: true, rdSituacao: 'Reunião Realizada · CLOSERS · Giovane Ribeiro' } };
    });
  const p = abrirPainel(api, { hash: '#resultados' });
  const linha = (id) => p.document.querySelector('tr[data-res="' + id + '"]');
  await esperar(() => !!linha('v2'), { motivo: 'linhas' });

  // o que o RD mostrou, como texto; a venda já vem com resultado, produto e ticket
  assert.equal(linha('v1').querySelector('.rd-situacao').textContent, 'RD: Vendido (vendido) · CLOSERS · Paulo <b>Henrique</b>');
  assert.equal(linha('v1').querySelector('.rd-situacao b'), null, 'nada que vem do RD vira HTML');
  assert.match(linha('v1').querySelector('.rd-situacao').title, /Conferido em 12\/10/);
  assert.deepEqual([linha('v1').querySelector('[data-res-campo="resultado"]').value, linha('v1').querySelector('[data-res-campo="produto"]').value, linha('v1').querySelector('[data-res-campo="ticket"]').value], ['venda_call', 'performance', '18.624,00']);
  assert.equal(linha('v1').querySelector('[data-res-campo="vinculo"]'), null, 'lead achado não pede vínculo');
  assert.equal(linha('v3').querySelector('.rd-situacao'), null, 'ainda não conferido: sem linha do RD');

  // não achado: a linha diz por quê e pede o e-mail ou o telefone
  assert.match(linha('v2').querySelector('.rd-situacao').textContent, /^RD: Não achei no RD: 2 contatos com esse nome/);
  const campo = linha('v2').querySelector('[data-res-campo="vinculo"]');
  assert.ok(campo, 'campo para informar o e-mail ou o telefone');
  // vazio não manda nada; e-mail vai como leadEmail, e a tela recarrega com o que o RD achou
  campo.value = '   ';
  campo.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await dormir(60);
  assert.equal(api.contar('PATCH /api/admin/reports/v2/resultado'), 0);
  campo.value = ' diego2@exemplo.com ';
  campo.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => linha('v2') && /Reunião Realizada/.test(linha('v2').textContent), { motivo: 'linha vinculada' });
  assert.deepEqual(Object.keys(api.corpos('PATCH /api/admin/reports/v2/resultado')[0]).sort(), ['leadEmail', 'versao']);
  assert.equal(api.corpos('PATCH /api/admin/reports/v2/resultado')[0].leadEmail, 'diego2@exemplo.com');
  assert.equal(linha('v2').querySelector('[data-res-campo="vinculo"]'), null);
  await dormir(40);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: telefone digitado na linha não achada vai como telefone', async () => {
  const linhas = { ...LINHAS_RES, reports: [{ ...LINHAS_RES.reports[0], id: 'v9', resultado: '', rdSituacao: 'Não achei este lead no RD. Informe o e-mail ou o telefone dele.' }] };
  const api = apiBase({ papel: 'master', nome: 'Cauã' })
    .quando('GET /api/master/resultados', () => ({ corpo: linhas }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }))
    .quando('PATCH /api/admin/reports/v9/resultado', () => ({ corpo: { ok: true, versao: 1, recarregar: true, rdSituacao: '' } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  await esperar(() => !!p.document.querySelector('tr[data-res="v9"] [data-res-campo="vinculo"]'), { motivo: 'campo de vínculo' });
  const campo = p.document.querySelector('tr[data-res="v9"] [data-res-campo="vinculo"]');
  campo.value = '(71) 99999-8888';
  campo.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => api.contar('PATCH /api/admin/reports/v9/resultado') === 1, { motivo: 'vínculo enviado' });
  assert.equal(api.corpos('PATCH /api/admin/reports/v9/resultado')[0].telefone, '(71) 99999-8888');
  assert.equal(api.corpos('PATCH /api/admin/reports/v9/resultado')[0].leadEmail, undefined);
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: "Não fechou" também é encerrado — sai da lista ao marcar e volta com "Mostrar encerrados"', async () => {
  const linhas = { ...LINHAS_RES, reports: [
    { ...LINHAS_RES.reports[0], id: 'a1', resultado: '' },
    { ...LINHAS_RES.reports[0], id: 'a2', resultado: 'sem_venda' },
    { ...LINHAS_RES.reports[0], id: 'a3', resultado: 'em_followup' },
    { ...LINHAS_RES.reports[0], id: 'a4', resultado: 'venda_fup' },
  ] };
  const api = apiBase({ papel: 'master', nome: 'Cauã' })
    .quando('GET /api/master/resultados', () => ({ corpo: linhas }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }))
    .quando('PATCH /api/admin/reports/a1/resultado', ({ corpo }) => ({ corpo: { ok: true, versao: corpo.versao + 1 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  const ids = () => [...p.$('listaRes').querySelectorAll('tr')].map((tr) => tr.dataset.res);
  await esperar(() => ids().length === 3, { motivo: 'linhas' });
  assert.deepEqual(ids().sort(), ['a1', 'a3', 'a4'], 'não fechou fora; em follow-up e venda continuam');
  const campo = p.document.querySelector('tr[data-res="a1"] [data-res-campo="resultado"]');
  campo.value = 'sem_venda';
  campo.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => !ids().includes('a1'), { motivo: 'linha encerrada some' });
  await esperar(() => /Não fechou: encerrado/.test(p.$('toast').textContent), { motivo: 'aviso' });
  p.$('resVisao').value = 'encerrados';
  p.$('resVisao').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => ids().includes('a2'), { motivo: 'encerrados à vista' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: produto, ticket e forma de pagamento aparecem na venda e são salvos um a um', async () => {
  const linhas = { ...LINHAS_RES, reports: [
    { ...LINHAS_RES.reports[0], id: 'v1', resultado: 'venda_call', produto: 'acelera', ticket: 29892, pagamento: 'Cartão de crédito 12x' },
    { ...LINHAS_RES.reports[0], id: 'v2', resultado: '', produto: '', ticket: 0, pagamento: '' },
  ] };
  const api = apiBase({ papel: 'master', nome: 'Cauã' })
    .quando('GET /api/master/resultados', () => ({ corpo: linhas }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }))
    .quando('PATCH /api/admin/reports/v2/resultado', ({ corpo }) => ({ corpo: { ok: true, versao: corpo.versao + 1 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  const campo = (id, nome) => p.document.querySelector('tr[data-res="' + id + '"] [data-res-campo="' + nome + '"]');
  const dados = (id) => p.document.querySelector('tr[data-res="' + id + '"] .dados-venda');
  await esperar(() => !!campo('v2', 'produto'), { motivo: 'linhas' });
  p.$('resVisao').value = 'tudo'; // este teste edita a linha: a visão "Tudo" não tira ela da tela
  p.$('resVisao').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await dormir(60);
  await esperar(() => !!campo('v1', 'produto'), { motivo: 'todas as linhas' });
  assert.ok(!dados('v1').classList.contains('hidden'), 'venda: os dados aparecem');
  assert.equal(campo('v1', 'produto').value, 'acelera');
  assert.equal(campo('v1', 'ticket').value, '29.892,00');
  assert.equal(campo('v1', 'pagamento').value, 'Cartão de crédito 12x');
  assert.deepEqual([...campo('v1', 'produto').options].map((o) => o.textContent), ['Produto…', 'PRONIX Performance', 'PRONIX Acelera']);
  assert.ok(dados('v2').classList.contains('hidden'), 'sem venda: escondidos');

  const mudar = (nome, valor) => { campo('v2', nome).value = valor; campo('v2', nome).dispatchEvent(new p.w.Event('change', { bubbles: true })); };
  mudar('resultado', 'venda_fup');
  await esperar(() => !dados('v2').classList.contains('hidden'), { motivo: 'dados da venda à vista' });
  mudar('produto', 'performance');
  mudar('ticket', '15.984,00');
  mudar('pagamento', 'Pix + cartão');
  await esperar(() => api.contar('PATCH /api/admin/reports/v2/resultado') === 4, { motivo: 'salvou os quatro' });
  assert.deepEqual(api.corpos('PATCH /api/admin/reports/v2/resultado').map((c) => Object.keys(c).filter((k) => k !== 'versao')[0] + '=' + Object.values(c)[0]),
    ['resultado=venda_fup', 'produto=performance', 'ticket=15.984,00', 'pagamento=Pix + cartão']);
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: venda com tudo preenchido sai de "Em andamento" e vai para "Vendidos"; faltando algo, continua na lista', async () => {
  const baseLinha = LINHAS_RES.reports[0];
  const linhas = { ...LINHAS_RES, reports: [
    { ...baseLinha, id: 'c1', closerId: 'c1', resultado: 'venda_call', produto: 'performance', ticket: 18624, pagamento: 'Cartão de crédito 12x' }, // completa
    { ...baseLinha, id: 'c2', closerId: 'c1', resultado: 'venda_call', produto: 'performance', ticket: 18624, pagamento: '' }, // falta o pagamento
    { ...baseLinha, id: 'c3', closerId: 'c1', resultado: 'em_followup' },
  ] };
  const api = apiBase({ papel: 'master', nome: 'Cauã', closers: [{ id: 'c1', nome: 'Pedro Pasin' }] })
    .quando('GET /api/master/resultados', () => ({ corpo: { ...linhas, closers: [{ id: 'c1', nome: 'Pedro Pasin' }] } }))
    .quando('GET /api/master/inteligencia', () => ({ corpo: INTEL }))
    .quando('PATCH /api/admin/reports/c2/resultado', ({ corpo }) => ({ corpo: { ok: true, versao: corpo.versao + 1 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  const ids = () => [...p.$('listaRes').querySelectorAll('tr')].map((tr) => tr.dataset.res);
  await esperar(() => ids().length === 2, { motivo: 'em andamento' });
  assert.deepEqual(ids().sort(), ['c2', 'c3'], 'a venda completa não fica em "Em andamento"; a incompleta fica');
  assert.match(p.$('statusRes').textContent, /2 em andamento · 1 vendido\(s\) \(R\$ 18\.624,00\)/);

  // preencher o que faltava: a linha vai para Vendidos
  const pagamento = p.document.querySelector('tr[data-res="c2"] [data-res-campo="pagamento"]');
  pagamento.value = 'Pix à vista';
  pagamento.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => !ids().includes('c2'), { motivo: 'venda completa sai da lista' });
  await esperar(() => /Venda completa: foi para Vendidos/.test(p.$('toast').textContent), { motivo: 'aviso' });

  p.$('resVisao').value = 'vendidos';
  p.$('resVisao').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => ids().includes('c1'), { motivo: 'aba de vendidos' });
  assert.ok(!ids().includes('c3'));
  p.$('resVisao').value = 'tudo';
  p.$('resVisao').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => ids().length === 3, { motivo: 'tudo' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

// ---------------------------------------------------------------- match pelo PDF do handoff (ligação)
test('Match com o closer pelo PDF do handoff: some sem closer com análise; envia o PDF, baixa o match; sem PDF usa o report gerado', async () => {
  const comAnalise = [{ id: 'c1', nome: 'Paulo Henrique', apelido: 'PH' }];
  let analises = [];
  const api = apiBase({ papel: 'sdr', nome: 'Ana' })
    .quando('GET /api/eu', () => ({ corpo: { ok: true, nome: 'Ana', id: '1', papel: 'sdr', analises } }))
    .quando('POST /api/afinidade/handoff', () => ({ corpo: { ok: true, afinidade: { nota: 8, apelido: 'PH', veredito: 'Casal decidido.' }, arquivo: 'Match PH - Lead.pdf', arquivoBase64: 'UERG' } }));
  let p = abrirPainel(api);
  await aberto(p);
  assert.ok(!visivel(p.$('matchCard')), 'sem closer com análise, o cartão nem aparece');
  p.fechar();

  analises = comAnalise;
  p = abrirPainel(api);
  await aberto(p);
  await esperar(() => visivel(p.$('matchCard')), { motivo: 'cartão do match' });
  assert.equal(p.$('matchAnalisar').textContent, 'Analisar Match com PH');
  assert.ok(!visivel(p.$('matchCloserBox')), 'um closer só: nem precisa escolher');

  // sem PDF, sem texto e sem report gerado: pede o PDF
  p.$('matchAnalisar').click();
  await esperar(() => /Escolha o PDF do handoff/.test(p.$('matchStatus').textContent), { motivo: 'pede o PDF' });
  assert.equal(api.contar('POST /api/afinidade/handoff'), 0);

  // com o PDF: vai em base64 e o match baixa
  Object.defineProperty(p.$('matchPdf'), 'files', { configurable: true, value: [new p.w.File(['%PDF-1.3 handoff'], 'Handoff - Lead.pdf', { type: 'application/pdf' })] });
  p.$('matchLead').value = 'Lead de Teste';
  p.$('matchAnalisar').click();
  await esperar(() => p.downloads.length === 1, { motivo: 'download do match' });
  const corpo = api.corpos('POST /api/afinidade/handoff')[0];
  assert.deepEqual([corpo.closerId, corpo.nome, Buffer.from(corpo.pdfBase64, 'base64').toString()], ['c1', 'Lead de Teste', '%PDF-1.3 handoff']);
  assert.deepEqual(p.downloads[0], { href: 'data:application/pdf;base64,UERG', nome: 'Match PH - Lead.pdf' });
  assert.match(p.$('matchStatus').textContent, /^Match 8\/10 com PH\. Casal decidido\. O PDF com os pontos de match e o plano da call foi baixado\.$/);
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

// ---------------------------------------------------------------- trazer do Report Closer
test('Resultados: trazer do Report Closer manda o arquivo em lotes de 5 e conta o que entrou; arquivo errado é recusado na hora', async () => {
  const api = apiMaster().quando('POST /api/master/importar-reports', ({ corpo }) => ({ corpo: { ok: true, importados: corpo.reports.length - 1, jaEstavam: 1, deOutroSdr: 0, invalidos: 0, comPdf: corpo.reports.length - 1 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  await esperar(() => p.document.querySelectorAll('#listaRes tr').length > 0, { motivo: 'linhas' });
  const escolher = (texto) => Object.defineProperty(p.$('impArquivo'), 'files', { configurable: true, value: texto == null ? [] : [{ name: 'report-closer.json', text: async () => texto }] });

  p.$('impEnviar').click();
  await esperar(() => /Escolha o arquivo/.test(p.$('impStatus').textContent), { motivo: 'sem arquivo' });
  escolher('{"qualquer": 1}');
  p.$('impEnviar').click();
  await esperar(() => /não é a exportação do Report Closer/.test(p.$('impStatus').textContent), { motivo: 'arquivo errado' });
  assert.equal(api.contar('POST /api/master/importar-reports'), 0);

  const reports = Array.from({ length: 7 }, (_, i) => ({ id: 'r' + i, lead: 'Lead ' + i, usuarioNome: 'Cauã', quando: '2026-10-07T14:00:00.000Z' }));
  escolher(JSON.stringify({ formato: 'report-closer/1', reports }));
  p.$('impEnviar').click();
  await esperar(() => /importado/.test(p.$('impStatus').textContent), { motivo: 'importou' });
  assert.deepEqual(api.corpos('POST /api/master/importar-reports').map((c) => [c.formato, c.reports.length]), [['report-closer/1', 5], ['report-closer/1', 2]]);
  assert.equal(p.$('impStatus').textContent, '5 report(s) importado(s), 5 com PDF; 2 já estavam aqui.');
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Puxar do RD: o RD pediu uma pausa — o painel espera e continua até acabar', async () => {
  const respostas = [{ conferidos: 2, vendidos: 1, encerrados: 0, restantes: 3, limitado: true }, { conferidos: 3, vendidos: 0, encerrados: 1, restantes: 0 }];
  const api = apiMaster().quando('POST /api/master/vendas-rd', () => ({ corpo: respostas.shift() || { conferidos: 0, restantes: 0 } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  await esperar(() => p.document.querySelectorAll('#listaRes tr').length > 0, { motivo: 'linhas' });
  p.w.ESPERA_DO_RD_MS = 60;
  p.$('resVendasRd').click();
  await esperar(() => /5 lead\(s\) conferido\(s\) no RD · 1 vendido\(s\) · 1 não comprou/.test(p.$('toast').textContent), { motivo: 'terminou depois da pausa' });
  const pedidos = api.pedidos.filter((x) => x.chave === 'POST /api/master/vendas-rd');
  assert.equal(pedidos.length, 2);
  assert.equal(pedidos[0].query.get('varredura'), pedidos[1].query.get('varredura'), 'a mesma varredura continua');
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

// ---------------------------------------------------------------- report automático
test('Report automático: mostra a contagem e os desqualificados do dia, guarda o que se digita e copia o texto pronto', async () => {
  const dia = (corpo = {}) => ({
    dia: '2026-10-14', contagem: { novos: 28, respostas: 16, recontatos: 53, conversas: 70 },
    desqualificados: { total: 3, motivos: [{ motivo: 'Nunca respondeu', qtd: 2 }, { motivo: 'Número inválido', qtd: 1 }], aviso: '' },
    manual: { automaticas: null, realizadas: null, agendasCaidas: '', noShow: '', extras: '', ...corpo },
    texto: 'REPORT Ana | 14/10\n\n\n---------------------------------- \nLeads novos contatados: 28' + (corpo.automaticas != null ? '\nAutomáticas: ' + corpo.automaticas : ''),
  });
  const api = apiDoDia()
    .quando('GET /api/report-dia', () => ({ corpo: { ok: true, ...dia() } }))
    .quando('PUT /api/report-dia', ({ corpo }) => ({ corpo: { ok: true, ...dia(corpo.manual) } }));
  const p = abrirPainel(api, { hash: '#dia' });
  await esperar(() => /Leads novos/.test(p.$('repContagem').textContent), { motivo: 'contagem' });
  assert.deepEqual([...p.$('repContagem').children].map((c) => c.lastElementChild.textContent), ['28', '16', '53', '3']);
  assert.equal(p.$('repDesq').textContent, 'Desqualificados: 2x Nunca respondeu · 1x Número inválido');
  assert.match(p.$('repTexto').value, /^REPORT Ana \| 14\/10/);
  assert.equal(api.pedidos.find((x) => x.chave === 'GET /api/report-dia').query.get('dia'), p.$('repDia').value);

  // digitar guarda (sem apagar o que a pessoa está escrevendo) e o texto pronto se refaz
  p.$('repAutomaticas').value = '11';
  p.$('repAutomaticas').dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.$('repNoShow').value = 'Nelson às 15h30';
  p.$('repNoShow').dispatchEvent(new p.w.Event('input', { bubbles: true }));
  await esperar(() => /Automáticas: 11/.test(p.$('repTexto').value), { motivo: 'texto refeito' });
  assert.equal(api.contar('PUT /api/report-dia'), 1, 'duas digitações seguidas, um só envio');
  assert.deepEqual(api.corpos('PUT /api/report-dia')[0].manual, { automaticas: '11', realizadas: '', agendasCaidas: '', noShow: 'Nelson às 15h30', extras: '' });
  assert.equal(p.$('repNoShow').value, 'Nelson às 15h30');

  // copiar
  let copiado = '';
  Object.defineProperty(p.w.navigator, 'clipboard', { configurable: true, value: { writeText: async (x) => { copiado = x; } } });
  p.$('repCopiar').click();
  await esperar(() => copiado !== '', { motivo: 'copiou' });
  assert.equal(copiado, p.$('repTexto').value);
  await esperar(() => /Report copiado/.test(p.$('toast').textContent), { motivo: 'aviso' });
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Resultados: trazer as vendas do closer direto do RD manda o closer e a data e conta o que entrou', async () => {
  const api = apiMaster().quando('POST /api/master/trazer-vendas-rd', () => ({ corpo: { ok: true, vistos: 9, criados: 6, completados: 2, jaEstavam: 1, semSdr: 1, deOutroSdr: 0, paginas: 1, truncado: false } }));
  const p = abrirPainel(api, { hash: '#resultados' });
  await esperar(() => p.document.querySelectorAll('#listaRes tr').length > 0, { motivo: 'linhas' });
  assert.match(p.$('vrDesde').value, /^\d{4}-\d{2}-01$/, 'começa no dia 1 do mês');
  assert.equal(p.$('vrCloser').value, 'Paulo Henrique');
  p.$('vrTrazer').click();
  await esperar(() => /9 venda\(s\) do closer no período: 6 report\(s\) criado\(s\), 2 completado\(s\), 1 já estavam completos; 1 sem o campo SDR/.test(p.$('vrStatus').textContent), { motivo: 'resumo' });
  assert.deepEqual(api.corpos('POST /api/master/trazer-vendas-rd'), [{ closer: 'Paulo Henrique', desde: p.$('vrDesde').value }]);
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Match com PH: medidor da meta, plano do mês, comparativo, mês a mês e a lista conferível; salvar a meta e atualizar do RD', async () => {
  const plano = (meta1) => ({
    mes: '2026-10', ultimoSabado: '2026-10-31', diasUteis: 23, diasPassados: 14, diasRestantes: 10, feito: { reunioes: 4, vendas: 1, faturamento: 20000 },
    conversao: 0.6, conversaoHistorica: 0.6, conversaoAlvo: 0, conversaoMes: 0.25, vendasEsperadas: null, ticketMedio: 15666.67, projecao: 32857.14, projecaoReunioes: 6.6,
    metas: meta1 ? [{ nome: 'meta1', alvo: meta1, falta: meta1 - 20000, pct: 20000 / meta1, batida: false, porDia: (meta1 - 20000) / 10, vendas: 6, reunioes: 10, reunioesPorDia: 1, esperadoHoje: 60870 }] : [],
  });
  let meta1 = 100000;
  const dados = (escopo = 'minhas') => ({
    ok: true, escopo, time: ['Reinaldo Junior', 'Luiza Lemes'], closer: 'Paulo Henrique', sdr: 'Cauã Lima', desde: '2026-07-01', ate: '2026-10-20', atualizadoEm: '2026-10-20T15:00:00.000Z', cache: false,
    meses: [
      { mes: '2026-07', reunioes: 2, vendas: 1, faturamento: 18000, conversao: 0.5, ticketMedio: 18000 },
      { mes: '2026-08', reunioes: 1, vendas: 0, faturamento: 0, conversao: 0, ticketMedio: 0 },
      { mes: '2026-09', reunioes: 1, vendas: 1, faturamento: 9000, conversao: 1, ticketMedio: 9000 },
      { mes: '2026-10', reunioes: 4, vendas: 1, faturamento: 20000, conversao: 0.25, ticketMedio: 20000 },
    ],
    reunioes: [
      { id: 'c1', fonte: 'rd', lead: 'Lead <b>Um</b>', dataReuniao: '2026-10-14', origemData: 'criacao', contaReuniao: true, estado: 'venda', etapa: 'Vendido', venda: true, diaVenda: '2026-10-15', ticket: 20000 },
      { id: 'r_x', fonte: 'report', lead: 'Lead Dois', dataReuniao: '2026-09-10', origemData: 'report', contaReuniao: true, estado: 'fup', etapa: '', venda: false, diaVenda: '', ticket: 0, sdr: 'Cauã Lima', minha: true },
      ...(escopo === 'time' ? [{ id: 'c9', fonte: 'rd', lead: 'Lead Três', dataReuniao: '2026-10-02', origemData: 'campo', contaReuniao: true, estado: 'fup', etapa: '', venda: false, diaVenda: '', ticket: 0, sdr: 'Luiza Lemes', minha: false }] : []),
    ],
    comparacao: {
      minha: { reunioes: 8, vendas: 3, conversao: 0.375, faturamento: 47000, ticketMedio: 15666.67 },
      time: { reunioes: 20, vendas: 5, conversao: 0.25, faturamento: 80000, ticketMedio: 16000 },
      sdrs: [
        { nome: 'Cauã Lima', voce: true, reunioes: 8, vendas: 3, conversao: 0.375, faturamento: 47000, ticketMedio: 15666.67 },
        { nome: 'Luiza <b>L</b>', voce: false, reunioes: 12, vendas: 2, conversao: 1 / 6, faturamento: 33000, ticketMedio: 16500 },
      ],
      profissoes: [
        { rotulo: 'Empresário', minha: { reunioes: 4, vendas: 3, conversao: 0.75 }, time: { reunioes: 9, vendas: 4, conversao: 4 / 9 } },
        { rotulo: 'Médico', minha: { reunioes: 0, vendas: 0, conversao: 0 }, time: { reunioes: 3, vendas: 0, conversao: 0 } },
      ],
    },
    diagnostico: { closerNoRd: 'Paulo Henrique Pagoti', cardsLidos: 120, paginas: 3, truncado: false, deOutroCloser: 0, semSdr: 7, deOutroSdr: 30, doTime: 12, noShow: 2, aindaNaoAconteceu: 3, foraDoPeriodo: 40, dataPeloCampo: 0, dataPelaCriacao: 8, etapasSemReuniao: { 'Reunião agendada': 3 }, doReport: 1 },
    metas: meta1 ? { '2026-10': { meta1, meta2: 0, meta3: 0, conversaoAlvo: 0 } } : {},
    plano: plano(meta1),
    mesmoPeriodo: { atual: { mes: '2026-10', ate: '2026-10-20', reunioes: 4, vendas: 1, faturamento: 20000 }, anterior: { mes: '2026-09', ate: '2026-09-20', reunioes: 2, vendas: 1, faturamento: 9000 } },
    analises: {
      total: 9, vendas: 4, media: 4 / 9, minAmostra: 3,
      cortes: [{ id: 'profissao', titulo: 'Profissão (formulário do lead)', informadas: 8, grupos: [
        { rotulo: 'Empresário', reunioes: 4, vendas: 3, faturamento: 60000, conversao: 0.75, ticketMedio: 20000 },
        { rotulo: 'Lojista <b>x</b>', reunioes: 4, vendas: 1, faturamento: 20000, conversao: 0.25, ticketMedio: 20000 },
      ] }],
      destaques: [{ corte: 'profissao', titulo: 'Profissão', melhor: 'Empresário', conversao: 0.75, vendas: 3, reunioes: 4, pior: 'Lojista', conversaoPior: 0.25, vezesMedia: 1.6875 }],
      porProduto: [{ rotulo: 'Pronix Performance', vendas: 4, faturamento: 80000, ticketMedio: 20000, parte: 1 }],
      tempo: { medioDias: 2, faixas: [{ rotulo: 'Na própria reunião', vendas: 3, parte: 0.75 }, { rotulo: 'Em até 7 dias', vendas: 1, parte: 0.25 }] },
      motivosPerda: [{ rotulo: 'Sem dinheiro', total: 2, parte: 2 / 3 }],
    },
  });
  const api = apiMaster()
    .quando('GET /api/master/google', () => ({ corpo: { configurado: false, conectado: false, agendas: [] } }))
    .quando('GET /api/master/match', ({ query }) => ({ corpo: dados(query.get('escopo') || 'minhas') }))
    .quando('PUT /api/master/match/meta', ({ corpo }) => { meta1 = Number(String(corpo.meta1).replace(/\./g, '')); return { corpo: { ok: true, meta: {}, ...dados(corpo.escopo) } }; });
  const p = abrirPainel(api, { hash: '#match' });
  await esperar(() => visivel(p.$('mtConteudo')), { motivo: 'aba do match carregada' });
  assert.ok(visivel(p.document.querySelector('.tab[data-aba="match"]')), 'item no menu');
  assert.equal(p.$('tituloPagina').textContent, 'Match com PH');
  const q = api.pedidos.find((x) => x.chave === 'GET /api/master/match').query;
  assert.deepEqual([q.get('closer'), q.get('desde'), q.get('atualizar'), q.get('escopo')], ['Paulo Henrique', '2026-06-01', null, 'minhas'], 'o padrão é junho (o CRM novo tem o histórico desde junho)');
  assert.equal(p.$('mtEscopoMinhas').getAttribute('aria-pressed'), 'true', 'começa em "Só as minhas"');

  // Você x time: as duas conversões lado a lado, por SDR e por profissão
  const vs = p.$('mtVs').textContent.replace(/\s+/g, ' ');
  assert.match(vs, /Só com você ?37,5% ?3 vendas de 8 reuniões/);
  assert.match(vs, /Time todo \(você \+ SDRs\) ?25,0% ?5 vendas de 20 reuniões/);
  assert.match(vs, /A sua conversão está \+12,5 p\.p\. acima da do time/);
  assert.match(p.$('mtTimeSub').textContent, /Reinaldo Junior, Luiza Lemes/);
  const porSdr = [...p.$('mtPorSdr').querySelectorAll('tr')].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  assert.deepEqual(porSdr, ['Cauã Lima (você) | 8 | 3 | 38% | R$ 47.000', 'Luiza <b>L</b> | 12 | 2 | 17% | R$ 33.000']);
  assert.equal(p.$('mtPorSdr').querySelector('b'), null, 'nome com HTML não vira elemento');
  const porProf = [...p.$('mtPorProfissao').querySelectorAll('tr')].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  assert.deepEqual(porProf, ['Empresário ▲ | 75%3 de 4 | 44%4 de 9', 'Médico | — | 0%0 de 3']);

  assert.match(p.$('mtMedidor').textContent, /20%[\s\S]*R\$\s*20\.000[\s\S]*de R\$\s*100\.000 \(meta 1\)/);
  // Metas: o ritmo, quanto falta e por dia útil, e a marca de onde deveria estar hoje (60.870 de 100.000 = 60,9%)
  const barras = p.$('mtBarras').textContent.replace(/\s+/g, ' ');
  assert.match(barras, /Atrás do ritmo da meta 1: faltam R\$ 40\.870 para o esperado de hoje/);
  assert.match(barras, /Meta 1 ?R\$ 20\.000 de R\$ 100\.000 ?20% ?Faltam R\$ 80\.000 · R\$ 8\.000 por dia útil ?hoje deveria estar em R\$ 60\.870/);
  assert.equal(p.$('mtBarras').querySelector('.marca').style.left, '60.9%');
  assert.ok(p.$('mtBarras').querySelector('.fill').classList.contains('atras'), 'atrás do ritmo: vermelho');
  // Conversão: régua com o alvo, a média do período e quantas vendas faltam para o alvo
  assert.match(p.$('mtConversaoVis').textContent.replace(/\s+/g, ' '), /Conversão do mês ?sem alvo ?25,0% ?1 venda em 4 reuniões\. Defina a conversão alvo[\s\S]*média desde jul\/26: 60,0%/);
  const plan = p.$('mtPlano').textContent;
  for (const x of ['Faturamento no mês', '14 de 23 dias úteis', 'Reuniões realizadas', 'Vendas', 'Vendas que faltam', '6', 'Reuniões que faltam', '10', '1 por dia útil', 'Projeção no ritmo', '32.857', '33% da meta 1']) assert.ok(plan.includes(x), 'faltou no plano: ' + x);
  assert.equal(p.$('mtPlano').querySelectorAll('.kpi').length, 6, 'seis quadros, sem repetir o que as barras mostram');
  // Análises: destaques e um quadro por corte
  assert.equal(p.$('mtAnalisesTitulo').textContent, 'Com quem o Paulo fecha mais');
  assert.match(p.$('mtDestaques').textContent, /Profissão[\s\S]*Empresário converte 75%[\s\S]*3 de 4 reuniões · 1,7x a média · menor: Lojista \(25%\)/);
  const tabelaProf = [...p.$('mtCortes').querySelectorAll('.mt-corte')[0].querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  assert.deepEqual(tabelaProf, ['Empresário ★ | 4 | 3 | 75% | R$ 60.000', 'Lojista <b>x</b> | 4 | 1 | 25% | R$ 20.000']);
  assert.equal(p.$('mtCortes').querySelector('b'), null, 'rótulo com HTML não vira elemento');
  assert.match(p.$('mtVendasAnalise').textContent, /Quanto tempo levou para fechar[\s\S]*média de 2 dias[\s\S]*Por que não compraram[\s\S]*Sem dinheiro/);
  assert.match(p.$('mtMesNome').textContent, /outubro de 2026 · 10 de 23 dias úteis pela frente/);
  // o formulário já vem com a meta salva, formatada, e explica os dias úteis
  assert.equal(p.$('mtMeta1').value, '100.000');
  assert.match(p.$('mtFormDias').textContent, /segunda a sexta \+ o último sábado \(31\/10\) · 23 no mês/);
  assert.match(p.$('mtDica1').textContent, /R\$\s*8\.000\/dia · 6 vendas · 10 reuniões/);
  assert.match(p.$('mtDicaConv').textContent, /No mês: 25,0% · desde jul\/26: 60,0%/);
  assert.equal(p.$('mtSabado'), null, 'não tem mais a opção de sábado: o último sábado sempre conta');
  // a prévia muda enquanto digita, antes de salvar
  p.$('mtConversao').value = '20';
  p.$('mtConversao').dispatchEvent(new p.w.Event('input'));
  assert.match(p.$('mtDica1').textContent, /6 vendas · 30 reuniões/);
  assert.match(p.$('mtComparativo').textContent, /Reuniões realizadas4▲ 100%antes: 2/);
  const linhas = [...p.$('mtMeses').querySelectorAll('tr')].map((tr) => [...tr.cells].map((td) => td.textContent.replace(/\s+/g, ' ').trim()).join(' '));
  assert.equal(linhas.length, 5, '4 meses + total');
  assert.match(linhas[0], /^jul\/26 2 1 50,0% R\$\s*18\.000/);
  assert.match(linhas[3], /^out\/26 \(atual\)/);
  assert.match(linhas[4], /^Total 8 3 37,5% R\$\s*47\.000/);
  assert.equal(p.$('mtLista').querySelector('b'), null, 'nome de lead com HTML não vira elemento');
  assert.match(p.$('mtLista').textContent.replace(/\s+/g, ' '), /14\/10Lead <b>Um<\/b> Vendeu · Vendido 15\/10R\$ 20\.000 RD · criação do card/);
  assert.match(p.$('mtDiag').textContent, /12 reunião\(ões\) de outros SDRs do time[\s\S]*7 sem o campo SDR preenchido, 30 de SDR fora do time[\s\S]*Reunião agendada \(3\)/);
  assert.doesNotMatch(p.$('mtLista').textContent, /· SDR/, 'só as minhas: a lista não repete o SDR');

  // Salvar a meta manda o mês e os valores e redesenha
  p.$('mtMeta1').value = '150000';
  p.$('mtMeta1').dispatchEvent(new p.w.Event('blur'));
  assert.equal(p.$('mtMeta1').value, '150.000', 'os reais ganham o ponto ao sair do campo');
  // milhar com vírgula também vale, e meta pequena demais ganha aviso antes de salvar
  p.$('mtMeta2').value = '392,000';
  p.$('mtMeta2').dispatchEvent(new p.w.Event('blur'));
  assert.equal(p.$('mtMeta2').value, '392.000');
  p.$('mtMeta3').value = '392';
  p.$('mtMeta3').dispatchEvent(new p.w.Event('input'));
  assert.match(p.$('mtDica3').textContent, /Confere: R\$\s*392\? Para 392 mil, digite 392\.000/);
  p.$('mtMeta2').value = '';
  p.$('mtMeta3').value = '';
  p.$('mtSalvarMeta').click();
  await esperar(() => /Meta salva às/.test(p.$('statusMtMeta').textContent), { motivo: 'meta salva' });
  assert.deepEqual(api.corpos('PUT /api/master/match/meta')[0], { closer: 'Paulo Henrique', desde: '2026-07-01', escopo: 'minhas', mes: '2026-10', meta1: '150.000', meta2: '', meta3: '', conversaoAlvo: '20' });
  assert.match(p.$('mtMedidor').textContent, /de R\$\s*150\.000/, 'redesenha com a resposta do salvar');
  assert.equal(api.contar('GET /api/master/match'), 1, 'sem depender de outra leitura');
  // alterar de novo também vale
  p.$('mtMeta1').value = '180.000';
  p.$('mtSalvarMeta').click();
  await esperar(() => /de R\$\s*180\.000/.test(p.$('mtMedidor').textContent), { motivo: 'segunda alteração' });
  assert.equal(api.corpos('PUT /api/master/match/meta')[1].meta1, '180.000');

  // Atualizar do RD pede leitura nova
  p.$('mtAtualizar').click();
  await esperar(() => api.pedidos.some((x) => x.chave === 'GET /api/master/match' && x.query.get('atualizar') === '1'), { motivo: 'atualizar do RD' });
  await esperar(() => !p.$('mtAtualizar').disabled && /Lido do RD/.test(p.$('statusMt').textContent), { motivo: 'leitura nova na tela' });

  // Trocar o "desde" recarrega a aba com o novo período e fica lembrado neste navegador
  p.$('mtDesde').value = '2026-08-01';
  p.$('mtDesde').dispatchEvent(new p.w.Event('change'));
  await esperar(() => api.pedidos.some((x) => x.chave === 'GET /api/master/match' && x.query.get('desde') === '2026-08-01'), { motivo: 'novo período' });
  assert.deepEqual(JSON.parse(p.w.localStorage.getItem('mtFiltro')), { closer: 'Paulo Henrique', desde: '2026-08-01', escopo: 'minhas' });
  await esperar(() => !p.$('mtAtualizar').disabled && /Lido do RD/.test(p.$('statusMt').textContent), { motivo: 'período novo na tela' });
  assert.equal(p.document.querySelectorAll('[data-mt-ir]').length, 6, 'atalhos para as partes da aba');

  // "Time todo": pede o recorte do time, a lista diz de quem é cada reunião, e fica lembrado
  p.$('mtEscopoTime').click();
  await esperar(() => api.pedidos.some((x) => x.chave === 'GET /api/master/match' && x.query.get('escopo') === 'time'), { motivo: 'escopo do time' });
  await esperar(() => /SDR Luiza Lemes/.test(p.$('mtLista').textContent), { motivo: 'lista do time' });
  assert.equal(p.$('mtEscopoTime').getAttribute('aria-pressed'), 'true');
  assert.equal(p.$('mtEscopoMinhas').getAttribute('aria-pressed'), 'false');
  assert.match(p.$('mtLista').textContent, /SDR você/);
  assert.match(p.$('mtMesesEscopo').textContent, /time todo/);
  assert.match(p.$('mtSubAba').textContent, /do time todo/);
  assert.equal(JSON.parse(p.w.localStorage.getItem('mtFiltro')).escopo, 'time');
  await dormir(60);
  assert.deepEqual(p.erros, []);
  p.fechar();
});

test('Match com PH: SDR não vê a aba nem chama a rota', async () => {
  const api = apiBase({ papel: 'sdr', nome: 'Ana' });
  const p = abrirPainel(api, { hash: '#match' });
  await aberto(p);
  assert.ok(!visivel(p.document.querySelector('.tab[data-aba="match"]')));
  assert.ok(!visivel(p.$('aba-match')));
  assert.equal(api.contar('GET /api/master/match'), 0);
  p.fechar();
});
