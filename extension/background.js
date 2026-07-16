// Service worker — faz as chamadas ao servidor pelo content script.
// (Fetch a partir da página do WhatsApp seria bloqueado pela CSP dela.)

const getChave = () =>
  new Promise((r) => chrome.storage.local.get({ chave: '' }, (c) => r((c.chave || '').trim())));

async function chamar(url, corpo) {
  const chave = await getChave();
  if (!chave) {
    return { ok: false, erro: 'Sem chave de acesso. Cole a sua chave no popup da extensão.' };
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cr-key': chave },
      body: JSON.stringify(corpo),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, erro: data.erro || `Erro ${r.status}` };
    return { ok: true, data };
  } catch (_) {
    return { ok: false, erro: 'Servidor não respondeu. Confira a URL do servidor no popup.' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === 'transcreverAudio') {
    (async () => {
      const r = await chamar(msg.server + '/api/transcrever', {
        audioBase64: msg.base64,
        nome: 'audio.ogg',
      });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, texto: r.data.texto });
    })();
    return true;
  }

  if (msg && msg.action === 'reportFetch') {
    (async () => {
      const r = await chamar(msg.server + '/api/report-direto', {
        mensagens: msg.mensagens,
        nome: msg.nome,
      });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({
        ok: true,
        dados: r.data.dados,
        arquivo: r.data.arquivo,
        arquivoBase64: r.data.arquivoBase64,
      });
    })();
    return true;
  }
});
