'use strict';
// Testes das correções da auditoria (A01, A02, A08, A09, A12, A13, A17, A20).
// Rodam sem rede, sem chave de API e sem navegador: carregam trechos reais dos
// arquivos-fonte em sandboxes com objetos falsos. Uso: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');

// Pega o texto entre dois marcadores do código-fonte (falha alto se sumirem).
function fatia(src, inicio, fim) {
  const i = src.indexOf(inicio);
  assert.notEqual(i, -1, `marcador não encontrado: ${inicio}`);
  const f = src.indexOf(fim, i);
  assert.notEqual(f, -1, `marcador não encontrado: ${fim}`);
  return src.slice(i, f);
}

const imediato = () => new Promise((r) => setImmediate(r));
const ATAQUE = '<img src=x onerror=alert(1)>';

// ---------------------------------------------------------------- A12
test('A12: setStatus do popup trata o texto como texto, não como HTML', () => {
  const src = ler('extension/popup.js');
  const codigo = fatia(src, 'let statusVersao = 0;', '\nfunction escapeHtml');
  const filhos = [];
  const el = {
    className: '',
    textContent: 'antigo',
    appendChild: (n) => filhos.push(n),
    insertAdjacentHTML: (_pos, html) => filhos.push({ html }),
  };
  const document = {
    createElement: () => ({ className: '' }),
    createTextNode: (t) => ({ texto: t }),
  };
  const $ = () => el;
  const { setStatus } = new Function('$', 'document', codigo + '; return { setStatus };')($, document);

  setStatus(ATAQUE, { erro: true });
  assert.equal(el.className, 'status erro');
  assert.deepEqual(filhos, [{ texto: ATAQUE }], 'deve virar nó de texto');

  filhos.length = 0;
  setStatus('ok', { loading: true });
  assert.equal(filhos.length, 2);
  assert.equal(filhos[0].className, 'spinner');

  filhos.length = 0;
  setStatus('<b>oi</b>', { html: true }); // só quem monta o HTML e escapa o que é de fora
  assert.deepEqual(filhos, [{ html: '<b>oi</b>' }]);
});

test('A12: dashboard.setStatus usa textContent', () => {
  const src = ler('public/dashboard.html');
  const codigo = fatia(src, 'function setStatus(el, txt, opts) {', '// ---------- Menu');
  const filhos = [];
  const alvo = { className: '', textContent: '', appendChild: (n) => filhos.push(n) };
  const document = { createElement: () => ({ className: '' }), createTextNode: (t) => ({ texto: t }) };
  const { setStatus } = new Function('$', 'document', codigo + '; return { setStatus };')(() => alvo, document);
  setStatus('x', ATAQUE, { erro: true });
  assert.deepEqual(filhos, [{ texto: ATAQUE }]);
  assert.match(alvo.className, /erro/);
});

