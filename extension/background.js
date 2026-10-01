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

// timeoutMs: o servidor da Vercel corta em 60s; melhor uma mensagem clara do que ficar esperando para sempre.
async function chamar(caminho, corpo, { metodo = 'POST', timeoutMs = 65000 } = {}) {
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
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'x-cr-key': chave },
      body: metodo === 'GET' ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, erro: data.erro || `Erro ${r.status}` };
    return { ok: true, data };
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return { ok: false, erro: 'O servidor demorou demais para responder. Tente de novo.' };
    }
    return { ok: false, erro: 'Servidor não respondeu. Confira a URL do servidor no popup.' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Só aceita pedidos da própria extensão (os content scripts).
  if (sender && sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return;

  if (msg && msg.action === 'transcreverAudio') {
    (async () => {
      // O servidor descobre o formato real pelos bytes; o nome é só um palpite.
      const r = await chamar('/api/transcrever', {
        audioBase64: msg.base64,
        nome: 'audio.ogg',
      }, { timeoutMs: 60000 });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, texto: r.data.texto });
    })();
    return true;
  }

  // Reabre o PDF de um report que já existe (o servidor só entrega ao dono ou ao admin) — sem IA.
  if (msg && msg.action === 'baixarExistente') {
    (async () => {
      const id = String(msg.id || '');
      if (!/^[a-f0-9]{6,32}$/i.test(id)) return sendResponse({ ok: false, erro: 'Report inválido.' });
      const r = await chamar('/api/reports/' + id + '/pdf', null, { metodo: 'GET', timeoutMs: 30000 });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, arquivo: r.data.arquivo, arquivoBase64: r.data.arquivoBase64 });
    })();
    return true;
  }

  // Ficha do lead no RD Station CRM (o token do CRM fica no servidor; aqui só vai telefone/nome).
  // Resumo rápido da conversa (botão do cartão): cenário, onde parou, última pergunta, próximo passo.
  // Coach da conversa (Groq gratuito) e a marcação "funcionou" que o faz aprender.
  if (msg && msg.action === 'coach') {
    (async () => {
      const r = await chamar('/api/coach', { mensagens: msg.mensagens, nome: msg.nome }, { timeoutMs: 65000 });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, coach: r.data.coach, cache: r.data.cache });
    })();
    return true;
  }
  if (msg && msg.action === 'coachFeedback') {
    (async () => {
      const r = await chamar('/api/coach/feedback', { tipo: msg.tipo, texto: msg.texto, contexto: msg.contexto, util: msg.util }, { timeoutMs: 20000 });
      sendResponse(r.ok ? { ok: true } : { ok: false, erro: r.erro });
    })();
    return true;
  }

  if (msg && msg.action === 'resumoRapido') {
    (async () => {
      const r = await chamar('/api/resumo-rapido', { mensagens: msg.mensagens, nome: msg.nome }, { timeoutMs: 65000 });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, resumo: r.data.resumo, cache: r.data.cache });
    })();
    return true;
  }

  if (msg && msg.action === 'crmLead') {
    (async () => {
      const corpo = {
        telefone: String(msg.telefone || '').slice(0, 30),
        nome: String(msg.nome || '').slice(0, 80),
        contatoId: String(msg.contatoId || '').slice(0, 40),
        dealId: String(msg.dealId || '').slice(0, 40),
        lembrar: msg.lembrar === true,
      };
      const r = await chamar('/api/crm/lead', corpo, { timeoutMs: 20000 });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, ...r.data });
    })();
    return true;
  }

  if (msg && msg.action === 'reportFetch') {
    (async () => {
      const r = await chamar('/api/report-direto', {
        mensagens: msg.mensagens,
        nome: msg.nome,
        forcarNovo: !!msg.forcarNovo,
        captureQuality: msg.captureQuality,
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
