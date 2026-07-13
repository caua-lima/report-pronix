// Roda no contexto REAL da página (world: MAIN). Intercepta a criação de blobs
// de áudio pelo WhatsApp e avisa o content script (isolated) via postMessage.
(function () {
  'use strict';
  try {
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
  } catch (_) {
    /* ignora */
  }
})();