for (const arq of ['extension/content.js', 'extension/content-instagram.js']) {
  test(`A12: ${arq} escapa nome, arquivo e erros antes de ir para o badge (innerHTML)`, () => {
    const src = ler(arq);
    assert.ok(/const escHtml = /.test(src), 'escHtml precisa existir');
    assert.ok(!/\$\{nome \|\|/.test(src), 'nome do contato não pode entrar cru no HTML');
    assert.ok(/\$\{escHtml\(nome \|\|/.test(src), 'nome do contato deve passar por escHtml');
    assert.ok(!/texto: '' \+ /.test(src), 'erro/mensagem não pode entrar cru no badge');
    assert.ok(!/download="\$\{arquivo/.test(src), 'nome do arquivo no atributo download deve ser escapado');
  });
}

test('A12: escHtml neutraliza tags e aspas', () => {
  const src = ler('extension/content.js');
  const linha = fatia(src, 'const escHtml = ', ';\n') + ';';
  const escHtml = new Function(linha + '; return escHtml;')();
  const out = escHtml(ATAQUE + '"\'&');
  assert.ok(!out.includes('<') && !out.includes('>') && !out.includes('"'));
  assert.equal(escHtml(null), '');
});

// ---------------------------------------------------------------- A02
for (const arq of ['extension/content.js', 'extension/content-instagram.js']) {
  test(`A02: ${arq} só silencia <audio> durante a geração e devolve o estado original`, () => {
    const src = ler(arq);
    const codigo = fatia(src, 'let capturaAtiva = false;', '// Todo texto que vem de fora');
    const audio = () => ({ muted: false, volume: 0.8, pausado: false, pause() { this.pausado = true; } });
    const tocando = [audio(), audio()];
    let callback = null;
    class MO {
      constructor(cb) { callback = cb; }
      observe() {}
    }
    const document = { documentElement: {}, querySelectorAll: () => tocando };
    const api = new Function(
      'document',
      'MutationObserver',
      codigo + '; return { ligar(v) { capturaAtiva = v; }, restaurarAudios, silenciar };'
    )(document, MO);

    callback(); // mutação da página fora de um job: NÃO pode mexer no som do usuário
    assert.deepEqual(tocando.map((a) => [a.muted, a.volume]), [[false, 0.8], [false, 0.8]]);

    api.ligar(true);
    callback();
    assert.deepEqual(tocando.map((a) => [a.muted, a.volume]), [[true, 0], [true, 0]]);

    api.ligar(false);
    api.restaurarAudios();
    assert.deepEqual(tocando.map((a) => [a.muted, a.volume]), [[false, 0.8], [false, 0.8]]);
    assert.ok(tocando.every((a) => a.pausado), 'não deixa áudio tocando ao restaurar');

    callback(); // depois do job, de novo não mexe
    assert.equal(tocando[0].muted, false);
  });

  test(`A02: ${arq} liga e desliga a captura ao redor do job (mesmo com erro)`, () => {
    const src = ler(arq);
    assert.match(src, /jobEmAndamento = true;\n\s+capturaAtiva = true;\n\s+try \{/);
    assert.match(src, /finally \{\n\s+jobEmAndamento = false;\n\s+capturaAtiva = false;\n\s+restaurarAudios\(\);/);
  });
}

// ---------------------------------------------------------------- A01
for (const arq of ['extension/content.js', 'extension/content-instagram.js']) {
  test(`A01: ${arq} só aceita da fila global blobs criados depois do clique`, () => {
    const src = ler(arq);
    assert.match(src, /const t0 = Date\.now\(\) - 250;/);
    assert.match(src, /if \(b\.usado \|\| \(b\.ts < t0 && !antigosOk\)\) continue;/);
    assert.ok(!/if \(b\.usado\) continue;/.test(src), 'o consumo cego da fila não pode voltar');
  });
}

test('A01: a regra de tempo separa blob antigo de blob novo', () => {
  const t0 = 1000 - 250;
  const fila = [{ ts: 100, usado: false }, { ts: 900, usado: false }, { ts: 1200, usado: false }];
  const aceitos = fila.filter((b) => !(b.usado || b.ts < t0));
  assert.deepEqual(aceitos.map((b) => b.ts), [900, 1200]);
});

test('A02: capturarAudio do Instagram sempre pausa a bolha, também nas saídas antecipadas', () => {
  const src = ler('extension/content-instagram.js');
  const codigo = fatia(src, 'async function capturarAudio(bolha, dbg, iteracoes = 30) {', 'async function capturarAudioDaBolha');
  let pausas = 0;
  const bolha = { querySelectorAll: () => [{ pause: () => pausas++ }] };
  const fabrica = (interna) =>
    new Function('capturarAudioDaBolha', codigo + '; return capturarAudio;')(interna);

  return (async () => {
    assert.equal(await fabrica(async () => 'B64')(bolha, 'x'), 'B64');
    assert.equal(pausas, 1, 'pausa quando retorna cedo');
    await assert.rejects(fabrica(async () => { throw new Error('boom'); })(bolha, 'x'), /boom/);
    assert.equal(pausas, 2, 'pausa também quando dá erro');
  })();
});

// ---------------------------------------------------------------- A13
function carregarBackground(store, respostas = {}) {
  const chamadas = [];
  let listener = null;
  const chrome = {
    storage: { local: { get: (padrao, cb) => cb(Object.assign({}, padrao, store)) } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
  };
  const fetch = async (url, opts) => {
    chamadas.push({ url, opts });
    return { ok: true, status: 200, json: async () => respostas.corpo || { texto: 'ola' } };
  };
  vm.runInNewContext(ler('extension/background.js'), { chrome, fetch, URL, JSON, Promise, console, AbortSignal });
  const enviar = (msg) => new Promise((resolve) => { listener(msg, {}, resolve); });
  return { chamadas, enviar };
}

test('A13: o background ignora o server da mensagem e usa o salvo no popup', async () => {
  const { chamadas, enviar } = carregarBackground({ chave: 'pnx_abc', server: 'https://report-closer.vercel.app/' });
  const r = await enviar({ action: 'transcreverAudio', server: 'https://evil.example', base64: 'AA' });
  assert.equal(r.ok, true);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'https://report-closer.vercel.app/api/transcrever');
  assert.equal(chamadas[0].opts.headers['x-cr-key'], 'pnx_abc');
});

test('A13: sem server salvo usa o padrão; localhost http é aceito para testes locais', async () => {
  let ctx = carregarBackground({ chave: 'k' });
  await ctx.enviar({ action: 'reportFetch', server: 'https://evil.example', mensagens: [], nome: 'n' });
  assert.equal(ctx.chamadas[0].url, 'https://report-closer.vercel.app/api/report-direto');

  ctx = carregarBackground({ chave: 'k', server: 'http://localhost:3000' });
  await ctx.enviar({ action: 'reportFetch', mensagens: [], nome: 'n' });
  assert.equal(ctx.chamadas[0].url, 'http://localhost:3000/api/report-direto');
});

test('A13: servidor salvo inválido ou http fora do localhost não recebe a chave', async () => {
  for (const ruim of ['http://evil.example', 'javascript:alert(1)', 'nao e url']) {
    const { chamadas, enviar } = carregarBackground({ chave: 'k', server: ruim });
    const r = await enviar({ action: 'transcreverAudio', base64: 'AA' });
    assert.equal(r.ok, false, ruim);
    assert.match(r.erro, /servidor/i);
    assert.equal(chamadas.length, 0, `não pode chamar ${ruim}`);
  }
});

test('A13: sem chave não chama servidor nenhum', async () => {
  const { chamadas, enviar } = carregarBackground({ chave: '' });
  const r = await enviar({ action: 'transcreverAudio', base64: 'AA' });
  assert.equal(r.ok, false);
  assert.equal(chamadas.length, 0);
});

test('A13: duplicado continua sendo repassado ao content script', async () => {
  const { enviar } = carregarBackground({ chave: 'k' }, { corpo: { duplicado: true, existente: { id: '1', lead: 'X' } } });
  const r = await enviar({ action: 'reportFetch', mensagens: [], nome: 'n' });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, duplicado: true, existente: { id: '1', lead: 'X' } });
});

// A08/A09 (botão de gerar e aviso de duplicado) são cobertos em tests/painel.test.js, com o painel real.

// ---------------------------------------------------------------- A17
test('A17: appendConversa agenda a estimativa de custo (mudar .value não dispara "input")', () => {
  const src = ler('public/dashboard.html');
  const codigo = fatia(src, 'function appendConversa(linha) {', 'function fileRow');
  const ta = { value: '', scrollTop: 0, scrollHeight: 10 };
  const timers = [];
  const contexto = {
    $: () => ta,
    estimativaTimer: null,
    atualizarEstimativaCusto: () => {},
    renderChat: () => {},
    clearTimeout: () => {},
    setTimeout: (fn, ms) => { timers.push(ms); return 1; },
  };
  const { appendConversa } = new Function(
    ...Object.keys(contexto),
    codigo + '; return { appendConversa };'
  )(...Object.values(contexto));
  appendConversa('(áudio): oi');
  assert.equal(ta.value, '(áudio): oi\n');
  assert.deepEqual(timers, [700]);
});

// ---------------------------------------------------------------- A20
test('A20: a política de privacidade descreve Instagram, PDF guardado e as ações automáticas', () => {
  const html = ler('public/privacidade.html');
  assert.match(html, /Instagram Direct/);
  assert.ok(!/não fica salvo no servidor/.test(html));
  assert.match(html, /guardado no servidor/);
  assert.match(html, /rola a conversa/);
  assert.match(html, /toca cada áudio no mudo/);
  assert.ok(!/nenhuma ação automática/.test(html));
});

// ---------------------------------------------------------------- integridade
test('manifest: versão e descrição dentro do limite da Chrome Web Store', () => {
  const m = JSON.parse(ler('extension/manifest.json'));
  assert.ok(m.description.length <= 132, `descrição com ${m.description.length} caracteres`);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});

// ---------------------------------------------------------------- automação do cartão
test('automação: o service worker manda só a etiqueta e a data do agendamento — nunca texto de conversa', async () => {
  const marca = { qualificado: true, agendadoPara: '2026-10-08T15:00', agendaFonteTs: 5 };
  const { chamadas, enviar } = carregarBackground({ chave: 'k' }, { corpo: { ok: true, marca } });
  const r = await enviar({
    action: 'leadMarca', telefone: '5571999998888', nome: 'Marcos', agendadoPara: '2026-10-08T15:00', fonteTs: 5, regra: 2,
    mensagens: [{ content: 'texto da conversa' }], server: 'https://evil.example',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, marca });
  assert.equal(chamadas[0].url, 'https://report-closer.vercel.app/api/lead/marca');
  assert.deepEqual(JSON.parse(chamadas[0].opts.body), { telefone: '5571999998888', nome: 'Marcos', agendadoPara: '2026-10-08T15:00', fonteTs: 5, regra: 2 });

  await enviar({ action: 'leadMarca', telefone: '5571999998888', qualificado: false, manual: true });
  assert.deepEqual(JSON.parse(chamadas[1].opts.body), { telefone: '5571999998888', nome: '', qualificado: false, manual: true, origem: '' });
  await enviar({ action: 'leadMarca', nome: 'Marcos', limparAgenda: true, agendadoPara: '2026-10-08T15:00' });
  assert.deepEqual(JSON.parse(chamadas[2].opts.body), { telefone: '', nome: 'Marcos', limparAgenda: true });
});

test('automação: "lead respondeu" vai para a rota de mover o card, só com a identificação do lead e do card', async () => {
  const { chamadas, enviar } = carregarBackground({ chave: 'k' }, { corpo: { movido: true, de: 'Contato iniciado', para: 'Respondeu' } });
  const r = await enviar({ action: 'crmRespondeu', telefone: '5571999998888', nome: '', contatoId: '', dealId: 'd1', mensagens: [{ content: 'x' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, movido: true, de: 'Contato iniciado', para: 'Respondeu', motivo: '' });
  assert.equal(chamadas[0].url, 'https://report-closer.vercel.app/api/crm/respondeu');
  assert.equal(chamadas[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(chamadas[0].opts.body), { telefone: '5571999998888', nome: '', contatoId: '', dealId: 'd1' });

  // a consulta da ficha leva de que conversa é (para o servidor lembrar a etiqueta do lead certo)
  await enviar({ action: 'crmLead', telefone: '71988887777', conversa: { telefone: '5571999998888', nome: 'Marcos', outro: 'x' } });
  assert.deepEqual(JSON.parse(chamadas[1].opts.body).conversa, { telefone: '5571999998888', nome: 'Marcos' });
});

test('manifest e popup carregam o leitor de agendamento ANTES do content.js do WhatsApp', () => {
  const m = JSON.parse(ler('extension/manifest.json'));
  const grupo = m.content_scripts.find((c) => (c.js || []).includes('content.js'));
  assert.deepEqual(grupo.js, ['agenda.js', 'content.js']);
  assert.match(ler('extension/popup.js'), /arquivos: \['agenda\.js', 'content\.js'\]/, 'a injeção pelo popup segue a mesma ordem');
  // o leitor de agendamento não fala com a rede nem com o servidor
  const agenda = ler('extension/agenda.js');
  assert.ok(!/fetch\(|chrome\.|XMLHttpRequest|sendMessage/.test(agenda));
});
