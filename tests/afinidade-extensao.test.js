'use strict';
// "Analisar Match com o closer" na extensão: content scripts REAIS (WhatsApp e Instagram), popup real
// e background, tudo em DOM simulado. Sem rede e sem IA.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
const { abrirPagina, montarWhatsApp, montarInstagram, esperar, dormir } = require('./helpers/dom');

const RAIZ = path.join(__dirname, '..');
const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');

const RESPOSTA_PDF = { ok: true, id: 'rep123', dados: { lead: 'Marcos', resumo: [{ rotulo: 'Investimento', valor: 'R$ 5 mil' }] }, arquivo: 'Report_Marcos.pdf', arquivoBase64: 'AAAA' };
const AFINIDADE = {
  ok: true,
  afinidade: {
    closerId: 'c1', closerNome: 'Paulo Henrique Pagoti', apelido: 'PH', nota: 8, faixa: 'alta',
    veredito: 'Casal decidido: é o cenário em que ele mais fecha. <img src=x onerror=alert(1)>',
    motivos: ['Decide com a esposa e os dois vão à call: casal junto fecha 9 de 17.', 'Loja física em queda. <b>x</b>', 'Tem cartão próprio.', 'Quarto motivo fica só no PDF.'],
    atencao: ['Nunca vendeu online.'], comoConduzir: ['c1'], faltaSaber: [],
    base: { inteligenciaEm: '2026-10-12T12:00:00.000Z', reunioes: 0, vendas: 0, casos: 87, casosVendas: 33 },
  },
  arquivo: 'Match_PH_Marcos_11-10-2026.pdf', arquivoBase64: 'CCCC',
};
const PH = { id: 'c1', apelido: 'PH', nome: 'Paulo Henrique Pagoti' };

/** Service worker falso: devolve o report e responde a análise de afinidade (ou o que `analise` mandar). */
function servidorFalso({ analise, duplicado = false } = {}) {
  const pedidos = { reports: [], afinidade: [] };
  const aoEnviar = async (original) => {
    const msg = JSON.parse(JSON.stringify(original));
    if (msg.action === 'reportFetch') {
      pedidos.reports.push(msg);
      if (duplicado && !msg.forcarNovo) return { ok: true, duplicado: true, existente: { id: 'abc', quando: Date.now(), lead: 'X', podeAbrir: true } };
      return RESPOSTA_PDF;
    }
    if (msg.action === 'baixarExistente') return { ok: true, arquivo: 'Report_Antigo.pdf', arquivoBase64: 'BBBB' };
    if (msg.action === 'afinidade') {
      pedidos.afinidade.push(msg);
      return analise ? analise(msg, pedidos.afinidade.length) : AFINIDADE;
    }
    if (msg.action === 'transcreverAudio') return { ok: true, texto: 'áudio transcrito' };
    return { ok: true };
  };
  return { aoEnviar, pedidos };
}

const CONVERSA = [
  { from: 'eu', texto: 'Você decide sozinho ou com alguém?', hora: '10:00, 01/09/2026' },
  { from: 'eles', texto: 'Com a minha esposa, ela vai na reunião', hora: '10:01, 01/09/2026' },
  { from: 'eu', texto: 'Consegue investir 5 mil?', hora: '10:03, 01/09/2026' },
  { from: 'eles', texto: 'Consigo', hora: '10:04, 01/09/2026' },
];

const abertas = [];
test.afterEach(() => abertas.splice(0).forEach((p) => p.fechar()));
function whatsapp(servidor) {
  const p = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar: servidor.aoEnviar });
  montarWhatsApp(p, CONVERSA);
  abertas.push(p);
  return p;
}
const caixa = (p) => p.document.querySelector('#closer-report-badge #cr-afinidade');
const pronto = (p) => esperar(() => /Report pronto/.test(p.badge()), { motivo: 'report pronto' });

