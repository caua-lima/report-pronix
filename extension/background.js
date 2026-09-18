// Service worker — faz as chamadas ao servidor pelo content script.
// (Fetch a partir da página do WhatsApp seria bloqueado pela CSP dela.)

const DEFAULT_SERVER = 'https://report-closer.vercel.app';

const getChave = () =>
  new Promise((r) => chrome.storage.local.get({ chave: '' }, (c) => r((c.chave || '').trim())));

// O destino vem SEMPRE do que o popup salvou — o endereço enviado na mensagem do
// content script é ignorado. Só aceita https (ou localhost para testes locais).
async function getServer() {
  const salvo = await new Promise((r) =>
    chrome.storage.local.get({ server: DEFAULT_SERVER }, (c) => r((c.server || DEFAULT_SERVER).trim().replace(/\/$/, '')))
  );
  try {
    const u = new URL(salvo);
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if (u.protocol === 'https:' || local) return u.origin;
  } catch (_) {
    /* cai no erro abaixo */
  }
  return null;
}

async function chamar(caminho, corpo) {
  const chave = await getChave();
  if (!chave) {
    return { ok: false, erro: 'Sem chave de acesso. Cole a sua chave no popup da extensão.' };
  }
  const server = await getServer();
  if (!server) {
    return { ok: false, erro: 'Endereço do servidor inválido. Confira a URL no popup da extensão.' };
  }
  try {
    const r = await fetch(server + caminho, {
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
      const r = await chamar('/api/transcrever', {
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
      const r = await chamar('/api/report-direto', {
        mensagens: msg.mensagens,
        nome: msg.nome,
        forcarNovo: !!msg.forcarNovo,
      });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      // Idempotência: mesma conversa já gerada antes — o content script decide
      // se pergunta ao SDR e reenvia com forcarNovo:true.
      if (r.data && r.data.duplicado) {
        return sendResponse({ ok: true, duplicado: true, existente: r.data.existente });
      }
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
