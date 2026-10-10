// Content script — lê a conversa aberta no Instagram Direct.
// Roda no contexto da página www.instagram.com/direct/*.
//
// O sinal de quem enviou cada mensagem foi descoberto testando ao vivo numa
// conversa real (ver git log) — pode precisar de ajuste se o Instagram mudar a
// estrutura (o CSS deles é atômico/hasheado e muda com frequência, mesmo risco
// já documentado no README para o WhatsApp).
//
// ÁUDIO (fase 2): ao contrário do WhatsApp, aqui não sabíamos de antemão COMO o
// Instagram entrega o arquivo de voz. Em vez de chutar um seletor, a captura
// tenta as formas reais que um navegador tem de expor áudio, em ordem, e valida
// o resultado pelos magic bytes — o que não for áudio de verdade é descartado:
//   1) <audio> da própria bolha com src (blob: ou https:)
//   2) clicar no play e olhar de novo (o src às vezes só existe depois do play)
//   3) fila do gancho URL.createObjectURL (inject.js), igual ao WhatsApp
// Se a 1 e a 2 falharem por CORS (src apontando pro CDN da Meta), o log diz
// exatamente isso — nesse caso o próximo passo é buscar pelo service worker,
// que precisaria de host_permissions do CDN (não pedimos sem necessidade).

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A versão vai em todo log: sem isso não dá pra saber, olhando um print do
  // console, se o SDR está rodando o build novo ou um antigo em cache.
  const VERSAO = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return '?';
    }
  })();
  const MSG_CONVERSA_MUDOU =
    'A conversa mudou durante a leitura, então nenhum report foi gerado. Abra a conversa do lead, espere o aviso "Gerando report…" e tente de novo.';
  const logI = (...a) => console.log(`[CR-instagram v${VERSAO}]`, ...a);
  const logA = (...a) => console.log(`[CR-ig-audio v${VERSAO}]`, ...a);

  // Silencia qualquer <audio> da página: a captura precisa dar play pra
  // materializar o arquivo, e sem isso o áudio tocaria alto pro SDR.
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

  // --- Helpers de áudio -----------------------------------------------------
  // Cópia consciente do que existe em content.js (WhatsApp): são funções puras e
  // já validadas em produção lá. Ficam duplicadas de propósito nesta fase pra não
  // mexer no caminho do WhatsApp, que está estável e não dá pra testar aqui —
  // quando alguém for mexer em áudio do WhatsApp de novo, vale unificar as duas.
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  async function fetchArrayBuffer(url) {
    try {
      return await fetch(url).then((r) => r.arrayBuffer());
    } catch (_) {
      return null; // CORS/rede — quem chama trata como "não consegui por aqui"
    }
  }

  /** Confere pelos magic bytes se o buffer é mesmo áudio (descarta imagem/pdf/etc.). */
  function ehAudioBuffer(buf) {
    if (!buf || buf.byteLength < 800) return false;
    const b = new Uint8Array(buf.slice(0, 12));
    const eq = (i, s) => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
    if (b[0] === 0xff && b[1] === 0xd8) return false; // JPEG
    if (b[0] === 0x89 && eq(1, 'PNG')) return false; // PNG
    if (eq(0, 'GIF8')) return false;
    if (eq(0, '%PDF')) return false;
    if (eq(0, 'RIFF') && eq(8, 'WEBP')) return false; // WebP
    if (eq(0, 'OggS')) return true; // ogg/opus
    if (eq(0, 'ID3')) return true; // mp3 com tag
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // frame mp3
    if (eq(0, 'fLaC')) return true;
    if (eq(0, 'RIFF')) return true; // wav
    if (eq(4, 'ftyp')) return true; // mp4/m4a/aac (formato provável no Instagram)
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // webm/matroska
    if (eq(0, '#!AMR')) return true; // amr
    // Desconhecido: só serve se NÃO for texto (HTML/JSON de erro do CDN) e tiver tamanho plausível de voz.
    const texto = [...new Uint8Array(buf.slice(0, 32))].every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));
    if (texto) return false;
    return buf.byteLength >= 1500 && buf.byteLength < 8000000;
  }

  // Fila de blobs vistos pelo gancho do inject.js (estratégia 3).
  const blobsAudio = [];
  const MAX_BLOBS_FILA = 500;
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.__crAudio && ev.data.url) {
      blobsAudio.push({ url: ev.data.url, ts: ev.data.ts || Date.now() });
      if (blobsAudio.length > MAX_BLOBS_FILA) blobsAudio.shift();
    }
  });

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
    logA(ganchoInstalado() ? 'gancho de áudio ativo' : 'gancho de áudio NÃO instalou (estratégia 3 indisponível)');
    return ganchoInstalado();
  }
  garantirGanchoAudio();

  // Texto de mensagem: candidato bruto. Também casa com nome do contato no
  // cabeçalho e outros textos da tela — por isso NUNCA usamos isto direto no
  // document inteiro; sempre escopado pelo root encontrado em acharRoot().
  const SELETOR_TEXTO = 'div[dir="auto"].html-div';

  /** Sobe os pais até achar o elemento que realmente rola (mesmo truque do content.js do WhatsApp). */
  function acharScroller(el) {
    let n = el ? el.parentElement : null;
    // Conversa curta (cabe inteira na tela): o container de rolagem existe, mas ainda não rola. Sem
    // guardar este, a conversa não era achada ("Não achei a conversa na tela").
    let semRolagem = null;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
        if (n.scrollHeight > n.clientHeight + 20) return n;
        if (!semRolagem) semRolagem = n;
      }
      n = n.parentElement;
    }
    return semRolagem;
  }

  /**
   * Acha o container real da conversa: pega todos os candidatos a mensagem na
   * página inteira, agrupa por qual scroller cada um pertence, e usa o
   * scroller com MAIS candidatos — a lista de conversas (sidebar) e o nome no
   * cabeçalho não ficam dentro do mesmo scroller que o corpo da conversa,
   * então essa contagem naturalmente filtra eles fora sem precisar de um
   * seletor fixo (que o Instagram trocaria a qualquer atualização).
   */
  function acharRoot() {
    const candidatos = [...document.querySelectorAll(SELETOR_TEXTO)];
    const contagem = new Map(); // scroller -> quantidade
    candidatos.forEach((el) => {
      const s = acharScroller(el);
      if (s) contagem.set(s, (contagem.get(s) || 0) + 1);
    });
    let melhor = null;
    let max = 0;
    for (const [scroller, n] of contagem) {
      if (n > max) {
        max = n;
        melhor = scroller;
      }
    }
    return melhor; // null se não achou nenhuma mensagem ainda (conversa vazia ou não carregou)
  }

  /**
   * Quem enviou: sobe os pais a partir do texto e procura o ancestral com
   * flex-direction: row-reverse — é assim que o Instagram empurra a bolha
   * pra direita nas mensagens ENVIADAS por quem está logado. Confirmado
   * comparando mensagens reais enviadas vs. recebidas na mesma conversa.
   * Fallback: se não achar o CSS (Instagram pode trocar a técnica), compara
   * a posição horizontal do texto com o meio do container.
   */
  function ehDeMim(el, root) {
    let n = el;
    for (let i = 0; i < 12 && n && n !== root; i++) {
      const dir = getComputedStyle(n).flexDirection;
      if (dir === 'row-reverse') return true;
      if (dir === 'row' && n !== el) {
        // "row" normal no mesmo nível estrutural onde o enviado tem "row-reverse"
        // é um sinal de recebida — mas só decide se ainda não achamos nada melhor.
      }
      n = n.parentElement;
    }
    // Fallback por posição: a bolha enviada encosta na DIREITA do container, a recebida na esquerda.
    // Compara as folgas dos dois lados (e não "passou do meio"): uma mensagem minha comprida começa
    // antes do meio e seria lida como do lead.
    if (root) {
      const rEl = el.getBoundingClientRect();
      const rRoot = root.getBoundingClientRect();
      return rRoot.right - rEl.right < rEl.left - rRoot.left;
    }
    return false;
  }

  function extrairMensagem(el, root) {
    const texto = (el.textContent || '').trim();
    if (!texto) return null;
    return { from: ehDeMim(el, root) ? 'eu' : 'eles', type: 'texto', content: texto, timestamp: null };
  }

  // --- Áudio: achar, capturar ----------------------------------------------

  // Sinais de que um pedaço da tela é uma mensagem de voz. Amplo de propósito
  // (não sabemos a marcação exata do Instagram): o que não for áudio de verdade
  // morre depois, na validação por magic bytes.
  const SINAIS_AUDIO =
    'audio, [aria-label*="udio" i], [aria-label*="voice" i], [aria-label*="voz" i], [aria-label*="mensagem de v" i]';

  /** "0:12", "1:05" — duração/relógio, não é conteúdo de mensagem. */
  const ehDuracaoOuHora = (t) => /^\d{1,2}:\d{2}(:\d{2})?\s*$/.test((t || '').trim());

  /**
   * Sobe do sinal encontrado até um ancestral que contenha o <audio> — é essa
   * "bolha" que a captura usa pra procurar o player e o botão de play. Para no
   * primeiro que serve, pra não subir demais e pegar DUAS mensagens de voz
   * juntas (aí o áudio capturado seria o da mensagem errada).
   */
  function acharBolhaAudio(hit) {
    if (hit.tagName === 'AUDIO') return hit.parentElement || hit;
    let n = hit;
    for (let i = 0; i < 8 && n; i++) {
      if (n.querySelector && n.querySelector('audio')) return n;
      n = n.parentElement;
    }
    // Sem <audio> ainda (só aparece depois do play): usa um ancestral próximo.
    let sobe = hit;
    for (let i = 0; i < 4 && sobe.parentElement; i++) sobe = sobe.parentElement;
    return sobe;
  }

  /** Acha o controle de play dentro da bolha (pra materializar o arquivo). */
  function acharPlay(bolha) {
    return (
      bolha.querySelector('[aria-label*="reproduzir" i], [aria-label*="play" i], [aria-label*="tocar" i]') ||
      bolha.querySelector('div[role="button"], button, [role="button"]')
    );
  }

  /**
   * Tenta pegar os bytes do áudio desta bolha. Devolve base64 ou null.
   * Estratégias em ordem (ver comentário do topo do arquivo).
   */
  // Qualquer saída (inclusive as antecipadas) deixa o áudio da bolha pausado.
  async function capturarAudio(bolha, dbg, iteracoes = 30) {
    try {
      return await capturarAudioDaBolha(bolha, dbg, iteracoes);
    } finally {
      try {
        bolha.querySelectorAll('audio').forEach((a) => a.pause());
      } catch (_) {
        /* ok */
      }
    }
  }

  async function capturarAudioDaBolha(bolha, dbg, iteracoes) {
    // A fila global é compartilhada por todas as mensagens: só aceita blobs criados
    // a partir deste clique, senão daria pra atribuir o áudio de OUTRA mensagem.
    const t0 = Date.now() - 250;
    // Lê o <audio> DESTA bolha (nunca document.querySelector: pegaria o de outra
    // mensagem). Serve tanto pra blob: quanto pra https:// do CDN.
    const tentarElementoAudio = async () => {
      const a = bolha.querySelector('audio');
      const src = a && (a.currentSrc || a.src || '');
      if (!src) return null;
      silenciar(a);
      const buf = await fetchArrayBuffer(src);
      if (!buf) {
        logA(`${dbg}: <audio> tem src (${src.slice(0, 12)}…) mas o fetch falhou — provável CORS do CDN`);
        return null;
      }
      if (!ehAudioBuffer(buf)) return null;
      logA(`${dbg}: OK via <audio> (${buf.byteLength} bytes, ${src.startsWith('blob:') ? 'blob' : 'url'})`);
      return arrayBufferToBase64(buf);
    };

    // 1) já tem player carregado?
    let b64 = await tentarElementoAudio();
    if (b64) return b64;

    // 2) dá play (no mudo) pra forçar o Instagram a materializar o arquivo
    const play = acharPlay(bolha);
    if (play) {
      try {
        play.click();
      } catch (_) {
        /* ok */
      }
    }

    // 3) espera o arquivo aparecer — no <audio> ou na fila do gancho
    let descartados = 0;
    for (let i = 0; i < iteracoes; i++) {
      b64 = await tentarElementoAudio();
      if (b64) return b64;
      // 1º os arquivos criados a partir deste clique (são desta mensagem por construção). 2º, se nada novo
      // aparecer em ~1s, os que já existiam na fila: o WhatsApp às vezes cria o arquivo ANTES do clique — foi
      // assim que a captura sempre funcionou, e sem isso esses áudios nunca seriam lidos.
      const antigosOk = i >= 6 && !blobsAudio.some((b) => !b.usado && b.ts >= t0);
      for (const b of blobsAudio) {
        if (b.usado || (b.ts < t0 && !antigosOk)) continue;
        b.usado = true;
        const buf = await fetchArrayBuffer(b.url);
        if (ehAudioBuffer(buf)) {
          logA(`${dbg}: OK via gancho (${buf.byteLength} bytes, descartados ${descartados} não-áudio)`);
          return arrayBufferToBase64(buf);
        }
        descartados++;
      }
      await sleep(150);
    }

    // Pausa o que ficou tocando, pra não deixar áudio rodando na tela do SDR.
    try {
      bolha.querySelectorAll('audio').forEach((a) => a.pause());
    } catch (_) {
      /* ok */
    }
    logA(`${dbg}: não consegui os bytes (blobs vistos=${blobsAudio.length}, gancho=${ganchoInstalado()})`);
    return null;
  }

  // O cabeçalho mostra o nome do contato, às vezes junto com status
  // ("Ativo(a) agora", "Ativo(a) há 5 min") — filtra pra não virar o nome.
  const STATUS_CONTATO_IG =
    /^(ativo|online|digitando|visto por [úu]ltimo|[úu]ltima vez|active|typing|last (active|seen))/i;

  function nomeDoContato() {
    const header = document.querySelector('header') || document.body;
    const candidatos = [];
    header.querySelectorAll('span, h1, h2, a').forEach((s) => {
      const t = (s.textContent || '').trim();
      if (t) candidatos.push(t);
    });
    for (const c of candidatos) {
      if (!c || c.length > 60 || STATUS_CONTATO_IG.test(c)) continue;
      return c;
    }
    return '';
  }

  /** Identidade de uma mensagem, pra costurar as janelas de leitura sem duplicar. */
  const chaveMsg = (m) => `${m.from}|${m.type}|${m._dur || ''}|${m.content}`;

  /**
   * Lê o que está no DOM AGORA, em ordem do documento. É uma "janela" da
   * conversa: o Instagram virtualiza a lista, então isso nunca é a conversa
   * inteira — é só o pedaço que existe neste instante.
   */
  function lerJanela(root) {
    const janela = [];
    const bandas = new Set(); // dedup: as várias marcações de uma bolha de voz viram 1 mensagem
    for (const el of root.querySelectorAll(SELETOR_TEXTO + ', ' + SINAIS_AUDIO)) {
      if (el.matches(SELETOR_TEXTO)) {
        const t = (el.textContent || '').trim();
        if (!t) continue;
        if (ehDuracaoOuHora(t)) {
          // "0:12" não é mensagem, mas gruda no áudio anterior: é o que diferencia
          // um áudio do outro na hora de costurar as janelas.
          const ult = janela[janela.length - 1];
          if (ult && ult.type === 'audio' && !ult._dur) ult._dur = t;
          continue;
        }
        const reg = extrairMensagem(el, root);
        if (!reg) continue;
        const topo = el.getBoundingClientRect().top;
        const ant = janela[janela.length - 1];
        // Só descarta se for a MESMA mensagem lida duas vezes (nó dentro do outro, ou na mesma posição da tela).
        // Duas falas iguais em posições diferentes ("ok", "ok") são duas mensagens de verdade.
        if (
          ant &&
          ant.type === 'texto' &&
          ant.from === reg.from &&
          ant.content === reg.content &&
          (ant._el.contains(el) || el.contains(ant._el) || Math.abs(ant._topo - topo) < 6)
        ) {
          continue;
        }
        reg._el = el;
        reg._topo = topo;
        janela.push(reg);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const banda = Math.round(r.top / 8);
      if (bandas.has(banda)) continue;
      bandas.add(banda);
      janela.push({
        from: ehDeMim(el, root) ? 'eu' : 'eles',
        type: 'audio',
        content: '[áudio]',
        timestamp: null,
        _bolha: acharBolhaAudio(el),
        _el: el,
      });
    }
    return janela;
  }

  /**
   * Costura a janela recém-lida no que já temos: acha a maior sobreposição entre
   * o FIM do acumulado e o COMEÇO da janela e só acrescenta o que é novo. Compara
   * sequência (não conjunto), então mensagem repetida na conversa ("kkk" duas
   * vezes) continua aparecendo duas vezes.
   * @returns {Array} só os itens novos (os que acabaram de entrar)
   */
  function mesclarJanela(acumulado, janela) {
    if (!janela.length) return [];
    if (!acumulado.length) {
      acumulado.push(...janela);
      return janela;
    }
    const max = Math.min(acumulado.length, janela.length);
    const sobrepoe = (k, igual) => {
      for (let j = 0; j < k; j++) {
        if (!igual(acumulado[acumulado.length - k + j], janela[j])) return false;
      }
      return true;
    };
    // 1º pelo ELEMENTO: se é o mesmo nó da tela, é a mesma mensagem — resolve falas repetidas
    // ("ok", "ok", "ok") que só pelo texto seriam impossíveis de alinhar.
    // 2º pelo conteúdo: quando o Instagram recriou os elementos.
    const criterios = [(a, b) => a._el && b._el && a._el === b._el, (a, b) => chaveMsg(a) === chaveMsg(b)];
    for (const igual of criterios) {
      for (let k = max; k > 0; k--) {
        if (sobrepoe(k, igual)) {
          const novos = janela.slice(k);
          acumulado.push(...novos);
          return novos;
        }
      }
    }
    // Nenhuma sobreposição: a rolagem pulou um pedaço. Acrescenta tudo — é melhor
    // ter a conversa com um buraco do que perder mensagem.
    acumulado.push(...janela);
    return janela;
  }

  /**
   * Lê a conversa (texto + voz) rolando do topo até o fim e costurando o que
   * aparece em cada passo. A leitura tem que ser progressiva porque o Instagram
   * virtualiza a lista: ao rolar, ele DESTRÓI do DOM as mensagens que saíram da
   * tela — ler tudo de uma vez no final pegaria só o último pedaço.
   * O áudio também é capturado aqui dentro, no passo em que a bolha aparece,
   * pelo mesmo motivo (depois ela não existe mais pra clicar no play).
   */
  async function coletarConversa(server, comAudio) {
    let root = acharRoot();
    if (!root) {
      // Conversa pode não ter renderizado nada ainda — dá uma chance.
      await sleep(800);
      root = acharRoot();
    }
    if (!root) {
      throw new Error('Não achei a conversa na tela. Abra uma conversa no Instagram Direct e tente de novo.');
    }

    if (comAudio) await garantirGanchoAudio();

    // A conversa aberta AGORA é a alvo (o endereço /direct/t/<id>/ muda ao abrir outra). Se mudar
    // durante a leitura, aborta: o report sairia com mensagens de duas pessoas misturadas.
    const alvoCaminho = location.pathname;
    const alvoNome = nomeDoContato();
    const garantirMesmaConversa = () => {
      if (location.pathname !== alvoCaminho) throw new Error(MSG_CONVERSA_MUDOU);
    };

    // A lista do Direct IGNORA escrita em scrollTop (medido ao vivo: pedir
    // scrollTop=2959 deixava em 1). Então a navegação é feita com
    // scrollIntoView na própria mensagem — é o navegador que resolve como
    // rolar, funcione a lista como funcionar.
    const nosBrutos = () => [...root.querySelectorAll(SELETOR_TEXTO + ', ' + SINAIS_AUDIO)];
    const irPara = async (el, bloco, espera = 380) => {
      try {
        el.scrollIntoView({ block: bloco });
      } catch (_) {
        try {
          el.scrollIntoView();
        } catch (__) {
          /* ok */
        }
      }
      await sleep(espera);
      garantirMesmaConversa();
    };

    // 1) Sobe até o topo, ancorando na primeira mensagem renderizada. Cada
    //    subida faz o Instagram carregar mais histórico acima.
    //    Se a primeira mensagem não mudou, pode ser o topo OU o Instagram ainda buscando as mensagens
    //    antigas na rede (conversa longa, internet lenta). Antes de concluir que é o topo, tenta de novo
    //    esperando mais (até ~3,5s no total) — concluir cedo demais é perder o começo da conversa.
    const ESPERAS_TOPO = [700, 1200, 1600];
    let ancora = null;
    let subidas = 0;
    let paciencia = 0;
    for (let i = 0; i < 300; i++) {
      const nos = nosBrutos();
      if (!nos.length) break;
      if (nos[0] === ancora) {
        if (paciencia >= ESPERAS_TOPO.length) break; // não mexeu mesmo esperando: é o topo
        await irPara(ancora, 'center', ESPERAS_TOPO[paciencia++]);
        continue;
      }
      paciencia = 0;
      ancora = nos[0];
      await irPara(ancora, 'center', 420);
      subidas++;
    }
    logI(`subiu ao topo em ${subidas} passo(s) — altura ${root.scrollHeight}px, janela ${root.clientHeight}px`);

    const mensagens = [];

    const capturarNovos = async (novos) => {
      if (!comAudio) return;
      for (const m of novos) {
        if (m.type !== 'audio' || !m._bolha) continue;
        // Captura AGORA, enquanto a bolha ainda está no DOM: depois de rolar,
        // o Instagram descarta o elemento e não dá mais pra clicar no play.
        m._b64 = await capturarAudio(m._bolha, `áudio ${mensagens.filter((x) => x.type === 'audio').length}`, 15).catch(() => null);
      }
    };

    // 2) Desce lendo. A cada passo, ancora numa mensagem a ~60% da janela atual
    //    e a leva pro topo: avança pouco menos de uma tela, deixando ~40% de
    //    sobreposição — que é o que a costura precisa pra encaixar sem buraco.
    let semNovas = 0;
    let paradas = 0;
    for (let i = 0; i < 400; i++) {
      const nos = nosBrutos();
      const janela = lerJanela(root);
      const novos = mesclarJanela(mensagens, janela);
      await capturarNovos(novos);
      mostrarBadge({ texto: `<b>Lendo a conversa…</b> (${mensagens.length} mensagens até aqui)`, loading: true });
      logI(`passo ${i}: janela ${janela.length} msg | +${novos.length} nova(s) | total ${mensagens.length}`);

      if (!nos.length) break;
      semNovas = novos.length ? 0 : semNovas + 1;
      if (semNovas >= 3) break; // 3 passos sem nada novo: acabou a conversa

      const primeiroAntes = nos[0];
      const ultimoAntes = nos[nos.length - 1];
      const alvo = nos[Math.max(0, Math.min(nos.length - 1, Math.floor(nos.length * 0.6)))];
      await irPara(alvo, 'start');

      // Se nem o primeiro nem o último nó renderizado mudaram, a tela não andou.
      const depois = nosBrutos();
      const travou = depois.length && depois[0] === primeiroAntes && depois[depois.length - 1] === ultimoAntes;
      paradas = travou ? paradas + 1 : 0;
      if (paradas >= 3) {
        logI('a lista parou de andar — provavelmente chegou ao fim da conversa.');
        break;
      }
    }
    // Leitura final já no fundo, pra pegar o que entrou depois do último passo.
    await capturarNovos(mesclarJanela(mensagens, lerJanela(root)));

    if (mensagens.length === 0) {
      throw new Error('Nenhuma mensagem lida. Role a conversa manualmente uma vez e tente de novo.');
    }

    // Transcrição só depois de rolar tudo: não depende mais do DOM, e assim a
    // leitura da conversa não fica parada esperando a rede.
    const audios = mensagens.filter((m) => m.type === 'audio');
    let transcritos = 0;
    if (comAudio && server) {
      const comBytes = audios.filter((m) => m._b64);
      for (let n = 0; n < comBytes.length; n++) {
        mostrarBadge({ texto: `<b>Transcrevendo áudios…</b> (${n + 1}/${comBytes.length})`, loading: true });
        try {
          const resp = await new Promise((r) =>
            chrome.runtime.sendMessage({ action: 'transcreverAudio', server, base64: comBytes[n]._b64 }, r)
          );
          if (resp && resp.ok && resp.texto && resp.texto.trim()) {
            comBytes[n].content = resp.texto.trim(); // quem enviou já veio do DOM
            transcritos++;
          } else if (resp && resp.erro) {
            logA('transcrição falhou:', resp.erro);
          }
        } catch (e) {
          logA('transcrição erro:', e.message);
        }
      }
    }

    // Tira o que era só andaime interno antes de mandar pro servidor.
    const limpas = mensagens.map(({ from, type, content, timestamp }) => ({ from, type, content, timestamp }));
    const stats = {
      total: limpas.length,
      audios: audios.length,
      audiosTranscritos: transcritos,
      doVendedor: limpas.filter((m) => m.from === 'eu').length,
      doLead: limpas.filter((m) => m.from !== 'eu').length,
    };
    logI(
      `${stats.total} mensagens lidas — ${stats.audios} áudio(s) (${stats.audiosTranscritos} com transcrição) — ` +
        `${stats.doVendedor} do vendedor, ${stats.doLead} do lead.`
    );
    // O nome vem do INÍCIO da leitura: lido no fim, podia ser o de outra conversa aberta enquanto os áudios transcreviam.
    return { mensagens: limpas, nome: alvoNome || nomeDoContato(), stats };
  }

  // ---------------------------------------------------------------------------
  // Aviso fixo na tela (mesmo componente visual usado no WhatsApp)
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
        'border:1px solid #3a373f', 'border-top:3px solid #ffc233',
        'border-radius:12px', 'padding:12px 14px', 'font:13px/1.45 Segoe UI Variable Text,Segoe UI,system-ui,-apple-system,Roboto,sans-serif',
        'box-shadow:0 14px 34px rgba(0,0,0,.5)', 'display:flex', 'gap:10px', 'align-items:flex-start',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function mostrarBadge({ texto, cor = '#ffc233', loading = false, arquivo = null, arquivoBase64 = null, botoes = [], aoEscolher = null, aoFechar = null }) {
    const el = badgeEl();
    el.style.borderTopColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;display:flex">' + "<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" style=\"vertical-align:-2px;flex:none\" fill=\"none\" stroke=\"#ffc233\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/></svg>" + '</span>';
    let acao = '';
    if (arquivoBase64) {
      const url = 'data:application/pdf;base64,' + arquivoBase64;
      acao =
        `<a href="${escHtml(url)}" download="${escHtml(arquivo || 'report.pdf')}" style="display:inline-block;margin-top:8px;background:#ffc233;color:#18171b;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#18171b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg> Baixar PDF</a>`;
    }
    const htmlBotoes = botoes.length
      ? '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
        botoes
          .map(
            (b) =>
              `<button type="button" data-cr-acao="${escHtml(b.acao)}" style="cursor:pointer;border:0;border-radius:7px;padding:6px 10px;font-weight:700;font-size:12px;background:${b.primario ? '#ffc233' : '#3a373f'};color:${b.primario ? '#18171b' : '#f3efe6'}">${escHtml(b.rotulo)}</button>`
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
          nota.style.color = '#ffc233';
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
  // Orquestração (mesmo contrato de mensagens do content.js do WhatsApp — o
  // popup e o background.js não precisam saber qual plataforma está aberta)
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
      cor: '#ffc233',
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

  async function gerarReportEmBackground(server) {
    if (jobEmAndamento) {
      mostrarBadge({ texto: 'Já existe um report sendo gerado…', cor: '#f2a93b', loading: true });
      return;
    }
    jobEmAndamento = true;
    capturaAtiva = true;
    try {
      mostrarBadge({
        texto:
          '<b>Lendo a conversa…</b><br>Os áudios são tocados no mudo pra transcrever. ' +
          '<u>Não troque de conversa agora</u>.',
        loading: true,
      });
      const { mensagens, nome, stats } = await coletarConversa(server, true);

      const linhaAudio =
        stats.audios > 0
          ? `${stats.audios} áudio(s), ${stats.audiosTranscritos} com transcrição` +
            (stats.audiosTranscritos < stats.audios ? ' <span style="color:#a39e93">(o resto entra como [áudio])</span>' : '')
          : 'Sem áudios nesta conversa';

      mostrarBadge({
        texto: `<b>Gerando report…</b> (${mensagens.length} mensagens)<br>${linhaAudio}<br>` +
          '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#3ddc84" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> Já pode responder outras conversas.',
        loading: true,
      });

      // Como foi a leitura (áudios achados x transcritos): o servidor guarda para o admin ver reports com captura parcial.
      const captureQuality = {
        plataforma: 'instagram',
        versao: VERSAO,
        mensagens: stats.total,
        audios: stats.audios,
        audiosTranscritos: stats.audiosTranscritos,
        mensagensVendedor: stats.doVendedor,
        mensagensLead: stats.doLead,
      };
      const resp = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality }, resolve)
      );

      if (!resp || !resp.ok) {
        mostrarBadge({ texto: escHtml((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6f5c' });
        jobEmAndamento = false;
        return;
      }

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
          mostrarBadge({ texto: 'Geração cancelada — já existe um report igual.', cor: '#f2a93b' });
          return;
        }
        mostrarBadge({ texto: '<b>Gerando de novo…</b>', loading: true });
        const resp2 = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, captureQuality, forcarNovo: true }, resolve)
        );
        if (!resp2 || !resp2.ok) {
          mostrarBadge({ texto: escHtml((resp2 && resp2.erro) || 'Falha ao gerar o report.'), cor: '#ff6f5c' });
          jobEmAndamento = false;
          return;
        }
        return finalizar(resp2, nome, server, stats);
      }

      finalizar(resp, nome, server, stats);
    } catch (e) {
      mostrarBadge({ texto: escHtml(e.message), cor: '#ff6f5c' });
    } finally {
      jobEmAndamento = false;
      capturaAtiva = false;
      restaurarAudios();
    }
  }

  function finalizar(resp, nome, server, stats) {
    guardarUltimoReport(resp, nome, server);
    // O resumo dos áudios fica no aviso final: é a dúvida de sempre (transcreveu
    // ou não?) e o "Gerando report…" some rápido demais pra dar tempo de ler.
    const s = stats || { audios: 0, audiosTranscritos: 0 };
    const resumoAudio =
      s.audios === 0
        ? '<span style="color:#a39e93">Sem áudios nesta conversa</span>'
        : s.audiosTranscritos === s.audios
          ? `${s.audios} áudio(s) transcrito(s)`
          : `<span style="color:#f2a93b">${s.audiosTranscritos} de ${s.audios} áudio(s) transcrito(s)</span>` +
            ' <span style="color:#a39e93">— o resto entrou como [áudio]</span>';
    mostrarBadge({
      texto: `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#3ddc84" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> <b>Report pronto!</b> (${escHtml(nome || 'contato')})<br>${linhaRemetentes(s)}${resumoAudio}`,
      arquivo: resp.arquivo,
      arquivoBase64: resp.arquivoBase64,
    });
    anexarEscolhaDeCloser(resp);
    jobEmAndamento = false;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'start') {
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