// ---------------------------------------------------------------- WhatsApp
test('WhatsApp: o botão do closer gera SÓ a análise — nenhum report é pedido; o aviso traz a nota, o veredito e o PDF do match', async () => {
  const servidor = servidorFalso();
  const p = whatsapp(servidor);
  p.iniciar('https://servidor.teste', { afinidade: PH });
  await esperar(() => caixa(p) && /Match com PH/.test(caixa(p).textContent), { motivo: 'análise no aviso' });
  assert.equal(servidor.pedidos.reports.length, 0, 'sem report novo (nem custo da IA paga)');
  assert.doesNotMatch(p.badge(), /Report pronto|Gerando report/);

  // o que foi pedido: o closer e a conversa lida (o servidor junta o perfil do report que o lead já tiver)
  assert.equal(servidor.pedidos.afinidade.length, 1);
  const pedido = servidor.pedidos.afinidade[0];
  assert.deepEqual([pedido.closerId, pedido.reportId, pedido.dados], ['c1', '', null]);
  assert.equal(pedido.mensagens.length, 4);
  assert.equal(pedido.mensagens[1].content, 'Com a minha esposa, ela vai na reunião');

  // o que aparece
  const t = caixa(p).textContent;
  assert.match(t, /8\/10Match com PHalto/);
  assert.match(t, /Casal decidido/);
  assert.match(t, /Atenção: Nunca vendeu online\./);
  // o porquê da nota fica no próprio aviso (até 3 motivos), com a base em que ela se apoia
  assert.match(t, /• Decide com a esposa e os dois vão à call: casal junto fecha 9 de 17\./);
  assert.match(t, /• Tem cartão próprio\./);
  assert.ok(!t.includes('Quarto motivo'), 'o quarto motivo fica para o PDF');
  assert.match(t, /Base: 87 calls dele analisadas, 33 vendas/);
  assert.equal(caixa(p).querySelector('b'), null, 'motivo nunca vira HTML');
  assert.equal(caixa(p).querySelector('img'), null, 'texto da análise nunca vira HTML');
  const link = caixa(p).querySelector('a[download]');
  assert.equal(link.getAttribute('download'), 'Match_PH_Marcos_11-10-2026.pdf');
  assert.equal(link.getAttribute('href'), 'data:application/pdf;base64,CCCC');
  // só o PDF do match: o do report não é gerado
  const baixar = [...p.document.querySelectorAll('#closer-report-badge a[download]')].map((a) => a.getAttribute('download'));
  assert.deepEqual(baixar, ['Match_PH_Marcos_11-10-2026.pdf']);
});

test('WhatsApp: pelo "Gerar report" comum, nada de análise (nem pedido, nem bloco no aviso)', async () => {
  const servidor = servidorFalso();
  const p = whatsapp(servidor);
  p.iniciar();
  await pronto(p);
  await dormir(80);
  assert.equal(servidor.pedidos.afinidade.length, 0);
  assert.equal(caixa(p), null);
});

test('WhatsApp: se a análise falha, dá para tentar de novo (sem gerar report)', async () => {
  const servidor = servidorFalso({ analise: (_msg, n) => (n === 1 ? { ok: false, erro: 'A IA gratuita chegou no limite. Tente em 1 minuto.' } : AFINIDADE) });
  const p = whatsapp(servidor);
  p.iniciar('https://servidor.teste', { afinidade: PH });
  await esperar(() => caixa(p) && /chegou no limite/.test(caixa(p).textContent), { motivo: 'erro da análise' });
  assert.equal(servidor.pedidos.reports.length, 0);
  [...caixa(p).querySelectorAll('button')].find((b) => b.textContent === 'Tentar de novo').click();
  await esperar(() => /Match com PH/.test(caixa(p).textContent), { motivo: 'análise na segunda tentativa' });
  assert.equal(servidor.pedidos.afinidade.length, 2);
});

test('WhatsApp: lead que já tem report — o botão do closer não pergunta de duplicado nem abre o report: só a análise', async () => {
  const servidor = servidorFalso({ duplicado: true });
  const p = whatsapp(servidor);
  p.iniciar('https://servidor.teste', { afinidade: PH });
  await esperar(() => caixa(p) && /Match com PH/.test(caixa(p).textContent), { motivo: 'análise no aviso' });
  assert.equal(servidor.pedidos.reports.length, 0);
  assert.doesNotMatch(p.badge(), /Já existe/);
  assert.equal(servidor.pedidos.afinidade[0].mensagens.length, 4);
});

test('pedido de análise malformado vindo de fora (sem id) é ignorado', async () => {
  const servidor = servidorFalso();
  const p = whatsapp(servidor);
  p.iniciar('https://servidor.teste', { afinidade: { apelido: 'PH' } });
  await pronto(p);
  await dormir(80);
  assert.equal(servidor.pedidos.afinidade.length, 0);
});

