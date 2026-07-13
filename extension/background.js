// Service worker — faz a chamada ao servidor local em nome do content script.
// (Fetch a partir da página do WhatsApp seria bloqueado pela CSP dela.)

// Decodifica base64 -> Uint8Array (para reenviar o áudio ao servidor).
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === 'transcreverAudio') {
    (async () => {
      try {
        const bytes = base64ToBytes(msg.base64);
        const r = await fetch(msg.server + '/api/transcrever?nome=audio.ogg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        const data = await r.json();
        if (!r.ok) return sendResponse({ ok: false, erro: data.erro || 'falha' });
        sendResponse({ ok: true, texto: data.texto, quem: data.quem });
      } catch (e) {
        sendResponse({ ok: false, erro: e.message });
      }
    })();
    return true; // resposta assíncrona
  }

  if (msg && msg.action === 'reportFetch') {
    (async () => {
      try {
        const r = await fetch(msg.server + '/api/report-direto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mensagens: msg.mensagens, nome: msg.nome }),
        });
        const data = await r.json();
        if (!r.ok) {
          sendResponse({ ok: false, erro: data.erro || 'Erro ao gerar o relatório.' });
        } else {
          sendResponse({ ok: true, dados: data.dados, arquivo: data.arquivo });
        }
      } catch (_) {
        sendResponse({
          ok: false,
          erro: 'Servidor local não respondeu. Rode "npm start" e confira a porta.',
        });
      }
    })();
    return true; // resposta assíncrona
  }
});
