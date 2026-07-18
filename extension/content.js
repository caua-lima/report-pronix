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

  // O gancho que intercepta os áudios precisa rodar no contexto da PÁGINA. O
  // manifesto pede isso com world:"MAIN", mas nem todo Chromium respeita (Brave e
  // versões antigas ignoram em silêncio) — e sem gancho a captura devolve zero.
  // Aqui garantimos o gancho injetando o inject.js como <script>, que funciona em
  // todos. O marcador no DOM é a única forma de o content script (outro "mundo")
  // saber se o gancho está de pé.
  const ganchoInstalado = () => document.documentElement.getAttribute('data-cr-audio-hook') === '1';

  async function garantirGanchoAudio() {
    if (ganchoInstalado()) return true;
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('inject.js');
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      logA('falha ao injetar o gancho:', e.message);
    }
    for (let i = 0; i < 20 && !ganchoInstalado(); i++) await sleep(50);
    logA(ganchoInstalado() ? 'gancho de áudio ativo' : 'GANCHO DE ÁUDIO NÃO INSTALOU');
    return ganchoInstalado();
  }

  // Instala o quanto antes; os áudios só criam blob quando clicados, bem depois.
  garantirGanchoAudio();

  async function fetchArrayBuffer(url) {
    try {
      return await fetch(url).then((r) => r.arrayBuffer());
    } catch (_) {
      return null;
    }
  }

  // Confere pelos magic bytes se o blob é mesmo áudio (descarta imagem/pdf/etc.).
  function ehAudioBuffer(buf) {
    if (!buf || buf.byteLength < 800) return false;
    const b = new Uint8Array(buf.slice(0, 12));
    const eq = (i, s) => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
    // Não-áudio conhecidos -> rejeita
    if (b[0] === 0xff && b[1] === 0xd8) return false; // JPEG
    if (b[0] === 0x89 && eq(1, 'PNG')) return false; // PNG
    if (eq(0, 'GIF8')) return false;
    if (eq(0, '%PDF')) return false;
    if (eq(0, 'RIFF') && eq(8, 'WEBP')) return false; // WebP
    // Áudio conhecidos -> aceita
    if (eq(0, 'OggS')) return true; // ogg/opus (voz do WhatsApp)
    if (eq(0, 'ID3')) return true; // mp3 com tag
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // frame mp3
    if (eq(0, 'fLaC')) return true; // flac
    if (eq(0, 'RIFF')) return true; // wav
    if (eq(4, 'ftyp')) return true; // mp4/m4a/aac
    // Desconhecido, mas tamanho plausível de voz -> aceita
    return buf.byteLength >= 1500 && buf.byteLength < 8000000;
  }

  // Força o WhatsApp a materializar o áudio (baixa se preciso + play no mudo),
  // captura os bytes (via <audio> ou via hook createObjectURL). Retorna base64 ou null.
  async function capturarBytes(el, dbg, iteracoes = 40) {
    // 1) Se houver botão de baixar (áudio não carregado ainda), clica primeiro.
    const btnBaixar = el.querySelector(
      '[data-icon="audio-download"], [data-icon="down"], [data-icon*="download" i], span[data-icon="audio-download"]'
    );
    if (btnBaixar) {
      const alvo = btnBaixar.closest('button,[role="button"]') || btnBaixar;
      try {
        alvo.click();
        await sleep(500);
      } catch (_) {
        /* ok */
      }
    }

    // 2) Clica no play (ajuda a materializar o blob se for criado no play).
    const btn =
      el.querySelector('[data-icon*="play" i]')?.closest('button,[role="button"]') ||
      el.querySelector(
        'button[aria-label*="play" i], button[aria-label*="reproduzir" i], [role="button"][aria-label*="reproduzir" i]'
      ) ||
      el.querySelector('[data-icon*="play" i]') ||
      el.querySelector('button,[role="button"]');
    const antes = blobsAudio.length;
    if (btn) {
      try {
        btn.click();
      } catch (_) {
        /* ok */
      }
    }

    // 3) Consome o próximo blob que SEJA áudio (valida magic bytes; descarta
    //    imagem/pdf/etc.). Áudios processados de cima p/ baixo = ordem cronológica.
    //    iteracoes controla a paciência (cada iteração ~150ms): a repescagem
    //    aumenta isso para os áudios que demoram a carregar.
    let descartados = 0;
    for (let i = 0; i < iteracoes; i++) {
      for (const b of blobsAudio) {
        if (b.usado) continue;
        b.usado = true;
        const buf = await fetchArrayBuffer(b.url);
        if (ehAudioBuffer(buf)) {
          logA(`áudio ${dbg || ''}: OK ${buf.byteLength} bytes (descartados ${descartados} não-áudio)`);
          return arrayBufferToBase64(buf);
        }
        descartados++;
      }
      // elemento <audio>, se esta versão usar
      const a = el.querySelector('audio') || document.querySelector('audio');
      if (a && (a.currentSrc || a.src || '').startsWith('blob:')) {
        a.muted = true;
        a.volume = 0;
        try { a.pause(); } catch (_) {}
        const buf = await fetchArrayBuffer(a.currentSrc || a.src);
        if (ehAudioBuffer(buf)) { logA(`áudio ${dbg || ''}: via <audio> OK ${buf.byteLength}`); return arrayBufferToBase64(buf); }
      }
      await sleep(150);
    }
    logA(`áudio ${dbg || ''}: sem blob de áudio (blobs vistos=${blobsAudio.length}, antes=${antes})`);
    return null;
  }

  // Captura os bytes dos áudios visíveis, de cima para baixo (mapeamento
  // cronológico). Pula os que JÁ foram capturados (audioBytes) — nunca desiste de
  // um que ainda falta. tentadosNestaPassada evita reclicar o mesmo áudio enquanto
  // ele fica na tela durante a rolagem; zera a cada passada de repescagem.
  async function capturarAudiosVisiveis(root, audioBytes, tentadosNestaPassada, iteracoes) {
    const audios = acharMensagens(root).filter((el) => ehAudio(el));
    for (const el of audios) {
      const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]') || el.querySelector('[data-id]');
      const chave = idEl ? idEl.getAttribute('data-id') : null;
      if (!chave || audioBytes.has(chave) || tentadosNestaPassada.has(chave)) continue;
      tentadosNestaPassada.add(chave);
      try {
        const b64 = await capturarBytes(el, chave.slice(0, 8), iteracoes);
        if (b64) audioBytes.set(chave, b64);
      } catch (_) {
        /* segue */
      }
    }
  }

  // Rola do topo até o fim uma vez, capturando os áudios que ainda faltam.
  async function passadaDeCaptura(scroller, root, capturar, audioBytes, expandir, iteracoes) {
    const tentados = new Set(); // reinicia a cada passada: os que faltam serão retentados
    if (!scroller) {
      await expandir(root);
      capturar();
      await capturarAudiosVisiveis(root, audioBytes, tentados, iteracoes);
      return;
    }
    scroller.scrollTop = 0;
    await sleep(300);
    const passo = Math.max(200, Math.floor(scroller.clientHeight * 0.6));
    for (let i = 0; i < 500; i++) {
      await expandir(root);
      capturar();
      await capturarAudiosVisiveis(root, audioBytes, tentados, iteracoes);
      const antes = scroller.scrollTop;
      scroller.scrollTop = Math.min(antes + passo, scroller.scrollHeight);
      await sleep(280);
      const fim = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
      if (scroller.scrollTop === antes || fim) {
        await expandir(root);
        capturar();
        await capturarAudiosVisiveis(root, audioBytes, tentados, iteracoes);
        break;
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
    // Fallback 2: role="row" com texto OU com mídia/áudio (para não perder áudios).
    els = [...root.querySelectorAll('div[role="row"]')].filter((el) =>
      el.querySelector(
        '.selectable-text, .copyable-text, [data-icon*="ptt" i], [data-icon*="mic" i], ' +
          '[data-icon*="audio" i], [data-icon*="play" i], [data-icon*="pause" i], ' +
          'input[type="range"], audio'
      )
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
    if (id.startsWith('true_')) return true;
    if (id.startsWith('false_')) return false;
    // aria-label "Você:" — nesta versão do WhatsApp marca mensagens enviadas por mim.
    for (const a of el.querySelectorAll('[aria-label]')) {
      if (/^você\b/i.test((a.getAttribute('aria-label') || '').trim())) return true;
    }
    // data-pre-plain-text: "[hora, data] Remetente: " — "Você" = eu; nome = deles.
    const copy = el.querySelector('.copyable-text');
    const pre = copy && copy.getAttribute('data-pre-plain-text');
    if (pre) {
      const m = pre.match(/\]\s*(.+?):\s*$/);
      if (m) return /^você$/i.test(m[1].trim());
    }
    return false; // padrão: deles (lead)
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
      // Placeholder limpo; a transcrição real vem da captura + Whisper (não do DOM,
      // que aqui só traria lixo como nome do remetente/duração).
      return { from: fromMe ? 'eu' : 'eles', type: 'audio', content: '[áudio]', timestamp, ts };
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
    const faltamAudios = () =>
      [...mapa].filter(([chave, reg]) => reg.type === 'audio' && !audioBytes.has(chave)).length;

    if (scroller) {
      // 1) Rola até o topo para carregar o histórico antigo (uma vez só).
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
    }

    // Sem o gancho instalado nenhum áudio é interceptado — tenta de novo antes de rolar.
    if (capturarAudio) await garantirGanchoAudio();

    // 2) Passadas de captura: desce do topo capturando os áudios que faltam.
    //    A primeira pega a maioria; as seguintes voltam nos teimosos com mais
    //    paciência, até não faltar nenhum (ou esgotar as tentativas).
    const MAX_PASSADAS = 6;
    let faltaramAntes = Infinity;
    for (let passada = 0; passada < MAX_PASSADAS; passada++) {
      const iteracoes = 40 + passada * 25; // ~6s na 1ª, subindo até ~24s por áudio
      if (passada > 0 && capturarAudio) {
        mostrarBadge({
          texto: `<b>Repescando áudios…</b> faltam ${faltamAudios()} (tentativa ${passada + 1})`,
          loading: true,
        });
      }
      await passadaDeCaptura(scroller, root, capturar, audioBytes, expandirTranscricoes, iteracoes);

      if (!capturarAudio) break; // sem áudio: uma passada basta
      const faltam = faltamAudios();
      if (faltam === 0) break; // pegou todos
      // Se uma passada inteira não recuperou NENHUM novo, insistir não ajuda:
      // provavelmente é mídia que o WhatsApp não consegue mais baixar.
      if (faltam >= faltaramAntes) break;
      faltaramAntes = faltam;
    }

    // Transcreve os áudios capturados (via service worker, evitando a CSP da página).
    if (capturarAudio && server) {
      const totalAudios = [...mapa.values()].filter((r) => r.type === 'audio').length;
      const pendentes = [...mapa].filter(([chave, reg]) => reg.type === 'audio' && audioBytes.get(chave));
      logA(`${totalAudios} áudios | ${pendentes.length} capturados p/ transcrever`);
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
          if (resp && resp.ok && resp.texto && resp.texto.trim()) {
            // quem enviou já veio do DOM (aria-label "Você:"), não sobrescreve.
            reg.content = resp.texto.trim();
          } else if (resp && resp.erro) {
            logA('transcrição falhou:', resp.erro);
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

  function mostrarBadge({ texto, cor = '#25d366', loading = false, arquivo = null, server = null, arquivoBase64 = null }) {
    const el = badgeEl();
    el.style.borderLeftColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;font-size:15px">📋</span>';
    let acao = '';
    if (arquivoBase64) {
      const url = 'data:application/pdf;base64,' + arquivoBase64;
      acao =
        `<a href="${url}" download="${arquivo || 'report.docx'}" style="display:inline-block;margin-top:8px;background:#25d366;color:#05130c;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px">⬇ Baixar PDF</a>`;
    } else if (arquivo && server) {
      const url = server + '/api/download/' + encodeURIComponent(arquivo);
      acao =
        `<a href="${url}" target="_blank" style="display:inline-block;margin-top:8px;background:#25d366;color:#05130c;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px">⬇ Baixar PDF</a>`;
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
        ultimoReport: { arquivo: resp.arquivo, dados: resp.dados, arquivoBase64: resp.arquivoBase64, nome, server, quando: Date.now() },
      });
      // O resumo dos áudios fica no aviso final: o "Gerando report…" some rápido
      // demais para dar tempo de ler, e é a dúvida de sempre — transcreveu ou não?
      const resumoAudio =
        stats.audios === 0
          ? '<span style="color:#8b98a5">Sem áudios nesta conversa</span>'
          : stats.audiosTranscritos === stats.audios
            ? `🎤 ${stats.audios} áudio(s) transcrito(s)`
            : stats.audiosTranscritos === 0 && !ganchoInstalado()
              ? // Nenhum capturado E sem gancho: não é áudio difícil, é a página.
                '⚠️ <b>Recarregue a aba do WhatsApp (F5)</b>' +
                ' <span style="color:#8b98a5">e gere de novo — a leitura de áudio não iniciou</span>'
              : `⚠️ ${stats.audiosTranscritos} de ${stats.audios} áudio(s) transcrito(s)` +
                ' <span style="color:#8b98a5">— o resto entrou como [áudio]</span>';

      mostrarBadge({
        texto: `<b>✅ Report pronto!</b> (${nome || 'lead'})<br>${resumoAudio}`,
        arquivo: resp.arquivo,
        server,
        arquivoBase64: resp.arquivoBase64,
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