// ---------------------------------------------------------------- Instagram
test('Instagram: o mesmo botão funciona — nota e segundo PDF no aviso', async () => {
  const servidor = servidorFalso();
  const p = abrirPagina({ arquivo: 'extension/content-instagram.js', url: 'https://www.instagram.com/direct/t/111/', aoEnviar: servidor.aoEnviar });
  abertas.push(p);
  montarInstagram(p, CONVERSA.map((m) => ({ from: m.from, texto: m.texto })), { visiveis: 6 });
  p.iniciar('https://servidor.teste', { afinidade: PH });
  await esperar(() => caixa(p) && /Match com PH/.test(caixa(p).textContent), { motivo: 'análise no aviso' });
  assert.equal(servidor.pedidos.reports.length, 0, 'só a análise, sem report');
  assert.deepEqual([servidor.pedidos.afinidade[0].closerId, servidor.pedidos.afinidade[0].reportId], ['c1', '']);
  assert.ok(caixa(p).querySelector('a[download="Match_PH_Marcos_11-10-2026.pdf"]'));
});

// ---------------------------------------------------------------- background
test('background: a análise vai para /api/afinidade com a chave salva; erro do servidor volta como erro', async () => {
  const carregar = (corpo, ok = true) => {
    const chamadas = [];
    let listener = null;
    const chrome = {
      storage: { local: { get: (padrao, cb) => cb(Object.assign({}, padrao, { chave: 'pnx_abc', server: 'https://report-pronix.vercel.app' })) } },
      runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    };
    const fetch = async (url, opts) => {
      chamadas.push({ url, opts });
      return { ok, status: ok ? 200 : 400, json: async () => corpo };
    };
    vm.runInNewContext(ler('extension/background.js'), { chrome, fetch, URL, JSON, Promise, console, AbortSignal });
    // A resposta nasce no contexto do vm (outro "realm"): copia para objetos do Node antes de comparar.
    return { chamadas, enviar: (msg) => new Promise((resolve) => { listener(msg, {}, (r) => resolve(JSON.parse(JSON.stringify(r)))); }) };
  };
  const bom = carregar({ ok: true, afinidade: { nota: 7 }, arquivo: 'a.pdf', arquivoBase64: 'ZZ' });
  const r = await bom.enviar({ action: 'afinidade', closerId: 'c1', reportId: 'rep1', dados: { lead: 'X' }, mensagens: [{ from: 'eu', content: 'oi' }], nome: 'X', server: 'https://evil.example' });
  assert.deepEqual(r, { ok: true, afinidade: { nota: 7 }, arquivo: 'a.pdf', arquivoBase64: 'ZZ' });
  assert.equal(bom.chamadas[0].url, 'https://report-pronix.vercel.app/api/afinidade');
  assert.equal(bom.chamadas[0].opts.headers['x-cr-key'], 'pnx_abc');
  assert.deepEqual(JSON.parse(bom.chamadas[0].opts.body), { closerId: 'c1', reportId: 'rep1', dados: { lead: 'X' }, mensagens: [{ from: 'eu', content: 'oi' }], nome: 'X' });

  const ruim = carregar({ erro: 'Ainda não há inteligência cadastrada para Fulano.' }, false);
  assert.deepEqual(await ruim.enviar({ action: 'afinidade', closerId: 'c2' }), { ok: false, erro: 'Ainda não há inteligência cadastrada para Fulano.' });
});

// ---------------------------------------------------------------- popup
async function abrirPopup(storageInicial, eu) {
  const html = ler('extension/popup.html').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://teste/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const storage = JSON.parse(JSON.stringify(storageInicial));
  const enviadas = [];
  w.chrome = {
    runtime: { lastError: null, getManifest: () => ({ version: 'teste' }) },
    tabs: {
      query: async () => [{ id: 1, url: 'https://web.whatsapp.com/' }],
      sendMessage: (_tab, msg, cb) => { enviadas.push(JSON.parse(JSON.stringify(msg))); cb({ ok: true, iniciado: true }); },
    },
    scripting: { executeScript: async () => {} },
    storage: {
      local: {
        get: (padrao, cb) => cb(Object.assign({}, padrao, JSON.parse(JSON.stringify(storage)))),
        set: (o, cb) => { Object.assign(storage, JSON.parse(JSON.stringify(o))); if (cb) cb(); },
        remove: (k, cb) => { delete storage[k]; if (cb) cb(); },
      },
    },
  };
  Object.defineProperty(w, 'crypto', { value: { subtle: { digest: (...a) => webcrypto.subtle.digest(...a) } }, configurable: true });
  w.TextEncoder = TextEncoder;
  if (!w.AbortSignal.timeout) w.AbortSignal.timeout = () => new w.AbortController().signal;
  w.fetch = async () => ({ ok: true, json: async () => eu });
  w.eval(ler('extension/popup.js'));
  return { w, document: w.document, storage, enviadas, botoes: () => [...w.document.querySelectorAll('#analises button')] };
}

