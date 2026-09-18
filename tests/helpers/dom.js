'use strict';
// Harness de DOM para testar os content scripts REAIS da extensão (jsdom, sem navegador):
// carrega o arquivo em uma janela simulada, com um "chrome" falso (service worker,
// storage) e páginas do Instagram/WhatsApp montadas à mão. Nenhuma rede, nenhuma IA.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const RAIZ = path.join(__dirname, '..', '..');
const ALTURA_LINHA = 40;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a condição ficar verdadeira (polling curto) ou estoura o tempo. */
async function esperar(cond, { ms = 20000, motivo = 'condição' } = {}) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return;
    await dormir(5);
  }
  throw new Error(`Tempo esgotado esperando: ${motivo}`);
}

/**
 * Cria a janela simulada, instala o "chrome" falso e executa o content script.
 * @param {{arquivo: string, url: string, aoEnviar?: Function, blobs?: Map}} o
 *   aoEnviar(msg) responde às mensagens ao service worker (transcreverAudio, reportFetch...)
 */
function abrirPagina({ arquivo, url, aoEnviar, blobs = new Map() }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const w = dom.window;

  // Os "sleeps" dos scripts (centenas de ms) viram 0ms: o teste roda rápido e sem depender de relógio.
  const setTimeoutReal = w.setTimeout.bind(w);
  w.setTimeout = (fn, _ms, ...args) => setTimeoutReal(fn, 0, ...args);
  w.document.documentElement.setAttribute('data-cr-audio-hook', '1'); // gancho "instalado"

  const enviadas = [];
  const ouvintes = [];
  const storage = {};
  w.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: 'teste' }),
      getURL: (p) => 'chrome-extension://teste/' + p,
      onMessage: { addListener: (fn) => ouvintes.push(fn) },
      sendMessage: (msg, cb) => {
        enviadas.push(msg);
        Promise.resolve(aoEnviar ? aoEnviar(msg) : { ok: true }).then((r) => cb && cb(r));
      },
    },
    storage: {
      local: {
        get: (padrao, cb) => cb(Object.assign({}, padrao, storage)),
        set: (o, cb) => {
          Object.assign(storage, o);
          if (cb) cb();
        },
      },
    },
  };
  w.confirm = () => true;
  // jsdom não implementa mídia: play/pause viram no-ops (senão cada pause() vira um erro no console).
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

  // fetch de blob: — devolve os bytes registrados para a URL (ou falha, como um CORS).
  w.fetch = async (u) => {
    if (!blobs.has(u)) throw new Error('sem bytes para ' + u);
    const b = blobs.get(u);
    return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };

  w.eval(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8'));

  return {
    w,
    document: w.document,
    enviadas,
    storage,
    blobs,
    /** Dispara o clique em "Gerar Report" do popup. */
    iniciar: (server = 'https://servidor.teste') => ouvintes.forEach((fn) => fn({ action: 'start', server }, {}, () => {})),
    badge: () => {
      const el = w.document.getElementById('closer-report-badge');
      return el ? el.textContent : '';
    },
    fechar: () => w.close(),
  };
}

/** Bytes de um áudio fake reconhecível pelo validador (OggS + 2000 bytes) que carrega o índice. */
const audioFake = (indice) => Uint8Array.from([0x4f, 0x67, 0x67, 0x53, ...new Array(2000).fill(indice + 1)]);
/** Recupera o índice a partir do base64 enviado ao "servidor". */
const indiceDoAudio = (base64) => Buffer.from(base64, 'base64')[4] - 1;

// ------------------------------------------------------------------------------------
// Instagram Direct: lista VIRTUALIZADA (só ~6 linhas no DOM) que IGNORA escrita em scrollTop
// e só anda com scrollIntoView — exatamente o que foi medido ao vivo.
// ------------------------------------------------------------------------------------
/**
 * @param {*} pagina retorno de abrirPagina
 * @param {{from: 'eu'|'eles', tipo?: 'texto'|'audio', texto?: string, dur?: string}[]} mensagens
 */
