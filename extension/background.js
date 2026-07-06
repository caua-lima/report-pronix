// Service worker — faz a chamada ao servidor local em nome do content script.
// (Fetch a partir da página do WhatsApp seria bloqueado pela CSP dela.)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
