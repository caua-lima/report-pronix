// Content script — lê a conversa aberta no WhatsApp Web (incl. histórico retroativo).
// Roda no contexto da página web.whatsapp.com.

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VERSAO = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return '?';
    }
  })();
  const MSG_CONVERSA_MUDOU =
    'A conversa mudou durante a leitura, então nenhum report foi gerado. Abra a conversa do lead, espere o aviso "Gerando report…" e tente de novo.';

  // Silencia qualquer <audio> que o WhatsApp criar (a captura "toca" no mudo).
  // Só vale enquanto um report está sendo gerado: fora disso o SDR ouve os áudios
  // normalmente. Guarda o estado original de cada <audio> pra devolver no fim.
  let capturaAtiva = false;
  const silenciados = new Map();
  function silenciar(a) {
    if (!silenciados.has(a)) silenciados.set(a, { muted: a.muted, volume: a.volume });
    a.muted = true;
    a.volume = 0;
  }
  function restaurarAudios() {
    silenciados.forEach((estado, a) => {
      try {
        a.pause();
        a.muted = estado.muted;
        a.volume = estado.volume;
      } catch (_) {
        /* elemento já descartado pela página */
      }
    });
    silenciados.clear();
  }
  try {
    const mutar = () => {
      if (capturaAtiva) document.querySelectorAll('audio').forEach(silenciar);
    };
    new MutationObserver(mutar).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {
    /* ignora */
  }

  // Todo texto que vem de fora (nome do contato, erro do servidor, nome de arquivo)
  // passa por aqui antes de ir para innerHTML.
  const escHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // Blobs de áudio capturados pelo inject.js (hook do URL.createObjectURL). O hook
  // é permissivo (pega tipo vazio também, porque a voz do WhatsApp às vezes vem
  // assim) — então a fila recebe bastante coisa que NÃO é áudio (fotos, figurinhas,
  // thumbnails também usam createObjectURL). Numa conversa longa com muitos áudios,
  // um buffer pequeno é atropelado antes do código alcançar os áudios mais adiante
  // na lista — por isso o teto é alto: cabe uma conversa cheia sem perder nada.
  const blobsAudio = [];
  const MAX_BLOBS_FILA = 500;
  let totalBlobsVistos = 0; // quantos arquivos o WhatsApp já criou (a fila é cortada em MAX_BLOBS_FILA; este não)
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.__crAudio && ev.data.url) {
      totalBlobsVistos++;
      blobsAudio.push({ url: ev.data.url, ts: ev.data.ts || Date.now() });
      if (blobsAudio.length > MAX_BLOBS_FILA) blobsAudio.shift();
    }
  });

  // Toda linha leva a versão: um log colado sem versão não diz qual extensão estava rodando.
  const logA = (...a) => console.log(`[CR-audio v${VERSAO}]`, ...a);

  // Diagnóstico (uma vez por leitura): dos blobs que já existiam ANTES do clique, quantos são áudio de
  // verdade? Separa "o WhatsApp não entregou o arquivo" (mídia expirada) de "o arquivo existia e a
  // extensão não pegou".
  let filaDiagnosticada = false;
  async function diagnosticarFila(t0) {
    if (filaDiagnosticada) return;
    filaDiagnosticada = true;
    let audio = 0;
    let outros = 0;
    let semBytes = 0;
    for (const b of blobsAudio.slice(-30)) {
      if (b.ts >= t0) continue;
      const buf = await fetchArrayBuffer(b.url);
      if (!buf) semBytes++;
      else if (ehAudioBuffer(buf)) audio++;
      else outros++;
    }
    logA(`fila anterior ao clique: ${audio} áudio(s) válido(s), ${outros} outro(s), ${semBytes} sem bytes`);
  }

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
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // webm/matroska
    if (eq(0, '#!AMR')) return true; // amr
    // Desconhecido: só serve se NÃO for texto (HTML/JSON de erro do CDN) e tiver tamanho plausível de voz.
    const texto = [...new Uint8Array(buf.slice(0, 32))].every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));
    if (texto) return false;
    return buf.byteLength >= 1500 && buf.byteLength < 8000000;
  }

  // Força o WhatsApp a materializar o áudio (baixa se preciso + play no mudo),
  // captura os bytes (via <audio> ou via hook createObjectURL). Retorna base64 ou null.
  async function capturarBytes(el, dbg, iteracoes = 40) {
    // A fila global é compartilhada por todas as mensagens: só aceita blobs criados
    // a partir deste clique, senão daria pra atribuir o áudio de OUTRA mensagem.
    const t0 = Date.now() - 250;
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

    // 3) Busca os bytes do áudio, em duas fontes por iteração:
    //    a) o <audio> DESTA mensagem (el.querySelector, nunca document.querySelector
    //       — pegar o <audio> global seria o de OUTRA linha). É o sinal mais confiável
    //       porque está amarrado à própria mensagem, não a uma fila compartilhada.
    //    b) a fila global de blobs do hook, como repescagem (valida magic bytes;
    //       descarta imagem/pdf/etc.). iteracoes controla a paciência (~150ms cada);
    //       a repescagem aumenta isso para os áudios que demoram a carregar.
    let descartados = 0;
    for (let i = 0; i < iteracoes; i++) {
      const a = el.querySelector('audio');
      if (a && (a.currentSrc || a.src || '').startsWith('blob:')) {
        silenciar(a);
        try { a.pause(); } catch (_) {}
        const buf = await fetchArrayBuffer(a.currentSrc || a.src);
        if (ehAudioBuffer(buf)) { logA(`áudio ${dbg || ''}: via <audio> OK ${buf.byteLength}`); return arrayBufferToBase64(buf); }
      }
      // 1º os arquivos criados a partir deste clique (são desta mensagem por construção). 2º, se nada novo
      // aparecer em ~1s, os que já existiam na fila: o WhatsApp às vezes cria o arquivo ANTES do clique — foi
      // assim que a captura sempre funcionou, e sem isso esses áudios nunca seriam lidos.
      const antigosOk = i >= 6 && !blobsAudio.some((b) => !b.usado && b.ts >= t0);
      for (const b of blobsAudio) {
        if (b.usado || (b.ts < t0 && !antigosOk)) continue;
        b.usado = true;
        const buf = await fetchArrayBuffer(b.url);
        if (ehAudioBuffer(buf)) {
          logA(`áudio ${dbg || ''}: OK ${buf.byteLength} bytes (descartados ${descartados} não-áudio)`);
          return arrayBufferToBase64(buf);
        }
        descartados++;
      }
      await sleep(150);
    }
    const novos = blobsAudio.filter((b) => b.ts >= t0).length;
    logA(
      `áudio ${dbg || ''}: sem blob de áudio (na fila=${blobsAudio.length}, novos após o clique=${novos}, ` +
        `<audio> na bolha=${!!el.querySelector('audio')}, botão de play=${!!btn}, botão de baixar=${!!btnBaixar})`
    );
    if (!novos) await diagnosticarFila(t0);
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
  // Decide se a mensagem é MINHA (vendedor) ou do LEAD. Precisa funcionar em áudio,
  // que não tem texto nem data-pre-plain-text — por isso não basta o sinal textual.
  function ehDeMim(el) {
    // Sobe até a linha inteira: o elemento de áudio às vezes é estreito e não contém
    // os sinais (data-id da mensagem, tique de status) que ficam na meta da bolha.
    const row = (el.closest && (el.closest('[role="row"]') || el.closest('[data-id]'))) || el;

    // 1) data-id da mensagem: "true_" = eu, "false_" = lead. É o sinal canônico do
    //    WhatsApp e vale para áudio. Prefere o data-id da própria linha (não de uma
    //    citação aninhada, que poderia ter outro remetente).
    const idEl = row.matches && row.matches('[data-id]') ? row : row.querySelector && row.querySelector('[data-id]');
    const id = idEl ? idEl.getAttribute('data-id') || '' : '';
    if (/^true_/.test(id)) return true;
    if (/^false_/.test(id)) return false;

    // 2) Classes explícitas (quando esta versão do WhatsApp as usa).
    if (row.classList && (row.classList.contains('message-out') || row.querySelector('.message-out'))) return true;
    if (row.classList && (row.classList.contains('message-in') || row.querySelector('.message-in'))) return false;

    // 3) Tique de status (enviado/entregue/lido): SÓ mensagem MINHA tem confirmação.
    //    O lead nunca tem tique — então achar um aqui garante que é minha. Funciona em
    //    áudio, que era o furo: a voz da Agatha não tinha texto, mas TEM tique.
    if (
      row.querySelector &&
      row.querySelector('[data-icon^="msg-check"], [data-icon^="msg-dblcheck"], [data-icon="status-dblcheck"], [data-icon="status-check"]')
    ) {
      return true;
    }

    // 4) aria-label "Você:".
    if (row.querySelectorAll) {
      for (const a of row.querySelectorAll('[aria-label]')) {
        if (/^você\b/i.test((a.getAttribute('aria-label') || '').trim())) return true;
      }
    }

    // 5) data-pre-plain-text: "[hora, data] Remetente: " — "Você" = eu; nome = deles.
    const copy = row.querySelector && row.querySelector('.copyable-text');
    const pre = copy && copy.getAttribute('data-pre-plain-text');
    if (pre) {
      const m = pre.match(/\]\s*(.+?):\s*$/);
      if (m) return /^você$/i.test(m[1].trim());
    }

    return false; // padrão: lead
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
      // Log de diagnóstico: se algum áudio for atribuído errado, esta linha mostra
      // qual data-id tinha e o que decidiu — basta o SDR copiar do console.
      const row = (el.closest && (el.closest('[role="row"]') || el.closest('[data-id]'))) || el;
      const idDbg = (row.querySelector && row.querySelector('[data-id]')) || (row.matches && row.matches('[data-id]') ? row : null);
      const temTique = !!(row.querySelector && row.querySelector('[data-icon^="msg-check"], [data-icon^="msg-dblcheck"]'));
      logA(
        'áudio →',
        fromMe ? 'VENDEDOR (meu)' : 'LEAD',
        '| data-id:', idDbg ? (idDbg.getAttribute('data-id') || '').slice(0, 14) : 'nenhum',
        '| tique:', temTique
      );
      // Placeholder limpo; a transcrição real vem da captura + Whisper (não do DOM,
      // que aqui só traria lixo como nome do remetente/duração).
      return { from: fromMe ? 'eu' : 'eles', type: 'audio', content: '[áudio]', timestamp, ts };
    }

    const texto = extrairTexto(el);
    if (!texto) return null; // imagem/figurinha/sistema sem texto: ignora
    return { from: fromMe ? 'eu' : 'eles', type: 'texto', content: texto, timestamp, ts };
  }

  // O cabeçalho traz o nome E o status ("online", "digitando…", "visto por último…").
  // Sem filtrar, o status vira o nome do lead — foi assim que um report saiu com
  // "Lead: online".
  const STATUS_CONTATO =
    /^(online|digitando|gravando|escrevendo|visto por [úu]ltimo|[úu]ltima vez|typing|recording|last seen|click here|clique aqui|toque aqui)/i;

  function nomeDoContato() {
    const header = document.querySelector('#main header');
    if (!header) return '';

    const candidatos = [];
    // O title costuma trazer o nome completo (o texto visível pode vir cortado).
    header.querySelectorAll('span[title]').forEach((s) => {
      const t = (s.getAttribute('title') || '').trim();
      if (t) candidatos.push(t);
    });
    header.querySelectorAll('span[dir="auto"], h1, h2').forEach((s) => {
      const t = (s.innerText || '').trim();
      if (t) candidatos.push(t);
    });

    for (const c of candidatos) {
      if (!c || c.length > 80) continue;
      if (STATUS_CONTATO.test(c)) continue; // é status, não nome
      return c;
    }
    return '';
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

  // Id da conversa aberta: o trecho "…@c.us" / "…@g.us" que vem no data-id de toda mensagem
  // (true_<conversa>_<id>). O que aparecer MAIS vezes na tela é a conversa que está aberta.
  const JID_RE = /^(?:true|false)_([^_]+@[a-z.]+)_/i;
  function jidPredominante(root) {
    const contagem = new Map();
    root.querySelectorAll('[data-id]').forEach((el) => {
      const m = JID_RE.exec(el.getAttribute('data-id') || '');
      if (m) contagem.set(m[1], (contagem.get(m[1]) || 0) + 1);
    });
    let melhor = '';
    let max = 0;
    contagem.forEach((n, jid) => {
      if (n > max) {
        max = n;
        melhor = jid;
      }
    });
    return melhor;
  }

  async function coletarConversa(server, capturarAudio) {
    const root = document.querySelector('#main') || document;

    // A conversa aberta AGORA é a alvo. Se o SDR abrir outra durante a leitura, o report sairia
    // misturado — então aborta na hora. O id da conversa é definitivo; sem ele (WhatsApp mudou
    // o formato), cai para o nome do cabeçalho, exigindo 3 leituras seguidas diferentes.
    const alvoJid = jidPredominante(root);
    const alvoNome = nomeDoContato();
    let divergenciasDeNome = 0;
    const garantirMesmaConversa = () => {
      const jid = jidPredominante(root);
      if (alvoJid && jid) {
        if (jid !== alvoJid) throw new Error(MSG_CONVERSA_MUDOU);
        return;
      }
      const nome = alvoNome ? nomeDoContato() : '';
      divergenciasDeNome = nome && nome !== alvoNome ? divergenciasDeNome + 1 : 0;
      if (divergenciasDeNome >= 3) throw new Error(MSG_CONVERSA_MUDOU);
    };

    const scroller = acharScroller(acharMensagens(root)[0]);
    const mapa = new Map(); // chave -> registro (ordem = primeira aparição top→bottom)
    const audioBytes = new Map(); // chave (data-id) -> base64 do áudio capturado
    let seq = 0;

    const capturar = () => {
      garantirMesmaConversa();
      acharMensagens(root).forEach((el) => {
        const reg = extrairMensagem(el);
        if (!reg) return;
        const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]') || el.querySelector('[data-id]');
        // Sem data-id, a chave inclui o remetente: "ok" meu e "ok" do lead no mesmo minuto são mensagens diferentes.
        const chave = idEl
          ? idEl.getAttribute('data-id')
          : reg.from + '|' + (reg.timestamp || '') + '|' + reg.content.slice(0, 80);
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
        garantirMesmaConversa();
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
    filaDiagnosticada = false;
    for (let passada = 0; passada < MAX_PASSADAS; passada++) {
      const vistosAntesDaPassada = totalBlobsVistos;
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
      // Primeira passada inteira: nenhum áudio saiu E o WhatsApp não criou arquivo nenhum ao clicar nos
      // áudios (nem um). Ele não está entregando as mídias (costuma ser áudio antigo, já expirado no
      // servidor). Repescar só gasta minutos esperando o que não vai chegar.
      if (passada === 0 && audioBytes.size === 0 && totalBlobsVistos === vistosAntesDaPassada && faltam >= 3) {
        logA(`nenhum dos ${faltam} áudios foi entregue pelo WhatsApp (mídia expirada?) — não vou repescar.`);
        break;
      }
      // Se uma passada inteira não recuperou NENHUM novo, insistir não ajuda:
      // provavelmente é mídia que o WhatsApp não consegue mais baixar.
      if (faltam >= faltaramAntes) break;
      faltaramAntes = faltam;
    }

    garantirMesmaConversa(); // a última passada ainda foi na conversa certa?

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
    // O nome vem do INÍCIO da leitura: lido no fim, podia ser o de outra conversa aberta enquanto os áudios transcreviam.
    return { mensagens, nome: alvoNome || nomeDoContato(), stats };
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

  function mostrarBadge({ texto, cor = '#25d366', loading = false, arquivo = null, server = null, arquivoBase64 = null, botoes = [], aoEscolher = null, aoFechar = null }) {
    const el = badgeEl();
    el.style.borderLeftColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;display:flex">' + "<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" style=\"vertical-align:-2px;flex:none\" fill=\"none\" stroke=\"#ffc400\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/></svg>" + '</span>';
    let acao = '';
    if (arquivoBase64) {
      const url = 'data:application/pdf;base64,' + arquivoBase64;
      acao =
        `<a href="${escHtml(url)}" download="${escHtml(arquivo || 'report.pdf')}" style="display:inline-block;margin-top:8px;background:#25d366;color:#05130c;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#121214" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg> Baixar PDF</a>`;
    } else if (arquivo && server) {
      const url = server + '/api/download/' + encodeURIComponent(arquivo);
      acao =
        `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:8px;background:#25d366;color:#05130c;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#121214" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg> Baixar PDF</a>`;
    }
    const htmlBotoes = botoes.length
      ? '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
        botoes
          .map(
            (b) =>
              `<button type="button" data-cr-acao="${escHtml(b.acao)}" style="cursor:pointer;border:0;border-radius:7px;padding:6px 10px;font-weight:700;font-size:12px;background:${b.primario ? '#25d366' : '#26333f'};color:${b.primario ? '#05130c' : '#e6edf3'}">${escHtml(b.rotulo)}</button>`
          )
          .join('') +
        '</div>'
      : '';
    el.innerHTML =
      (document.getElementById('crspin-style') ? '' : '<style id="crspin-style">@keyframes crspin{to{transform:rotate(360deg)}}</style>') +
      spinner +
      `<div style="flex:1"><div>${texto}</div>${acao}${htmlBotoes}</div>` +
      `<span id="cr-x" style="flex:none;cursor:pointer;color:#8b98a5;font-size:15px;line-height:1">×</span>`;
    el.querySelectorAll('[data-cr-acao]').forEach((b) => {
      b.onclick = () => {
        if (aoEscolher) aoEscolher(b.dataset.crAcao);
      };
    });
    const x = el.querySelector('#cr-x');
    if (x) {
      x.onclick = () => {
        el.remove();
        if (aoFechar) aoFechar();
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Orquestração do report (roda em segundo plano, sobrevive ao fechar o popup)
  // ---------------------------------------------------------------------------

  // Quem é o dono do "último report" guardado (impressão digital da chave — a chave em si nunca é gravada aqui).
  async function impressaoDaChave() {
    try {
      const { chave } = await new Promise((r) => chrome.storage.local.get({ chave: '' }, r));
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((chave || '').trim()));
      return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return '';
    }
  }

  // Guarda o último report para o popup (sem o PDF: ele é regerado a partir dos dados, de graça).
  async function guardarUltimoReport(resp, nome, server) {
    const dono = await impressaoDaChave();
    chrome.storage.local.set({
      ultimoReport: { arquivo: resp.arquivo, dados: resp.dados, nome, server, dono, versao: 0, quando: Date.now() },
    });
  }

  /** Já existe um report igual: pergunta o que fazer. Resolve 'abrir' | 'gerar' | 'cancelar'. */
  function perguntarDuplicado(existente) {
    return new Promise((resolve) => {
      const quando = new Date(existente.quando).toLocaleString('pt-BR');
      const botoes = [];
      if (existente.podeAbrir && existente.id) botoes.push({ acao: 'abrir', rotulo: 'Abrir o existente', primario: true });
      botoes.push({ acao: 'gerar', rotulo: 'Gerar de novo (custo extra)', primario: !botoes.length });
      mostrarBadge({
        texto: `<b>Já existe um report igual</b> pra ${escHtml(existente.lead || 'este contato')}, gerado em ${escHtml(quando)}.`,
        cor: '#f0ad4e',
        botoes,
        aoEscolher: resolve,
        aoFechar: () => resolve('cancelar'),
      });
    });
  }

  /** Baixa o PDF do report existente (o servidor só entrega ao dono ou ao admin) — sem chamar a IA. */
  async function abrirExistente(existente) {
    mostrarBadge({ texto: 'Buscando o report existente…', loading: true });
    const r = await new Promise((res) => chrome.runtime.sendMessage({ action: 'baixarExistente', id: existente.id }, res));
    if (!r || !r.ok) {
      mostrarBadge({ texto: escHtml((r && r.erro) || 'Não consegui abrir o report existente.'), cor: '#ff6b6b' });
      return;
    }
    mostrarBadge({
      texto: '<b>Report existente</b> — nenhuma IA foi usada.',
      cor: '#25d366',
      arquivo: r.arquivo,
      arquivoBase64: r.arquivoBase64,
    });
  }

  let jobEmAndamento = false;

  async function gerarReportEmBackground(server) {
    if (jobEmAndamento) {
      mostrarBadge({ texto: 'Já existe um report sendo gerado…', cor: '#f0ad4e', loading: true });
      return;
    }
    jobEmAndamento = true;
    capturaAtiva = true;
    try {
      mostrarBadge({
        texto:
          '<b>Lendo a conversa…</b><br>Capturando e transcrevendo áudios pode demorar um pouco. ' +
          '<u>Não troque de conversa agora</u>.',
        loading: true,
      });
      const { mensagens, nome, stats } = await coletarConversa(server, true);
      if (!mensagens.length) {
        mostrarBadge({ texto: 'Nenhuma mensagem encontrada nesta conversa.', cor: '#ff6b6b' });
        jobEmAndamento = false;
        return;
      }

      const linhaAudio =
        stats.audios > 0
          ? `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#ffc400" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg> ${stats.audios} áudio(s), ${stats.audiosTranscritos} com transcrição` +
            (stats.audiosTranscritos < stats.audios
              ? ' <span style="color:#8b98a5">(os demais entram como [áudio])</span>'
              : '')
          : 'Sem áudios nesta conversa';

      mostrarBadge({
        texto:
          `<b>Gerando report…</b> (${stats.total} mensagens)<br>` +
          `${linhaAudio}<br><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#25d366" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> Já pode responder outros leads.`,
        loading: true,
      });

      // Como foi a leitura (áudios achados x transcritos): o servidor guarda para o admin ver reports com captura parcial.
      const captureQuality = {
        plataforma: 'whatsapp',
        versao: VERSAO,
        mensagens: stats.total,
        audios: stats.audios,
        audiosTranscritos: stats.audiosTranscritos,
      };
      let resp = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality }, resolve)
      );

      if (!resp || !resp.ok) {
        mostrarBadge({ texto: escHtml((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6b6b' });
        jobEmAndamento = false;
        return;
      }

      // Idempotência: já existe um report idêntico pra esta conversa — não chama
      // a IA de novo (nem cobra de novo) sem o SDR confirmar que quer mesmo.
      if (resp.duplicado) {
        // A leitura acabou: devolve o som dos áudios enquanto o SDR decide.
        capturaAtiva = false;
        restaurarAudios();
        const escolha = await perguntarDuplicado(resp.existente);
        if (escolha === 'abrir') {
          await abrirExistente(resp.existente);
          return;
        }
        if (escolha !== 'gerar') {
          mostrarBadge({ texto: 'Geração cancelada — já existe um report igual pra esta conversa.', cor: '#f0ad4e' });
          return;
        }
        mostrarBadge({ texto: '<b>Gerando de novo…</b>', loading: true });
        resp = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality, forcarNovo: true }, resolve)
        );
        if (!resp || !resp.ok) {
          mostrarBadge({ texto: escHtml((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6b6b' });
          jobEmAndamento = false;
          return;
        }
      }

      guardarUltimoReport(resp, nome, server);
      // O resumo dos áudios fica no aviso final: o "Gerando report…" some rápido
      // demais para dar tempo de ler, e é a dúvida de sempre — transcreveu ou não?
      const resumoAudio =
        stats.audios === 0
          ? '<span style="color:#8b98a5">Sem áudios nesta conversa</span>'
          : stats.audiosTranscritos === stats.audios
            ? `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#ffc400" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg> ${stats.audios} áudio(s) transcrito(s)`
            : stats.audiosTranscritos === 0 && !ganchoInstalado()
              ? // Nenhum capturado E sem gancho: não é áudio difícil, é a página.
                '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#f0ad4e" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> <b>Recarregue a aba do WhatsApp (F5)</b>' +
                ' <span style="color:#8b98a5">e gere de novo — a leitura de áudio não iniciou</span>'
              : `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#f0ad4e" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> ${stats.audiosTranscritos} de ${stats.audios} áudio(s) transcrito(s)` +
                (stats.audiosTranscritos === 0
                  ? ' <span style="color:#8b98a5">— o WhatsApp não entregou os arquivos de áudio (áudios antigos costumam expirar); entraram como [áudio]</span>'
                  : ' <span style="color:#8b98a5">— o resto entrou como [áudio]</span>');

      mostrarBadge({
        texto: `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#25d366" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> <b>Report pronto!</b> (${escHtml(nome || 'lead')})<br>${resumoAudio}`,
        arquivo: resp.arquivo,
        server,
        arquivoBase64: resp.arquivoBase64,
      });
    } catch (e) {
      mostrarBadge({ texto: escHtml(e.message), cor: '#ff6b6b' });
    } finally {
      jobEmAndamento = false;
      capturaAtiva = false;
      restaurarAudios();
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
