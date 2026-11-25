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
// Gravação de ligação do WhatsApp Web. A chamada é WebRTC aqui na página: a voz do lead chega como faixa de áudio
// remota (RTCPeerConnection) e a sua sai do microfone (getUserMedia). Cada lado é gravado separado, em partes de
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
      const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo, audioBitsPerSecond: 32000 } : undefined);
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
      const lead = [...remotas].filter(viva);
      if (lead.length) ativos.push(gravarParte(new MediaStream(lead), 'lead', indice, inicioMs));
      if (g.mic && g.mic.getAudioTracks().some(viva)) ativos.push(gravarParte(new MediaStream(g.mic.getAudioTracks().filter(viva)), 'eu', indice, inicioMs));
      g.recorders = ativos;
    }

    async function comecar() {
      if (gravacao) return;
      if (!window.MediaRecorder) return avisar({ evento: 'erro', erro: 'Este navegador não grava áudio.' });
      let mic = micDaPagina && micDaPagina.getAudioTracks().some(viva) ? micDaPagina : null;
      let micProprio = false;
      if (!mic && md && md.getUserMedia) {
        try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); micProprio = true; } catch (_) { mic = null; }
      }
      if (![...remotas].some(viva) && !mic) return avisar({ evento: 'erro', erro: 'Não achei a ligação nem o microfone. Comece a ligação e clique de novo.' });
      gravacao = { inicio: Date.now(), partes: 0, mic, micProprio, recorders: [] };
      novaRodada();
      gravacao.relogio = setInterval(() => {
        const antigos = gravacao.recorders;
        novaRodada();
        antigos.forEach((r) => { try { r.stop(); } catch (_) { /* ignora */ } });
      }, PARTE_MS);
      avisar({ evento: 'gravando', inicio: gravacao.inicio, temLead: [...remotas].some(viva), temMic: Boolean(mic) });
    }

    function parar(motivo) {
      if (!gravacao) return;
      const g = gravacao;
      gravacao = null;
      clearInterval(g.relogio);
      g.recorders.forEach((r) => { try { r.stop(); } catch (_) { /* ignora */ } });
      if (g.micProprio && g.mic) g.mic.getTracks().forEach((t) => t.stop());
      avisar({ evento: 'parou', partes: g.partes, duracaoMs: Date.now() - g.inicio, motivo: motivo || '' });
    }

    window.addEventListener('message', (ev) => {
      if (ev.source !== window || !ev.data || !ev.data.__crLigacaoCmd) return;
      if (ev.data.__crLigacaoCmd === 'gravar') comecar();
      else if (ev.data.__crLigacaoCmd === 'parar') parar('parado pelo SDR');
      else if (ev.data.__crLigacaoCmd === 'estado') avisar({ evento: 'estado', chamada: [...remotas].some(viva), gravando: Boolean(gravacao), inicio: gravacao ? gravacao.inicio : 0 });
    });
    document.documentElement.setAttribute('data-cr-ligacao-hook', '1');
  } catch (_) {
    /* ignora */
  }
})();
