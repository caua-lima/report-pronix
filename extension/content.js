// Content script — lê a conversa aberta no WhatsApp Web (incl. histórico retroativo).
// Roda no contexto da página web.whatsapp.com.

(function () {
  'use strict';

  // As duas extensões (Report PRONIX e PRONIX Closer Report) desenham o MESMO cartão. Com as duas
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
  // A conversa aberta quando o WhatsApp criou o arquivo: o report só aceita arquivo da conversa dele. Sem isso, um
  // áudio ouvido em OUTRA conversa (e que ficou na fila) podia ser transcrito no report deste lead.
  const conversaDaTela = () => {
    try {
      return nomeDoContato();
    } catch (_) {
      return '';
    }
  };
  let conversaDaLeitura = ''; // a conversa do report que está sendo lido agora ('' = sem leitura)
  const MAX_BLOBS_FILA = 500;
  let totalBlobsVistos = 0; // quantos arquivos o WhatsApp já criou (a fila é cortada em MAX_BLOBS_FILA; este não)
  // De que conversa é cada arquivo. O WhatsApp novo BAIXA os áudios da conversa assim que ela é clicada na lista —
  // antes de o nome dela aparecer no topo. Pelo nome do topo, esses arquivos ficavam com a conversa ANTERIOR e o
  // report recusava todos ("sem blob de áudio"). Agora a conversa do arquivo é a da "rodada" em que ele foi criado:
  // tudo o que surge depois de um clique na lista é da conversa que esse clique abriu (o nome que aparece no topo em
  // seguida). Sem clique (aberta por link ou atalho), a troca do nome no topo abre a rodada.
  const LISTA_DE_CONVERSAS_AUDIO = '#pane-side, [aria-label="Lista de conversas"], [aria-label="Chat list"]';
  const ESPERA_NOME_DA_RODADA = 8000; // clicou e o topo não mudou em 8 s: é a mesma conversa (ou um filtro da lista)
  let rodada = { inicio: 0, nome: '', anterior: '' };
  function novaRodada(nome) {
    rodada = { inicio: Date.now(), nome: nome || '', anterior: rodada.nome || rodada.anterior || '' };
  }
  function acompanharRodada() {
    const nome = conversaDaTela();
    if (!nome) return;
    if (!rodada.nome) {
      // logo depois do clique o topo ainda mostra a conversa anterior: espera o nome mudar (ou o tempo passar)
      if (nome !== rodada.anterior || Date.now() - rodada.inicio > ESPERA_NOME_DA_RODADA) rodada.nome = nome;
      return;
    }
    if (nome !== rodada.nome) novaRodada(nome); // trocou de conversa sem clique na lista
  }
  document.addEventListener('click', (ev) => {
    try {
      if (!ev.target || !ev.target.closest || !ev.target.closest(LISTA_DE_CONVERSAS_AUDIO)) return;
      acompanharRodada(); // a conversa de antes do clique fica registrada
      novaRodada('');
    } catch (_) {
      /* ok */
    }
  }, true);
  setInterval(() => {
    try {
      acompanharRodada();
    } catch (_) {
      /* ok */
    }
  }, 300);
  /** A conversa de um arquivo da fila: a da rodada em que ele foi criado; sem ela, o nome do topo naquela hora. */
  const conversaDoBlob = (b) => (b.rodada && b.rodada.nome) || b.conversa || '';

  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.__crAudio && ev.data.url) {
      totalBlobsVistos++;
      acompanharRodada();
      blobsAudio.push({ url: ev.data.url, ts: ev.data.ts || Date.now(), conversa: conversaDaTela(), rodada });
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
    const deOutra = new Map(); // conversa -> quantos áudios válidos dela (os que não são desta leitura)
    for (const b of blobsAudio.slice(-30)) {
      if (b.ts >= t0) continue;
      const buf = await fetchArrayBuffer(b.url);
      if (!buf) semBytes++;
      else if (ehAudioBuffer(buf)) {
        audio++;
        const c = conversaDoBlob(b);
        if (conversaDaLeitura && c !== conversaDaLeitura) deOutra.set(c || '(sem nome)', (deOutra.get(c || '(sem nome)') || 0) + 1);
      } else outros++;
    }
    const outrasTxt = [...deOutra].map(([c, n]) => `${n} de "${c}"`).join(', ');
    logA(`fila anterior ao clique: ${audio} áudio(s) válido(s)${outrasTxt ? ` (de outra conversa: ${outrasTxt})` : ''}, ${outros} outro(s), ${semBytes} sem bytes`);
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
    const btnBaixar = botaoDeBaixar(el);
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
    const btn = botaoDePlay(el);
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
        // De outra conversa, nunca. Arquivo antigo (criado antes do clique) só se for, com certeza, desta conversa —
        // pela rodada em que foi criado (o WhatsApp baixa os áudios ao abrir a conversa, antes de o nome mudar no topo).
        const doBlob = conversaDoBlob(b);
        if (conversaDaLeitura && (b.ts < t0 ? doBlob !== conversaDaLeitura : doBlob && doBlob !== conversaDaLeitura)) continue;
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
    if (conversaDaLeitura && nomeDoContato() !== conversaDaLeitura) return; // outra conversa na tela
    const todas = acharMensagens(root);
    const chaves = chavesDasMensagens(todas);
    for (let i = 0; i < todas.length; i++) {
      const el = todas[i];
      if (!ehAudio(el)) continue;
      const chave = chaves[i];
      if (!chave || audioBytes.has(chave) || tentadosNestaPassada.has(chave)) continue;
      if (conversaDaLeitura && nomeDoContato() !== conversaDaLeitura) return; // trocou de conversa no meio
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
      return /^(true|false)_/.test(id) && (el.querySelector('.copyable-text, .selectable-text, [data-icon], audio') || ehAudio(el));
    });
    if (els.length) { _estrategiaMsg = 2; return els; }
    // Fallback 2: role="row" com texto OU com mídia/áudio (para não perder áudios).
    els = [...root.querySelectorAll('div[role="row"]')].filter(
      (el) =>
        el.querySelector(
          '.selectable-text, .copyable-text, [data-icon*="ptt" i], [data-icon*="mic" i], ' +
            '[data-icon*="audio" i], [data-icon*="play" i], [data-icon*="pause" i], ' +
            'input[type="range"], [role="slider"], audio'
        ) || ehAudio(el)
    );
    _estrategiaMsg = 3;
    return els;
  }

  // Chave única de cada mensagem — a MESMA na captura do áudio, na montagem da conversa e na leitura rápida.
  // 1º o data-id da própria mensagem (nela ou dentro dela). O de um bloco ACIMA só vale se esse bloco tiver
  // uma mensagem só: senão todas as mensagens dele ganhavam a mesma chave e os áudios seguintes eram pulados
  // como "já capturados" (era o "10 áudios, 1 transcrito").
  function idDaMensagem(el) {
    if (el.matches && el.matches('[data-id]')) return el.getAttribute('data-id') || '';
    const dentro = el.querySelector && el.querySelector('[data-id]');
    if (dentro) return dentro.getAttribute('data-id') || '';
    const acima = el.closest && el.closest('[data-id]');
    if (acima && acharMensagens(acima).length <= 1) return acima.getAttribute('data-id') || '';
    return '';
  }
  // Sem data-id: quem mandou + o carimbo do WhatsApp + o que a bolha mostra de curto (no áudio, a duração e a
  // hora). Antes a chave do áudio era só "remetente + [áudio]": todos os áudios do lead viravam um só.
  function assinaturaDaBolha(el) {
    const copy = el.querySelector && el.querySelector('.copyable-text');
    const carimbo = (copy && copy.getAttribute('data-pre-plain-text')) || '';
    const curtos = [];
    if (el.querySelectorAll) {
      el.querySelectorAll('span, div').forEach((n) => {
        if (n.children.length) return;
        const t = (n.textContent || '').trim();
        if (ehDuracaoOuHora(t)) curtos.push(t);
      });
    }
    return (ehDeMim(el) ? 'eu' : 'eles') + '|' + carimbo + '|' + curtos.join(',');
  }
  /** Chaves das mensagens, na ordem da tela. Sem data-id e iguais em tudo, ganham #2, #3… pela ordem. */
  function chavesDasMensagens(els) {
    const repetidas = new Map();
    return els.map((el) => {
      const id = idDaMensagem(el);
      if (id) return id;
      const base = 'sem-id|' + (ehAudio(el) ? 'audio' : 'texto|' + extrairTexto(el).slice(0, 80)) + '|' + assinaturaDaBolha(el);
      const n = (repetidas.get(base) || 0) + 1;
      repetidas.set(base, n);
      return n > 1 ? base + '#' + n : base;
    });
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
        (row.querySelector('.selectable-text, .copyable-text, audio, input[type="range"], [data-icon*="audio" i], [data-icon*="ptt" i], img') ||
          row.querySelector('[role="slider"], button, [role="button"], svg'));
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

  // O WhatsApp troca a marcação dos áudios de tempos em tempos: o nome do ícone já veio em data-icon, e nas
  // versões novas pode vir só no <title> do SVG, num data-testid ou no rótulo do botão — ou em nada.
  const SINAL_AUDIO = /ptt|voz|voice|áudio|audio|waveform|\bmic\b|microfone/i;
  const SINAL_PLAY = /play|reproduzir|tocar|ouvir/i;
  /** Nomes e rótulos dos controles e ícones da bolha (nunca o texto da mensagem). */
  function rotuloDoControle(n) {
    if ((n.tagName || '').toLowerCase() === 'title') return n.textContent || '';
    const partes = [];
    for (const a of ['data-icon', 'data-testid', 'aria-label', 'title']) {
      const v = n.getAttribute && n.getAttribute(a);
      if (v) partes.push(v);
    }
    if (n.querySelectorAll) n.querySelectorAll('svg title').forEach((t) => partes.push(t.textContent || ''));
    return partes.join(' ');
  }
  function sinaisDosControles(el) {
    const partes = [];
    el.querySelectorAll('button, [role="button"], [role="slider"], [data-icon], [data-testid], svg title').forEach((n) => {
      partes.push(rotuloDoControle(n));
    });
    return partes.join(' | ');
  }
  /** Folhas com "0:11" / "14:29": no áudio vêm a duração E a hora; na mensagem de texto, só a hora. */
  function folhasDeTempo(el) {
    const tempos = [];
    el.querySelectorAll('span, div').forEach((n) => {
      if (n.children.length) return;
      const t = (n.textContent || '').trim();
      if (ehDuracaoOuHora(t)) tempos.push(t);
    });
    return tempos;
  }
  /** Foto/vídeo tem miniatura grande; o áudio só tem a foto pequena de quem gravou. */
  function temImagemGrande(el) {
    for (const img of el.querySelectorAll('img, canvas')) {
      try {
        if (img.getBoundingClientRect().width > 120) return true;
      } catch (_) {
        /* segue */
      }
    }
    return false;
  }
  function ehAudio(el) {
    if (!el || !el.querySelector) return false;
    if (el.querySelector('audio')) return true;
    // Barra de progresso (seek) é um sinal forte de mensagem de voz/áudio.
    if (el.querySelector('input[type="range"], [role="slider"]')) return true;
    const controles = sinaisDosControles(el);
    if (SINAL_AUDIO.test(controles)) return true;
    const temTexto = !!extrairTexto(el);
    if (!temTexto) {
      for (const r of el.querySelectorAll('[aria-label]')) {
        if (SINAL_AUDIO.test(r.getAttribute('aria-label') || '')) return true;
      }
    }
    // Sem nome de ícone nenhum: botão de tocar + duração além da hora, sem texto, sem vídeo e sem foto grande.
    if (temTexto || el.querySelector('video')) return false;
    if (!el.querySelector('button, [role="button"]') || folhasDeTempo(el).length < 2) return false;
    return (SINAL_PLAY.test(controles) || !!el.querySelector('svg')) && !temImagemGrande(el);
  }

  /** O botão de tocar do áudio — nunca o menu, a reação ou o encaminhar que também moram na bolha. */
  function botaoDePlay(el) {
    const icone = el.querySelector('[data-icon*="play" i], [data-testid*="play" i]');
    if (icone) return icone.closest('button,[role="button"]') || icone;
    const botoes = [...el.querySelectorAll('button, [role="button"]')];
    return (
      botoes.find((b) => SINAL_PLAY.test(rotuloDoControle(b))) ||
      botoes.find(
        (b) =>
          !/menu|op[çc][õo]es|mais|reag|react|emoji|encaminh|forward|baixar|download|velocidade|speed|transcri/i.test(rotuloDoControle(b)) &&
          !b.querySelector('img')
      ) ||
      botoes[0] ||
      null
    );
  }
  function botaoDeBaixar(el) {
    const icone = el.querySelector('[data-icon="audio-download"], [data-icon="down"], [data-icon*="download" i], [data-testid*="download" i]');
    if (icone) return icone;
    return [...el.querySelectorAll('button, [role="button"]')].find((b) => /baixar|download/i.test(rotuloDoControle(b))) || null;
  }

  /** Diagnóstico quando nenhum áudio é reconhecido: só a estrutura das bolhas sem texto (nada do conteúdo). */
  function diagnosticoDeAudio(root) {
    const linhas = [...root.querySelectorAll('div[role="row"]')].filter((r) => !extrairTexto(r));
    return {
      linhasSemTexto: linhas.length,
      exemplos: linhas.slice(-8).map((r) => ({
        botoes: r.querySelectorAll('button, [role="button"]').length,
        svgs: r.querySelectorAll('svg').length,
        imgs: r.querySelectorAll('img').length,
        slider: !!r.querySelector('input[type="range"], [role="slider"]'),
        audio: !!r.querySelector('audio'),
        tempos: folhasDeTempo(r).length,
        controles: sinaisDosControles(r).slice(0, 160),
        reconhecido: ehAudio(r),
      })),
    };
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
    conversaDaLeitura = alvoNome;
    /**
     * Ainda é a conversa do report? Não: nada da tela é lido nesta volta (devolve false) e, se continuar assim por 3
     * voltas, a leitura para. Antes, a outra conversa era lida até a 3ª volta — e, se o SDR voltasse, ficava no report.
     */
    const garantirMesmaConversa = () => {
      const jid = jidPredominante(root);
      if (alvoJid && jid) {
        if (jid !== alvoJid) throw new Error(MSG_CONVERSA_MUDOU);
        return true;
      }
      if (!alvoNome) return true;
      const nome = nomeDoContato();
      const outra = nome !== alvoNome; // cabeçalho vazio (trocando de conversa) também não é esta
      divergenciasDeNome = outra ? divergenciasDeNome + 1 : 0;
      if (divergenciasDeNome >= 3) throw new Error(MSG_CONVERSA_MUDOU);
      return !outra;
    };

    const scroller = acharScroller(acharMensagens(root)[0]);
    const mapa = new Map(); // chave -> registro (ordem = primeira aparição top→bottom)
    const audioBytes = new Map(); // chave (data-id) -> base64 do áudio capturado
    let seq = 0;

    const capturar = () => {
      if (!garantirMesmaConversa()) return; // outra conversa na tela: não lê nada dela
      const els = acharMensagens(root);
      const chaves = chavesDasMensagens(els); // a mesma chave da captura do áudio
      els.forEach((el, i) => {
        const reg = extrairMensagem(el);
        if (!reg) return;
        const chave = chaves[i];
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
            audiosLidos.set(conversaDaLeitura + '|' + chave, reg.content); // a leitura rápida da tela usa sem transcrever de novo
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
    if (!stats.audios) logA('nenhum áudio reconhecido; bolhas sem texto na tela:', JSON.stringify(diagnosticoDeAudio(root)));

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
      // O que vai junto com o report (o lead no CRM e o formulário) sai AGORA, da conversa do report. Lido no fim,
      // depois de minutos de leitura e transcrição, podia ser o cartão de outro lead (o SDR já em outra conversa).
      const fichaDoJob = conversaDoJob && ficha.ultimoEstado && ficha.ultimoEstado.tipo === 'ok' && ficha.chave === chaveDaConversa(conversaDoJob) ? ficha.ultimoEstado : null;
      const vinculoDoJob = fichaDoJob ? vinculoDoLead(fichaDoJob) : conversaDoJob && conversaDoJob.telefone ? { telefone: String(conversaDoJob.telefone), email: '', contatoId: '', dealId: '' } : null;
      const formularioDoJob = fichaDoJob ? formularioDoLead(fichaDoJob) : null;
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
        chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality, vinculo: vinculoDoJob, formulario: formularioDoJob }, resolve)
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
          chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality, forcarNovo: true, vinculo: vinculoDoJob, formulario: formularioDoJob }, resolve)
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
      if (s.closest('#pane-side, #main, #' + FICHA_ID + ', #closer-report-badge, [contenteditable="true"]')) continue;
      const t = (s.getAttribute('title') || s.textContent || '').trim();
      if (!/^\+\d{1,3}[\d\s().-]{8,20}$/.test(t)) continue;
      const d = t.replace(/\D/g, '');
      achados.set(d.slice(-8), d);
      if (achados.size > 1) return '';
    }
    return achados.size === 1 ? [...achados.values()][0] : '';
  }
  const ficha = {
    ligada: true, cartaoLocal: true, minimizada: false, chave: null, fechadaPara: null, seq: 0, timer: null, vigia: null, ultimoEstado: null,
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
  function vinculoDoLead(est = ficha.ultimoEstado) {
    const f = est && est.ficha && typeof est.ficha === 'object' ? est.ficha : null;
    const escolhido = f ? (f.negociacoes || []).find((c) => c && c.escolhida) : null;
    return {
      telefone: String((ficha.conversa && ficha.conversa.telefone) || (f && (f.telefones || [])[0]) || ''),
      email: String((f && (f.emails || [])[0]) || ''),
      contatoId: String((f && f.contatoId) || ''),
      dealId: String((escolhido && escolhido.id) || ''),
    };
  }
  /**
   * O que o formulário do lead no RD diz e o report pode usar: hoje, a profissão (inteira, sem encurtar).
   * O servidor só põe no PDF de quem tem "Profissão no report" ligado.
   */
  function formularioDoLead(est = ficha.ultimoEstado) {
    const f = est && est.ficha && typeof est.ficha === 'object' ? est.ficha : null;
    if (!f) return null;
    const campos = ((f.formulario && f.formulario.campos) || []).concat(f.campos || []);
    const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const c = campos.find((x) => x && /profiss|ocupac/.test(semAcento(x.rotulo)) && String(x.valor || '').trim() && !/\{\{/.test(String(x.valor || '')));
    return c ? { profissao: String(c.valor).replace(/\s+/g, ' ').trim().slice(0, 120) } : null;
  }
  // Leitura do agendamento e do "lead respondeu" (agenda.js, carregado antes deste arquivo).
  const agendaLib = (typeof globalThis !== 'undefined' && globalThis.__crAgenda) || null;
  // Painel lateral do Chrome (sidepanel.html): recebe o mesmo estado do cartão do lead, via service worker.
  const PAINEL_SEM_CONVERSA = { tipo: 'sem-conversa' };
  let painelEnviado; // o último estado mandado (o cartão se redesenha muito com o MESMO estado)
  let painelPodia = false; // os botões que escrevem no CRM (o mesmo acesso do Desqualificar: a automação do cartão)
  function publicarPainel(estado) {
    if (estado === painelEnviado && painelPodia === (ficha.automacao === true)) return;
    painelEnviado = estado;
    painelPodia = ficha.automacao === true; // no Report PRONIX, os botões que escrevem no CRM vêm com a automação do cartão
    try {
      chrome.runtime.sendMessage({ action: 'painelEstado', estado: estado ? { ...estado, podeEscrever: painelPodia } : null }, () => void chrome.runtime.lastError);
    } catch (_) {
      /* extensão recarregada: este script ficou órfão */
    }
  }
  /** Manda de novo o que está na tela (botão Atualizar do painel, aba que voltou a ficar visível). */
  function republicarPainel() {
    painelEnviado = undefined;
    if (!document.querySelector('#main')) return ficha.crmLigado === true ? publicarPainel(PAINEL_SEM_CONVERSA) : null;
    if (ficha.ultimoEstado) atualizarPainel(ficha.ultimoEstado);
  }
  /** O painel mostra o lead só para quem tem a ficha do CRM (o servidor diz em "configurado"). */
  function atualizarPainel(estadoDoCartao) {
    if (!ficha.ligada || ficha.crmLigado === false || !estadoDoCartao || estadoDoCartao.tipo === 'sem-crm') return publicarPainel(null);
    if (ficha.crmLigado !== true && estadoDoCartao.tipo === 'carregando') return; // ainda não se sabe se este usuário tem CRM
    publicarPainel(estadoDoCartao);
  }

  // Abriu uma conversa pela lista do WhatsApp: o painel lateral abre junto. O Chrome só deixa abrir o painel num
  // clique da pessoa — e é esse clique que vale. Já aberto, ele só segue mostrando o lead da conversa nova.
  const LISTA_DE_CONVERSAS = '#pane-side, [aria-label="Lista de conversas"], [aria-label="Chat list"]';
  document.addEventListener('click', (ev) => {
    try {
      if (!ficha.ligada || ficha.crmLigado === false) return;
      if (!ev.target || !ev.target.closest || !ev.target.closest(LISTA_DE_CONVERSAS)) return;
      chrome.runtime.sendMessage({ action: 'abrirPainel', automatico: true }, () => void chrome.runtime.lastError);
    } catch (_) {
      /* extensão recarregada */
    }
  }, true);
  function abrirPainelDoChrome() {
    try {
      chrome.runtime.sendMessage({ action: 'abrirPainel' }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) {
          mostrarBadge({ texto: '<b>Painel lateral:</b> clique no ícone da extensão e em "Abrir painel lateral do CRM".' });
        }
      });
    } catch (_) {
      /* órfão */
    }
  }
  const auto = { assinatura: '', tentados: new Set() };
  // Resumo rápido por conversa (só na memória desta aba): some ao recarregar o WhatsApp.
  const resumos = new Map();
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
      // A conversa lida (com os áudios já transcritos) fica na memória desta aba: o mapa e as perguntas usam
      // ela, sem reler nem retranscrever. Nada disso é guardado em disco.
      resumos.set(chave, {
        tipo: 'ok', dados: r.resumo, nome,
        mensagens: mensagens.slice(-1500).map(({ from, type, content, timestamp }) => ({ from, type: type === 'audio' ? 'audio' : 'texto', content, timestamp })),
        mapa: null, perguntas: [], rascunho: '',
      });
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

  /** Os pontinhos no canto do topo: avisam que o popup pode ser arrastado. */
  const pegador = () => elem('span', 'flex:none;color:#a39e93;font-size:14px;line-height:1;letter-spacing:-1px', '⠿');

  /**
   * Arrastar pelo topo muda o popup de lugar (fica guardado); duplo clique devolve ao lugar padrão.
   * `dono` é quem guarda a posição (a ficha), `chave` o nome no storage e `posicionar` reaplica na tela.
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

  // ---------------------------------------------------------------------------
  // Depois do resumo rápido: o "mapa da conversa" (o que já foi perguntado e respondido) e perguntas livres.
  // Conversa com áudios longos não se reouve: a IA lê tudo e responde, citando quem disse o quê.
  // ---------------------------------------------------------------------------
  const VEREDITO = { sim: ['Sim', '#3ddc84'], parcial: ['Em parte', '#ffc233'], nao: ['Não', '#ff6f5c'], aberta: ['', '#f3efe6'] };
  const PERGUNTAS_RAPIDAS = ['Já está qualificado financeiramente?', 'Já perguntei do decisor?', 'Já falei de prazo e pagamento?', 'O que ele quer com o projeto?'];

  function pedirMapa(chave) {
    const r = resumos.get(chave);
    if (!r || r.tipo !== 'ok' || (r.mapa && r.mapa.tipo === 'carregando')) return;
    r.mapa = { tipo: 'carregando' };
    redesenharFicha();
    try {
      chrome.runtime.sendMessage({ action: 'conversaMapa', mensagens: r.mensagens, nome: r.nome }, (resp) => {
        if (chrome.runtime.lastError) return;
        r.mapa = resp && resp.ok
          ? { tipo: 'ok', itens: resp.mapa || [], qualificado: resp.qualificadoFinanceiramente || 'nao' }
          : { tipo: 'erro', erro: (resp && resp.erro) || 'Não consegui mapear a conversa.' };
        if (ficha.chave === chave) redesenharFicha();
      });
    } catch (_) {
      /* extensão recarregada */
    }
  }

  function perguntarNaConversa(chave, pergunta) {
    const r = resumos.get(chave);
    const p = String(pergunta || '').trim();
    if (!r || r.tipo !== 'ok' || p.length < 3) return;
    const item = { pergunta: p, tipo: 'carregando' };
    r.perguntas.unshift(item);
    r.perguntas.length = Math.min(r.perguntas.length, 6);
    r.rascunho = '';
    redesenharFicha();
    try {
      chrome.runtime.sendMessage({ action: 'conversaPergunta', mensagens: r.mensagens, nome: r.nome, pergunta: p }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok) Object.assign(item, { tipo: 'ok', veredito: resp.veredito, resposta: resp.resposta, evidencias: resp.evidencias || [] });
        else Object.assign(item, { tipo: 'erro', erro: (resp && resp.erro) || 'Não consegui responder.' });
        if (ficha.chave === chave) redesenharFicha();
      });
    } catch (_) {
      /* extensão recarregada */
    }
  }

  const rotuloPequeno = 'font-size:10.5px;color:#a39e93;text-transform:uppercase;letter-spacing:.1em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif';

  function blocoMapa(r) {
    const caixa = elem('div', 'margin-top:10px;padding-top:8px;border-top:1px solid #3a373f');
    caixa.id = 'cr-mapa';
    if (!r.mapa) {
      const b = botaoFicha('Mapear a conversa', () => pedirMapa(ficha.chave));
      b.title = 'Mostra o que você já perguntou e o que o lead respondeu: investimento, decisor, momento, objetivo, prazo, pagamento e reunião';
      caixa.appendChild(b);
      return caixa;
    }
    caixa.appendChild(elem('div', rotuloPequeno, 'Mapa da conversa'));
    if (r.mapa.tipo === 'carregando') {
      caixa.appendChild(elem('div', 'color:#a39e93;margin-top:4px', 'Lendo a conversa toda…'));
      return caixa;
    }
    if (r.mapa.tipo === 'erro') {
      caixa.appendChild(elem('div', 'color:#ff6f5c;margin:4px 0', r.mapa.erro));
      caixa.appendChild(botaoFicha('Tentar de novo', () => pedirMapa(ficha.chave)));
      return caixa;
    }
    const [qRot, qCor] = VEREDITO[r.mapa.qualificado] || VEREDITO.nao;
    caixa.appendChild(elem('div', `margin:4px 0 6px;font-weight:700;color:${qCor}`, 'Qualificado financeiramente: ' + qRot));
    r.mapa.itens.forEach((it) => {
      const [simbolo, cor] = it.respondeu === 'sim' ? ['✓', '#3ddc84'] : it.respondeu === 'parcial' ? ['◐', '#ffc233'] : it.perguntou === 'sim' ? ['?', '#ff6f5c'] : ['–', '#6f6b75'];
      const estado = it.respondeu === 'sim' ? '' : it.respondeu === 'parcial' ? 'respondeu em parte' : it.perguntou === 'sim' ? 'perguntou, sem resposta' : 'ainda não perguntado';
      const linha = elem('div', 'display:flex;gap:6px;margin-top:4px;font-size:12px');
      linha.appendChild(elem('span', `flex:none;width:12px;color:${cor};font-weight:800`, simbolo));
      const texto = elem('div', 'flex:1;min-width:0');
      texto.appendChild(elem('div', 'font-weight:600', it.nome));
      const detalhe = [estado, it.resumo && it.resumo !== estado ? it.resumo : ''].filter(Boolean).join(' · ');
      if (detalhe) texto.appendChild(elem('div', 'color:#a39e93', detalhe));
      if (it.evidencia) {
        const e = elem('div', 'color:#d5d0c5;font-style:italic', '“' + it.evidencia + '”' + (it.quando ? ' · ' + it.quando : ''));
        e.title = 'O que o lead escreveu ou disse';
        texto.appendChild(e);
      }
      linha.appendChild(texto);
      caixa.appendChild(linha);
    });
    return caixa;
  }

  function blocoPerguntas(r) {
    const caixa = elem('div', 'margin-top:10px;padding-top:8px;border-top:1px solid #3a373f');
    caixa.id = 'cr-perguntas';
    caixa.appendChild(elem('div', rotuloPequeno, 'Pergunte sobre a conversa'));
    const rapidas = elem('div', 'display:flex;flex-wrap:wrap;gap:5px;margin:5px 0');
    PERGUNTAS_RAPIDAS.forEach((q) => {
      const b = botaoFicha(q, () => perguntarNaConversa(ficha.chave, q));
      b.style.fontSize = '11px';
      rapidas.appendChild(b);
    });
    caixa.appendChild(rapidas);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'cr-pergunta-texto';
    input.maxLength = 300;
    input.placeholder = 'Ex.: ele disse quem decide?';
    input.value = r.rascunho || '';
    input.style.cssText = 'flex:1;min-width:0;background:#121113;color:#f3efe6;border:1px solid #3a373f;border-radius:7px;padding:6px 8px;font:inherit;font-size:12px';
    input.addEventListener('input', () => { r.rascunho = input.value; });
    const enviar = () => perguntarNaConversa(ficha.chave, input.value);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); enviar(); } });
    ['keyup', 'keypress'].forEach((nome) => input.addEventListener(nome, (ev) => ev.stopPropagation())); // o WhatsApp não pode roubar as teclas
    const enviarBtn = botaoFicha('Perguntar', enviar, true);
    enviarBtn.id = 'cr-pergunta-enviar';
    caixa.appendChild(elem('div', 'display:flex;gap:6px', input, enviarBtn));
    (r.perguntas || []).forEach((p) => {
      const bloco = elem('div', 'margin-top:8px;padding:6px 8px;background:#1d1c1f;border-radius:7px');
      bloco.appendChild(elem('div', 'font-size:11px;color:#a39e93', 'Você: ' + p.pergunta));
      if (p.tipo === 'carregando') bloco.appendChild(elem('div', 'color:#a39e93;margin-top:3px', 'Lendo a conversa…'));
      else if (p.tipo === 'erro') bloco.appendChild(elem('div', 'color:#ff6f5c;margin-top:3px', p.erro));
      else {
        const [rot, cor] = VEREDITO[p.veredito] || VEREDITO.aberta;
        const linha = elem('div', 'margin-top:3px');
        if (rot) linha.appendChild(elem('span', `font-weight:800;color:${cor}`, rot + '. '));
        linha.appendChild(document.createTextNode(p.resposta));
        bloco.appendChild(linha);
        (p.evidencias || []).forEach((e) => bloco.appendChild(elem('div', 'margin-top:3px;font-size:11.5px;color:#d5d0c5;font-style:italic', (e.quem === 'voce' ? 'Você' : 'Lead') + (e.quando ? ' (' + e.quando + ')' : '') + ': “' + e.trecho + '”')));
      }
      caixa.appendChild(bloco);
    });
    return caixa;
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
    // Conversa lida: dá para mapear o que já foi perguntado e perguntar qualquer coisa sobre ela.
    if (r.mensagens && r.mensagens.length) {
      caixa.appendChild(blocoMapa(r));
      caixa.appendChild(blocoPerguntas(r));
    }
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
    const chaves = chavesDasMensagens(els);
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      try {
        if (ehAudio(el)) {
          // Áudio que uma leitura completa já transcreveu nesta aba entra com o texto; senão, como [áudio].
          const lido = audiosLidos.get(conversaDaTela() + '|' + chaves[i]) || '';
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

  /**
   * Lead respondeu a ESTA tentativa de contato e o card ainda está antes de "Respondeu": pede ao servidor para avançar
   * no RD (uma vez por card). Só conta resposta com data depois de o card entrar na tentativa atual (contatoDesde, que
   * vem do CRM): numa recuperação, a conversa traz o histórico antigo, em que o lead respondeu meses atrás — isso não
   * move nada. Sem essa data na ficha, não move. O servidor confere a data de novo antes de mexer no card.
   */
  function avancarParaRespondeu(est, mensagens) {
    if (est.tipo !== 'ok' || !est.podeResponder || !agendaLib || !agendaLib.respostaDepoisDe) return;
    const card = ((est.ficha && est.ficha.negociacoes) || []).find((c) => c.escolhida);
    if (!card || !card.id || auto.tentados.has(card.id)) return;
    const resposta = agendaLib.respostaDepoisDe(mensagens, Date.parse(card.contatoDesde || ''));
    if (!resposta) return;
    auto.tentados.add(card.id);
    const b = est.busca || {};
    try {
      chrome.runtime.sendMessage({ action: 'crmRespondeu', telefone: b.telefone || '', nome: b.nome || '', contatoId: b.contatoId || '', dealId: card.id, respostaEm: new Date(resposta.em).toISOString() }, (r) => {
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
    // O "Respondeu" roda para todos (só precisa do card poder ir); agendamento e etiquetas, só com a automação.
    if (!agendaLib || !est || est.tipo === 'carregando' || jobEmAndamento) return;
    if (!ficha.automacao && !est.podeResponder) return;
    // O contato no topo tem de ser o da ficha: mensagem de outro lead nunca vale para este.
    if (ficha.conversa && ficha.conversa.nome && conversaDaTela() && conversaDaTela() !== ficha.conversa.nome) return;
    // Mover para "Respondeu" espera a conversa nova assentar na tela (as mensagens da anterior podem ainda estar ali);
    // adiado, tenta de novo no próximo tique.
    const assentou = Date.now() - (ficha.trocouEm || 0) >= 1500;
    const els = acharMensagens(document.querySelector('#main') || document);
    const ultimo = els.length ? els[els.length - 1] : null;
    const assinatura = [ficha.seq, els.length, ultimo ? ultimo.getAttribute('data-id') || (ultimo.textContent || '').length : ''].join('|');
    if (assinatura === auto.assinatura && !(auto.moverAdiado && assentou)) return;
    const repetida = assinatura === auto.assinatura;
    auto.assinatura = assinatura;
    const mensagens = mensagensVisiveis(els);
    auto.moverAdiado = !assentou;
    if (assentou) avancarParaRespondeu(est, mensagens);
    if (repetida) return; // só voltou para tentar mover: o resto já rodou com estas mensagens
    anotarAgendamento(mensagens, ficha.conversa);
    if (ficha.automacao) anotarAtividade(mensagens, ficha.conversa);
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
    const nota = String(d.nota || '').replace(/\s+/g, ' ').trim();
    if (precisaNota(d) && nota.length < NOTA_DESQ) {
      d.erro = `Escreva o que o lead disse: pelo menos ${NOTA_DESQ} caracteres (faltam ${NOTA_DESQ - nota.length}).`;
      redesenharFicha();
      return;
    }
    d.enviando = true;
    d.erro = '';
    redesenharFicha();
    const b = estado.busca || {};
    try {
      chrome.runtime.sendMessage({ action: 'crmDesqualificar', telefone: b.telefone || '', nome: b.nome || '', contatoId: b.contatoId || '', dealId: card.id, motivoId: d.escolhido.id, nota }, (r) => {
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
          // O CRM pediu a anotação (motivo que não veio marcado como desqualificação): abre o campo.
          if (/50 caracteres|conte o que o lead disse|o que o lead disse|OBSERVACAO_OBRIGATORIA/i.test(d.erro)) d.pedirNota = true;
        }
        if (ficha.ultimoEstado === estado) redesenharFicha();
      });
    } catch (_) {
      /* extensão recarregada */
    }
  }
  /** A caixinha do "Desqualificar": a lista de motivos e, escolhido um, a confirmação. */

  // ---------------------------------------------------------------- sugestão de motivo e anotação
  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const diaBR = (iso) => `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}`;
  /**
   * Sem IA: o lead não responde há 3 ou mais tentativas suas (em dias diferentes, quando a tela mostra a data) depois
   * da última mensagem dele. Escolhe o motivo de "não respondeu" do CRM e escreve a anotação com as datas.
   */
  function sugestaoPorRegra(msgs, motivos) {
    const lista = (msgs || []).filter(Boolean);
    let i = lista.length - 1;
    const minhas = [];
    while (i >= 0 && lista[i].from === 'eu') { minhas.unshift(lista[i]); i--; }
    const leadFalou = i >= 0;
    const comData = minhas.some((m) => m.timestamp);
    const dias = [...new Set(minhas.map((m) => (m.timestamp ? String(m.timestamp).slice(0, 10) : '')).filter(Boolean))];
    const tentativas = comData ? dias.length : minhas.length;
    if (tentativas < 3) return null;
    const achar = (re) => (motivos || []).find((m) => re.test(semAcento(m.nome)));
    const motivo = (!leadFalou && achar(/nunca respond/)) || achar(/parou de respond|sem resposta|nao respond|deixou de respond|sumiu|nunca respond/);
    if (!motivo) return null;
    const quando = dias.length ? ` (${dias.map(diaBR).join(', ')})` : '';
    const ultima = !leadFalou ? ' O lead nunca respondeu.' : lista[i].timestamp ? ` A última mensagem do lead foi em ${diaBR(String(lista[i].timestamp).slice(0, 10))}.` : '';
    return {
      motivo,
      nota: `Lead não respondeu após ${tentativas} tentativas de recontato${quando}.${ultima} Perda por falta de retorno.`,
      porque: `${tentativas} tentativas sem resposta (regra, sem IA)`,
    };
  }
  /** Botão "Sugerir motivo e anotação": a regra resolve o "não responde"; o resto vai à IA gratuita do servidor. */
  function sugerirDesqualificacao(estado) {
    const d = estado.desq;
    if (!d || !d.motivos || d.sugerindo) return;
    let msgs = [];
    try {
      msgs = mensagensVisiveis(acharMensagens(document.querySelector('#main') || document));
    } catch (_) {
      msgs = [];
    }
    const regra = sugestaoPorRegra(msgs, d.motivos);
    const aplicar = (motivo, nota, porque) => {
      d.escolhido = motivo;
      d.nota = nota || '';
      d.sugerida = true;
      d.porque = porque || '';
      d.erro = '';
    };
    if (regra) {
      aplicar(regra.motivo, regra.nota, regra.porque);
      redesenharFicha();
      return;
    }
    d.sugerindo = true;
    d.erro = '';
    redesenharFicha();
    const enviar = msgs.filter((m) => m && m.content).slice(-60).map((m) => ({ from: m.from, content: String(m.content).slice(0, 400), timestamp: m.timestamp || null }));
    try {
      chrome.runtime.sendMessage({ action: 'crmSugestaoDesq', mensagens: enviar }, (r) => {
        if (chrome.runtime.lastError || !estado.desq) return;
        d.sugerindo = false;
        const motivo = r && r.ok && d.motivos.find((m) => String(m.id) === String(r.motivoId));
        if (motivo) aplicar(motivo, r.nota, r.porque ? r.porque + ' (IA gratuita)' : 'sugestão da IA gratuita');
        else d.erro = (r && r.erro) || 'Não consegui sugerir. Escolha o motivo à mão.';
        if (ficha.ultimoEstado === estado) redesenharFicha();
      });
    } catch (_) {
      d.sugerindo = false;
    }
  }
  const NOTA_DESQ = 50;
  /** O motivo escolhido pede a anotação: é de desqualificação, ou o CRM já respondeu que falta ela. */
  const precisaNota = (d) => Boolean(d && d.escolhido && (d.escolhido.tipo === 'desqualificacao' || d.pedirNota));
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
      // Motivo de desqualificação: o CRM exige a anotação do que o lead disse (50+ caracteres).
      if (d.porque) caixa.appendChild(elem('div', 'font-size:11px;color:#3ddc84;margin:-4px 0 6px', 'Sugestão: ' + d.porque + '. Confira antes de confirmar.'));
      if (precisaNota(d) || d.sugerida) {
        const conta = () => {
          const n = String(d.nota || '').replace(/\s+/g, ' ').trim().length;
          return n >= NOTA_DESQ ? `${n} caracteres ✓` : `${n}/${NOTA_DESQ} caracteres (faltam ${NOTA_DESQ - n})`;
        };
        caixa.appendChild(elem('div', 'font-size:12px;margin-bottom:4px;color:#a39e93', 'O que o lead disse (o CRM pede pelo menos 50 caracteres):'));
        const ta = document.createElement('textarea');
        ta.id = 'cr-desq-nota';
        ta.style.cssText = 'width:100%;box-sizing:border-box;min-height:70px;background:#121113;color:#f3efe6;border:1px solid #3a373f;border-radius:6px;padding:6px;font:12px/1.4 inherit;resize:vertical';
        ta.placeholder = 'Ex.: disse que não tem o investimento agora e que só vai pensar nisso no ano que vem.';
        ta.value = d.nota || '';
        const contador = elem('div', 'font-size:11px;color:#a39e93;margin:3px 0 8px', conta());
        contador.id = 'cr-desq-nota-conta';
        ta.addEventListener('input', () => { d.nota = ta.value; contador.textContent = conta(); });
        ta.addEventListener('focus', () => { d.focoNota = true; });
        ta.addEventListener('keydown', (ev) => ev.stopPropagation()); // atalhos do WhatsApp não roubam a digitação
        caixa.appendChild(ta);
        caixa.appendChild(contador);
        // O cartão se redesenha quando algo muda: quem estava escrevendo continua no campo.
        if (d.focoNota) setTimeout(() => { if (document.body.contains(ta)) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 0);
      }
      if (d.enviando) caixa.appendChild(elem('div', 'font-size:12px;color:#a39e93', 'Dando perda no RD…'));
      else {
        const acoes = elem('div', 'display:flex;gap:6px');
        const sim = botao('Confirmar perda', 'border:0;background:#ff6f5c;color:#18171b;font-weight:700', () => confirmarDesqualificar(estado, card));
        sim.id = 'cr-desq-confirmar';
        acoes.appendChild(sim);
        acoes.appendChild(botao('Voltar', 'border:1px solid #55515b;background:transparent;color:#f3efe6', () => { d.escolhido = null; d.erro = ''; d.pedirNota = false; d.focoNota = false; d.sugerida = false; d.porque = ''; redesenharFicha(); }));
        caixa.appendChild(acoes);
      }
    } else {
      caixa.appendChild(elem('div', 'font-size:12px;margin-bottom:6px;color:#a39e93', 'Por que desqualificar? O card vira perda no RD com este motivo.'));
      if (d.motivos) {
        const sug = botao(d.sugerindo ? 'Lendo a conversa…' : '✨ Sugerir motivo e anotação', 'border:1px solid #3ddc84;background:transparent;color:#3ddc84;font-weight:700;margin-bottom:6px', () => sugerirDesqualificacao(estado));
        sug.id = 'cr-desq-sugerir';
        sug.title = 'Lê as mensagens da tela: lead sem resposta há 3+ tentativas sai por regra; o resto, pela IA gratuita';
        caixa.appendChild(sug);
      }
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
    atualizarPainel(estado); // o painel lateral acompanha o cartão, mesmo com o cartão fechado nesta conversa
    if (!ficha.cartaoLocal) {
      // Cartão desmarcado no menu da extensão: o lead fica só no painel lateral — e a automação ("Respondeu",
      // contagem do dia) segue igual.
      ficha.ultimoEstado = estado;
      esconderFicha();
      return;
    }
    if (ficha.fechadaPara && ficha.fechadaPara === ficha.chave) return;
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
        elem('div', 'font-size:10.5px;color:#ffc233;font-weight:600;letter-spacing:.14em;font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif', semCrm ? 'PRONIX' : String((estado.ficha && estado.ficha.crmNome) || 'RD Station').toUpperCase()),
        elem('div', 'font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', titulo))
    );
    alca.title = 'Arraste para mudar de lugar (duplo clique volta ao lugar padrão)';
    tornarArrastavel(el, alca, { dono: ficha, chave: 'fichaPos', posicionar: posicionarFicha });
    const btnPainel = botaoFicha('▤', abrirPainelDoChrome);
    btnPainel.title = 'Abrir o painel lateral do CRM (barra do Chrome)';
    btnPainel.setAttribute('data-abrir-painel', '1');
    el.appendChild(elem('div', 'display:flex;align-items:center;gap:6px', alca, btnPainel, btnMin, btnX));
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
    if (n && /^https:\/\/(crm\.rdstation\.com|crm\.pronixhub\.com\.br)\//.test(n.url || '')) {
      const a = elem('a', 'display:inline-block;margin-top:8px;color:#ffc233;font-weight:600;text-decoration:none', `Abrir no ${(estado.ficha && estado.ficha.crmNome) || 'RD Station'} ↗`);
      a.href = n.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      corpo.appendChild(a);
    }
  }

  // Fichas que esta aba já buscou (10 min): voltar a uma conversa mostra o lead na hora; a busca nova só atualiza.
  const fichasRecentes = new Map();
  const chaveDaBusca = (b) => JSON.stringify([b.telefone || '', b.nome || '', b.contatoId || '', b.dealId || '']);
  async function consultarFicha(busca) {
    const seq = ++ficha.seq;
    const guardada = fichasRecentes.get(chaveDaBusca(busca));
    const mostrada = guardada && Date.now() - guardada.em < 10 * 60 * 1000 ? guardada.json : '';
    if (mostrada) mostrarResposta(JSON.parse(mostrada), busca);
    else renderFicha({ tipo: 'carregando', busca });
    let r;
    try {
      r = await new Promise((res) => chrome.runtime.sendMessage({ action: 'crmLead', ...busca, ...(ficha.conversa ? { conversa: ficha.conversa } : {}) }, res));
    } catch (_) {
      // Extensão atualizada/recarregada: este script ficou órfão. Para de vigiar em silêncio.
      clearInterval(ficha.vigia);
      esconderFicha();
      publicarPainel(null);
      return;
    }
    if (seq !== ficha.seq) return; // resposta de uma conversa que o SDR já deixou
    const json = r && r.ok ? JSON.stringify(r) : '';
    if (json) {
      fichasRecentes.set(chaveDaBusca(busca), { json, em: Date.now() });
      if (fichasRecentes.size > 200) fichasRecentes.delete(fichasRecentes.keys().next().value);
    }
    // Veio igual ao que já está na tela: o cartão fica como está (e o que o SDR estava fazendo nele também).
    if (mostrada && json === mostrada) return;
    mostrarResposta(r, busca);
  }

  /** Desenha o cartão (e o painel lateral) com a resposta do servidor — a nova ou a guardada desta aba. */
  function mostrarResposta(r, busca) {
    if (!r || !r.ok) return renderFicha({ tipo: 'erro', erro: (r && r.erro) || 'Não consegui consultar o RD Station.', busca });
    // Automação (mover para "Respondeu", etiqueta e agendamento): o servidor diz se o master ligou para esta chave.
    ficha.automacao = r.automacao === true;
    ficha.etiquetas = r.etiquetas === true; // etiquetas do formulário: permissão própria
    // podeResponder vem para todos (o "Respondeu" automático não depende da automação); marca e reunião, só com ela.
    const extras = ficha.automacao ? { marca: r.marca || null, podeResponder: r.podeResponder === true, reuniao: r.reuniao || null } : { podeResponder: r.podeResponder === true };
    // Sem ficha do CRM para este usuário (CRM desligado no servidor ou popup do lead desligado): sem cartão.
    ficha.crmLigado = r.configurado === true;
    if (!r.configurado) publicarPainel(null);
    if (!r.configurado) return esconderFicha();
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
      if (ficha.crmLigado === true) publicarPainel(PAINEL_SEM_CONVERSA);
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
      // A cada volta do vigia (0,4 s): a automação (Respondeu, etiqueta) é leve — só trabalha quando a tela mudou.
      automatizar();
      return;
    }
    ficha.chave = chave;
    ficha.conversa = { telefone, nome };
    ficha.trocouEm = Date.now(); // a automação espera a conversa nova assentar na tela
    ficha.ultimoEstado = null; // o que estava na tela era da conversa anterior
    ficha.fechadaPara = null;
    clearTimeout(ficha.timer);
    // O painel troca na hora para o lead novo ("buscando…"), sem esperar a resposta do CRM.
    if (ficha.crmLigado === true) publicarPainel({ tipo: 'carregando', busca: { telefone, nome } });
    ficha.timer = setTimeout(() => consultarFicha({ telefone, nome: telefone && nome.replace(/\D/g, '') === telefone ? '' : nome }), 150);
  }

  try {
    chrome.storage.local.get({ fichaCrm: true, fichaCrmMinimizada: false, fichaPos: null }, (c) => {
      const lugar = (p) => (p && Number.isFinite(p.left) && Number.isFinite(p.top) ? { left: p.left, top: p.top } : null);
      // A opção do menu da extensão esconde só o cartão flutuante: a ficha, o painel lateral, o "Respondeu" automático
      // e a contagem de recontatos rodam sempre (antes, desmarcar para tirar o cartão desligava tudo isso junto).
      ficha.cartaoLocal = c.fichaCrm !== false;
      ficha.minimizada = !!c.fichaCrmMinimizada;
      ficha.pos = lugar(c.fichaPos);
      ficha.vigia = setInterval(() => {
        try {
          verificarConversa();
        } catch (_) {
          /* uma falha de leitura do DOM não pode derrubar o vigia */
        }
      }, 400); // a troca de conversa aparece em menos de meio segundo
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((mud) => {
        if (!mud.fichaCrm) return;
        ficha.cartaoLocal = mud.fichaCrm.newValue !== false;
        if (!ficha.cartaoLocal) esconderFicha();
        else if (ficha.ultimoEstado) renderFicha(ficha.ultimoEstado); // religou: o cartão volta com o lead da tela
      });
    }
  } catch (_) {
    /* sem storage (contexto inválido): sem ficha */
  }


  // ---------------------------------------------------------------------------
  // Aviso de novidades: depois de instalar ou atualizar, uma vez, o que mudou e como usar.
  // ---------------------------------------------------------------------------
  const NOVIDADES_ID = 'pronix-novidades';
  const NOVIDADES = [
    ['"Respondeu" para todos', 'O card passa para "Respondeu" sozinho para todo mundo que usa a ficha do CRM — não depende mais da "Automação RD" liberada pelo master. E a conversa do WhatsApp (com os áudios transcritos) vai para o card do lead no CRM a cada report.'],
    ['Áudios de volta no report', 'Corrigido: o WhatsApp novo baixa os áudios assim que você abre a conversa, e o report deixava esses áudios de fora ("sem blob de áudio"). Agora eles são lidos — e áudio de outra conversa continua sem entrar no report.'],
    ['"Respondeu" sem depender do cartão', 'No menu da extensão, a opção agora é "Mostrar o cartão flutuante": desmarcada, só o cartão some. A ficha no painel lateral, o "Respondeu" automático e as etiquetas continuam funcionando (antes, desmarcar desligava tudo junto).'],
    ['"Respondeu" só com resposta de verdade', 'Corrigido: cards de recuperação iam para "Respondeu" sozinhos, porque a conversa tinha o lead respondendo meses atrás. Agora só conta a resposta do lead DEPOIS que o card entrou na tentativa de contato atual (a data vem do CRM), e o servidor confere a data antes de mover.'],
    ['Botão Atualizar no painel', 'No topo do painel lateral, "↻ Atualizar" puxa de novo as informações do CRM para a conversa aberta. Abriu a conversa e o painel não mostrou o lead? Clique nele. Se nem assim, recarregue o WhatsApp (F5).'],
    ['Painel sempre com o lead certo', 'Corrigido: com outra aba ou janela do WhatsApp aberta, o painel às vezes ficava em "Abra uma conversa". Agora cada aba tem o seu lead.'],
    ['Report sem mistura de leads', 'Corrigido: o report não pega mais áudio nem mensagem de outro lead — acontecia quando você tinha ouvido áudios em outras conversas ou trocava de conversa durante a leitura.'],
    ['Painel lateral do CRM', 'Abre na barra lateral do Chrome: clique no botão ▤ do cartão do lead ou no ícone da extensão → "Abrir painel lateral do CRM". Mostra o lead da conversa aberta, todas as negociações dele (clique numa para abrir o card no CRM), o formulário e as últimas anotações. Ele acompanha quando você troca de conversa.'],
    ['Copiar link do card', 'No painel, embaixo de "Abrir o card no Pronix CRM": o link do card com o botão "Copiar link". É só colar no Pronix Calendar ao criar a reunião.'],
    ['Qualificado ✓', 'O lead qualificou e confirmou a reunião? Clique e o card vai para a etapa de qualificado do funil (ou "Agendou"). O painel mostra o caminho e só move quando você confirma. A etiqueta "Qualificado" do cartão vem junto.'],
    ['Reunião realizada →', 'Depois da reunião: escolha o closer e confirme. O card percorre as etapas do funil até "Reunião realizada" e o report do lead vai como handoff (gere o report antes; sem ele, o painel pede um texto).'],
    ['Perder como duplicado', 'Lead com dois cards em aberto: o botão aparece no mais antigo e marca a perda com o motivo de duplicidade, dizendo em qual card o lead continua.'],
    ['Desqualificar com anotação', 'Motivos de desqualificação pedem que você escreva o que o lead disse (pelo menos 50 caracteres): o campo aparece no cartão, com o contador.'],
    ['Sugerir motivo e anotação', 'No Desqualificar, "✨ Sugerir motivo e anotação" lê a conversa da tela: lead sem resposta há 3 ou mais tentativas sai na hora (sem IA); nos outros casos, a IA gratuita escolhe o motivo e escreve a anotação. Confira e confirme.'],
    ['Handoff + ligação', 'No "Reunião realizada", o texto do report aparece para editar e há um campo para o que veio da ligação: os dois vão juntos para o CRM como handoff.'],
    ['Painel abre junto', 'Clicou numa conversa na lista do WhatsApp, o painel lateral abre junto e já mostra o lead enquanto busca no CRM.'],
    ['Áudios de volta', 'O report voltou a achar e transcrever os áudios no formato novo do WhatsApp.'],
  ];
  function mostrarNovidades(id) {
    if (document.getElementById(NOVIDADES_ID)) return;
    const fechar = () => {
      try {
        chrome.storage.local.set({ novidadesVistas: id });
      } catch (_) {
        /* ok */
      }
      fundo.remove();
    };
    const botao = (texto, cor, fundoCor, aoClicar) => {
      const b = elem('button', `cursor:pointer;border:${fundoCor ? '0' : '1px solid ' + cor};border-radius:9px;padding:10px 14px;background:${fundoCor || 'transparent'};color:${cor};font:700 13px inherit`, texto);
      b.type = 'button';
      b.addEventListener('click', aoClicar);
      return b;
    };
    const lista = elem('div', 'display:grid;gap:10px;margin-top:14px');
    NOVIDADES.forEach(([titulo, texto]) =>
      lista.appendChild(elem('div', 'padding:10px 12px;border-radius:10px;background:#211f24;border:1px solid #3a373f',
        elem('div', 'font-weight:700;color:#ffc233;margin-bottom:3px', titulo),
        elem('div', 'color:#e9e5dc;font-size:13px;line-height:1.45', texto))));
    const caixa = elem('div', 'width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:#1a191c;color:#f3efe6;border:1px solid #3a373f;border-top:4px solid #ffc233;border-radius:14px;padding:20px 22px;font:14px/1.4 Segoe UI,system-ui,-apple-system,Roboto,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.55)',
      elem('div', 'font-size:11px;letter-spacing:.14em;color:#ffc233;font-weight:700', 'NOVIDADES DA EXTENSÃO'),
      elem('div', 'font-size:20px;font-weight:700;margin-top:4px', 'O que mudou e como usar'),
      lista,
      elem('div', 'color:#a39e93;font-size:12px;margin-top:12px', 'Os botões Qualificado, Reunião realizada e Perder como duplicado aparecem para quem tem o acesso liberado pelo master (o mesmo do Desqualificar).'),
      elem('div', 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px',
        botao('Abrir o painel agora', '#ffc233', '', () => { abrirPainelDoChrome(); fechar(); }),
        botao('Entendi', '#18171b', '#ffc233', fechar)));
    const fundo = elem('div', 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center', caixa);
    fundo.id = NOVIDADES_ID;
    fundo.setAttribute('role', 'dialog');
    fundo.setAttribute('aria-label', 'Novidades da extensão');
    fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fechar(); });
    document.body.appendChild(fundo);
  }
  try {
    chrome.storage.local.get({ novidadesPendentes: '', novidadesVistas: '' }, (c) => {
      if (!c || !c.novidadesPendentes || c.novidadesPendentes === c.novidadesVistas) return;
      // Um instante para o WhatsApp montar a tela (e, com as duas extensões, para o Report PRONIX se anunciar).
      setTimeout(() => {
        if (false && document.documentElement.getAttribute('data-report-dono') === 'pronix') return;
        mostrarNovidades(c.novidadesPendentes);
      }, 2500);
    });
  } catch (_) {
    /* sem storage */
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'start') {
      // Dispara em background e responde na hora para o popup poder fechar.
      gerarReportEmBackground(msg.server, { afinidade: msg.afinidade });
      sendResponse({ ok: true, iniciado: true });
      return false;
    }
    if (msg && msg.action === 'painelConsultar') {
      // Busca ou "Tentar de novo" feitos no painel lateral do Chrome.
      consultarFicha({ ...(msg.busca || {}) });
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.action === 'painelAtualizar') {
      // Botão "Atualizar" do painel: lê de novo a conversa aberta e busca o lead no CRM.
      if (!document.querySelector('#main')) {
        republicarPainel();
        sendResponse({ ok: true, semConversa: true });
        return false;
      }
      painelEnviado = undefined;
      ficha.chave = null; // o vigia trata como conversa nova: busca de novo
      ficha.fechadaPara = null;
      try {
        verificarConversa();
      } catch (_) {
        /* o próximo tique do vigia tenta */
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
  });
  // Voltou para esta aba do WhatsApp: o painel lateral recebe de novo o lead que está na tela.
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'visible') republicarPainel();
    } catch (_) {
      /* órfão */
    }
  });

})();
