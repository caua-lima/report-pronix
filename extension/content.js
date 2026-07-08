// Content script — lê a conversa aberta no WhatsApp Web (incl. histórico retroativo).
// Roda no contexto da página web.whatsapp.com.

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Encontra os elementos de mensagem, tentando várias estratégias (o HTML do
  // WhatsApp Web muda de tempos em tempos).
  function acharMensagens(root) {
    let els = [...root.querySelectorAll('div.message-in, div.message-out')];
    if (els.length) return els;
    // Fallback 1: linhas com data-id de mensagem (true_/false_ = enviada/recebida).
    els = [...root.querySelectorAll('[data-id]')].filter((el) => {
      const id = el.getAttribute('data-id') || '';
      return /^(true|false)_/.test(id) && el.querySelector('.copyable-text, .selectable-text, [data-icon], audio');
    });
    if (els.length) return els;
    // Fallback 2: role="row" que contenha texto selecionável.
    els = [...root.querySelectorAll('div[role="row"]')].filter((el) =>
      el.querySelector('.selectable-text, .copyable-text')
    );
    return els;
  }

  // Encontra o elemento que realmente rola a lista de mensagens.
  function acharScroller(sample) {
    let el = sample ? sample.parentElement : null;
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

  // Descobre se a mensagem foi enviada por mim (várias pistas).
  function ehDeMim(el) {
    if (el.classList.contains('message-out')) return true;
    if (el.classList.contains('message-in')) return false;
    if (el.querySelector('.message-out')) return true;
    if (el.querySelector('.message-in')) return false;
    const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]') || el.querySelector('[data-id]');
    const id = idEl ? idEl.getAttribute('data-id') || '' : '';
    return id.startsWith('true_'); // padrão: recebida (deles)
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
    if (el.querySelector('[data-icon^="audio"], [data-icon="ptt"], [data-icon="ptt-status"]')) {
      return true;
    }
    for (const r of el.querySelectorAll('[aria-label]')) {
      if (/voz|voice|áudio|audio|ptt/i.test(r.getAttribute('aria-label') || '')) return true;
    }
    return false;
  }

  function ehDuracaoOuHora(t) {
    return /^\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?m\.?)?$/i.test((t || '').trim());
  }

  // Texto de mensagens normais. textContent (não innerText) para pegar também
  // texto que o WhatsApp deixa oculto/colapsado no DOM.
  function extrairTexto(el) {
    let texto = '';
    el.querySelectorAll('span.selectable-text').forEach((s) => {
      const t = (s.textContent || '').trim();
      if (t) texto += (texto ? ' ' : '') + t;
    });
    return texto.trim();
  }

  // Transcrição nativa do áudio: o maior trecho de texto do balão que não seja
  // duração/horário. Usa textContent para capturar transcrição colapsada.
  function extrairTranscricaoAudio(el) {
    let melhor = '';
    el.querySelectorAll('.selectable-text, .copyable-text').forEach((s) => {
      const t = (s.textContent || '').trim();
      if (t.length > melhor.length && !ehDuracaoOuHora(t)) melhor = t;
    });
    if (melhor.length < 3) {
      // Fallback: maior nó-folha de texto que não seja duração/horário.
      el.querySelectorAll('span, div').forEach((n) => {
        if (n.children.length === 0) {
          const t = (n.textContent || '').trim();
          if (t.length > melhor.length && !ehDuracaoOuHora(t)) melhor = t;
        }
      });
    }
    return melhor.length >= 3 ? melhor.replace(/\b\d{1,2}:\d{2}\b/g, '').trim() : '';
  }

  // Clica no botão "Transcrição" dos áudios visíveis que ainda não mostram texto,
  // para o WhatsApp renderizar a transcrição antes de a lermos.
  async function expandirTranscricoes(root) {
    let clicou = false;
    root.querySelectorAll('[aria-label]').forEach((b) => {
      if (!/transcri/i.test(b.getAttribute('aria-label') || '')) return;
      const bolha = b.closest('div.message-in, div.message-out') || b.closest('[data-id]') || b;
      if (extrairTranscricaoAudio(bolha).length < 3) {
        try {
          b.click();
          clicou = true;
        } catch (_) {
          /* ignora */
        }
      }
    });
    if (clicou) await sleep(700);
  }

  function extrairMensagem(el) {
    const fromMe = ehDeMim(el);
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

    if (ehAudio(el)) {
      const transc = extrairTranscricaoAudio(el);
      const content =
        transc || '[áudio sem transcrição — ative a transcrição de áudio no WhatsApp]';
      return { from: fromMe ? 'eu' : 'eles', type: 'audio', content, timestamp, ts };
    }

    const texto = extrairTexto(el);
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

  function diagnostico() {
    return {
      main: !!document.querySelector('#main'),
      msgClasses: document.querySelectorAll('.message-in, .message-out').length,
      dataId: document.querySelectorAll('[data-id]').length,
      rows: document.querySelectorAll('div[role="row"]').length,
      selectable: document.querySelectorAll('.selectable-text').length,
      copyable: document.querySelectorAll('.copyable-text').length,
    };
  }

  async function coletarConversa() {
    const root = document.querySelector('#main') || document;

    const scroller = acharScroller(acharMensagens(root)[0]);
    const mapa = new Map(); // chave -> registro (ordem = primeira aparição top→bottom)
    let seq = 0;

    const capturar = () => {
      acharMensagens(root).forEach((el) => {
        const reg = extrairMensagem(el);
        if (!reg) return;
        const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]') || el.querySelector('[data-id]');
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
        await expandirTranscricoes(root); // revela transcrições de áudio recolhidas
        capturar();
        const antes = scroller.scrollTop;
        scroller.scrollTop = Math.min(antes + passo, scroller.scrollHeight);
        await sleep(280);
        const fim = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
        if (scroller.scrollTop === antes || fim) {
          await expandirTranscricoes(root);
          capturar();
          break;
        }
      }
    } else {
      await expandirTranscricoes(root);
      capturar();
    }

    const mensagens = [...mapa.values()]
      .sort((a, b) => a._ord - b._ord)
      .map(({ from, type, content, timestamp }) => ({ from, type, content, timestamp }));

    if (mensagens.length === 0) {
      const diag = diagnostico();
      console.log('[Closer Report] Nenhuma mensagem lida. Diagnóstico:', diag);
      throw new Error('Nenhuma mensagem lida. Diag: ' + JSON.stringify(diag));
    }

    const audios = mensagens.filter((m) => m.type === 'audio');
    const audiosTranscritos = audios.filter((m) => !m.content.startsWith('[áudio'));
    const stats = {
      total: mensagens.length,
      audios: audios.length,
      audiosTranscritos: audiosTranscritos.length,
    };

    console.log(
      `[Closer Report] ${stats.total} mensagens lidas — ` +
        `${stats.audios} áudios (${stats.audiosTranscritos} com transcrição).`
    );
    return { mensagens, nome: nomeDoContato(), stats };
  }

  // ---------------------------------------------------------------------------
  // Aviso fixo na tela do WhatsApp (visível enquanto você responde outros leads)
  // ---------------------------------------------------------------------------
  const BADGE_ID = 'closer-report-badge';

  function badgeEl() {
    let el = document.getElementById(BADGE_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = BADGE_ID;
      el.style.cssText = [
        'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
        'max-width:320px', 'background:#16212e', 'color:#e6edf3',
        'border:1px solid #26333f', 'border-left:4px solid #25d366',
        'border-radius:10px', 'padding:12px 14px', 'font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.4)', 'display:flex', 'gap:10px', 'align-items:flex-start',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function mostrarBadge({ texto, cor = '#25d366', loading = false, arquivo = null, server = null }) {
    const el = badgeEl();
    el.style.borderLeftColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;font-size:15px">📋</span>';
    let acao = '';
    if (arquivo && server) {
      const url = server + '/api/download/' + encodeURIComponent(arquivo);
      acao =
        `<a href="${url}" target="_blank" style="display:inline-block;margin-top:8px;background:#25d366;color:#05130c;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px">⬇ Baixar .docx</a>`;
    }
    el.innerHTML =
      (document.getElementById('crspin-style') ? '' : '<style id="crspin-style">@keyframes crspin{to{transform:rotate(360deg)}}</style>') +
      spinner +
      `<div style="flex:1"><div>${texto}</div>${acao}</div>` +
      `<span id="cr-x" style="flex:none;cursor:pointer;color:#8b98a5;font-size:15px;line-height:1">×</span>`;
    const x = el.querySelector('#cr-x');
    if (x) x.onclick = () => el.remove();
  }

  // ---------------------------------------------------------------------------
  // Orquestração do report (roda em segundo plano, sobrevive ao fechar o popup)
  // ---------------------------------------------------------------------------
  let jobEmAndamento = false;

  async function gerarReportEmBackground(server) {
    if (jobEmAndamento) {
      mostrarBadge({ texto: 'Já existe um report sendo gerado…', cor: '#f0ad4e', loading: true });
      return;
    }
    jobEmAndamento = true;
    try {
      mostrarBadge({
        texto: '<b>Lendo a conversa…</b><br>Aguarde e <u>não troque de conversa agora</u>.',
        loading: true,
      });
      const { mensagens, nome, stats } = await coletarConversa();
      if (!mensagens.length) {
        mostrarBadge({ texto: '❌ Nenhuma mensagem encontrada nesta conversa.', cor: '#ff6b6b' });
        jobEmAndamento = false;
        return;
      }

      const linhaAudio =
        stats.audios > 0
          ? `🎤 ${stats.audios} áudio(s), ${stats.audiosTranscritos} com transcrição` +
            (stats.audiosTranscritos < stats.audios
              ? ' <span style="color:#f0ad4e">(ative a transcrição de áudio no WhatsApp p/ pegar o resto)</span>'
              : '')
          : 'Sem áudios nesta conversa';

      mostrarBadge({
        texto:
          `<b>Gerando report…</b> (${stats.total} mensagens)<br>` +
          `${linhaAudio}<br>✅ Já pode responder outros leads.`,
        loading: true,
      });

      const resp = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome }, resolve)
      );

      if (!resp || !resp.ok) {
        mostrarBadge({ texto: '❌ ' + ((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6b6b' });
        jobEmAndamento = false;
        return;
      }

      chrome.storage.local.set({
        ultimoReport: { arquivo: resp.arquivo, dados: resp.dados, nome, server, quando: Date.now() },
      });
      mostrarBadge({
        texto: `<b>✅ Report pronto!</b> (${nome || 'lead'})`,
        arquivo: resp.arquivo,
        server,
      });
    } catch (e) {
      mostrarBadge({ texto: '❌ ' + e.message, cor: '#ff6b6b' });
    } finally {
      jobEmAndamento = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'start') {
      // Dispara em background e responde na hora para o popup poder fechar.
      gerarReportEmBackground(msg.server);
      sendResponse({ ok: true, iniciado: true });
      return false;
    }
    if (msg && msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
  });
})();