test('popup: um botão por closer com inteligência; clicar manda gerar o report com a análise daquele closer', async () => {
  const eu = { ok: true, nome: 'Cauã Lima', analises: [PH, { id: 'c2', apelido: 'Vi<b>x</b>', nome: 'Vitor' }] };
  const p = await abrirPopup({ chave: 'pnx_caua', server: 'https://report-pronix.vercel.app' }, eu);
  await esperar(() => p.botoes().length === 2, { motivo: 'botões de análise' });
  assert.deepEqual(p.botoes().map((b) => b.textContent), ['Analisar Match com PH', 'Analisar Match com Vi<b>x</b>']);
  assert.equal(p.document.querySelector('#analises b'), null, 'apelido nunca vira HTML');
  assert.ok(!p.document.getElementById('analises').classList.contains('hidden'));
  assert.deepEqual(p.storage.analises, eu.analises, 'fica guardado para aparecer na hora da próxima vez');

  p.botoes()[0].click();
  await esperar(() => p.enviadas.length === 1, { motivo: 'start enviado' });
  assert.deepEqual(p.enviadas[0], { action: 'start', server: 'https://report-pronix.vercel.app', afinidade: PH });
  await esperar(() => /Analisando o match com PH/.test(p.document.getElementById('status').textContent), { motivo: 'status' });
  assert.match(p.document.getElementById('status').textContent, /Só a análise: nenhum report é gerado/);

  // o botão comum continua mandando só o report
  p.document.getElementById('gerar').click();
  await esperar(() => p.enviadas.length === 2, { motivo: 'start comum' });
  assert.deepEqual(p.enviadas[1], { action: 'start', server: 'https://report-pronix.vercel.app', afinidade: null });
  await dormir(40);
  p.w.close();
});

test('popup: para o master sem nenhum botão, explica o que falta (a inteligência do closer, ou o próprio closer)', async () => {
  const p = await abrirPopup({ chave: 'pnx_caua', server: 'https://report-pronix.vercel.app' }, { ok: true, nome: 'Cauã Lima', analises: [], analisesFaltando: ['PH<b>x</b>', 'Vitor'] });
  await esperar(() => !!p.document.getElementById('analisesFalta'), { motivo: 'aviso do que falta' });
  assert.equal(p.document.getElementById('analisesFalta').textContent, 'Botão "Analisar Match com PH<b>x</b>": falta cadastrar a inteligência dele no painel (Closers → Inteligência).');
  assert.equal(p.document.querySelector('#analises b'), null, 'apelido nunca vira HTML');
  assert.equal(p.botoes().length, 0);
  assert.ok(!p.document.getElementById('analises').classList.contains('hidden'));
  await dormir(40);
  p.w.close();

  const semCloser = await abrirPopup({ chave: 'pnx_caua', server: 'https://report-pronix.vercel.app' }, { ok: true, nome: 'Cauã Lima', analises: [], analisesFaltando: [] });
  await esperar(() => !!semCloser.document.getElementById('analisesFalta'), { motivo: 'aviso sem closer' });
  assert.match(semCloser.document.getElementById('analisesFalta').textContent, /cadastre o closer no painel \(aba Closers\)/);
  await dormir(40);
  semCloser.w.close();
});

test('popup: sem closer com inteligência, nenhum botão a mais (e a lista guardada é limpa)', async () => {
  const p = await abrirPopup({ chave: 'pnx_caua', server: 'https://report-pronix.vercel.app', analises: [PH] }, { ok: true, nome: 'Cauã Lima', analises: [] });
  await esperar(() => Array.isArray(p.storage.analises) && p.storage.analises.length === 0, { motivo: 'lista atualizada pelo servidor' });
  assert.equal(p.botoes().length, 0);
  assert.ok(p.document.getElementById('analises').classList.contains('hidden'));
  await dormir(40);
  p.w.close();
});

// ---------------------------------------------------------------- o pacote
test('manifest: o bloco da afinidade é carregado antes dos dois content scripts, e o popup injeta a mesma lista', () => {
  const manifest = JSON.parse(ler('extension/manifest.json'));
  const grupos = manifest.content_scripts.filter((c) => c.world !== 'MAIN').map((c) => c.js);
  assert.deepEqual(grupos, [['agenda.js', 'afinidade.js', 'painel.js', 'content.js'], ['afinidade.js', 'content-instagram.js']]);
  const popup = ler('extension/popup.js');
  assert.match(popup, /arquivos: \['agenda\.js', 'afinidade\.js', 'painel\.js', 'content\.js'\]/);
  assert.match(popup, /arquivos: \['afinidade\.js', 'content-instagram\.js'\]/);
  assert.ok(fs.existsSync(path.join(RAIZ, 'extension', 'afinidade.js')));
});