function montarInstagram(pagina, mensagens, { visiveis = 6, contato = 'Contato Teste' } = {}) {
  const w = pagina.w;
  const d = w.document;
  d.body.innerHTML = `<div id="app"><header><span>${contato}</span></header><div id="lista" style="overflow-y:auto"></div></div>`;
  const lista = d.getElementById('lista');
  const estado = { inicio: Math.max(0, mensagens.length - visiveis) };

  Object.defineProperty(lista, 'scrollHeight', { get: () => mensagens.length * ALTURA_LINHA });
  Object.defineProperty(lista, 'clientHeight', { get: () => visiveis * ALTURA_LINHA });
  Object.defineProperty(lista, 'scrollTop', { get: () => estado.inicio * ALTURA_LINHA, set: () => {} });

  const linha = (i) => {
    const m = mensagens[i];
    const el = d.createElement('div');
    el.dataset.i = String(i);
    el.dataset.enviada = m.from === 'eu' ? '1' : '0';
    el.setAttribute('style', `display:flex; flex-direction: ${m.from === 'eu' ? 'row-reverse' : 'row'}`);
    if (m.tipo === 'audio') {
      const url = `blob:mock-${i}`;
      pagina.blobs.set(url, audioFake(m.indiceAudio != null ? m.indiceAudio : i));
      el.innerHTML =
        `<div aria-label="Mensagem de voz"><div role="button" aria-label="Reproduzir"></div>` +
        `<audio src="${url}"></audio><div dir="auto" class="html-div">${m.dur || '0:10'}</div></div>`;
    } else {
      el.innerHTML = `<div><div dir="auto" class="html-div"></div></div>`;
      el.querySelector('.html-div').textContent = m.texto;
    }
    return el;
  };
  const nos = new Map(); // índice -> nó já criado (mantém a identidade enquanto está na janela)
  let renderizado = null;
  const render = () => {
    if (renderizado === estado.inicio) return;
    renderizado = estado.inicio;
    const fim = Math.min(mensagens.length, estado.inicio + visiveis);
    for (const i of [...nos.keys()]) if (i < estado.inicio || i >= fim) nos.delete(i);
    lista.textContent = '';
    for (let i = estado.inicio; i < fim; i++) {
      if (!nos.has(i)) nos.set(i, linha(i));
      lista.appendChild(nos.get(i));
    }
  };
  render();

  w.Element.prototype.getBoundingClientRect = function () {
    const row = this.closest && this.closest('[data-i]');
    if (row) {
      const top = (Number(row.dataset.i) - estado.inicio) * ALTURA_LINHA;
      const left = row.dataset.enviada === '1' ? 320 : 10;
      return { top, bottom: top + ALTURA_LINHA - 4, height: ALTURA_LINHA - 4, left, right: left + 200, width: 200 };
    }
    if (this.id === 'lista') return { top: 0, left: 0, right: 600, bottom: visiveis * ALTURA_LINHA, width: 600, height: visiveis * ALTURA_LINHA };
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  w.Element.prototype.scrollIntoView = function (arg) {
    const row = this.closest && this.closest('[data-i]');
    if (!row) return;
    const i = Number(row.dataset.i);
    const bloco = arg && arg.block;
    const alvo = bloco === 'center' ? i - Math.floor(visiveis / 2) : i;
    estado.inicio = Math.max(0, Math.min(mensagens.length - visiveis, alvo));
    render();
  };
  return { lista, estado, render };
}

// ------------------------------------------------------------------------------------
// WhatsApp Web: #main com todas as mensagens no DOM (div.message-in/out + data-id).
// ------------------------------------------------------------------------------------
/**
 * @param {{from: 'eu'|'eles', tipo?: 'texto'|'audio', texto?: string, hora?: string, jid?: string}[]} mensagens
 */
function montarWhatsApp(pagina, mensagens, { contato = 'Contato Teste', jid = '5511999990000@c.us' } = {}) {
  const w = pagina.w;
  const d = w.document;
  d.body.innerHTML = `<div id="main"><header><span dir="auto" title="${contato}">${contato}</span></header><div id="rolagem" style="overflow-y:auto"></div></div>`;
  const rolagem = d.getElementById('rolagem');
  Object.defineProperty(rolagem, 'scrollHeight', { get: () => mensagens.length * ALTURA_LINHA });
  Object.defineProperty(rolagem, 'clientHeight', { get: () => 3 * ALTURA_LINHA }); // menor que o conteúdo: a lista rola
  let topo = 0;
  Object.defineProperty(rolagem, 'scrollTop', { configurable: true, get: () => topo, set: (v) => { topo = Math.max(0, v); } });

  const html = mensagens
    .map((m, i) => {
      const dir = m.from === 'eu' ? 'out' : 'in';
      const dataId = `${m.from === 'eu' ? 'true' : 'false'}_${m.jid || jid}_MSG${String(i).padStart(4, '0')}`;
      if (m.tipo === 'audio') {
        const url = `blob:wa-${i}`;
        pagina.blobs.set(url, audioFake(m.indiceAudio != null ? m.indiceAudio : i));
        return `<div class="message-${dir}" data-id="${dataId}"><div><span data-icon="audio-play"></span><audio src="${url}"></audio></div></div>`;
      }
      const hora = m.hora || '10:00, 01/09/2026';
      return (
        `<div class="message-${dir}" data-id="${dataId}"><div class="copyable-text" data-pre-plain-text="[${hora}] ${m.from === 'eu' ? 'Você' : contato}: ">` +
        `<span class="selectable-text"></span></div></div>`
      );
    })
    .join('');
  rolagem.innerHTML = html;
  [...rolagem.querySelectorAll('.message-in, .message-out')].forEach((el, i) => {
    const t = el.querySelector('.selectable-text');
    if (t) t.textContent = mensagens[i].texto;
  });
  w.Element.prototype.scrollIntoView = function () {};
  return { rolagem };
}

module.exports = { abrirPagina, montarInstagram, montarWhatsApp, esperar, dormir, audioFake, indiceDoAudio, ALTURA_LINHA };
