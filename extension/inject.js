// Roda no contexto REAL da página (world: MAIN). Intercepta a criação de blobs
// de áudio pelo WhatsApp e avisa o content script (isolated) via postMessage.
//
// Chega aqui por dois caminhos (o manifesto com world:"MAIN" e, quando esse não
// funciona — Brave e Chromium antigos —, uma tag <script> injetada pelo content.js).
// O guarda abaixo garante que o gancho seja instalado UMA vez só.
(function () {
  'use strict';
  try {
    if (window.__crAudioHook) return;
    window.__crAudioHook = true;

    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
      const url = orig(obj);
      try {
        const type = obj && obj.type ? String(obj.type) : '';
        // Voz do WhatsApp costuma ser audio/ogg; type às vezes vem vazio.
        if (!type || /audio|ogg|opus|mpeg|mp4|mp3|octet-stream/i.test(type)) {
          window.postMessage({ __crAudio: true, url, type, ts: Date.now() }, '*');
        }
      } catch (_) {
        /* ignora */
      }
      return url;
    };

    // Marcador no DOM: é como o content script (que vive em outro "mundo" e não
    // enxerga as variáveis da página) confere se o gancho está mesmo instalado.
    document.documentElement.setAttribute('data-cr-audio-hook', '1');
  } catch (_) {
    /* ignora */
  }
})();

