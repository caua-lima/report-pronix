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
 * O content script e o que o manifest carrega junto dele, na mesma ordem (ex.: agenda.js antes do
 * content.js) — assim o teste roda o que o Chrome roda, e esquecer um arquivo no manifest aparece aqui.
 */
function arquivosDoManifest(arquivo) {
  const dir = path.dirname(arquivo);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(RAIZ, dir, 'manifest.json'), 'utf8'));
    const grupo = (manifest.content_scripts || []).find((c) => c.world !== 'MAIN' && (c.js || []).includes(path.basename(arquivo)));
    if (grupo) return grupo.js.map((j) => path.join(dir, j));
  } catch (_) {
    /* arquivo fora da extensão: só ele */
  }
  return [arquivo];
}

/**
 * Cria a janela simulada, instala o "chrome" falso e executa o content script.
 * @param {{arquivo: string, url: string, aoEnviar?: Function, blobs?: Map}} o
 *   aoEnviar(msg) responde às mensagens ao service worker (transcreverAudio, reportFetch...)
 */
function abrirPagina({ arquivo, url, aoEnviar, blobs = new Map(), intervaloRapido = false, storage: storageInicial = {} }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const w = dom.window;

  // Os "sleeps" dos scripts (centenas de ms) viram 0ms: o teste roda rápido e sem depender de relógio.
  const setTimeoutReal = w.setTimeout.bind(w);
  w.setTimeout = (fn, _ms, ...args) => setTimeoutReal(fn, 0, ...args);
  // Vigias com setInterval (ficha do CRM: 1,5s) ficam no tempo real, a não ser que o teste peça rápido.
  if (intervaloRapido) {
    const setIntervalReal = w.setInterval.bind(w);
    w.setInterval = (fn, _ms, ...args) => setIntervalReal(fn, 10, ...args);
  }
  w.document.documentElement.setAttribute('data-cr-audio-hook', '1'); // gancho "instalado"

  const enviadas = [];
  const ouvintes = [];
  const storage = { ...storageInicial };
  const ouvintesStorage = [];
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
          const mud = {};
          Object.keys(o).forEach((k) => { mud[k] = { oldValue: storage[k], newValue: o[k] }; });
          Object.assign(storage, o);
          ouvintesStorage.forEach((fn) => fn(mud, 'local'));
          if (cb) cb();
        },
      },
      onChanged: { addListener: (fn) => ouvintesStorage.push(fn) },
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

  for (const a of arquivosDoManifest(arquivo)) w.eval(fs.readFileSync(path.join(RAIZ, a), 'utf8'));

  return {
    w,
    document: w.document,
    enviadas,
    storage,
    blobs,
    /** Dispara o clique em "Gerar Report" do popup (extra: o que mais o popup manda, como o closer da análise). */
    iniciar: (server = 'https://servidor.teste', extra = {}) => ouvintes.forEach((fn) => fn({ action: 'start', server, ...extra }, {}, () => {})),
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
/**
 * Opções extras:
 *  - semFlex: o Instagram deixou de usar flex-direction: row-reverse (só sobra a posição na tela);
 *  - longas: bolhas largas (uma mensagem minha comprida começa ANTES do meio da tela);
 *  - carregadasNoInicio + atrasoTopo: só as últimas N mensagens estão carregadas; as antigas chegam
 *    de 10 em 10, e só depois de `atrasoTopo` tentativas paradas no topo (rede lenta).
 */
function montarInstagram(pagina, mensagens, { visiveis = 6, contato = 'Contato Teste', semFlex = false, longas = false, carregadasNoInicio = null, atrasoTopo = 0 } = {}) {
  const w = pagina.w;
  const d = w.document;
  d.body.innerHTML = `<div id="app"><header><span>${contato}</span></header><div id="lista" style="overflow-y:auto"></div></div>`;
  const lista = d.getElementById('lista');
  const carregadoDesde = carregadasNoInicio == null ? 0 : Math.max(0, mensagens.length - carregadasNoInicio);
  const estado = { inicio: Math.max(carregadoDesde, mensagens.length - visiveis), carregadoDesde, tentativasTopo: 0 };

  Object.defineProperty(lista, 'scrollHeight', { get: () => mensagens.length * ALTURA_LINHA });
  Object.defineProperty(lista, 'clientHeight', { get: () => visiveis * ALTURA_LINHA });
  Object.defineProperty(lista, 'scrollTop', { get: () => estado.inicio * ALTURA_LINHA, set: () => {} });

  const linha = (i) => {
    const m = mensagens[i];
    const el = d.createElement('div');
    el.dataset.i = String(i);
    el.dataset.enviada = m.from === 'eu' ? '1' : '0';
    el.setAttribute('style', `display:flex; flex-direction: ${m.from === 'eu' && !semFlex ? 'row-reverse' : 'row'}`);
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
      const largura = longas ? 430 : 200;
      const left = row.dataset.enviada === '1' ? 600 - 20 - largura : 10; // minha encosta na direita
      return { top, bottom: top + ALTURA_LINHA - 4, height: ALTURA_LINHA - 4, left, right: left + largura, width: largura };
    }
    if (this.id === 'lista') return { top: 0, left: 0, right: 600, bottom: visiveis * ALTURA_LINHA, width: 600, height: visiveis * ALTURA_LINHA };
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  w.Element.prototype.scrollIntoView = function (arg) {
    const row = this.closest && this.closest('[data-i]');
    if (!row) return;
    const i = Number(row.dataset.i);
    // Parado no topo do que já carregou: o Instagram busca as antigas na rede, mas só "responde" depois
    // de algumas tentativas. Quando chegam, aparecem acima (e a janela mostra algumas delas).
    if (i === estado.carregadoDesde && estado.inicio === estado.carregadoDesde && estado.carregadoDesde > 0) {
      estado.tentativasTopo++;
      if (estado.tentativasTopo > atrasoTopo) {
        estado.tentativasTopo = 0;
        estado.carregadoDesde = Math.max(0, estado.carregadoDesde - 10);
        estado.inicio = Math.max(estado.carregadoDesde, estado.inicio - 2);
        render();
        return;
      }
    }
    const bloco = arg && arg.block;
    const alvo = bloco === 'center' ? i - Math.floor(visiveis / 2) : i;
    estado.inicio = Math.max(estado.carregadoDesde, Math.min(mensagens.length - visiveis, alvo));
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
/**
 * semSinais: WhatsApp sem classes message-in/out, sem "true_/false_" no data-id, sem tique e com o MEU
 * nome (não "Você") no data-pre-plain-text. Só a posição da bolha diz quem mandou.
 * posicao: false = o navegador não informa a posição (larguras zeradas).
 */
function montarWhatsApp(pagina, mensagens, { contato = 'Contato Teste', jid = '5511999990000@c.us', idsSimples = false, semSinais = false, posicao = true } = {}) {
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
      // idsSimples = formato que o WhatsApp Web passou a usar (visto ao vivo): id só com hexadecimais,
      // sem "true_"/"false_" nem o id da conversa.
      const dataId = idsSimples
        ? `A5${(0xf00000 + i * 977).toString(16).toUpperCase().padStart(12, '0')}`
        : `${m.from === 'eu' ? 'true' : 'false'}_${m.jid || jid}_MSG${String(i).padStart(4, '0')}`;
      if (m.tipo === 'audio') {
        const url = `blob:wa-${i}`;
        // semBytes = o WhatsApp não entregou o arquivo (mídia expirada): o fetch do blob falha.
        if (!m.semBytes) pagina.blobs.set(url, audioFake(m.indiceAudio != null ? m.indiceAudio : i));
        if (semSinais) {
          return `<div role="row" data-row-i="${i}" data-lado="${m.from === 'eu' ? 'd' : 'e'}"><div data-id="A5${String(i).padStart(12, '0')}"><span data-icon="audio-play"></span><audio src="${url}"></audio></div></div>`;
        }
        return `<div class="message-${dir}" data-id="${dataId}"><div><span data-icon="audio-play"></span><audio src="${url}"></audio></div></div>`;
      }
      const hora = m.hora || '10:00, 01/09/2026';
      if (semSinais) {
        return (
          `<div role="row" data-row-i="${i}" data-lado="${m.from === 'eu' ? 'd' : 'e'}"><div data-id="A5${String(i).padStart(12, '0')}">` +
          `<div class="copyable-text" data-pre-plain-text="[${hora}] ${m.from === 'eu' ? 'Cauã Lima' : contato}: "><span class="selectable-text"></span></div></div></div>`
        );
      }
      return (
        `<div class="message-${dir}" data-id="${dataId}"><div class="copyable-text" data-pre-plain-text="[${hora}] ${m.from === 'eu' ? 'Você' : contato}: ">` +
        `<span class="selectable-text"></span></div></div>`
      );
    })
    .join('');
  rolagem.innerHTML = html;
  [...rolagem.querySelectorAll(semSinais ? '[data-row-i]' : '.message-in, .message-out')].forEach((el, i) => {
    const t = el.querySelector('.selectable-text');
    if (t) t.textContent = mensagens[i].texto;
  });
  if (semSinais) {
    // Painel da conversa com 800px; bolha minha encosta na direita, a do lead na esquerda.
    w.Element.prototype.getBoundingClientRect = function () {
      const vazio = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      if (!posicao) return vazio;
      if (this.id === 'main') return { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
      const row = this.closest && this.closest('[data-lado]');
      if (!row) return vazio;
      const left = row.dataset.lado === 'd' ? 480 : 20;
      return { top: 0, left, right: left + 300, bottom: 30, width: 300, height: 30 };
    };
  }
  w.Element.prototype.scrollIntoView = function () {};
  return { rolagem };
}

module.exports = { abrirPagina, montarInstagram, montarWhatsApp, esperar, dormir, audioFake, indiceDoAudio, ALTURA_LINHA };
