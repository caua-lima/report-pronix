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

    // O áudio de cada lado é cortado NAS PAUSAS da fala: o trecho sai com frases inteiras, sem os silêncios (é no
    // silêncio que o transcritor inventa texto) e com o horário certo, contado pelas amostras. Vai sem compressão
    // (WAV 16 kHz mono, 32 KB por segundo): um trecho de 28 s tem uns 900 KB, bem abaixo do limite do servidor.
    const TAXA = 16000;
    const BLOCO = 4096; // 256 ms
    const ANTES = TAXA; // 1 s guardado antes da fala, para não comer o começo da primeira palavra
    const MINIMO_COM_PAUSA = 12 * TAXA; // a partir daqui, qualquer pausa fecha o trecho
    const PAUSA_CURTA = Math.round(0.7 * TAXA);
    const PAUSA_LONGA = Math.round(2.2 * TAXA); // quem parou de falar: fecha mesmo um trecho curto
    const MAXIMO = 28 * TAXA;
    const SOM_MINIMO = 0.004; // volume (RMS) a partir do qual conta como som; baixo de propósito, para não perder fala baixa

    function emBase64(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
    function emWav(blocos, total) {
      const bytes = new Uint8Array(44 + total * 2);
      const v = new DataView(bytes.buffer);
      const letras = (pos, t) => { for (let i = 0; i < t.length; i++) bytes[pos + i] = t.charCodeAt(i); };
      letras(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); letras(8, 'WAVEfmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, TAXA, true); v.setUint32(28, TAXA * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      letras(36, 'data'); v.setUint32(40, total * 2, true);
      let pos = 44;
      for (const bloco of blocos) {
        for (let i = 0; i < bloco.length; i++, pos += 2) v.setInt16(pos, Math.max(-1, Math.min(1, bloco[i])) * 0x7fff, true);
      }
      return bytes;
    }

    /** Junta os blocos de um lado e manda um trecho a cada pausa. `entregar(blocos, inicioEmAmostras, total)`. */
    function cortadorPorFala(entregar) {
      let blocos = [];
      let total = 0;
      let inicio = 0; // posição (em amostras, desde o começo da gravação) do primeiro bloco guardado
      let comSom = 0; // amostras com som no trecho atual
      let silencio = 0; // silêncio no fim do trecho atual
      let fundo = SOM_MINIMO / 3; // o chiado do ambiente, aprendido aos poucos
      const fechar = (quantos = blocos.length) => {
        const saem = blocos.slice(0, quantos);
        const tamanho = saem.reduce((n, b) => n + b.amostras.length, 0);
        const som = saem.reduce((n, b) => n + (b.som ? b.amostras.length : 0), 0);
        if (som >= TAXA * 0.2) entregar(saem.map((b) => b.amostras), inicio, tamanho);
        blocos = blocos.slice(quantos);
        inicio += tamanho;
        total -= tamanho;
        comSom = blocos.reduce((n, b) => n + (b.som ? b.amostras.length : 0), 0);
        silencio = 0;
      };
      return {
        receber(amostras) {
          let soma = 0;
          for (let i = 0; i < amostras.length; i++) soma += amostras[i] * amostras[i];
          const volume = Math.sqrt(soma / (amostras.length || 1));
          const som = volume > Math.max(SOM_MINIMO, Math.min(fundo * 3, 0.02));
          if (!som) fundo = fundo * 0.95 + volume * 0.05;
          blocos.push({ amostras: new Float32Array(amostras), volume, som });
          total += amostras.length;
          if (som) { comSom += amostras.length; silencio = 0; } else silencio += amostras.length;
          if (!comSom) { // ainda ninguém falou: guarda só o finalzinho
            while (blocos.length > 1 && total - blocos[0].amostras.length >= ANTES) {
              const velho = blocos.shift();
              total -= velho.amostras.length;
              inicio += velho.amostras.length;
            }
            return;
          }
          if ((total >= MINIMO_COM_PAUSA && silencio >= PAUSA_CURTA) || silencio >= PAUSA_LONGA) fechar();
          else if (total >= MAXIMO) {
            // fala sem pausa: corta no ponto mais baixo dos últimos 5 s
            let melhor = blocos.length - 1;
            let atras = 0;
            for (let i = blocos.length - 1; i > 0 && atras < 5 * TAXA; i--) {
              atras += blocos[i].amostras.length;
              if (blocos[i].volume < blocos[melhor].volume) melhor = i;
            }
            fechar(melhor + 1);
          }
        },
        encerrar() { if (blocos.length && comSom) fechar(); blocos = []; total = 0; comSom = 0; },
      };
    }

    /** Liga um cortador em cada lado. As fontes são religadas se as faixas mudarem no meio da ligação. */
    function capturarFalas(g) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx({ sampleRate: TAXA });
      const mudo = ctx.createGain();
      mudo.gain.value = 0;
      mudo.connect(ctx.destination); // o processador só roda ligado à saída; nada é tocado
      const lados = [
        { quem: 'lead', faixas: () => faixasDoLead(g) },
        { quem: 'eu', faixas: () => (g.mic ? g.mic.getAudioTracks().filter(viva) : []) },
      ].map((lado) => {
        const cortador = cortadorPorFala((blocos, inicio, total) => {
          avisar({ evento: 'parte', quem: lado.quem, indice: g.partes++, inicioMs: Math.round((inicio / TAXA) * 1000), b64: emBase64(emWav(blocos, total)) });
        });
        const no = ctx.createScriptProcessor(BLOCO, 1, 1);
        no.onaudioprocess = (e) => cortador.receber(e.inputBuffer.getChannelData(0));
        no.connect(mudo);
        let fontes = [];
        let ligadas = '';
        const religar = () => {
          const faixas = lado.faixas();
          const ids = faixas.map((t) => t.id).join();
          if (ids === ligadas) return;
          ligadas = ids;
          fontes.forEach((f) => f.disconnect());
          fontes = faixas.map((t) => { const f = ctx.createMediaStreamSource(new MediaStream([t])); f.connect(no); return f; });
        };
        religar();
        // sem fonte nenhuma o processador ainda roda (com silêncio): o relógio dos dois lados anda junto
        const base = ctx.createConstantSource ? ctx.createConstantSource() : null;
        if (base) { base.offset.value = 0; base.connect(no); base.start(); }
        return { cortador, no, religar };
      });
      const relogio = setInterval(() => {
        if (ctx.state === 'suspended') ctx.resume();
        lados.forEach((l) => l.religar());
      }, 1000);
      if (ctx.state === 'suspended') ctx.resume();
      return {
        encerrar() {
          clearInterval(relogio);
          lados.forEach((l) => { l.no.onaudioprocess = null; l.cortador.encerrar(); l.no.disconnect(); });
          ctx.close().catch(() => {});
        },
      };
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
      if (!(window.AudioContext || window.webkitAudioContext)) return avisar({ evento: 'erro', erro: 'Este navegador não grava áudio.' });
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
        const g = { inicio: Date.now(), partes: 0, mic, micProprio, aba, falas: null, leadOuvido: false };
        gravacao = g;
        g.falas = capturarFalas(g);
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
      if (g.fecharVigia) g.fecharVigia();
      try { if (g.falas) g.falas.encerrar(); } catch (_) { /* os trechos já enviados continuam valendo */ } // manda o que sobrou
      if (g.micProprio && g.mic) g.mic.getTracks().forEach((t) => t.stop());
      if (g.aba) g.aba.getTracks().forEach((t) => t.stop());
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
