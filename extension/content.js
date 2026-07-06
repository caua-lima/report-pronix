// Content script — lê a conversa aberta no WhatsApp Web (incl. histórico retroativo).
// Roda no contexto da página web.whatsapp.com.

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Encontra o elemento que realmente rola a lista de mensagens.
  function acharScroller(main) {
    const msg = main.querySelector('div.message-in, div.message-out');
    let el = msg ? msg.parentElement : null;
    while (el && el !== document.body) {
      const st = getComputedStyle(el);
      if (
        (st.overflowY === 'auto' || st.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 20
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // "20:57, 06/07/2026" -> { iso, ms }  (best-effort, formato pt-BR)
  function parseDataHora(str) {
    try {
      const [hora, data] = str.split(',').map((s) => s.trim());
      if (!hora || !data) return null;
      const [dd, mm, yyyy] = data.split('/').map(Number);
      const [h, min] = hora.split(':').map(Number);
      if (!yyyy) return null;
      const d = new Date(yyyy, (mm || 1) - 1, dd || 1, h || 0, min || 0);
      if (isNaN(d)) return null;
      return { iso: d.toISOString(), ms: d.getTime() };
    } catch (_) {
      return null;
    }
  }

  function ehAudio(el) {
    if (el.querySelector('audio')) return true;
    if (
      el.querySelector(
        '[data-icon="audio-play"], [data-icon="audio-pause"], [data-icon="ptt"]'
      )
    )
      return true;
    const rotulo = el.querySelector('[aria-label]');
    return rotulo ? /voz|voice|áudio|audio/i.test(rotulo.getAttribute('aria-label') || '') : false;
  }

  function extrairTexto(el) {
    let texto = '';
    el.querySelectorAll('span.selectable-text').forEach((s) => {
      const t = (s.innerText || '').trim();
      if (t) texto += (texto ? ' ' : '') + t;
    });
    return texto.trim();
  }

  function extrairMensagem(el) {
    const fromMe = el.classList.contains('message-out');
    let timestamp = null;
    let ts = null;

    const copy = el.querySelector('.copyable-text');
    if (copy) {
      const pre = copy.getAttribute('data-pre-plain-text') || '';
      const m = pre.match(/\[(.*?)\]/);
      if (m) {
        const parsed = parseDataHora(m[1]);
        if (parsed) {
          timestamp = parsed.iso;
          ts = parsed.ms;
        }
      }
    }

    const texto = extrairTexto(el);

    if (ehAudio(el)) {
      // A "transcrição nativa" do WhatsApp aparece como texto selecionável no balão.
      const content =
        texto || '[áudio sem transcrição — ative a transcrição de áudio no WhatsApp]';
      return { from: fromMe ? 'eu' : 'eles', type: 'audio', content, timestamp, ts };
    }

    if (!texto) return null; // imagem/figurinha/sistema sem texto: ignora
    return { from: fromMe ? 'eu' : 'eles', type: 'texto', content: texto, timestamp, ts };
  }

  function nomeDoContato() {
    const header = document.querySelector('#main header');
    if (!header) return '';
    const comTitulo = header.querySelector('span[title]');
    if (comTitulo) return (comTitulo.getAttribute('title') || comTitulo.innerText || '').trim();
    const dir = header.querySelector('span[dir="auto"]');
    return dir ? (dir.innerText || '').trim() : '';
  }

  async function coletarConversa() {
    const main = document.querySelector('#main');
    if (!main) {
      throw new Error('Nenhuma conversa aberta. Clique numa conversa no WhatsApp Web e tente de novo.');
    }

    const scroller = acharScroller(main);
    const mapa = new Map(); // chave -> registro (ordem = primeira aparição top→bottom)
    let seq = 0;

    const capturar = () => {
      main.querySelectorAll('div.message-in, div.message-out').forEach((el) => {
        const idEl = el.closest('[data-id]');
        const reg = extrairMensagem(el);
        if (!reg) return;
        const chave = idEl
          ? idEl.getAttribute('data-id')
          : (reg.timestamp || '') + '|' + reg.content.slice(0, 80);
        if (!mapa.has(chave)) mapa.set(chave, { ...reg, _ord: seq++ });
      });
    };

    if (scroller) {
      // 1) Rola até o topo para carregar o histórico antigo.
      let alturaAnterior = -1;
      let estavel = 0;
      for (let i = 0; i < 150 && estavel < 3; i++) {
        scroller.scrollTop = 0;
        await sleep(450);
        const h = scroller.scrollHeight;
        if (h === alturaAnterior) estavel++;
        else {
          estavel = 0;
          alturaAnterior = h;
        }
      }

      // 2) Desce do topo até o fim capturando em ordem cronológica.
      scroller.scrollTop = 0;
      await sleep(300);
      const passo = Math.max(200, Math.floor(scroller.clientHeight * 0.6));
      for (let i = 0; i < 500; i++) {
        capturar();
        const antes = scroller.scrollTop;
        scroller.scrollTop = Math.min(antes + passo, scroller.scrollHeight);
        await sleep(280);
        const fim = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
        if (scroller.scrollTop === antes || fim) {
          capturar();
          break;
        }
      }
    } else {
      capturar();
    }

    const mensagens = [...mapa.values()]
      .sort((a, b) => a._ord - b._ord)
      .map(({ from, type, content, timestamp }) => ({ from, type, content, timestamp }));

    console.log(`[Closer Report] ${mensagens.length} mensagens lidas.`);
    return { mensagens, nome: nomeDoContato() };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'scrape') {
      coletarConversa()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, erro: e.message }));
      return true; // resposta assíncrona
    }
    if (msg && msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
  });
})();
