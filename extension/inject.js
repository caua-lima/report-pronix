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
