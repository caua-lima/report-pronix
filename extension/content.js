// Content script — lê a conversa aberta no WhatsApp Web (incl. histórico retroativo).
// Roda no contexto da página web.whatsapp.com.

(function () {
  'use strict';

  // As duas extensões (Report PRONIX e PRONIX Closer Report) desenham o MESMO cartão e o mesmo coach. Com as duas
  // instaladas, o cartão pulava de lugar e desligar um sumia com o outro. O Report PRONIX avisa na página que é
  // ele quem desenha; o Closer Report, vendo o aviso, fica quieto.
  try {
    document.documentElement.setAttribute('data-report-dono', 'pronix');
  } catch (_) {
    /* página sem documentElement ainda: o aviso vem no próximo carregamento */
  }

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

    // 3) Tique de status (enviado/entregue/lido/enviando): SÓ mensagem MINHA tem confirmação.
    //    O lead nunca tem tique — então achar um aqui garante que é minha. Funciona em
    //    áudio, que era o furo: a voz da Agatha não tinha texto, mas TEM tique.
    if (
      row.querySelector &&
      row.querySelector('[data-icon^="msg-check"], [data-icon^="msg-dblcheck"], [data-icon="status-dblcheck"], [data-icon="status-check"], [data-icon="msg-time"]')
    ) {
      return true;
    }

    // 4) aria-label "Você:".
    if (row.querySelectorAll) {
      for (const a of row.querySelectorAll('[aria-label]')) {
        if (/^você\b/i.test((a.getAttribute('aria-label') || '').trim())) return true;
      }
    }

    // 5) data-pre-plain-text: "[hora, data] Remetente: " — "Você" = eu. Um nome aqui NÃO decide sozinho:
    //    em mensagem minha o WhatsApp pode mostrar o meu próprio nome, e não "Você".
    const copy = row.querySelector && row.querySelector('.copyable-text');
    const pre = copy && copy.getAttribute('data-pre-plain-text');
    if (pre) {
      const m = pre.match(/\]\s*(.+?):\s*$/);
      if (m && /^você$/i.test(m[1].trim())) return true;
    }

    // 6) Último recurso — posição na tela: bolha minha encosta na direita do painel, a do lead na esquerda.
    //    O WhatsApp muda a marcação de tempos em tempos (o data-id já perdeu o "true_/false_"); sem isto,
    //    quando todos os sinais acima somem, TUDO viraria mensagem do lead.
    const lado = ladoNaTela(row);
    if (lado) return lado === 'direita';

    return false; // padrão: lead
  }

  /** 'direita' | 'esquerda' | '' (não dá para dizer): de que lado do painel da conversa a bolha está. */
  function ladoNaTela(row) {
    try {
      const alvo =
        row.querySelector &&
        row.querySelector('.selectable-text, .copyable-text, audio, input[type="range"], [data-icon*="audio" i], [data-icon*="ptt" i], img');
      const painel = document.querySelector('#main');
      if (!alvo || !painel) return '';
      const a = alvo.getBoundingClientRect();
      const p = painel.getBoundingClientRect();
      if (!a.width || !p.width) return '';
      const folgaEsq = a.left - p.left;
      const folgaDir = p.right - a.right;
      if (Math.abs(folgaEsq - folgaDir) < p.width * 0.08) return ''; // no meio: não decide
      return folgaDir < folgaEsq ? 'direita' : 'esquerda';
    } catch (_) {
      return '';
    }
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
            if (audiosLidos.size > 3000) audiosLidos.clear();
            audiosLidos.set(chave, reg.content); // as dicas do coach usam sem transcrever de novo
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
      console.log('[Report PRONIX] Nenhuma mensagem lida. Diagnóstico:', diag);
      throw new Error('Nenhuma mensagem lida. Diag: ' + JSON.stringify(diag));
    }

    const audios = mensagens.filter((m) => m.type === 'audio');
    const audiosTranscritos = audios.filter((m) => !m.content.startsWith('[áudio'));
    const stats = {
      total: mensagens.length,
      audios: audios.length,
      audiosTranscritos: audiosTranscritos.length,
      doVendedor: mensagens.filter((m) => m.from === 'eu').length,
      doLead: mensagens.filter((m) => m.from !== 'eu').length,
    };
    logA(`remetentes: ${stats.doVendedor} do vendedor, ${stats.doLead} do lead (estratégia de leitura ${_estrategiaMsg})`);

    console.log(
      `[Report PRONIX] ${stats.total} mensagens lidas — ` +
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
        'max-width:320px', 'background:#1a191c', 'color:#f3efe6',
        'border:1px solid #3a373f', 'border-top:3px solid #3ddc84',
        'border-radius:12px', 'padding:12px 14px', 'font:13px/1.45 Segoe UI Variable Text,Segoe UI,system-ui,-apple-system,Roboto,sans-serif',
        'box-shadow:0 14px 34px rgba(0,0,0,.5)', 'display:flex', 'gap:10px', 'align-items:flex-start',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function mostrarBadge({ texto, cor = '#3ddc84', loading = false, arquivo = null, server = null, arquivoBase64 = null, botoes = [], aoEscolher = null, aoFechar = null }) {
    const el = badgeEl();
    el.style.borderTopColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;display:flex">' + "<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" style=\"vertical-align:-2px;flex:none\" fill=\"none\" stroke=\"#ffc233\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/></svg>" + '</span>';
    let acao = '';
    if (arquivoBase64) {
      const url = 'data:application/pdf;base64,' + arquivoBase64;
      acao =
        `<a href="${escHtml(url)}" download="${escHtml(arquivo || 'report.pdf')}" style="display:inline-block;margin-top:8px;background:#3ddc84;color:#06180e;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#18171b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg> Baixar PDF</a>`;
    } else if (arquivo && server) {
      const url = server + '/api/download/' + encodeURIComponent(arquivo);
      acao =
        `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:8px;background:#3ddc84;color:#06180e;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#18171b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg> Baixar PDF</a>`;
    }
    const htmlBotoes = botoes.length
      ? '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
        botoes
          .map(
            (b) =>
              `<button type="button" data-cr-acao="${escHtml(b.acao)}" style="cursor:pointer;border:0;border-radius:7px;padding:6px 10px;font-weight:700;font-size:12px;background:${b.primario ? '#3ddc84' : '#3a373f'};color:${b.primario ? '#06180e' : '#f3efe6'}">${escHtml(b.rotulo)}</button>`
          )
          .join('') +
        '</div>'
      : '';
    el.innerHTML =
      (document.getElementById('crspin-style') ? '' : '<style id="crspin-style">@keyframes crspin{to{transform:rotate(360deg)}}</style>') +
      spinner +
      `<div style="flex:1"><div>${texto}</div>${acao}${htmlBotoes}</div>` +
      `<span id="cr-x" style="flex:none;cursor:pointer;color:#a39e93;font-size:15px;line-height:1">×</span>`;
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


  /**
   * Depois do "Report pronto!": o SDR escolhe o closer da reunião ali mesmo. A lista e a indicação
   * (qual closer costuma fechar com este perfil de lead) vêm do servidor junto do report.
   */
  function anexarEscolhaDeCloser(resp) {
    const el = document.getElementById(BADGE_ID);
    const lista = (resp && Array.isArray(resp.closers) && resp.closers) || [];
    if (!el || !resp || !resp.id || !lista.length) return;
    const alvo = el.querySelector('div[style*="flex:1"]') || el;
    const caixa = document.createElement('div');
    caixa.id = 'cr-closer';
    caixa.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid #3a373f';
    const rotulo = document.createElement('div');
    rotulo.style.cssText = 'font-size:11px;color:#a39e93;margin-bottom:4px';
    rotulo.textContent = 'Closer desta reunião';
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;background:#121113;color:#f3efe6;border:1px solid #3a373f;border-radius:7px;padding:6px;font-size:12.5px';
    const sugerido = resp.sugestaoCloser && resp.sugestaoCloser.closerId;
    const opcao = (valor, texto) => {
      const o = document.createElement('option');
      o.value = valor;
      o.textContent = texto;
      sel.appendChild(o);
    };
    opcao('', 'Escolher closer…');
    lista.forEach((c) => opcao(c.id, c.id === sugerido ? c.nome + ' (indicado)' : c.nome));
    const nota = document.createElement('div');
    nota.style.cssText = 'font-size:11px;color:#a39e93;margin-top:4px';
    nota.textContent = sugerido ? resp.motivoSugestao || '' : '';
    sel.addEventListener('change', () => {
      sel.disabled = true;
      nota.style.color = '#a39e93';
      nota.textContent = 'Salvando…';
      const fim = (r) => {
        sel.disabled = false;
        if (r && r.ok) {
          nota.style.color = '#3ddc84';
          nota.textContent = sel.value ? 'Closer salvo: ' + (r.closerNome || '') : 'Closer removido.';
        } else {
          nota.style.color = '#ff6f5c';
          nota.textContent = (r && r.erro) || 'Não consegui salvar o closer.';
        }
      };
      try {
        chrome.runtime.sendMessage({ action: 'definirCloser', reportId: resp.id, closerId: sel.value }, fim);
      } catch (_) {
        fim({ ok: false, erro: 'Recarregue a página (F5) e escolha o closer pelo site.' });
      }
    });
    caixa.appendChild(rotulo);
    caixa.appendChild(sel);
    caixa.appendChild(nota);
    alvo.appendChild(caixa);
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
        cor: '#f2a93b',
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
      mostrarBadge({ texto: escHtml((r && r.erro) || 'Não consegui abrir o report existente.'), cor: '#ff6f5c' });
      return;
    }
    mostrarBadge({
      texto: '<b>Report existente</b> — nenhuma IA foi usada.',
      cor: '#3ddc84',
      arquivo: r.arquivo,
      arquivoBase64: r.arquivoBase64,
    });
  }


  // Quantas mensagens de cada lado. Se a leitura do remetente quebrar (o site mudou a marcação), aparece
  // aqui na hora: "0 suas" numa conversa de 20 mensagens é leitura errada, e o SDR vê antes de mandar.
  const remetenteSuspeito = (s) => !!s && s.total >= 6 && (s.doVendedor === 0 || s.doLead === 0);
  function linhaRemetentes(s) {
    if (!s || !s.total || s.doVendedor == null) return '';
    const base = `<span style="color:#a39e93">${s.total} mensagens · ${s.doVendedor} suas · ${s.doLead} do lead</span><br>`;
    if (!remetenteSuspeito(s)) return base;
    return (
      base +
      '<span style="color:#f2a93b"><b>Confira o report:</b> ' +
      (s.doVendedor === 0 ? 'nenhuma mensagem sua' : 'nenhuma mensagem do lead') +
      ' foi reconhecida. Se estiver errado, copie o console (F12) e mande para o admin.</span><br>'
    );
  }

  let jobEmAndamento = false;

  // "Analisar Match com o closer" (afinidade.js, carregado antes deste arquivo).
  const afinidadeUi = (typeof globalThis !== 'undefined' && globalThis.__crAfinidade) || null;
  /** O closer pedido no popup, conferido: só id e nomes curtos entram no job. */
  const closerPedido = (a) =>
    a && typeof a.id === 'string' && a.id
      ? { id: a.id.slice(0, 40), apelido: String(a.apelido || '').slice(0, 20), nome: String(a.nome || '').slice(0, 80) }
      : null;
  /** Acrescenta ao aviso final a análise de afinidade (se o report foi pedido por esse botão). */
  function anexarAfinidade(closer, resp, mensagens, nome) {
    if (!closer || !afinidadeUi) return;
    afinidadeUi.anexar({ aviso: document.getElementById(BADGE_ID), closer, resp, mensagens, nome });
  }

  async function gerarReportEmBackground(server, opcoes = {}) {
    const closerDaAnalise = closerPedido(opcoes.afinidade);
    if (jobEmAndamento) {
      mostrarBadge({ texto: 'Já existe um report sendo gerado…', cor: '#f2a93b', loading: true });
      return;
    }
    jobEmAndamento = true;
    capturaAtiva = true;
    try {
      // De qual conversa é este report (o SDR pode trocar de conversa enquanto a IA escreve).
      const conversaDoJob = conversaAbertaAgora();
      mostrarBadge({
        texto:
          '<b>Lendo a conversa…</b><br>Capturando e transcrevendo áudios pode demorar um pouco. ' +
          '<u>Não troque de conversa agora</u>.',
        loading: true,
      });
      const { mensagens, nome, stats } = await coletarConversa(server, true);
      if (!mensagens.length) {
        mostrarBadge({ texto: 'Nenhuma mensagem encontrada nesta conversa.', cor: '#ff6f5c' });
        jobEmAndamento = false;
        return;
      }

      // "Analisar Match com o closer" é SÓ a análise: não gera report (não chama a IA paga nem cria report novo).
      // O servidor usa o perfil e o nível de consciência do report que já existir deste lead, se houver.
      if (closerDaAnalise && afinidadeUi) {
        capturaAtiva = false;
        restaurarAudios();
        mostrarBadge({ texto: '<b>Match com ' + escHtml(closerDaAnalise.apelido || closerDaAnalise.nome || 'o closer') + '</b>', cor: '#ffc233' });
        anexarAfinidade(closerDaAnalise, null, mensagens, nome);
        jobEmAndamento = false;
        return;
      }

      const linhaAudio =
        stats.audios > 0
          ? `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#ffc233" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg> ${stats.audios} áudio(s), ${stats.audiosTranscritos} com transcrição` +
            (stats.audiosTranscritos < stats.audios
              ? ' <span style="color:#a39e93">(os demais entram como [áudio])</span>'
              : '')
          : 'Sem áudios nesta conversa';

      mostrarBadge({
        texto:
          `<b>Gerando report…</b> (${stats.total} mensagens)<br>` +
          `${linhaAudio}<br><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#3ddc84" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> Já pode responder outros leads.`,
        loading: true,
      });

      // Como foi a leitura (áudios achados x transcritos): o servidor guarda para o admin ver reports com captura parcial.
      const captureQuality = {
        plataforma: 'whatsapp',
        versao: VERSAO,
        mensagens: stats.total,
        audios: stats.audios,
        audiosTranscritos: stats.audiosTranscritos,
        mensagensVendedor: stats.doVendedor,
        mensagensLead: stats.doLead,
      };
      let resp = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality, vinculo: vinculoDoLead() }, resolve)
      );

      if (!resp || !resp.ok) {
        mostrarBadge({ texto: escHtml((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6f5c' });
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
          // O report já existia: a análise sai da conversa lida agora, e a nota fica nesse report.
          anexarAfinidade(closerDaAnalise, { id: resp.existente && resp.existente.id, dados: null }, mensagens, nome);
          return;
        }
        if (escolha !== 'gerar') {
          mostrarBadge({ texto: 'Geração cancelada — já existe um report igual pra esta conversa.', cor: '#f2a93b' });
          return;
        }
        mostrarBadge({ texto: '<b>Gerando de novo…</b>', loading: true });
        resp = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality, forcarNovo: true, vinculo: vinculoDoLead() }, resolve)
        );
        if (!resp || !resp.ok) {
          mostrarBadge({ texto: escHtml((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6f5c' });
          jobEmAndamento = false;
          return;
        }
      }

      guardarUltimoReport(resp, nome, server);
      // O resumo dos áudios fica no aviso final: o "Gerando report…" some rápido
      // demais para dar tempo de ler, e é a dúvida de sempre — transcreveu ou não?
      const resumoAudio =
        stats.audios === 0
          ? '<span style="color:#a39e93">Sem áudios nesta conversa</span>'
          : stats.audiosTranscritos === stats.audios
            ? `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#ffc233" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg> ${stats.audios} áudio(s) transcrito(s)`
            : stats.audiosTranscritos === 0 && !ganchoInstalado()
              ? // Nenhum capturado E sem gancho: não é áudio difícil, é a página.
                '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#f2a93b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> <b>Recarregue a aba do WhatsApp (F5)</b>' +
                ' <span style="color:#a39e93">e gere de novo — a leitura de áudio não iniciou</span>'
              : `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#f2a93b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> ${stats.audiosTranscritos} de ${stats.audios} áudio(s) transcrito(s)` +
                (stats.audiosTranscritos === 0
                  ? ' <span style="color:#a39e93">— o WhatsApp não entregou os arquivos de áudio (áudios antigos costumam expirar); entraram como [áudio]</span>'
                  : ' <span style="color:#a39e93">— o resto entrou como [áudio]</span>');

      mostrarBadge({
        texto: `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#3ddc84" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> <b>Report pronto!</b> (${escHtml(nome || 'lead')})<br>${linhaRemetentes(stats)}${resumoAudio}`,
        arquivo: resp.arquivo,
        server,
        arquivoBase64: resp.arquivoBase64,
      });
      anexarEscolhaDeCloser(resp);
      anexarAfinidade(closerDaAnalise, resp, mensagens, nome);
      // Report gerado = lead qualificado: a etiqueta entra no cartão. E a leitura completa (com os áudios
      // transcritos) pode trazer o agendamento que não estava em texto.
      if (ficha.automacao && conversaDoJob) {
        enviarMarca(conversaDoJob, { qualificado: true, origem: 'report' });
        anotarAgendamento(mensagens, conversaDoJob);
      }
    } catch (e) {
      mostrarBadge({ texto: escHtml(e.message), cor: '#ff6f5c' });
    } finally {
      jobEmAndamento = false;
      capturaAtiva = false;
      restaurarAudios();
    }
  }

  // ---------------------------------------------------------------------------
  // Ficha do lead (RD Station CRM): ao abrir uma conversa, um cartão no canto mostra a negociação
  // do lead — etapa, funil, responsável e as respostas do formulário (Profissão, Estado,
  // Investimento...) — para prospectar sem trocar de aba. Liga/desliga no popup da extensão.
  // Tudo que vem do CRM entra na tela como TEXTO (textContent), nunca como HTML.
  // ---------------------------------------------------------------------------
  const FICHA_ID = 'cr-ficha-crm';

  // Aberto pelo botão de WhatsApp do card no RD (web.whatsapp.com/send?phone=5511...): o número do lead vem
  // no link. Vale mesmo para contato salvo com nome — mas só para a conversa que o link abriu (o endereço
  // não muda quando o SDR troca de conversa depois).
  const telefoneDoLink = (() => {
    try {
      return (new URLSearchParams(location.search).get('phone') || '').replace(/\D/g, '');
    } catch (_) {
      return '';
    }
  })();
  let conversaDoLink = null; // nome no cabeçalho da conversa que o link abriu

  // Contato salvo com nome: o topo da conversa não mostra o número, mas o painel "Dados do contato"
  // (clicar no nome) mostra. Quando ele está aberto, lemos o número e guardamos para essa conversa
  // (só na memória desta aba), para as próximas vezes que ela for aberta.
  const telefonesPorNome = new Map();
  let leituraAnterior = null; // { nome, telefone } do tick passado: só aceita quando repete (evita troca de conversa no meio)

  /** Número do painel "Dados do contato" aberto (fora da lista de conversas e da conversa). Vários números diferentes (grupo) = nenhum. */
  function telefoneDoPainelDoContato() {
    const achados = new Map(); // 8 últimos dígitos -> número completo
    for (const s of document.querySelectorAll('span[dir="auto"], span.selectable-text, span[title], div[title]')) {
      if (s.closest('#pane-side, #main, #' + FICHA_ID + ', #cr-coach, #closer-report-badge, [contenteditable="true"]')) continue;
      const t = (s.getAttribute('title') || s.textContent || '').trim();
      if (!/^\+\d{1,3}[\d\s().-]{8,20}$/.test(t)) continue;
      const d = t.replace(/\D/g, '');
      achados.set(d.slice(-8), d);
      if (achados.size > 1) return '';
    }
    return achados.size === 1 ? [...achados.values()][0] : '';
  }
  const ficha = {
    ligada: true, minimizada: false, chave: null, fechadaPara: null, seq: 0, timer: null, vigia: null, ultimoEstado: null, coach: false,
    pos: null, // { left, top } quando o usuário arrastou o cartão; null = lugar padrão
    automacao: false, // o master ligou a automação para esta chave (mover para "Respondeu", etiqueta e agendamento)
    etiquetas: false, // o master ligou as etiquetas do formulário (investimento e se já vende)
    conversa: null, // { telefone, nome } da conversa aberta: é por ela que o servidor lembra a etiqueta
  };
  /**
   * O vínculo do report com o lead no RD: o que o cartão aberto sabe — id do contato e do card, e-mail e
   * telefone. O servidor guarda isso no report e é por aí que depois puxa o resultado da reunião (o nome
   * do contato no WhatsApp não serve para achar o card). Sem cartão na tela, vai só o telefone da conversa.
   */
  function vinculoDoLead() {
    const est = ficha.ultimoEstado;
    const f = est && est.ficha && typeof est.ficha === 'object' ? est.ficha : null;
    const escolhido = f ? (f.negociacoes || []).find((c) => c && c.escolhida) : null;
    return {
      telefone: String((ficha.conversa && ficha.conversa.telefone) || (f && (f.telefones || [])[0]) || ''),
      email: String((f && (f.emails || [])[0]) || ''),
      contatoId: String((f && f.contatoId) || ''),
      dealId: String((escolhido && escolhido.id) || ''),
    };
  }
  // Leitura do agendamento e do "lead respondeu" (agenda.js, carregado antes deste arquivo).
  const agendaLib = (typeof globalThis !== 'undefined' && globalThis.__crAgenda) || null;
  const auto = { assinatura: '', tentados: new Set() };
  // Resumo rápido por conversa (só na memória desta aba): some ao recarregar o WhatsApp.
  const resumos = new Map();
  const coaches = new Map(); // coach da conversa, por conversa (só na memória desta aba)
  const marcados = new Set(); // sugestões já marcadas "funcionou"/"não ajudou" nesta aba
  const audiosLidos = new Map(); // data-id da mensagem -> transcrição feita numa leitura completa (só nesta aba)

  /** Telefone da conversa aberta: o cabeçalho (contato não salvo mostra o número) ou o id do chat no data-id. */
  function telefoneDaConversa() {
    const header = document.querySelector('#main header');
    if (header) {
      for (const s of header.querySelectorAll('span[title], span[dir="auto"]')) {
        const t = (s.getAttribute('title') || s.textContent || '').trim();
        if (/^\+?[\d\s().-]{10,22}$/.test(t)) return t.replace(/\D/g, '');
      }
    }
    const main = document.querySelector('#main');
    if (main) {
      for (const el of main.querySelectorAll('[data-id]')) {
        const m = /(\d{10,15})@c\.us/.exec(el.getAttribute('data-id') || '');
        if (m) return m[1];
      }
    }
    return '';
  }

  /** Cria um elemento com estilo e filhos; string vira nó de TEXTO (dado do CRM nunca vira HTML). */
  function elem(tag, estilo, ...filhos) {
    const e = document.createElement(tag);
    if (estilo) e.style.cssText = estilo;
    filhos.flat().forEach((f) => {
      if (f == null || f === false) return;
      e.appendChild(typeof f === 'string' ? document.createTextNode(f) : f);
    });
    return e;
  }
  const botaoFicha = (rotulo, aoClicar, destaque) => {
    const b = elem(
      'button',
      `cursor:pointer;border:0;border-radius:6px;padding:5px 9px;font-weight:600;font-size:12px;line-height:1.2;font-family:inherit;${destaque ? 'background:#ffc233;color:#18171b' : 'background:#3a373f;color:#f3efe6'}`,
      rotulo
    );
    b.type = 'button';
    b.addEventListener('click', aoClicar);
    return b;
  };
  const linhaCampo = (rotulo, valor, forte) =>
    elem(
      'div',
      'margin:5px 0',
      elem('div', 'font-size:10.5px;color:#a39e93;text-transform:uppercase;letter-spacing:.1em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif', rotulo),
      elem('div', `color:${forte ? '#ffc233' : '#f3efe6'};font-weight:${forte ? 700 : 500};word-break:break-word`, valor)
    );

  function posicionarFicha() {
    const el = document.getElementById(FICHA_ID);
    const main = document.querySelector('#main');
    if (!el) return;
    if (ficha.pos) {
      // Onde o usuário deixou, sem sair da janela.
      const dentro = (v, max) => Math.max(4, Math.min(Number(v) || 0, Math.max(4, max)));
      el.style.right = 'auto';
      el.style.left = dentro(ficha.pos.left, window.innerWidth - 120) + 'px';
      el.style.top = dentro(ficha.pos.top, window.innerHeight - 60) + 'px';
      return;
    }
    el.style.left = 'auto';
    if (!main) return;
    const r = main.getBoundingClientRect();
    if (!r || r.width < 320) {
      el.style.right = '16px';
      el.style.top = '70px';
      return;
    }
    el.style.right = Math.max(8, Math.round(window.innerWidth - r.right + 16)) + 'px';
    el.style.top = Math.max(8, Math.round(r.top + 70)) + 'px';
    el.style.width = Math.min(290, Math.round(r.width - 40)) + 'px';
  }

  function esconderFicha() {
    const el = document.getElementById(FICHA_ID);
    if (el) el.remove();
  }

  function formBusca() {
    const input = elem('input', 'flex:1;min-width:0;background:#121113;border:1px solid #3a373f;border-radius:7px;color:#f3efe6;padding:5px 8px;font-size:12px;font-family:inherit');
    input.placeholder = 'Telefone ou nome no RD';
    const buscar = () => {
      const v = input.value.trim();
      if (!v) return;
      const digitos = v.replace(/\D/g, '');
      consultarFicha(digitos.length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(v) ? { telefone: digitos } : { nome: v });
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') buscar();
    });
    return elem('div', 'display:flex;gap:6px;margin-top:10px', input, botaoFicha('Buscar', buscar));
  }

  const redesenharFicha = () => {
    if (ficha.ultimoEstado && document.getElementById(FICHA_ID)) renderFicha(ficha.ultimoEstado);
  };

  /**
   * Resumo rápido: lê a conversa aberta (inclusive transcrevendo os áudios, no mudo) e pede à IA o
   * cenário, onde parou, a última pergunta e o próximo passo. Não roda junto com um report.
   */
  async function pedirResumoRapido() {
    const chave = ficha.chave;
    if (!chave) return;
    if (jobEmAndamento) {
      resumos.set(chave, { tipo: 'erro', erro: 'Espere o report terminar para pedir o resumo.' });
      return redesenharFicha();
    }
    jobEmAndamento = true;
    capturaAtiva = true;
    resumos.set(chave, { tipo: 'carregando' });
    redesenharFicha();
    const badgeAntes = !!document.getElementById(BADGE_ID);
    try {
      const conversa = ficha.conversa;
      const { mensagens, nome } = await coletarConversa('ficha', true);
      anotarAgendamento(mensagens, conversa); // a leitura completa (com áudios) pode trazer o agendamento
      const r = await new Promise((res) => chrome.runtime.sendMessage({ action: 'resumoRapido', mensagens, nome }, res));
      if (!r || !r.ok) throw new Error((r && r.erro) || 'Não consegui gerar o resumo.');
      resumos.set(chave, { tipo: 'ok', dados: r.resumo });
    } catch (e) {
      resumos.set(chave, { tipo: 'erro', erro: e.message || 'Não consegui gerar o resumo.' });
    } finally {
      jobEmAndamento = false;
      capturaAtiva = false;
      restaurarAudios();
      // A leitura usa o aviso do report para o andamento ("Transcrevendo áudios…"): tira ao terminar.
      const b = document.getElementById(BADGE_ID);
      if (b && !badgeAntes) b.remove();
      if (ficha.chave === chave) redesenharFicha();
    }
  }

  // ---------------------------------------------------------------------------
  // Coach da conversa: um popup próprio, separado do cartão da ficha. Só trabalha quando o usuário
  // clica: "Pedir dica" lê as mensagens que já estão na tela (sem rolar a conversa nem tocar áudio);
  // "Ler conversa inteira" faz a leitura completa, com os áudios transcritos — e as transcrições ficam
  // lembradas nesta aba para as próximas dicas. Só para quem o master liberou o Coach.
  // ---------------------------------------------------------------------------
  const COACH_ID = 'cr-coach';
  const coachUi = { minimizado: false, detalhes: false, pos: null, fechadoPara: null, emCurso: false };

  const mensagensNaTela = () => acharMensagens(document.querySelector('#main') || document);
  /** Até onde a conversa foi lida: a última mensagem na tela. Chegou mensagem nova, muda. */
  const assinaturaDaTela = (els) => {
    const ultimo = els.length ? els[els.length - 1] : null;
    return [ficha.chave, ultimo ? ultimo.getAttribute('data-id') || (ultimo.textContent || '').length : ''].join('|');
  };
  const audiosDoLeadSemLer = (mensagens) =>
    mensagens.filter((m) => m.from !== 'eu' && m.type === 'audio' && String(m.content || '').startsWith('[áudio')).length;

  /** "Pedir dica": lê o que já está na tela (leitura leve: não rola a conversa nem toca áudio). */
  function pedirDica() {
    const chave = ficha.chave;
    if (!chave || coachUi.emCurso) return;
    const anterior = coaches.get(chave);
    const tinha = anterior && anterior.tipo === 'ok' ? anterior : null;
    const falhou = (erro) => coaches.set(chave, tinha ? { ...tinha, atualizando: false, erro } : { tipo: 'erro', erro });
    if (jobEmAndamento) {
      falhou('Espere o report ou o resumo terminarem.');
      return renderCoach();
    }
    const els = mensagensNaTela();
    const assinatura = assinaturaDaTela(els);
    const mensagens = mensagensVisiveis(els).filter((m) => m.content);
    if (!mensagens.length) {
      falhou('Ainda não há mensagens nesta conversa para analisar.');
      return renderCoach();
    }
    const nome = nomeDoContato();
    coachUi.emCurso = true;
    coaches.set(chave, tinha ? { ...tinha, atualizando: true, erro: '' } : { tipo: 'carregando' });
    renderCoach();
    const fim = (r) => {
      coachUi.emCurso = false;
      if (r && r.ok && r.coach) {
        coaches.set(chave, { tipo: 'ok', dados: r.coach, contexto: nome || '', assinatura, quando: Date.now(), audiosSemLer: audiosDoLeadSemLer(mensagens) });
      } else {
        falhou((r && r.erro) || 'Não consegui gerar a dica.');
      }
      if (ficha.chave === chave) renderCoach();
    };
    try {
      chrome.runtime.sendMessage(
        {
          action: 'coach',
          mensagens: mensagens.map(({ from, type, content, timestamp }) => ({ from, type: type === 'audio' ? 'audio' : 'texto', content, timestamp })),
          nome,
        },
        (r) => fim(chrome.runtime.lastError ? null : r)
      );
    } catch (_) {
      fim({ ok: false, erro: 'A extensão foi atualizada: recarregue a página (F5).' });
    }
  }

  /** "Ler conversa inteira": rola a conversa e transcreve os áudios (no mudo), como no report. */
  async function lerConversaInteira() {
    const chave = ficha.chave;
    if (!chave || coachUi.emCurso) return;
    const anterior = coaches.get(chave);
    const tinha = anterior && anterior.tipo === 'ok' ? anterior : null;
    const falhou = (erro) => coaches.set(chave, tinha ? { ...tinha, atualizando: false, erro } : { tipo: 'erro', erro });
    if (jobEmAndamento) {
      falhou('Espere o report ou o resumo terminarem.');
      return renderCoach();
    }
    coachUi.emCurso = true;
    jobEmAndamento = true;
    capturaAtiva = true;
    try {
      coaches.set(chave, { tipo: 'lendo' });
      renderCoach();
      const badgeAntes = !!document.getElementById(BADGE_ID);
      try {
        const conversa = ficha.conversa;
        const { mensagens, nome } = await coletarConversa('ficha', true);
        anotarAgendamento(mensagens, conversa);
        const r = await new Promise((res) => chrome.runtime.sendMessage({ action: 'coach', mensagens, nome }, res));
        if (!r || !r.ok) throw new Error((r && r.erro) || 'Não consegui gerar a dica.');
        coaches.set(chave, {
          tipo: 'ok', dados: r.coach, contexto: nome || '', assinatura: assinaturaDaTela(mensagensNaTela()), quando: Date.now(),
          audiosSemLer: audiosDoLeadSemLer(mensagens),
        });
      } finally {
        // A leitura usa o aviso do report para o andamento ("Transcrevendo áudios…"): tira ao terminar.
        const b = document.getElementById(BADGE_ID);
        if (b && !badgeAntes) b.remove();
      }
    } catch (e) {
      falhou(e.message || 'Não consegui gerar a dica.');
    } finally {
      jobEmAndamento = false;
      capturaAtiva = false;
      restaurarAudios();
      coachUi.emCurso = false;
      if (ficha.chave === chave) renderCoach();
    }
  }

  /**
   * A cada tique do vigia: mantém o popup na tela e no lugar, e avisa quando chegaram mensagens depois
   * da dica. Não pede nada sozinho — a dica só é pedida no clique.
   */
  function vigiarCoach() {
    if (!ficha.coach || !ficha.chave) return;
    if (!document.getElementById(COACH_ID)) return renderCoach();
    posicionarCoach();
    const r = coaches.get(ficha.chave);
    if (!r || r.tipo !== 'ok' || r.desatualizada || coachUi.emCurso || jobEmAndamento) return;
    const els = mensagensNaTela();
    if (els.length && r.assinatura !== assinaturaDaTela(els)) {
      r.desatualizada = true;
      renderCoach();
    }
  }

  function enviarFeedbackCoach(tipo, textoSugestao, contexto, util, botaoEl) {
    const id = tipo + '|' + textoSugestao;
    if (marcados.has(id)) return;
    marcados.add(id);
    if (botaoEl) {
      botaoEl.disabled = true;
      botaoEl.textContent = util ? 'Anotado, vou lembrar' : 'Anotado';
    }
    try {
      chrome.runtime.sendMessage({ action: 'coachFeedback', tipo, texto: textoSugestao, contexto, util }, () => {});
    } catch (_) {
      /* extensão recarregada: sem aprendizado desta vez */
    }
  }

  function posicionarCoach() {
    const el = document.getElementById(COACH_ID);
    if (!el) return;
    if (coachUi.pos) {
      // Onde o usuário deixou, sem sair da janela.
      const dentro = (v, max) => Math.max(4, Math.min(Number(v) || 0, Math.max(4, max)));
      el.style.left = dentro(coachUi.pos.left, window.innerWidth - 120) + 'px';
      el.style.top = dentro(coachUi.pos.top, window.innerHeight - 60) + 'px';
      return;
    }
    // Padrão: na borda esquerda da conversa — o lado oposto ao da ficha do RD.
    const main = document.querySelector('#main');
    const r = main && main.getBoundingClientRect();
    if (!r || r.width < 320) {
      el.style.left = '16px';
      el.style.top = '70px';
      return;
    }
    el.style.left = Math.max(8, Math.round(r.left + 16)) + 'px';
    el.style.top = Math.max(8, Math.round(r.top + 70)) + 'px';
    el.style.width = Math.min(300, Math.round(r.width - 40)) + 'px';
  }

  /** Os pontinhos no canto do topo: avisam que o popup pode ser arrastado. */
  const pegador = () => elem('span', 'flex:none;color:#a39e93;font-size:14px;line-height:1;letter-spacing:-1px', '⠿');

  /**
   * Arrastar pelo topo muda o popup de lugar (fica guardado); duplo clique devolve ao lugar padrão.
   * `dono` é quem guarda a posição (ficha ou coachUi), `chave` o nome no storage e `posicionar` reaplica na tela.
   */
  function tornarArrastavel(el, alca, { dono, chave, posicionar }) {
    alca.style.cursor = 'move';
    const guardar = () => {
      try {
        chrome.storage.local.set({ [chave]: dono.pos });
      } catch (_) {
        /* sem storage: vale só nesta aba */
      }
    };
    alca.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const r = el.getBoundingClientRect();
      const dx = ev.clientX - r.left;
      const dy = ev.clientY - r.top;
      const mover = (e) => {
        dono.pos = { left: Math.round(e.clientX - dx), top: Math.round(e.clientY - dy) };
        posicionar();
      };
      const soltar = () => {
        document.removeEventListener('mousemove', mover);
        document.removeEventListener('mouseup', soltar);
        if (dono.pos) guardar();
      };
      document.addEventListener('mousemove', mover);
      document.addEventListener('mouseup', soltar);
      ev.preventDefault();
    });
    alca.addEventListener('dblclick', () => {
      dono.pos = null;
      guardar();
      posicionar();
    });
  }

  function renderCoach() {
    let el = document.getElementById(COACH_ID);
    if (!ficha.ligada || !ficha.coach || !ficha.chave || coachUi.fechadoPara === ficha.chave || !document.querySelector('#main')) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = COACH_ID;
      // Fora do #main, como a ficha: a leitura da conversa nunca confunde o popup com mensagem.
      el.style.cssText = [
        'position:fixed', 'top:70px', 'left:16px', 'z-index:2147483645', 'width:300px',
        'max-height:calc(100vh - 150px)', 'overflow:auto', 'background:#1a191c', 'color:#f3efe6',
        'border:1px solid #3a373f', 'border-top:3px solid #3ddc84', 'border-radius:12px', 'padding:11px 13px 12px',
        'font:13px/1.4 Segoe UI Variable Text,Segoe UI,system-ui,-apple-system,Roboto,sans-serif', 'box-shadow:0 14px 34px rgba(0,0,0,.5)',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = '';
    posicionarCoach();

    const r = coaches.get(ficha.chave);
    const d = (r && r.tipo === 'ok' && r.dados) || null;
    const hora = d ? new Date(r.quando || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';

    // Topo: título (é por ele que se arrasta), minimizar e fechar.
    const btnMin = botaoFicha(coachUi.minimizado ? '+' : '–', () => {
      coachUi.minimizado = !coachUi.minimizado;
      try {
        chrome.storage.local.set({ coachMinimizado: coachUi.minimizado });
      } catch (_) {
        /* ok */
      }
      renderCoach();
    });
    btnMin.title = coachUi.minimizado ? 'Abrir o coach' : 'Minimizar';
    const btnX = botaoFicha('×', () => {
      coachUi.fechadoPara = ficha.chave; // só nesta conversa; volta na próxima
      renderCoach();
    });
    btnX.title = 'Fechar nesta conversa';
    const alca = elem(
      'div',
      'flex:1;min-width:0;user-select:none;display:flex;align-items:center;gap:6px',
      pegador(),
      elem(
        'div',
        'flex:1;min-width:0',
        elem('div', 'font-size:10.5px;color:#3ddc84;font-weight:600;letter-spacing:.14em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif', 'COACH'),
        elem('div', 'font-size:11px;color:#a39e93', d ? 'dica de ' + hora : 'dica quando você pedir')
      )
    );
    alca.title = 'Arraste para mudar de lugar (duplo clique volta ao lugar padrão)';
    tornarArrastavel(el, alca, { dono: coachUi, chave: 'coachPos', posicionar: posicionarCoach });
    el.appendChild(elem('div', 'display:flex;align-items:center;gap:6px', alca, btnMin, btnX));

    const agora = d ? d.agora || d.comoAbordar : '';
    const caixaAgora = () =>
      elem(
        'div',
        'margin-top:8px;background:#121113;border:1px solid #3a373f;border-top:2px solid #3ddc84;border-radius:8px;padding:7px 9px',
        elem('div', 'font-size:10.5px;color:#3ddc84;font-weight:600;letter-spacing:.14em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif', 'AGORA'),
        elem('div', '', agora)
      );
    if (coachUi.minimizado) {
      if (agora) el.appendChild(caixaAgora()); // minimizado: só a dica do momento
      return;
    }

    const corpo = elem('div', 'margin-top:2px');
    el.appendChild(corpo);
    const nota = (t, cor) => elem('div', `margin-top:8px;font-size:12px;color:${cor || '#a39e93'}`, t);
    const controles = (rotuloPedir) => {
      const linha = elem('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px');
      const mini = (b) => {
        b.style.cssText += ';padding:4px 8px;font-size:11.5px';
        return b;
      };
      const pedir = mini(botaoFicha(rotuloPedir, pedirDica, true));
      pedir.title = 'Lê as mensagens que estão na tela (não rola a conversa nem toca áudio).';
      linha.appendChild(pedir);
      const inteira = mini(botaoFicha('Ler conversa inteira', lerConversaInteira));
      inteira.title = 'Rola a conversa e transcreve os áudios (no mudo). Não troque de conversa enquanto lê.';
      linha.appendChild(inteira);
      return linha;
    };

    if (!r) {
      corpo.appendChild(nota('Peça a dica de como seguir nesta conversa: perfil do lead, o que fazer agora e a próxima mensagem.'));
      corpo.appendChild(controles('Pedir dica'));
      return;
    }
    if (r.tipo === 'carregando') return void corpo.appendChild(nota('Lendo as últimas mensagens…'));
    if (r.tipo === 'lendo') return void corpo.appendChild(nota('Lendo a conversa inteira e os áudios… não troque de conversa.'));
    if (r.tipo === 'erro') {
      corpo.appendChild(nota(r.erro, '#ff6f5c'));
      corpo.appendChild(controles('Tentar de novo'));
      return;
    }

    // Dica pronta: o que fazer agora e a mensagem para mandar; a análise completa fica recolhida.
    const util = (tipo, textoSug, contexto) => {
      const b = botaoFicha(marcados.has(tipo + '|' + textoSug) ? 'Anotado' : 'Funcionou', () => enviarFeedbackCoach(tipo, textoSug, contexto, true, b));
      b.style.cssText += ';margin-top:4px;padding:3px 7px;font-size:11px';
      if (marcados.has(tipo + '|' + textoSug)) b.disabled = true;
      return b;
    };
    const rotulo = (t) => elem('div', 'font-size:10.5px;color:#a39e93;text-transform:uppercase;letter-spacing:.1em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif;margin-top:8px', t);
    const perfil = d.perfil && d.perfil.tipo;
    if (agora) corpo.appendChild(caixaAgora());
    if (d.proximaMensagem) {
      corpo.appendChild(rotulo('Próxima mensagem'));
      corpo.appendChild(elem('div', 'white-space:pre-wrap;background:#121113;border:1px solid #3a373f;border-radius:7px;padding:6px 8px;margin-top:2px', d.proximaMensagem));
      const copiar = botaoFicha('Copiar', async () => {
        try {
          await navigator.clipboard.writeText(d.proximaMensagem);
          copiar.textContent = 'Copiado';
        } catch (_) {
          copiar.textContent = 'Selecione e copie';
        }
      });
      copiar.style.cssText += ';margin:4px 6px 0 0;padding:3px 7px;font-size:11px';
      corpo.appendChild(copiar);
      corpo.appendChild(util('mensagem', d.proximaMensagem, perfil));
    }
    if (perfil) {
      corpo.appendChild(elem('div', 'margin-top:8px', elem('span', 'color:#a39e93', 'Perfil do lead: '), elem('span', 'color:#ffc233;font-weight:700;text-transform:capitalize', perfil)));
    }

    const det = document.createElement('details');
    det.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid #3a373f';
    det.open = coachUi.detalhes;
    det.addEventListener('toggle', () => {
      coachUi.detalhes = det.open;
    });
    det.appendChild(elem('summary', 'cursor:pointer;color:#a39e93;font-size:12px', 'Análise completa'));
    if (d.perfil && d.perfil.evidencia) det.appendChild(elem('div', 'font-size:12px;color:#d5d0c5;margin-top:6px', d.perfil.evidencia));
    if (d.comoAbordar) {
      det.appendChild(rotulo('Como abordar'));
      det.appendChild(elem('div', '', d.comoAbordar));
      det.appendChild(util('abordagem', d.comoAbordar, perfil));
    }
    if ((d.faltaLevantar || []).length) {
      det.appendChild(rotulo('Ainda falta levantar'));
      d.faltaLevantar.forEach((f) => det.appendChild(elem('div', 'margin-top:2px', '• ' + f)));
    }
    (d.objecoes || []).forEach((o) => {
      det.appendChild(rotulo('Objeção: ' + o.objecao));
      det.appendChild(elem('div', 'white-space:pre-wrap', o.resposta));
      det.appendChild(util('objecao', o.resposta, o.objecao));
    });
    if ((d.perguntas || []).length) {
      det.appendChild(rotulo('Perguntas para aprofundar'));
      d.perguntas.forEach((p) => {
        det.appendChild(elem('div', 'margin-top:4px', '• ' + p));
        det.appendChild(util('pergunta', p, perfil));
      });
    }
    corpo.appendChild(det);

    if (r.erro) corpo.appendChild(nota(r.erro, '#ff6f5c'));
    else if (r.atualizando) corpo.appendChild(nota('Atualizando a dica…'));
    else if (r.desatualizada) corpo.appendChild(nota('Chegaram mensagens depois desta dica. Clique em Atualizar para ver a nova.', '#f2a93b'));
    if (r.audiosSemLer) {
      corpo.appendChild(nota(`${r.audiosSemLer} áudio(s) do lead ainda sem leitura: "Ler conversa inteira" transcreve.`, '#f2a93b'));
    }
    corpo.appendChild(controles('Atualizar'));
  }

  function blocoResumo() {
    const r = resumos.get(ficha.chave);
    const caixa = elem('div', 'margin:2px 0 10px;padding:8px 10px;background:#121113;border:1px solid #3a373f;border-radius:8px');
    const titulo = (t) => elem('div', 'font-size:10.5px;color:#ffc233;font-weight:600;letter-spacing:.14em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif;margin-bottom:4px', t);
    if (!r) {
      caixa.appendChild(botaoFicha('Resumo rápido da conversa', pedirResumoRapido, true));
      caixa.appendChild(elem('div', 'font-size:11px;color:#a39e93;margin-top:5px', 'Lê a conversa e os áudios (no mudo) e mostra o cenário e onde parou.'));
      return caixa;
    }
    if (r.tipo === 'carregando') {
      caixa.appendChild(titulo('RESUMO RÁPIDO'));
      caixa.appendChild(elem('div', 'color:#a39e93', 'Lendo a conversa e os áudios… não troque de conversa.'));
      return caixa;
    }
    if (r.tipo === 'erro') {
      caixa.appendChild(titulo('RESUMO RÁPIDO'));
      caixa.appendChild(elem('div', 'color:#ff6f5c;margin-bottom:6px', r.erro));
      caixa.appendChild(botaoFicha('Tentar de novo', pedirResumoRapido));
      return caixa;
    }
    const d = r.dados || {};
    caixa.appendChild(titulo('RESUMO RÁPIDO'));
    if (d.cenario) caixa.appendChild(elem('div', 'margin-bottom:6px', d.cenario));
    const item = (rotulo, valor, forte) =>
      valor
        ? elem('div', 'margin-top:5px',
            elem('div', 'font-size:10.5px;color:#a39e93;text-transform:uppercase;letter-spacing:.1em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif', rotulo),
            elem('div', `color:${forte ? '#ffc233' : '#f3efe6'};font-weight:${forte ? 700 : 500}`, valor))
        : null;
    [item('Onde parou', d.peQueParou, true), item('Última pergunta', d.ultimaPergunta), item('Próximo passo', d.proximoPasso)]
      .filter(Boolean)
      .forEach((x) => caixa.appendChild(x));
    const meta = [d.aguardando === 'voce' ? 'Você deve responder' : d.aguardando === 'lead' ? 'Aguardando o lead' : '', d.ultimaMensagem ? 'última mensagem ' + d.ultimaMensagem : '']
      .filter(Boolean)
      .join(' · ');
    const rodape = elem('div', 'display:flex;align-items:center;gap:8px;margin-top:8px');
    if (meta) rodape.appendChild(elem('div', 'flex:1;font-size:11px;color:#a39e93', meta));
    const atualizar = botaoFicha('Atualizar', pedirResumoRapido);
    atualizar.title = 'Ler a conversa de novo (se chegaram mensagens novas)';
    rodape.appendChild(atualizar);
    caixa.appendChild(rodape);
    return caixa;
  }

  // ---------------------------------------------------------------------------
  // Automação do cartão (só para quem o master ligou em Acessos): o card avança para "Respondeu" no RD
  // quando o lead responde, e o cartão mostra a etiqueta "Qualificado" e o dia/horário agendado.
  // A leitura é local e leve (mensagens que já estão na tela); para o servidor vai só o resultado.
  // ---------------------------------------------------------------------------
  const chaveDaConversa = (c) => (c ? c.telefone || c.nome : '');

  /** Mensagens que já estão na tela, sem rolar a conversa nem tocar áudio. */
  function mensagensVisiveis(els) {
    const out = [];
    for (const el of els) {
      try {
        if (ehAudio(el)) {
          // Áudio que uma leitura completa já transcreveu nesta aba entra com o texto; senão, como [áudio].
          const idEl = el.matches('[data-id]') ? el : el.closest('[data-id]') || el.querySelector('[data-id]');
          const lido = idEl ? audiosLidos.get(idEl.getAttribute('data-id')) : '';
          out.push({ from: ehDeMim(el) ? 'eu' : 'eles', type: 'audio', content: lido || '[áudio]', timestamp: null });
          continue;
        }
        // Foto ou figurinha também contam como "alguém falou" — só não têm texto para ler.
        out.push(extrairMensagem(el) || { from: ehDeMim(el) ? 'eu' : 'eles', type: 'outro', content: '', timestamp: null });
      } catch (_) {
        /* mensagem que não deu para ler: fica de fora */
      }
    }
    return out;
  }

  /** Guarda a etiqueta/agendamento no servidor e atualiza o cartão se a conversa aberta ainda for a mesma. */
  function enviarMarca(conversa, campos) {
    if (!conversa) return;
    try {
      chrome.runtime.sendMessage({ action: 'leadMarca', telefone: conversa.telefone, nome: conversa.nome, ...campos }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok || !r.marca) return;
        if (ficha.chave === chaveDaConversa(conversa) && ficha.ultimoEstado) {
          ficha.ultimoEstado.marca = r.marca;
          redesenharFicha();
        }
      });
    } catch (_) {
      /* extensão recarregada: fica para a próxima vez que a conversa abrir */
    }
  }

  /** Achou na conversa um agendamento mais novo que o anotado? Mostra na hora e guarda. */
  function anotarAgendamento(mensagens, conversa) {
    if (!ficha.automacao || !agendaLib || !conversa) return;
    const achado = agendaLib.detectarAgendamento(mensagens, new Date());
    if (!achado) return;
    const est = ficha.chave === chaveDaConversa(conversa) ? ficha.ultimoEstado : null;
    const marca = (est && est.marca) || {};
    // A mensagem de onde saiu (ou uma mais nova) já foi anotada — ou o usuário apagou o agendamento dela.
    if ((typeof marca.agendaFonteTs === 'number' ? marca.agendaFonteTs : -1) >= achado.fonteTs) return;
    if (est && est.tipo !== 'carregando') {
      est.marca = { ...marca, agendadoPara: achado.quando, agendaFonteTs: achado.fonteTs };
      redesenharFicha();
    }
    enviarMarca(conversa, { agendadoPara: achado.quando, fonteTs: achado.fonteTs, regra: agendaLib.REGRA });
  }

  /** Lead respondeu e o card ainda está antes de "Respondeu": pede ao servidor para avançar no RD (uma vez por card). */
  function avancarParaRespondeu(est, mensagens) {
    if (est.tipo !== 'ok' || !est.podeResponder || !agendaLib || !agendaLib.leadRespondeu(mensagens)) return;
    const card = ((est.ficha && est.ficha.negociacoes) || []).find((c) => c.escolhida);
    if (!card || !card.id || auto.tentados.has(card.id)) return;
    auto.tentados.add(card.id);
    const b = est.busca || {};
    try {
      chrome.runtime.sendMessage({ action: 'crmRespondeu', telefone: b.telefone || '', nome: b.nome || '', contatoId: b.contatoId || '', dealId: card.id }, (r) => {
        if (chrome.runtime.lastError || !r) return;
        est.podeResponder = false;
        if (r.ok && r.movido) {
          if (est.ficha.negociacao) est.ficha.negociacao.etapa = r.para;
          card.etapa = r.para;
          est.aviso = { texto: `Movido para "${r.para}" no RD.` };
        } else if (!r.ok) {
          est.aviso = { erro: true, texto: 'Não movi o card para "Respondeu": ' + (r.erro || 'o servidor não respondeu.') };
        } else {
          return; // o card já estava adiante (ou o funil não tem essa etapa): nada a mostrar
        }
        if (ficha.ultimoEstado === est) redesenharFicha();
      });
    } catch (_) {
      /* extensão recarregada */
    }
  }

  /** Roda a cada tique do vigia, mas só trabalha quando as mensagens na tela mudaram. */
  function automatizar() {
    const est = ficha.ultimoEstado;
    if (!ficha.automacao || !agendaLib || !est || est.tipo === 'carregando' || jobEmAndamento) return;
    const els = acharMensagens(document.querySelector('#main') || document);
    const ultimo = els.length ? els[els.length - 1] : null;
    const assinatura = [ficha.seq, els.length, ultimo ? ultimo.getAttribute('data-id') || (ultimo.textContent || '').length : ''].join('|');
    if (assinatura === auto.assinatura) return;
    auto.assinatura = assinatura;
    const mensagens = mensagensVisiveis(els);
    avancarParaRespondeu(est, mensagens);
    anotarAgendamento(mensagens, ficha.conversa);
    anotarAtividade(mensagens, ficha.conversa);
  }

  // ---------------------------------------------------------------------------
  // Report automático: a contagem do dia (leads novos, respostas, recontatos). Daqui sai só o que se viu
  // na conversa hoje — escrevi, já havia mensagens de antes, o lead escreveu —, nunca o texto.
  // ---------------------------------------------------------------------------
  const atividadeEnviada = new Map(); // conversa|dia -> o que já foi avisado
  /** O que a conversa mostra de hoje. null quando nenhuma mensagem tem data (não dá para dizer o dia). */
  function atividadeDeHoje(mensagens, agora) {
    const datas = [];
    let ultima = null;
    for (const m of mensagens) {
      const t = m && m.timestamp ? Date.parse(m.timestamp) : NaN;
      if (Number.isFinite(t)) ultima = t;
      datas.push(ultima); // áudio e foto não têm hora: valem a da mensagem de antes
    }
    let proxima = null;
    for (let i = datas.length - 1; i >= 0; i--) {
      if (datas[i] !== null) proxima = datas[i];
      else datas[i] = proxima; // as primeiras, sem hora, valem a da primeira que tem
    }
    if (!datas.length || datas[0] === null) return null;
    const inicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
    // elesAntes: o lead já tinha escrito em algum dia anterior — então o que ele escreve hoje não é a primeira resposta.
    const saida = { eu: false, antes: false, eles: false, elesAntes: false };
    mensagens.forEach((m, i) => {
      if (datas[i] < inicio) {
        saida.antes = true;
        if (m.from !== 'eu') saida.elesAntes = true;
      } else if (m.from === 'eu') saida.eu = true;
      else saida.eles = true;
    });
    return saida;
  }
  function anotarAtividade(mensagens, conversa) {
    if (!conversa || !(conversa.telefone || conversa.nome)) return;
    const agora = new Date();
    const hoje = atividadeDeHoje(mensagens, agora);
    if (!hoje || (!hoje.eu && !hoje.eles)) return;
    const chave = chaveDaConversa(conversa) + '|' + agora.toDateString();
    const antes = atividadeEnviada.get(chave) || { eu: false, antes: false, eles: false, elesAntes: false };
    const novo = { eu: antes.eu || hoje.eu, antes: antes.antes || hoje.antes, eles: antes.eles || hoje.eles, elesAntes: antes.elesAntes || hoje.elesAntes };
    if (novo.eu === antes.eu && novo.antes === antes.antes && novo.eles === antes.eles && novo.elesAntes === antes.elesAntes) return; // nada de novo para avisar
    atividadeEnviada.set(chave, novo);
    try {
      chrome.runtime.sendMessage({ action: 'atividade', telefone: conversa.telefone || '', nome: conversa.nome || '', ...novo }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* extensão recarregada: volta a avisar quando a conversa for aberta de novo */
    }
  }

  /**
   * Etiquetas tiradas das respostas do formulário (ficha do RD):
   *  - investimento: "R$3.000 a R$5.000" -> "3 a 5k"; "+ de R$5.000" -> "5k+"; "até R$3.000" -> "até 3k";
   *  - vende: "Já vendo e quero aumentar…" -> "Já vende"; "Quero começar a vender…" -> "Ainda não vende";
   *  - profissao: a resposta como o lead marcou ("Lojista/Comerciante"), encurtada se for comprida.
   * Sem o campo no formulário (ou resposta que não dá para ler), a etiqueta não aparece.
   */
  function etiquetasDoFormulario(f) {
    const saida = { investimento: '', faturamento: '', vende: '', profissao: '', busca: '' };
    if (!f) return saida;
    const campos = ((f.formulario && f.formulario.campos) || []).concat(f.campos || []);
    const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // Valor que ficou como modelo não preenchido ("{{data.Qual modalidade…}}") não é resposta de ninguém.
    const valorDe = (re) => {
      const c = campos.find((x) => re.test(semAcento(x.rotulo)) && !/\{\{/.test(String(x.valor || '')));
      return c ? String(c.valor || '') : '';
    };
    // "R$3.000 a R$5.000" -> "3 a 5k"; "+ de R$5.000" -> "5k+"; "até R$3.000" -> "até 3k"
    const emFaixa = (texto) => {
      const inv = semAcento(texto);
      if (!inv) return '';
      const emK = (v) => (v >= 1000 ? String(Math.round(v / 100) / 10).replace('.', ',') + 'k' : String(v));
      const numeros = [...inv.matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)\s*(mil\b|k\b)?/g)]
        .map((m) => {
          const n = Number(m[1].replace(/\./g, ''));
          return m[2] && n < 1000 ? n * 1000 : n;
        })
        .filter((n) => n > 0);
      if (numeros.length >= 2) return `${emK(numeros[0]).replace(/k$/, '')} a ${emK(numeros[1])}`;
      if (numeros.length === 1) {
        if (/\+|mais de|acima|a partir/.test(inv)) return emK(numeros[0]) + '+';
        if (/ate|menos de|abaixo/.test(inv)) return 'até ' + emK(numeros[0]);
        return emK(numeros[0]);
      }
      return '';
    };
    saida.investimento = emFaixa(valorDe(/invest/));
    saida.faturamento = emFaixa(valorDe(/fatur/)); // funil de análise: "FATURAMENTO: Entre R$10.000 a R$50.000"

    // "Vende online?" (formulário) ou "MOMENTO: Sim, já vendo" (funil de análise)
    const vende = semAcento(valorDe(/vend|momento/));
    if (/comec|ainda nao|nao vend|do zero|quero vender|^nao\b/.test(vende)) saida.vende = 'Ainda não vende';
    else if (/ja vend|ja tenho|aumentar|^sim\b/.test(vende)) saida.vende = 'Já vende';

    const profissao = valorDe(/profiss|ocupac/).replace(/\s+/g, ' ').trim();
    if (profissao) saida.profissao = profissao.length > 30 ? profissao.slice(0, 29).trimEnd() + '…' : profissao;
    const busca = valorDe(/busca|modalidade/).replace(/\s+/g, ' ').trim();
    if (busca) saida.busca = busca.length > 30 ? busca.slice(0, 29).trimEnd() + '…' : busca;
    return saida;
  }

  /**
   * O card do RD desta conversa foi dado como perdido? Devolve o que a etiqueta mostra (ou null).
   * Vale o card escolhido para a ficha: se o lead tem outro card em aberto, é ele o escolhido e não há etiqueta.
   * Na etapa "Desqualificados" a etiqueta diz DESQUALIFICADO; perdido em outra etapa, PERDIDO.
   */
  function perdaNoRd(f) {
    const card = ((f && f.negociacoes) || []).find((c) => c && c.escolhida);
    if (!card || !card.perdida) return null;
    const motivo = String(card.motivoPerda || '').replace(/\s+/g, ' ').trim();
    const nota = String(card.notaPerda || '').replace(/\s+/g, ' ').trim();
    return {
      rotulo: /desqualific/i.test(String(card.etapa || '')) ? 'DESQUALIFICADO' : 'PERDIDO',
      motivo: motivo.length > 34 ? motivo.slice(0, 33).trimEnd() + '…' : motivo,
      titulo: 'Card dado como perdido no RD' + (card.etapa ? ` (etapa ${card.etapa})` : '') + (motivo ? `. Motivo: ${motivo}` : '') + (nota ? `. Anotação: ${nota}` : '') + '.',
    };
  }

  // ---------------------------------------------------------------- desqualificar pelo cartão
  // Os motivos de perda do RD (buscados uma vez por página).
  let motivosDePerda = null;
  /** O card do lead que pode ser desqualificado: o escolhido na ficha, ainda em aberto. */
  function cardParaDesqualificar(estado) {
    if (!estado || estado.tipo !== 'ok' || !estado.ficha) return null;
    const card = (estado.ficha.negociacoes || []).find((c) => c && c.escolhida);
    return card && card.id && card.aberta && !card.perdida && !card.ganha ? card : null;
  }
  function abrirDesqualificar(estado) {
    estado.desq = { motivos: motivosDePerda, escolhido: null, enviando: false, erro: '' };
    redesenharFicha();
    if (motivosDePerda) return;
    try {
      chrome.runtime.sendMessage({ action: 'crmMotivosPerda' }, (r) => {
        if (chrome.runtime.lastError || !estado.desq) return;
        if (r && r.ok && r.motivos.length) {
          motivosDePerda = r.motivos;
          estado.desq.motivos = r.motivos;
        } else {
          estado.desq.erro = (r && r.erro) || 'Não consegui buscar os motivos de perda no RD.';
        }
        if (ficha.ultimoEstado === estado) redesenharFicha();
      });
    } catch (_) {
      /* extensão recarregada */
    }
  }
  function confirmarDesqualificar(estado, card) {
    const d = estado.desq;
    if (!d || !d.escolhido || d.enviando) return;
    d.enviando = true;
    d.erro = '';
    redesenharFicha();
    const b = estado.busca || {};
    try {
      chrome.runtime.sendMessage({ action: 'crmDesqualificar', telefone: b.telefone || '', nome: b.nome || '', contatoId: b.contatoId || '', dealId: card.id, motivoId: d.escolhido.id }, (r) => {
        if (chrome.runtime.lastError) return;
        if (r && r.ok) {
          // O cartão já mostra a perda (etiqueta DESQUALIFICADO com o motivo); a próxima consulta vem do RD.
          Object.assign(card, { perdida: true, aberta: false, motivoPerda: r.motivo || d.escolhido.nome, etapa: r.etapa || card.etapa });
          if (estado.ficha.negociacao && r.etapa) estado.ficha.negociacao.etapa = r.etapa;
          estado.desq = null;
          estado.aviso = { texto: `Card dado como perdido no RD: ${r.motivo || d.escolhido.nome}.` };
        } else {
          d.enviando = false;
          d.erro = (r && r.erro) || 'O servidor não respondeu. Tente de novo.';
        }
        if (ficha.ultimoEstado === estado) redesenharFicha();
      });
    } catch (_) {
      /* extensão recarregada */
    }
  }
  /** A caixinha do "Desqualificar": a lista de motivos e, escolhido um, a confirmação. */
  function caixaDesqualificar(estado, card) {
    const d = estado.desq;
    const caixa = elem('div', 'flex-basis:100%;margin-top:4px;padding:8px;border:1px solid #ff6f5c;border-radius:8px;background:rgba(255,111,92,.07)');
    caixa.id = 'cr-desqualificar';
    const botao = (texto, estilo, aoClicar) => {
      const x = elem('button', 'cursor:pointer;border-radius:6px;padding:4px 9px;font-size:12px;font-family:inherit;' + estilo, texto);
      x.type = 'button';
      x.addEventListener('click', aoClicar);
      return x;
    };
    const fechar = () => { estado.desq = null; redesenharFicha(); };
    if (d.escolhido) {
      caixa.appendChild(elem('div', 'font-size:12px;margin-bottom:6px', 'Dar perda no RD com o motivo:'));
      caixa.appendChild(elem('div', 'font-weight:700;color:#ff6f5c;margin-bottom:8px', d.escolhido.nome));
      if (d.enviando) caixa.appendChild(elem('div', 'font-size:12px;color:#a39e93', 'Dando perda no RD…'));
      else {
        const acoes = elem('div', 'display:flex;gap:6px');
        const sim = botao('Confirmar perda', 'border:0;background:#ff6f5c;color:#18171b;font-weight:700', () => confirmarDesqualificar(estado, card));
        sim.id = 'cr-desq-confirmar';
        acoes.appendChild(sim);
        acoes.appendChild(botao('Voltar', 'border:1px solid #55515b;background:transparent;color:#f3efe6', () => { d.escolhido = null; d.erro = ''; redesenharFicha(); }));
        caixa.appendChild(acoes);
      }
    } else {
      caixa.appendChild(elem('div', 'font-size:12px;margin-bottom:6px;color:#a39e93', 'Por que desqualificar? O card vira perda no RD com este motivo.'));
      if (!d.motivos && !d.erro) caixa.appendChild(elem('div', 'font-size:12px;color:#a39e93', 'Buscando os motivos no RD…'));
      if (d.motivos) {
        const lista = elem('div', 'display:flex;flex-direction:column;gap:4px;max-height:190px;overflow:auto');
        d.motivos.forEach((m) => {
          const x = botao(m.nome, 'text-align:left;border:1px solid #3a373f;background:#121113;color:#f3efe6', () => { d.escolhido = m; redesenharFicha(); });
          x.dataset.motivo = m.id;
          lista.appendChild(x);
        });
        caixa.appendChild(lista);
      }
      caixa.appendChild(elem('div', 'margin-top:6px', botao('Cancelar', 'border:1px solid #55515b;background:transparent;color:#a39e93', fechar)));
    }
    if (d.erro) caixa.appendChild(elem('div', 'font-size:12px;color:#ff6f5c;margin-top:6px', d.erro));
    return caixa;
  }

  /** Linha de etiquetas no topo do cartão: perda no RD, "Qualificado" (liga/desliga à mão), o agendamento e o formulário. */
  function blocoEtiquetas(estado) {
    if (estado.tipo === 'carregando') return null;
    // A perda vem da própria ficha do RD: aparece para quem vê o cartão, com ou sem as outras etiquetas ligadas.
    const perda = perdaNoRd(estado.ficha);
    if (!ficha.automacao && !ficha.etiquetas && !perda) return null;
    const marca = estado.marca || {};
    const conversa = ficha.conversa;
    const linha = elem('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:7px');
    linha.id = 'cr-etiquetas';
    const base = 'border-radius:5px;padding:2px 8px;font-size:11px;font-weight:600;line-height:1.5;letter-spacing:.07em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif';
    const tirar = (titulo, aoClicar) => {
      const b = elem('button', 'cursor:pointer;border:0;background:transparent;color:#a39e93;font-size:13px;line-height:1;padding:0 2px;font-family:inherit', '×');
      b.type = 'button';
      b.title = titulo;
      b.setAttribute('aria-label', titulo);
      b.addEventListener('click', aoClicar);
      return b;
    };
    // Mostra na hora e guarda no servidor (que devolve a marca final).
    const mudar = (campos, local) => {
      estado.marca = { ...marca, ...local };
      redesenharFicha();
      enviarMarca(conversa, campos);
    };
    if (perda) {
      const chip = elem('span', `${base};border:1px solid #ff6f5c;background:rgba(255,111,92,.14);color:#ff6f5c`, perda.rotulo + (perda.motivo ? ' · ' + perda.motivo : ''));
      chip.id = 'cr-etiqueta-perda';
      chip.title = perda.titulo;
      linha.appendChild(chip);
    }
    if (ficha.automacao && marca.qualificado) {
      const chip = elem('span', `${base};border:1px solid #3ddc84;background:rgba(61,220,132,.14);color:#3ddc84`, 'QUALIFICADO');
      // De onde a etiqueta veio (passe o mouse): assim dá para confiar nela sem reabrir a conversa.
      const porque = { rd: 'o card esteve na etapa Qualificado do RD', report: 'você gerou o report deste lead', manual: 'você marcou à mão' }[marca.origem];
      chip.title = porque ? 'Qualificado: ' + porque + '.' : 'Lead qualificado.';
      linha.appendChild(chip);
      linha.appendChild(tirar('Tirar a etiqueta Qualificado', () => mudar({ qualificado: false, manual: true }, { qualificado: false })));
    } else if (ficha.automacao && !perda) {
      // Card perdido não ganha a sugestão de marcar como qualificado.
      const b = elem('button', `${base};cursor:pointer;border:1px dashed #55515b;background:transparent;color:#a39e93`, '+ Qualificado');
      b.type = 'button';
      b.title = 'Marcar este lead como qualificado';
      b.addEventListener('click', () => mudar({ qualificado: true, manual: true }, { qualificado: true, origem: 'manual' }));
      linha.appendChild(b);
    }
    // A reunião que está no Google Agenda vale mais que o que foi lido na conversa: é o compromisso de fato.
    const daAgenda = ficha.automacao && estado.reuniao && agendaLib ? agendaLib.descrever(estado.reuniao.quando, new Date()) : null;
    if (daAgenda) {
      const cor = daAgenda.passou ? '#f2a93b' : '#ffc233';
      const texto = (daAgenda.passou ? 'Estava agendado: ' : 'Agendado: ') + daAgenda.texto + (estado.reuniao.closer ? ' · ' + estado.reuniao.closer : '');
      const c = elem('span', `${base};border:1px solid ${cor};background:rgba(255,194,51,.12);color:${cor}`, texto);
      c.title = 'Do Google Agenda' + (estado.reuniao.titulo ? ': ' + estado.reuniao.titulo : '');
      linha.appendChild(c);
    }
    const ag = !daAgenda && ficha.automacao && marca.agendadoPara && agendaLib ? agendaLib.descrever(marca.agendadoPara, new Date()) : null;
    if (ag) {
      const cor = ag.passou ? '#f2a93b' : '#ffc233';
      linha.appendChild(elem('span', `${base};border:1px solid ${cor};background:rgba(255,194,51,.12);color:${cor}`, (ag.passou ? 'Estava agendado: ' : 'Agendado: ') + ag.texto));
      linha.appendChild(tirar('Apagar este agendamento', () => mudar({ limparAgenda: true }, { agendadoPara: '' })));
    }
    // Do formulário do RD, para ver de relance: quanto o lead disse que investe, se já vende e a profissão.
    // Cheias e maiores que as outras: são o que se bate o olho primeiro, mesmo com o cartão minimizado.
    const doFormulario = ficha.etiquetas ? etiquetasDoFormulario(estado.ficha) : { investimento: '', faturamento: '', vende: '', profissao: '', busca: '' };
    const cheia = (fundo, cor) => `border-radius:5px;padding:3px 10px;font-size:12px;font-weight:800;line-height:1.5;letter-spacing:.01em;border:1px solid ${fundo};background:${fundo};color:${cor}`;
    if (doFormulario.investimento || doFormulario.faturamento || doFormulario.vende || doFormulario.profissao || doFormulario.busca) {
      const doForm = elem('div', 'flex-basis:100%;display:flex;flex-wrap:wrap;gap:6px');
      if (doFormulario.investimento) {
        const c = elem('span', cheia('#ffc233', '#18171b'), 'R$ ' + doFormulario.investimento);
        c.title = 'Investimento informado no formulário';
        doForm.appendChild(c);
      }
      if (doFormulario.faturamento) {
        const c = elem('span', cheia('#ff9f43', '#2a1500'), 'Fat. R$ ' + doFormulario.faturamento);
        c.title = 'Faturamento informado no formulário';
        doForm.appendChild(c);
      }
      if (doFormulario.vende) {
        const jaVende = doFormulario.vende === 'Já vende';
        const c = elem('span', cheia(jaVende ? '#3ddc84' : '#8aa9ff', jaVende ? '#06180e' : '#0e1730'), doFormulario.vende);
        c.title = 'Resposta do formulário sobre vender online';
        doForm.appendChild(c);
      }
      if (doFormulario.profissao) {
        const c = elem('span', cheia('#b79cff', '#17102b'), doFormulario.profissao);
        c.title = 'Profissão informada no formulário';
        doForm.appendChild(c);
      }
      if (doFormulario.busca) {
        const c = elem('span', cheia('#5ad1d1', '#06201f'), doFormulario.busca);
        c.title = 'O que o lead busca (modalidade)';
        doForm.appendChild(c);
      }
      linha.appendChild(doForm);
    }
    // Desqualificar: só no card em aberto do lead, para quem tem a automação do cartão.
    const paraPerder = ficha.automacao && !perda ? cardParaDesqualificar(estado) : null;
    if (paraPerder && !estado.desq) {
      const b = elem('button', `${base};cursor:pointer;border:1px dashed #ff6f5c;background:transparent;color:#ff6f5c`, 'Desqualificar');
      b.type = 'button';
      b.id = 'cr-desqualificar-btn';
      b.title = 'Dar perda no RD com um motivo, sem abrir o card';
      b.addEventListener('click', () => abrirDesqualificar(estado));
      linha.appendChild(b);
    }
    if (paraPerder && estado.desq) linha.appendChild(caixaDesqualificar(estado, paraPerder));
    if (estado.aviso) linha.appendChild(elem('div', `flex-basis:100%;font-size:11px;color:${estado.aviso.erro ? '#ff6f5c' : '#3ddc84'}`, estado.aviso.texto));
    return linha;
  }

  function renderFicha(estado) {
    if (!ficha.ligada || (ficha.fechadaPara && ficha.fechadaPara === ficha.chave)) return;
    ficha.ultimoEstado = estado;
    let el = document.getElementById(FICHA_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = FICHA_ID;
      // Fora do #main de propósito: a leitura da conversa (report) nunca pode confundir o cartão com mensagem.
      el.style.cssText = [
        'position:fixed', 'top:70px', 'right:16px', 'z-index:2147483646', 'width:290px',
        'max-height:calc(100vh - 150px)', 'overflow:auto', 'background:#1a191c', 'color:#f3efe6',
        'border:1px solid #3a373f', 'border-top:3px solid #ffc233', 'border-radius:12px', 'padding:11px 13px 12px',
        'font:13px/1.4 Segoe UI Variable Text,Segoe UI,system-ui,-apple-system,Roboto,sans-serif', 'box-shadow:0 14px 34px rgba(0,0,0,.5)',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = '';
    posicionarFicha();

    const semCrm = estado.tipo === 'sem-crm';
    const titulo = estado.ficha ? estado.ficha.nome || 'Lead' : semCrm ? nomeDoContato() || 'Conversa' : 'Ficha do lead';
    const btnMin = botaoFicha(ficha.minimizada ? '+' : '–', () => {
      ficha.minimizada = !ficha.minimizada;
      try {
        chrome.storage.local.set({ fichaCrmMinimizada: ficha.minimizada });
      } catch (_) {
        /* ok */
      }
      renderFicha(estado);
    });
    btnMin.title = ficha.minimizada ? 'Abrir a ficha' : 'Minimizar';
    const btnX = botaoFicha('×', () => {
      ficha.fechadaPara = ficha.chave; // só nesta conversa; abre de novo na próxima
      esconderFicha();
    });
    btnX.title = 'Fechar nesta conversa';
    // Topo: é por ele que se arrasta o cartão.
    const alca = elem(
      'div',
      'flex:1;min-width:0;user-select:none;display:flex;align-items:center;gap:6px',
      pegador(),
      elem('div', 'flex:1;min-width:0',
        elem('div', 'font-size:10.5px;color:#ffc233;font-weight:600;letter-spacing:.14em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif', semCrm ? 'PRONIX' : 'RD STATION'),
        elem('div', 'font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', titulo))
    );
    alca.title = 'Arraste para mudar de lugar (duplo clique volta ao lugar padrão)';
    tornarArrastavel(el, alca, { dono: ficha, chave: 'fichaPos', posicionar: posicionarFicha });
    el.appendChild(elem('div', 'display:flex;align-items:center;gap:6px', alca, btnMin, btnX));
    // As etiquetas ficam à vista mesmo com o cartão minimizado.
    const etiquetas = blocoEtiquetas(estado);
    if (etiquetas) el.appendChild(etiquetas);
    if (ficha.minimizada) return;

    const corpo = elem('div', 'margin-top:8px');
    el.appendChild(corpo);
    if (estado.tipo !== 'carregando') corpo.appendChild(blocoResumo());

    if (estado.tipo === 'carregando') {
      corpo.appendChild(elem('div', 'color:#a39e93', 'Buscando no RD Station…'));
      return;
    }
    if (semCrm) return;
    if (estado.tipo === 'erro') {
      corpo.appendChild(elem('div', 'color:#ff6f5c', estado.erro));
      corpo.appendChild(elem('div', 'margin-top:8px', botaoFicha('Tentar de novo', () => consultarFicha(estado.busca))));
      return;
    }
    if (estado.tipo === 'nao-encontrado') {
      corpo.appendChild(elem('div', 'color:#a39e93', 'Não achei este lead no RD Station. Busque pelo telefone ou nome:'));
      corpo.appendChild(formBusca());
      return;
    }
    if (estado.tipo === 'candidatos') {
      corpo.appendChild(elem('div', 'color:#a39e93;margin-bottom:6px', 'Mais de um contato com esse nome. Qual é?'));
      estado.candidatos.forEach((c) => {
        const b = botaoFicha([c.nome, c.telefone].filter(Boolean).join(' · '), () => consultarFicha({ contatoId: c.id }));
        b.style.cssText += ';display:block;width:100%;text-align:left;margin:4px 0';
        corpo.appendChild(b);
      });
      corpo.appendChild(formBusca());
      return;
    }

    // Ficha encontrada
    const f = estado.ficha;
    const n = f.negociacao;
    if (n) {
      const etapa = [n.etapa, n.funil].filter(Boolean).join(' · ');
      if (etapa) corpo.appendChild(elem('div', 'font-weight:600', etapa));
      if (n.responsavel) corpo.appendChild(elem('div', 'color:#a39e93;font-size:12px', 'Responsável: ' + n.responsavel));
    } else {
      corpo.appendChild(elem('div', 'color:#a39e93', 'Contato sem negociação no RD.'));
    }
    if (f.formulario && f.formulario.campos.length) {
      const bloco = elem('div', 'margin-top:8px;padding-top:6px;border-top:1px solid #3a373f');
      f.formulario.campos.forEach((c) => bloco.appendChild(linhaCampo(c.rotulo, c.valor, /invest/i.test(c.rotulo))));
      const meta = [f.formulario.autor, f.formulario.quando].filter(Boolean).join(' · ');
      if (meta) bloco.appendChild(elem('div', 'font-size:11px;color:#a39e93;margin-top:4px', 'Anotado por ' + meta));
      corpo.appendChild(bloco);
    }
    if (f.campos && f.campos.length) {
      const bloco = elem('div', 'margin-top:8px;padding-top:6px;border-top:1px solid #3a373f');
      f.campos.forEach((c) => bloco.appendChild(linhaCampo(c.rotulo, c.valor)));
      corpo.appendChild(bloco);
    }
    if (f.anotacoes && f.anotacoes.length) {
      const det = document.createElement('details');
      det.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid #3a373f';
      det.appendChild(elem('summary', 'cursor:pointer;color:#a39e93;font-size:12px', `Outras anotações (${f.anotacoes.length})`));
      f.anotacoes.forEach((a) => {
        det.appendChild(elem('div', 'font-size:11px;color:#a39e93;margin-top:6px', [a.autor, a.quando].filter(Boolean).join(' · ')));
        det.appendChild(elem('div', 'white-space:pre-wrap;word-break:break-word', a.texto));
      });
      corpo.appendChild(det);
    }
    if ((f.negociacoes || []).length > 1) {
      // Lead com mais de um card (inscreveu de novo, contato duplicado): o SDR troca para o certo e o servidor lembra.
      const sel = document.createElement('select');
      sel.style.cssText = 'width:100%;margin-top:4px;background:#121113;color:#f3efe6;border:1px solid #3a373f;border-radius:7px;padding:5px 6px;font-size:12px';
      f.negociacoes.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = [c.etapa || c.nome || 'Card', c.funil, c.criadaEm, c.aberta ? '' : 'fechado'].filter(Boolean).join(' · ');
        if (c.escolhida) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => consultarFicha({ ...estado.busca, dealId: sel.value, lembrar: true }));
      corpo.appendChild(elem('div', 'font-size:11px;color:#a39e93;margin-top:8px', `Este lead tem ${f.negociacoes.length} cards no RD — mostrando o que parece ser o certo. Trocou? Escolha aqui (fica lembrado):`));
      corpo.appendChild(sel);
    }
    if (n && /^https:\/\/crm\.rdstation\.com\//.test(n.url || '')) {
      const a = elem('a', 'display:inline-block;margin-top:8px;color:#ffc233;font-weight:600;text-decoration:none', 'Abrir no RD Station ↗');
      a.href = n.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      corpo.appendChild(a);
    }
  }

  async function consultarFicha(busca) {
    const seq = ++ficha.seq;
    renderFicha({ tipo: 'carregando', busca });
    let r;
    try {
      r = await new Promise((res) => chrome.runtime.sendMessage({ action: 'crmLead', ...busca, ...(ficha.conversa ? { conversa: ficha.conversa } : {}) }, res));
    } catch (_) {
      // Extensão atualizada/recarregada: este script ficou órfão. Para de vigiar em silêncio.
      clearInterval(ficha.vigia);
      esconderFicha();
      return;
    }
    if (seq !== ficha.seq) return; // resposta de uma conversa que o SDR já deixou
    if (r && typeof r.coach === 'boolean') ficha.coach = r.coach; // o servidor diz se este usuário vê o Coach
    renderCoach();
    if (!r || !r.ok) return renderFicha({ tipo: 'erro', erro: (r && r.erro) || 'Não consegui consultar o RD Station.', busca });
    // Automação (mover para "Respondeu", etiqueta e agendamento): o servidor diz se o master ligou para esta chave.
    ficha.automacao = r.automacao === true;
    ficha.etiquetas = r.etiquetas === true; // etiquetas do formulário: permissão própria
    const extras = ficha.automacao ? { marca: r.marca || null, podeResponder: r.podeResponder === true, reuniao: r.reuniao || null } : {};
    // Sem ficha do RD para este usuário (CRM desligado no servidor ou popup do lead desligado):
    // quem tem o Coach continua vendo o cartão, só com o resumo e o coach.
    if (!r.configurado) return ficha.coach ? renderFicha({ tipo: 'sem-crm', busca, ...extras }) : esconderFicha();
    if (r.encontrado && r.ficha) return renderFicha({ tipo: 'ok', ficha: r.ficha, busca, ...extras });
    if (r.candidatos && r.candidatos.length) return renderFicha({ tipo: 'candidatos', candidatos: r.candidatos, busca, ...extras });
    renderFicha({ tipo: 'nao-encontrado', busca, ...extras });
  }

  /** A conversa aberta neste instante, sem esperar o próximo tique do vigia (null com a ficha desligada). */
  function conversaAbertaAgora() {
    try {
      verificarConversa();
    } catch (_) {
      /* falha de leitura do DOM: fica com a última conversa conhecida */
    }
    return ficha.conversa;
  }

  /** A cada 1,5s: a conversa aberta mudou? Então busca a ficha do novo lead. */
  function verificarConversa() {
    if (!ficha.ligada) return;
    if (!document.querySelector('#main')) {
      ficha.chave = null;
      ficha.conversa = null;
      esconderFicha();
      renderCoach();
      return;
    }
    let telefone = telefoneDaConversa();
    const nome = nomeDoContato();
    if (telefoneDoLink.length >= 10) {
      // A 1ª conversa que aparece depois de abrir pelo link é a do link (mesmo que o topo já mostre o número).
      if (conversaDoLink === null) conversaDoLink = nome || telefone;
      if (!telefone && nome && nome === conversaDoLink) telefone = telefoneDoLink;
    }
    if (!telefone && nome) {
      if (!telefonesPorNome.has(nome)) {
        const doPainel = telefoneDoPainelDoContato();
        const repetiu = doPainel && leituraAnterior && leituraAnterior.nome === nome && leituraAnterior.telefone === doPainel;
        leituraAnterior = doPainel ? { nome, telefone: doPainel } : null;
        if (repetiu) telefonesPorNome.set(nome, doPainel);
      }
      telefone = telefonesPorNome.get(nome) || '';
    }
    posicionarFicha();
    const chave = telefone || nome;
    if (!chave) return;
    if (chave === ficha.chave) {
      automatizar();
      vigiarCoach();
      return;
    }
    ficha.chave = chave;
    ficha.conversa = { telefone, nome };
    ficha.ultimoEstado = null; // o que estava na tela era da conversa anterior
    ficha.fechadaPara = null;
    coachUi.fechadoPara = null;
    renderCoach();
    clearTimeout(ficha.timer);
    ficha.timer = setTimeout(() => consultarFicha({ telefone, nome: telefone && nome.replace(/\D/g, '') === telefone ? '' : nome }), 700);
  }

  try {
    chrome.storage.local.get({ fichaCrm: true, fichaCrmMinimizada: false, fichaPos: null, coachMinimizado: false, coachPos: null }, (c) => {
      const lugar = (p) => (p && Number.isFinite(p.left) && Number.isFinite(p.top) ? { left: p.left, top: p.top } : null);
      ficha.ligada = c.fichaCrm !== false;
      ficha.minimizada = !!c.fichaCrmMinimizada;
      ficha.pos = lugar(c.fichaPos);
      coachUi.minimizado = !!c.coachMinimizado;
      coachUi.pos = lugar(c.coachPos);
      // O Coach não depende da ficha do RD: a permissão vem da chave (e o cartão se redesenha se já estiver na tela).
      try {
        chrome.runtime.sendMessage({ action: 'permissoes' }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok || typeof r.coach !== 'boolean') return;
          const antes = ficha.coach;
          ficha.coach = Boolean(r.coach);
          if (ficha.coach !== antes) renderCoach();
        });
      } catch (_) {
        /* sem a permissão o cartão segue como a ficha disser */
      }
      ficha.vigia = setInterval(() => {
        try {
          verificarConversa();
        } catch (_) {
          /* uma falha de leitura do DOM não pode derrubar o vigia */
        }
      }, 1500);
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((mud) => {
        if (!mud.fichaCrm) return;
        ficha.ligada = mud.fichaCrm.newValue !== false;
        if (!ficha.ligada) {
          esconderFicha();
          renderCoach();
        }
        ficha.chave = null; // ao religar, busca de novo a conversa aberta
      });
    }
  } catch (_) {
    /* sem storage (contexto inválido): sem ficha */
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'start') {
      // Dispara em background e responde na hora para o popup poder fechar.
      gerarReportEmBackground(msg.server, { afinidade: msg.afinidade });
      sendResponse({ ok: true, iniciado: true });
      return false;
    }
    if (msg && msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
  });

})();
