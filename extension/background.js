// Service worker — faz as chamadas ao servidor (local ou nuvem) pelo content script.
// (Fetch a partir da página do WhatsApp seria bloqueado pela CSP dela.)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === 'transcreverAudio') {
    (async () => {
      try {
        const r = await fetch(msg.server + '/api/transcrever', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: msg.base64, nome: 'audio.ogg' }),
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

  if (msg && msg.action === 'pushDia') {
    // Best-effort: envia os contadores do dia ao servidor (para a página /dia).
    fetch(msg.server + '/api/dia', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.dia),
    }).catch(() => {});
    return false; // não precisa de resposta
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
          sendResponse({ ok: true, dados: data.dados, arquivo: data.arquivo, docxBase64: data.docxBase64 });
        }
      } catch (_) {
        sendResponse({
          ok: false,
          erro: 'Servidor não respondeu. Confira a URL do servidor no popup da extensão.',
        });
      }
    })();
    return true; // resposta assíncrona
  }
});
