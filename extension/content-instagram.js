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
  const logI = (...a) => console.log('[CR-instagram]', ...a);
  const logA = (...a) => console.log('[CR-ig-audio]', ...a);

  // Silencia qualquer <audio> da página: a captura precisa dar play pra
  // materializar o arquivo, e sem isso o áudio tocaria alto pro SDR.
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
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 20) {
        return n;
      }
      n = n.parentElement;
    }
    return null;
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
    // Fallback por posição: enviada fica na metade direita do container.
    if (root) {
      const rEl = el.getBoundingClientRect();
      const rRoot = root.getBoundingClientRect();
      const meio = rRoot.left + rRoot.width / 2;
      return rEl.left > meio;
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
  async function capturarAudio(bolha, dbg, iteracoes = 30) {
    // Lê o <audio> DESTA bolha (nunca document.querySelector: pegaria o de outra
    // mensagem). Serve tanto pra blob: quanto pra https:// do CDN.
    const tentarElementoAudio = async () => {
      const a = bolha.querySelector('audio');
      const src = a && (a.currentSrc || a.src || '');
      if (!src) return null;
      a.muted = true;
      a.volume = 0;
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
      for (const b of blobsAudio) {
        if (b.usado) continue;
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

  /**
   * Rola até o topo pra carregar o histórico (mesma lógica de espera do
   * WhatsApp: repete até a altura da lista parar de crescer).
   */
  async function carregarHistorico(scroller) {
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

  /**
   * Lê a conversa (texto + voz) numa passada só, depois de rolar até o topo.
   * Sem o esquema de múltiplas passadas do WhatsApp porque o Instagram não expõe
   * id estável na mensagem — se isso perder mensagens em conversas muito longas
   * por virtualização, é o próximo ajuste, testando ao vivo.
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

    await carregarHistorico(root);
    await sleep(300);
    if (comAudio) await garantirGanchoAudio();

    // querySelectorAll com vários seletores devolve em ORDEM DO DOCUMENTO — é o
    // que mantém texto e áudio intercalados na ordem certa da conversa, sem
    // precisar de timestamp (que o Instagram não dá por mensagem).
    const nos = [...root.querySelectorAll(SELETOR_TEXTO + ', ' + SINAIS_AUDIO)];
    const bandasAudio = new Set(); // dedup por faixa vertical: 1 mensagem por linha da tela
    const mensagens = [];
    const bolhasPorIndice = new Map(); // índice na lista -> bolha do áudio, pra capturar depois

    for (const el of nos) {
      if (el.matches(SELETOR_TEXTO)) {
        const t = (el.textContent || '').trim();
        if (!t || ehDuracaoOuHora(t)) continue; // "0:12" da bolha de voz não é mensagem
        const reg = extrairMensagem(el, root);
        if (!reg) continue;
        const anterior = mensagens[mensagens.length - 1];
        if (anterior && anterior.from === reg.from && anterior.content === reg.content) continue;
        mensagens.push(reg);
        continue;
      }
      // Sinal de áudio: várias marcações da mesma bolha (o <audio>, o botão, o
      // aria-label) caem aqui — a faixa vertical junta todas numa mensagem só.
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const banda = Math.round(r.top / 8);
      if (bandasAudio.has(banda)) continue;
      bandasAudio.add(banda);
      bolhasPorIndice.set(mensagens.length, acharBolhaAudio(el));
      mensagens.push({ from: ehDeMim(el, root) ? 'eu' : 'eles', type: 'audio', content: '[áudio]', timestamp: null });
    }

    if (mensagens.length === 0) {
      throw new Error('Nenhuma mensagem lida. Role a conversa manualmente uma vez e tente de novo.');
    }

    const totalAudios = bolhasPorIndice.size;
    let transcritos = 0;

    if (comAudio && totalAudios && server) {
      let n = 0;
      for (const [indice, bolha] of bolhasPorIndice) {
        n++;
        mostrarBadge({ texto: `<b>Lendo áudios…</b> (${n}/${totalAudios})`, loading: true });
        const b64 = await capturarAudio(bolha, `áudio ${n}`).catch(() => null);
        if (!b64) continue;
        mostrarBadge({ texto: `<b>Transcrevendo áudios…</b> (${n}/${totalAudios})`, loading: true });
        try {
          const resp = await new Promise((r) =>
            chrome.runtime.sendMessage({ action: 'transcreverAudio', server, base64: b64 }, r)
          );
          if (resp && resp.ok && resp.texto && resp.texto.trim()) {
            mensagens[indice].content = resp.texto.trim(); // quem enviou já veio do DOM
            transcritos++;
          } else if (resp && resp.erro) {
            logA('transcrição falhou:', resp.erro);
          }
        } catch (e) {
          logA('transcrição erro:', e.message);
        }
      }
    }

    const stats = { total: mensagens.length, audios: totalAudios, audiosTranscritos: transcritos };
    logI(`${stats.total} mensagens lidas — ${stats.audios} áudio(s) (${stats.audiosTranscritos} com transcrição).`);
    return { mensagens, nome: nomeDoContato(), stats };
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
        'max-width:320px', 'background:#16212e', 'color:#e6edf3',
        'border:1px solid #26333f', 'border-left:4px solid #ffc400',
        'border-radius:10px', 'padding:12px 14px', 'font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.4)', 'display:flex', 'gap:10px', 'align-items:flex-start',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function mostrarBadge({ texto, cor = '#ffc400', loading = false, arquivo = null, arquivoBase64 = null }) {
    const el = badgeEl();
    el.style.borderLeftColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;display:flex">' + "<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" style=\"vertical-align:-2px;flex:none\" fill=\"none\" stroke=\"#ffc400\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/></svg>" + '</span>';
    let acao = '';
    if (arquivoBase64) {
      const url = 'data:application/pdf;base64,' + arquivoBase64;
      acao =
        `<a href="${url}" download="${arquivo || 'report.pdf'}" style="display:inline-block;margin-top:8px;background:#ffc400;color:#121214;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#121214" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg> Baixar PDF</a>`;
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
  // Orquestração (mesmo contrato de mensagens do content.js do WhatsApp — o
  // popup e o background.js não precisam saber qual plataforma está aberta)
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
          '<b>Lendo a conversa…</b><br>Os áudios são tocados no mudo pra transcrever. ' +
          '<u>Não troque de conversa agora</u>.',
        loading: true,
      });
      const { mensagens, nome, stats } = await coletarConversa(server, true);

      const linhaAudio =
        stats.audios > 0
          ? `${stats.audios} áudio(s), ${stats.audiosTranscritos} com transcrição` +
            (stats.audiosTranscritos < stats.audios ? ' <span style="color:#8b98a5">(o resto entra como [áudio])</span>' : '')
          : 'Sem áudios nesta conversa';

      mostrarBadge({
        texto: `<b>Gerando report…</b> (${mensagens.length} mensagens)<br>${linhaAudio}<br>` +
          '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#25d366" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> Já pode responder outras conversas.',
        loading: true,
      });

      const resp = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome }, resolve)
      );

      if (!resp || !resp.ok) {
        mostrarBadge({ texto: '' + ((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6b6b' });
        jobEmAndamento = false;
        return;
      }

      if (resp.duplicado) {
        const quando = new Date(resp.existente.quando).toLocaleString('pt-BR');
        const confirmar = confirm(
          `Já existe um report igual pra ${resp.existente.lead || 'este contato'}, gerado em ${quando}.\n\n` +
            'Gerar de novo chama a IA outra vez (custo extra). Gerar mesmo assim?'
        );
        if (!confirmar) {
          mostrarBadge({ texto: 'Geração cancelada — já existe um report igual.', cor: '#f0ad4e' });
          jobEmAndamento = false;
          return;
        }
        const resp2 = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, forcarNovo: true }, resolve)
        );
        if (!resp2 || !resp2.ok) {
          mostrarBadge({ texto: '' + ((resp2 && resp2.erro) || 'Falha ao gerar o report.'), cor: '#ff6b6b' });
          jobEmAndamento = false;
          return;
        }
        return finalizar(resp2, nome, server, stats);
      }

      finalizar(resp, nome, server, stats);
    } catch (e) {
      mostrarBadge({ texto: '' + e.message, cor: '#ff6b6b' });
    } finally {
      jobEmAndamento = false;
    }
  }

  function finalizar(resp, nome, server, stats) {
    chrome.storage.local.set({
      ultimoReport: { arquivo: resp.arquivo, dados: resp.dados, arquivoBase64: resp.arquivoBase64, nome, server, quando: Date.now() },
    });
    // O resumo dos áudios fica no aviso final: é a dúvida de sempre (transcreveu
    // ou não?) e o "Gerando report…" some rápido demais pra dar tempo de ler.
    const s = stats || { audios: 0, audiosTranscritos: 0 };
    const resumoAudio =
      s.audios === 0
        ? '<span style="color:#8b98a5">Sem áudios nesta conversa</span>'
        : s.audiosTranscritos === s.audios
          ? `${s.audios} áudio(s) transcrito(s)`
          : `<span style="color:#f0ad4e">${s.audiosTranscritos} de ${s.audios} áudio(s) transcrito(s)</span>` +
            ' <span style="color:#8b98a5">— o resto entrou como [áudio]</span>';
    mostrarBadge({
      texto: `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#25d366" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> <b>Report pronto!</b> (${nome || 'contato'})<br>${resumoAudio}`,
      arquivo: resp.arquivo,
      arquivoBase64: resp.arquivoBase64,
    });
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
