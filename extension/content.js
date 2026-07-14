// Content script — lê a conversa aberta no WhatsApp Web (incl. histórico retroativo).
// Roda no contexto da página web.whatsapp.com.

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Silencia qualquer <audio> que o WhatsApp criar (a captura "toca" no mudo).
  try {
    const mutar = () =>
      document.querySelectorAll('audio').forEach((a) => {
        a.muted = true;
        a.volume = 0;
      });
    new MutationObserver(mutar).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {
    /* ignora */
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // Blobs de áudio capturados pelo inject.js (hook do URL.createObjectURL).
  const blobsAudio = [];
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.__crAudio && ev.data.url) {
      blobsAudio.push({ url: ev.data.url, ts: ev.data.ts || Date.now() });
      if (blobsAudio.length > 40) blobsAudio.shift();
    }
  });

  const logA = (...a) => console.log('[CR-audio]', ...a);

  async function bytesDeBlob(url) {
    try {
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      logA('blob fetch ok, bytes =', buf ? buf.byteLength : 0, 'url', String(url).slice(0, 30));
      if (buf && buf.byteLength >= 300) return arrayBufferToBase64(buf);
    } catch (e) {
      logA('blob fetch FALHOU:', e.message, String(url).slice(0, 30));
    }
    return null;
  }

  // Força o WhatsApp a materializar o áudio (baixa se preciso + play no mudo),
  // captura os bytes (via <audio> ou via hook createObjectURL). Retorna base64 ou null.
  async function capturarBytes(el) {
    // 1) Se houver botão de baixar (áudio não carregado ainda), clica primeiro.
    const btnBaixar = el.querySelector(
      '[data-icon="audio-download"], [data-icon="down"], [data-icon*="download" i], span[data-icon="audio-download"]'
    );
    logA('capturarBytes: btnBaixar?', !!btnBaixar, '| icons:',
      [...el.querySelectorAll('[data-icon]')].map((i) => i.getAttribute('data-icon')).join(','));
    if (btnBaixar) {
      const alvo = btnBaixar.closest('button,[role="button"]') || btnBaixar;
      try {
        alvo.click();
        await sleep(500);
      } catch (_) {
        /* ok */
      }
    }

    // 2) Clica no play (dispara a descriptografia/criação do blob).
    const btn =
      el.querySelector('[data-icon*="play" i]')?.closest('button,[role="button"]') ||
      el.querySelector(
        'button[aria-label*="play" i], button[aria-label*="reproduzir" i], [role="button"][aria-label*="reproduzir" i]'
      ) ||
      el.querySelector('[data-icon*="play" i]') ||
      el.querySelector('button,[role="button"]');
    const t0 = Date.now();
    logA('capturarBytes: btnPlay?', !!btn);
    if (btn) {
      try {
        btn.click();
      } catch (_) {
        /* ok */
      }
    }

    // 3) Aguarda o blob aparecer — via <audio> OU via hook do createObjectURL.
    for (let i = 0; i < 30; i++) {
      const a = el.querySelector('audio') || document.querySelector('audio');
      if (a) {
        a.muted = true;
        a.volume = 0;
        const s = a.currentSrc || a.src || '';
        if (s.startsWith('blob:')) {
          try { a.pause(); } catch (_) {}
          const b64 = await bytesDeBlob(s);
          if (b64) return b64;
        }
      }
      // blob capturado pelo hook depois do clique
      const recente = blobsAudio.filter((b) => b.ts >= t0 - 500).pop();
      if (recente) {
        const b64 = await bytesDeBlob(recente.url);
        if (b64) return b64;
      }
      await sleep(150);
    }
    logA('capturarBytes: NÃO capturou bytes (nem <audio> nem hook). blobs vistos:', blobsAudio.length);
    return null;
  }

  // Captura os bytes dos áudios visíveis ainda não capturados (mapeados por data-id).
  async function capturarAudiosVisiveis(root, audioBytes) {
    const todas = acharMensagens(root);
    const audios = todas.filter((el) => ehAudio(el));
    if (audios.length) logA('visíveis:', todas.length, 'mensagens,', audios.length, 'áudios detectados');
    for (const el of audios) {
      const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]') || el.querySelector('[data-id]');
      const chave = idEl ? idEl.getAttribute('data-id') : null;
      if (!chave || audioBytes.has(chave)) continue;
      audioBytes.set(chave, null); // marca como tentado
      try {
        const b64 = await capturarBytes(el);
        audioBytes.set(chave, b64 || null);
        logA('áudio', chave.slice(0, 24), b64 ? 'CAPTURADO (' + b64.length + ' b64)' : 'não capturado');
      } catch (e) {
        logA('erro capturando áudio:', e.message);
      }
    }
  }

  // Encontra os elementos de mensagem, tentando várias estratégias (o HTML do
  // WhatsApp Web muda de tempos em tempos).
  let _estrategiaMsg = 0;
  function acharMensagens(root) {
    let els = [...root.querySelectorAll('div.message-in, div.message-out')];
    if (els.length) { _estrategiaMsg = 1; return els; }
    // Fallback 1: linhas com data-id de mensagem (true_/false_ = enviada/recebida).
    els = [...root.querySelectorAll('[data-id]')].filter((el) => {
      const id = el.getAttribute('data-id') || '';
      return /^(true|false)_/.test(id) && el.querySelector('.copyable-text, .selectable-text, [data-icon], audio');
    });
    if (els.length) { _estrategiaMsg = 2; return els; }
    // Fallback 2: role="row" que contenha texto selecionável.
    els = [...root.querySelectorAll('div[role="row"]')].filter((el) =>
      el.querySelector('.selectable-text, .copyable-text')
    );
    _estrategiaMsg = 3;
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
    // Barra de progresso (seek) é um sinal forte de mensagem de voz/áudio.
    if (el.querySelector('input[type="range"]')) return true;
    if (
      el.querySelector(
        '[data-icon*="audio" i], [data-icon*="ptt" i], [data-icon*="mic" i], [data-icon*="voice" i]'
      )
    ) {
      return true;
    }
    for (const r of el.querySelectorAll('[aria-label]')) {
      if (/voz|voice|áudio|audio|ptt|mensagem de voz|voice message/i.test(r.getAttribute('aria-label') || '')) {
        return true;
      }
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
      const content = transc || '[áudio — sem transcrição disponível]';
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

  async function coletarConversa(server, capturarAudio) {
    const root = document.querySelector('#main') || document;

    const scroller = acharScroller(acharMensagens(root)[0]);
    const mapa = new Map(); // chave -> registro (ordem = primeira aparição top→bottom)
    const audioBytes = new Map(); // chave (data-id) -> base64 do áudio capturado
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
        if (capturarAudio) await capturarAudiosVisiveis(root, audioBytes);
        const antes = scroller.scrollTop;
        scroller.scrollTop = Math.min(antes + passo, scroller.scrollHeight);
        await sleep(280);
        const fim = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
        if (scroller.scrollTop === antes || fim) {
          await expandirTranscricoes(root);
          capturar();
          if (capturarAudio) await capturarAudiosVisiveis(root, audioBytes);
          break;
        }
      }
    } else {
      await expandirTranscricoes(root);
      capturar();
      if (capturarAudio) await capturarAudiosVisiveis(root, audioBytes);
    }

    // Transcreve os áudios capturados (via service worker, evitando a CSP da página).
    if (capturarAudio && server) {
      const icons = [...new Set([...root.querySelectorAll('[data-icon]')].map((e) => e.getAttribute('data-icon')))];
      logA('data-icons na conversa:', icons.join(', ') || '(nenhum)');
      logA('inputs range (barra de áudio):', root.querySelectorAll('input[type="range"]').length);
      logA('estratégia de leitura:', _estrategiaMsg);
      // Loga os ícones de cada mensagem que tem algum ícone (revela o balão de áudio).
      acharMensagens(root).forEach((el, i) => {
        const ic = [...el.querySelectorAll('[data-icon]')].map((x) => x.getAttribute('data-icon'));
        const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]');
        const id = idEl ? idEl.getAttribute('data-id') || '' : '';
        const temRange = !!el.querySelector('input[type="range"]');
        const temAudioEl = !!el.querySelector('audio');
        if (ic.length || temRange || temAudioEl) {
          logA(`msg#${i} ${id.slice(0, 16)} icons=[${ic.join(',')}] range=${temRange} audioEl=${temAudioEl}`);
        }
      });
      const totalAudios = [...mapa.values()].filter((r) => r.type === 'audio').length;
      const capturados = [...audioBytes.values()].filter(Boolean).length;
      const pendentes = [...mapa].filter(([chave, reg]) => reg.type === 'audio' && audioBytes.get(chave));
      logA(`RESUMO: ${totalAudios} áudios na conversa | ${capturados} capturados | ${pendentes.length} p/ transcrever | servidor: ${server}`);
      for (let i = 0; i < pendentes.length; i++) {
        const [chave, reg] = pendentes[i];
        mostrarBadge({
          texto: `<b>Transcrevendo áudios…</b> (${i + 1}/${pendentes.length})`,
          loading: true,
        });
        try {
          const resp = await new Promise((r) =>
            chrome.runtime.sendMessage(
              { action: 'transcreverAudio', server, base64: audioBytes.get(chave) },
              r
            )
          );
          logA('transcrição', i + 1, resp && resp.ok ? 'OK: "' + String(resp.texto || '').slice(0, 40) + '"' : 'FALHOU: ' + (resp && resp.erro));
          if (resp && resp.ok && resp.texto && resp.texto.trim()) {
            reg.content = resp.texto.trim();
            if (resp.quem) reg.from = resp.quem === 'EU' ? 'eu' : 'eles';
          }
        } catch (e) {
          logA('transcrição erro:', e.message);
        }
      }
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

  function mostrarBadge({ texto, cor = '#25d366', loading = false, arquivo = null, server = null, docxBase64 = null }) {
    const el = badgeEl();
    el.style.borderLeftColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;font-size:15px">📋</span>';
    let acao = '';
    if (docxBase64) {
      const url = 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + docxBase64;
      acao =
        `<a href="${url}" download="${arquivo || 'report.docx'}" style="display:inline-block;margin-top:8px;background:#25d366;color:#05130c;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px">⬇ Baixar .docx</a>`;
    } else if (arquivo && server) {
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
        texto:
          '<b>Lendo a conversa…</b><br>Capturando e transcrevendo áudios pode demorar um pouco. ' +
          '<u>Não troque de conversa agora</u>.',
        loading: true,
      });
      const { mensagens, nome, stats } = await coletarConversa(server, true);
      if (!mensagens.length) {
        mostrarBadge({ texto: '❌ Nenhuma mensagem encontrada nesta conversa.', cor: '#ff6b6b' });
        jobEmAndamento = false;
        return;
      }

      const linhaAudio =
        stats.audios > 0
          ? `🎤 ${stats.audios} áudio(s), ${stats.audiosTranscritos} com transcrição` +
            (stats.audiosTranscritos < stats.audios
              ? ' <span style="color:#8b98a5">(os demais entram como [áudio])</span>'
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
        ultimoReport: { arquivo: resp.arquivo, dados: resp.dados, docxBase64: resp.docxBase64, nome, server, quando: Date.now() },
      });
      mostrarBadge({
        texto: `<b>✅ Report pronto!</b> (${nome || 'lead'})`,
        arquivo: resp.arquivo,
        server,
        docxBase64: resp.docxBase64,
      });
    } catch (e) {
      mostrarBadge({ texto: '❌ ' + e.message, cor: '#ff6b6b' });
    } finally {
      jobEmAndamento = false;
    }
  }

  // ===========================================================================
  // Rastreador diário (beta): conta contatos iniciados, respostas e recontatos
  // observando as mensagens enquanto você usa o WhatsApp Web.
  // ===========================================================================
  const hojeStr = () => new Date().toISOString().slice(0, 10);
  const msgProcessadas = new Set();
  let serverTracker = 'http://localhost:3000';
  let pushTimer = null;

  const storageGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  const storageSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

  function jidEDirecao(dataId) {
    const p = String(dataId).split('_');
    const dir = p[0] === 'true' ? 'meu' : p[0] === 'false' ? 'deles' : null;
    return { dir, jid: p[1] || '' };
  }

  // Só conta mensagens "ao vivo" (últimos 2 min) — evita contar histórico ao abrir a conversa.
  function msgAoVivo(el) {
    const copy = el.querySelector('.copyable-text');
    const pre = copy && copy.getAttribute('data-pre-plain-text');
    if (!pre) return false;
    const m = pre.match(/\[(.*?)\]/);
    if (!m) return false;
    const parsed = parseDataHora(m[1]);
    return parsed ? Math.abs(Date.now() - parsed.ms) < 120000 : false;
  }

  function agendarPush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      const { crDia } = await storageGet(['crDia']);
      if (!crDia) return;
      chrome.runtime.sendMessage({
        action: 'pushDia',
        server: serverTracker,
        dia: {
          data: crDia.data,
          iniciados: crDia.iniciados.length,
          respostas: crDia.respostas.length,
          recontatos: crDia.recontatos.length,
        },
      });
    }, 1500);
  }

  async function contarMensagem(el) {
    const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]');
    if (!idEl) return;
    const dataId = idEl.getAttribute('data-id');
    if (!dataId || msgProcessadas.has(dataId)) return;
    const { dir, jid } = jidEDirecao(dataId);
    if (!dir || !jid || jid.endsWith('@g.us')) return; // ignora grupos/inválidos
    if (!msgAoVivo(el)) {
      msgProcessadas.add(dataId);
      return;
    }
    msgProcessadas.add(dataId);

    const store = await storageGet(['crDia', 'crContatos']);
    const crContatos = store.crContatos || {};
    const hoje = hojeStr();
    let crDia = store.crDia;
    if (!crDia || crDia.data !== hoje) crDia = { data: hoje, iniciados: [], recontatos: [], respostas: [] };

    if (dir === 'meu') {
      const c = crContatos[jid];
      if (!c) {
        // primeiro contato de todos os tempos com esse lead
        crContatos[jid] = { primeiroDia: hoje, ultimaRespostaDia: null };
        if (!crDia.iniciados.includes(jid)) crDia.iniciados.push(jid);
      } else {
        const nuncaRespondeu = !c.ultimaRespostaDia;
        const esfriou = c.ultimaRespostaDia && c.ultimaRespostaDia < hoje;
        if ((nuncaRespondeu || esfriou) && !crDia.recontatos.includes(jid)) {
          crDia.recontatos.push(jid);
        }
      }
    } else {
      if (!crContatos[jid]) crContatos[jid] = { primeiroDia: hoje, ultimaRespostaDia: null };
      crContatos[jid].ultimaRespostaDia = hoje;
      if (!crDia.respostas.includes(jid)) crDia.respostas.push(jid);
    }

    await storageSet({ crDia, crContatos });
    agendarPush();
  }

  function iniciarTracker() {
    chrome.storage.local.get({ server: 'http://localhost:3000' }, (c) => {
      serverTracker = (c.server || 'http://localhost:3000').replace(/\/$/, '');
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.server) serverTracker = (ch.server.newValue || '').replace(/\/$/, '');
    });
    const obs = new MutationObserver((muts) => {
      for (const mu of muts) {
        mu.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          const id = n.getAttribute && n.getAttribute('data-id');
          if (id && /^(true|false)_/.test(id)) contarMensagem(n);
          if (n.querySelectorAll) {
            n.querySelectorAll('[data-id]').forEach((e) => {
              const eid = e.getAttribute('data-id') || '';
              if (/^(true|false)_/.test(eid)) contarMensagem(e);
            });
          }
        });
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'start') {
      // Dispara em background e responde na hora para o popup poder fechar.
      gerarReportEmBackground(msg.server);
      sendResponse({ ok: true, iniciado: true });
      return false;
    }
    if (msg && msg.action === 'contadoresDia') {
      storageGet(['crDia']).then(({ crDia }) => {
        sendResponse({
          ok: true,
          data: crDia && crDia.data,
          iniciados: crDia ? crDia.iniciados.length : 0,
          respostas: crDia ? crDia.respostas.length : 0,
          recontatos: crDia ? crDia.recontatos.length : 0,
        });
      });
      return true; // assíncrono
    }
    if (msg && msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
  });

  iniciarTracker();
})();