// ---------------------------------------------------------------------------
// Gravação de ligação do WhatsApp Web. A sua voz sai do microfone (getUserMedia). A voz do lead é capturada do
// ÁUDIO DA ABA (getDisplayMedia, o Chrome pede um "Permitir"): o WhatsApp nem sempre toca a chamada por uma faixa
// WebRTC que dê para gravar. Se o áudio da aba não vier, tenta a faixa remota (RTCPeerConnection). Cada lado é gravado separado, em partes de
// alguns minutos (o servidor recebe no máximo uns 4 MB por vez), e cada parte vai para o content script, que manda
// transcrever. Nada grava sozinho: só depois do clique em "Gravar ligação" (mensagem __crLigacaoCmd).
// ---------------------------------------------------------------------------
(function () {
  'use strict';
  try {
    if (window.__crLigacaoHook) return;
    window.__crLigacaoHook = true;
    const PARTE_MS = 3 * 60 * 1000;
    const remotas = new Set(); // faixas de áudio que chegam da chamada (a voz do lead)
    let micDaPagina = null; // o microfone que o próprio WhatsApp abriu para a chamada
    let gravacao = null;
    const avisar = (dados) => window.postMessage({ __crLigacao: true, ...dados }, '*');
    const viva = (t) => t && t.readyState === 'live';

    function chamadaTerminou() {
      if (gravacao) parar('fim da ligação');
      avisar({ evento: 'semChamada' });
    }
    function novaFaixaRemota(track) {
      if (!track || track.kind !== 'audio' || remotas.has(track)) return;
      remotas.add(track);
      track.addEventListener('ended', () => {
        remotas.delete(track);
        if (![...remotas].some(viva)) chamadaTerminou();
      });
      avisar({ evento: 'chamada' });
    }

    const PC = window.RTCPeerConnection;
    if (PC) {
      const Embrulho = function (...args) {
        const pc = new PC(...args);
        pc.addEventListener('track', (ev) => novaFaixaRemota(ev.track));
        pc.addEventListener('connectionstatechange', () => {
          if (['closed', 'failed', 'disconnected'].includes(pc.connectionState) && ![...remotas].some(viva)) chamadaTerminou();
        });
        return pc;
      };
      Embrulho.prototype = PC.prototype;
      Object.setPrototypeOf(Embrulho, PC);
      window.RTCPeerConnection = Embrulho;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Embrulho;
    }
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async function (c) {
        const s = await orig(c);
        try { if (s.getAudioTracks().length) micDaPagina = s; } catch (_) { /* ignora */ }
        return s;
      };
    }

    const tipo = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    const base64 = (blob) => new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = () => res('');
      fr.readAsDataURL(blob);
    });

    function gravarParte(stream, quem, indice, inicioMs) {
      const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo, audioBitsPerSecond: 64000 } : undefined);
      const pedacos = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) pedacos.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(pedacos, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 2000) avisar({ evento: 'parte', quem, indice, inicioMs, b64: await base64(blob) });
        else avisar({ evento: 'parteVazia', quem, indice });
      };
      rec.start(1000);
      return rec;
    }

    function novaRodada() {
      if (!gravacao) return;
      const g = gravacao;
      const inicioMs = Date.now() - g.inicio;
      const indice = g.partes++;
      const ativos = [];
      const lead = faixasDoLead(g);
      if (lead.length) ativos.push(gravarParte(new MediaStream(lead), 'lead', indice, inicioMs));
      if (g.mic && g.mic.getAudioTracks().some(viva)) ativos.push(gravarParte(new MediaStream(g.mic.getAudioTracks().filter(viva)), 'eu', indice, inicioMs));
      g.recorders = ativos;
    }

    const faixasDoLead = (g) => {
      const daAba = g.aba ? g.aba.getAudioTracks().filter(viva) : [];
      return daAba.length ? daAba : [...remotas].filter(viva);
    };

    /** O áudio que a aba está tocando. Precisa ser pedido logo no clique (antes de qualquer outra espera). */
    async function capturarAba() {
      if (!md || !md.getDisplayMedia) return null;
      try {
        const s = await md.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
        });
        if (!s.getAudioTracks().length) { s.getTracks().forEach((t) => t.stop()); return null; }
        s.getVideoTracks().forEach((t) => { t.enabled = false; }); // só o áudio interessa
        return s;
      } catch (_) {
        return null;
      }
    }

    /** Mede o som dos dois lados a cada segundo: mostra na hora se algum não está chegando, não só no fim. */
    function vigiarSom(g) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      let ctx = null;
      let segundos = 0;
      const lados = {
        lead: { faixas: () => faixasDoLead(g), ligadas: '', analisador: null, ultimo: 0 },
        eu: { faixas: () => (g.mic ? g.mic.getAudioTracks().filter(viva) : []), ligadas: '', analisador: null, ultimo: 0 },
      };
      const pico = (lado) => {
        const faixas = lado.faixas();
        const ids = faixas.map((t) => t.id).join();
        if (ids !== lado.ligadas) {
          lado.ligadas = ids;
          lado.analisador = null;
          if (faixas.length) {
            lado.analisador = ctx.createAnalyser();
            faixas.forEach((t) => ctx.createMediaStreamSource(new MediaStream([t])).connect(lado.analisador));
          }
        }
        if (!lado.analisador) return 0;
        const amostras = new Uint8Array(lado.analisador.fftSize);
        lado.analisador.getByteTimeDomainData(amostras);
        return amostras.reduce((m, v) => Math.max(m, Math.abs(v - 128)), 0);
      };
      let avisouSemLead = false;
      g.vigia = setInterval(() => {
        try {
          if (!ctx) ctx = new Ctx();
          if (ctx.state === 'suspended') ctx.resume();
          segundos++;
          if (pico(lados.lead) > 3) {
            lados.lead.ultimo = segundos;
            if (!g.leadOuvido) { g.leadOuvido = true; avisar({ evento: 'vozDoLead' }); }
          }
          if (pico(lados.eu) > 3) lados.eu.ultimo = segundos;
          if (!g.leadOuvido && !avisouSemLead && segundos >= 20) { avisouSemLead = true; avisar({ evento: 'semVozDoLead' }); }
          // "ouvindo" = teve som nos últimos 5 segundos
          avisar({ evento: 'niveis', lead: lados.lead.ultimo > 0 && segundos - lados.lead.ultimo < 5, eu: lados.eu.ultimo > 0 && segundos - lados.eu.ultimo < 5 });
        } catch (_) { /* sem análise: a gravação segue */ }
      }, 1000);
      g.fecharVigia = () => { clearInterval(g.vigia); if (ctx) ctx.close().catch(() => {}); };
    }

    // Sem tratamento de voz na fonte do lead (é um áudio que já chega pronto); no seu microfone, com.
    const abrirEntrada = (id, tratar) => md.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: tratar, noiseSuppression: tratar, autoGainControl: tratar } });

    let preparando = false;
    /** @param {{ microfone?: string, fonteLead?: string }} [opcoes] ids dos aparelhos escolhidos; vazio = o padrão */
    async function comecar(opcoes = {}) {
      if (gravacao || preparando) return;
      if (!window.MediaRecorder) return avisar({ evento: 'erro', erro: 'Este navegador não grava áudio.' });
      preparando = true;
      try {
        // Voz do lead: o áudio da aba (padrão) ou a entrada escolhida (ex.: um cabo de áudio virtual).
        let aba = null;
        if (opcoes.fonteLead) {
          try { aba = await abrirEntrada(opcoes.fonteLead, false); } catch (_) {
            return avisar({ evento: 'erro', erro: 'Não consegui abrir a entrada escolhida para a voz do lead. Confira em "Áudio da ligação".' });
          }
        } else {
          aba = await capturarAba();
        }
        let mic = null;
        let micProprio = false;
        if (opcoes.microfone && md && md.getUserMedia) {
          try { mic = await abrirEntrada(opcoes.microfone, true); micProprio = true; } catch (_) {
            if (aba) aba.getTracks().forEach((t) => t.stop());
            return avisar({ evento: 'erro', erro: 'Não consegui abrir o microfone escolhido. Confira em "Áudio da ligação".' });
          }
        }
        if (!mic) mic = micDaPagina && micDaPagina.getAudioTracks().some(viva) ? micDaPagina : null;
        if (!mic && md && md.getUserMedia) {
          try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); micProprio = true; } catch (_) { mic = null; }
        }
        const temLead = Boolean(aba) || [...remotas].some(viva);
        if (!temLead) {
          // gravar só um lado não serve para o report: melhor parar aqui e dizer o que fazer
          if (micProprio && mic) mic.getTracks().forEach((t) => t.stop());
          return avisar({ evento: 'erro', erro: 'Não consegui o áudio do lead. Clique em "Gravar ligação" de novo e, na janela do Chrome, clique em "Permitir" deixando o áudio da aba ligado.' });
        }
        const g = { inicio: Date.now(), partes: 0, mic, micProprio, aba, recorders: [], leadOuvido: false };
        gravacao = g;
        novaRodada();
        g.relogio = setInterval(() => {
          const antigos = g.recorders;
          novaRodada();
          antigos.forEach((r) => { try { r.stop(); } catch (_) { /* ignora */ } });
        }, PARTE_MS);
        // "Parar de compartilhar" na barra do Chrome encerra a gravação
        if (aba) aba.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (gravacao === g) parar('compartilhamento encerrado'); }));
        vigiarSom(g);
        avisar({ evento: 'gravando', inicio: g.inicio, temLead, temMic: Boolean(mic) });
      } finally {
        preparando = false;
      }
    }

    function parar(motivo) {
      if (!gravacao) return;
      const g = gravacao;
      gravacao = null;
      clearInterval(g.relogio);
      if (g.fecharVigia) g.fecharVigia();
      g.recorders.forEach((r) => { try { r.stop(); } catch (_) { /* ignora */ } });
      if (g.micProprio && g.mic) g.mic.getTracks().forEach((t) => t.stop());
      // solta a captura da aba depois que os gravadores fecharam o arquivo
      if (g.aba) setTimeout(() => g.aba.getTracks().forEach((t) => t.stop()), 500);
      avisar({ evento: 'parou', partes: g.partes, duracaoMs: Date.now() - g.inicio, leadOuvido: g.leadOuvido, motivo: motivo || '' });
    }

    window.addEventListener('message', (ev) => {
      if (ev.source !== window || !ev.data || !ev.data.__crLigacaoCmd) return;
      if (ev.data.__crLigacaoCmd === 'gravar') comecar(ev.data.opcoes || {});
      else if (ev.data.__crLigacaoCmd === 'parar') parar('parado pelo SDR');
      else if (ev.data.__crLigacaoCmd === 'estado') avisar({ evento: 'estado', chamada: [...remotas].some(viva), gravando: Boolean(gravacao), inicio: gravacao ? gravacao.inicio : 0 });
    });
    document.documentElement.setAttribute('data-cr-ligacao-hook', '1');
  } catch (_) {
    /* ignora */
  }
})();
