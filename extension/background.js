// Service worker — faz as chamadas ao servidor pelo content script.
// (Fetch a partir da página do WhatsApp seria bloqueado pela CSP dela.)

const DEFAULT_SERVER = 'https://report-pronix.vercel.app';

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

  // Painel lateral do Chrome: o cartão do WhatsApp publica o estado do lead; o painel lê daqui.
  if (msg && msg.action === 'painelEstado') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    try {
      chrome.storage.session.set({ painelLead: { estado: msg.estado || null, tabId, em: Date.now() } });
    } catch (_) {
      /* sem storage.session */
    }
    sendResponse({ ok: true });
    return false;
  }
  // Botões do painel lateral que escrevem no CRM: só estas rotas.
  if (msg && msg.action === 'crmPainel') {
    const permitidas = ['/api/crm/duplicado', '/api/crm/realizada/plano', '/api/crm/realizada'];
    if (!permitidas.includes(msg.caminho)) {
      sendResponse({ ok: false, erro: 'Ação desconhecida.' });
      return false;
    }
    (async () => {
      const r = await chamar(msg.caminho, msg.corpo || {}, { timeoutMs: 58000 });
      sendResponse(r.ok ? { ok: true, ...r.data } : { ok: false, erro: r.erro });
    })();
    return true;
  }
  // Botão do cartão: abre o painel lateral do Chrome nesta janela.
  if (msg && msg.action === 'abrirPainel') {
    try {
      chrome.sidePanel
        .open({ windowId: sender.tab.windowId })
        .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, erro: String((e && e.message) || e) }));
    } catch (e) {
      sendResponse({ ok: false, erro: String((e && e.message) || e) });
      return false;
    }
    return true;
  }

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

  // O lead respondeu: o servidor avança o card para "Respondeu" no RD (só se ainda estiver antes dessa etapa).
  if (msg && msg.action === 'crmRespondeu') {
    (async () => {
      const corpo = {
        telefone: String(msg.telefone || '').slice(0, 30),
        nome: String(msg.nome || '').slice(0, 80),
        contatoId: String(msg.contatoId || '').slice(0, 40),
        dealId: String(msg.dealId || '').slice(0, 40),
      };
      const r = await chamar('/api/crm/respondeu', corpo, { timeoutMs: 25000 });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, movido: r.data.movido === true, de: r.data.de || '', para: r.data.para || '', motivo: r.data.motivo || '' });
    })();
    return true;
  }

  // Botão "Desqualificar" do cartão: os motivos de perda do RD e a perda no card do lead.
  if (msg && msg.action === 'crmMotivosPerda') {
    (async () => {
      const r = await chamar('/api/crm/motivos-perda', null, { metodo: 'GET', timeoutMs: 20000 });
      sendResponse(r.ok ? { ok: true, motivos: Array.isArray(r.data.motivos) ? r.data.motivos : [] } : { ok: false, erro: r.erro });
    })();
    return true;
  }
  if (msg && msg.action === 'crmDesqualificar') {
    (async () => {
      const corpo = {
        telefone: String(msg.telefone || '').slice(0, 30),
        nome: String(msg.nome || '').slice(0, 80),
        contatoId: String(msg.contatoId || '').slice(0, 40),
        dealId: String(msg.dealId || '').slice(0, 40),
        motivoId: String(msg.motivoId || '').slice(0, 40),
      };
      const r = await chamar('/api/crm/desqualificar', corpo, { timeoutMs: 30000 });
      sendResponse(r.ok ? { ok: true, motivo: r.data.motivo || '', etapa: r.data.etapa || '' } : { ok: false, erro: r.erro });
    })();
    return true;
  }

  // Report automático: o que se viu na conversa hoje (escrevi / havia histórico / o lead escreveu). Só três sinais.
  if (msg && msg.action === 'atividade') {
    (async () => {
      const corpo = {
        telefone: String(msg.telefone || '').slice(0, 30), nome: String(msg.nome || '').slice(0, 80),
        eu: msg.eu === true, antes: msg.antes === true, eles: msg.eles === true, elesAntes: msg.elesAntes === true,
      };
      const r = await chamar('/api/atividade', corpo, { timeoutMs: 15000 });
      sendResponse(r.ok ? { ok: true } : { ok: false, erro: r.erro });
    })();
    return true;
  }

  // Etiqueta "Qualificado" e o dia/horário agendado do lead (vai só a data lida — nunca o texto da conversa).
  if (msg && msg.action === 'leadMarca') {
    (async () => {
      const corpo = { telefone: String(msg.telefone || '').slice(0, 30), nome: String(msg.nome || '').slice(0, 80) };
      if (typeof msg.qualificado === 'boolean') Object.assign(corpo, { qualificado: msg.qualificado, manual: msg.manual === true, origem: String(msg.origem || '').slice(0, 20) });
      if (msg.limparAgenda === true) corpo.limparAgenda = true;
      else if (msg.agendadoPara) Object.assign(corpo, { agendadoPara: String(msg.agendadoPara).slice(0, 16), fonteTs: Number(msg.fonteTs) || 0, regra: Number(msg.regra) || 0 });
      const r = await chamar('/api/lead/marca', corpo, { timeoutMs: 20000 });
      sendResponse(r.ok ? { ok: true, marca: r.data.marca || null } : { ok: false, erro: r.erro });
    })();
    return true;
  }

  // O SDR marca o closer da reunião no aviso final do report.
  if (msg && msg.action === 'definirCloser') {
    (async () => {
      const id = String(msg.reportId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      if (!id) return sendResponse({ ok: false, erro: 'Report sem identificação.' });
      const r = await chamar('/api/reports/' + id + '/closer', { closerId: String(msg.closerId || '').slice(0, 40) }, { timeoutMs: 20000 });
      sendResponse(r.ok ? { ok: true, closerNome: r.data.closerNome || '' } : { ok: false, erro: r.erro });
    })();
    return true;
  }

  // Depois do resumo rápido: mapa da conversa e perguntas sobre ela (a conversa já lida vai junto; nada fica guardado).
  if (msg && (msg.action === 'conversaMapa' || msg.action === 'conversaPergunta')) {
    (async () => {
      const ehMapa = msg.action === 'conversaMapa';
      const corpo = {
        mensagens: Array.isArray(msg.mensagens) ? msg.mensagens : [],
        nome: String(msg.nome || '').slice(0, 120),
        ...(ehMapa ? {} : { pergunta: String(msg.pergunta || '').slice(0, 300) }),
      };
      const r = await chamar(ehMapa ? '/api/conversa/mapa' : '/api/conversa/perguntar', corpo, { timeoutMs: 55000 });
      sendResponse(r.ok ? { ok: true, ...r.data } : { ok: false, erro: r.erro });
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
      // A conversa aberta (cabeçalho do WhatsApp): é por ela que o servidor lembra a etiqueta e o agendamento.
      if (msg.conversa && typeof msg.conversa === 'object') {
        corpo.conversa = { telefone: String(msg.conversa.telefone || '').slice(0, 30), nome: String(msg.conversa.nome || '').slice(0, 80) };
      }
      const r = await chamar('/api/crm/lead', corpo, { timeoutMs: 20000 });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, ...r.data });
    })();
    return true;
  }

  // "Analisar Match com o closer": a nota de 0 a 10 e o segundo PDF, depois que o report ficou pronto.
  if (msg && msg.action === 'afinidade') {
    (async () => {
      const r = await chamar('/api/afinidade', {
        closerId: String(msg.closerId || '').slice(0, 40),
        reportId: String(msg.reportId || '').slice(0, 40),
        dados: msg.dados || null,
        mensagens: Array.isArray(msg.mensagens) ? msg.mensagens : [],
        nome: String(msg.nome || '').slice(0, 120),
      });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      sendResponse({ ok: true, afinidade: r.data.afinidade, arquivo: r.data.arquivo, arquivoBase64: r.data.arquivoBase64 });
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
        // O que o cartão do RD sabia do lead na hora: é o vínculo do report com o card.
        vinculo: msg.vinculo || null,
        // A profissão do formulário do RD: vai para o PDF de quem tem "Profissão no report" ligado.
        formulario: msg.formulario || null,
      });
      if (!r.ok) return sendResponse({ ok: false, erro: r.erro });
      // Idempotência: mesma conversa já gerada antes — o content script decide
      // se pergunta ao SDR e reenvia com forcarNovo:true.
      if (r.data && r.data.duplicado) {
        return sendResponse({ ok: true, duplicado: true, existente: r.data.existente });
      }
      agendarAquecimento(AQUECER_APOS_MS);
      sendResponse({
        ok: true,
        dados: r.data.dados,
        arquivo: r.data.arquivo,
        arquivoBase64: r.data.arquivoBase64,
        // Para escolher o closer no aviso final (com a indicação pelo perfil do lead).
        id: r.data.id || '',
        closers: Array.isArray(r.data.closers) ? r.data.closers : [],
        sugestaoCloser: r.data.sugestaoCloser || null,
        motivoSugestao: r.data.motivoSugestao || '',
      });
    })();
    return true;
  }
});

// De hora em hora, enquanto o Chrome está aberto: pede ao servidor para pôr os resultados em dia com o RD
// (venda com produto e ticket, follow-up, não comprou, closer). O servidor só confere o que mudou de fato
// e nunca roda mais de uma vez a cada 30 minutos, então a batida é barata. Sem chave salva, não faz nada.
const ALARME_RD = 'rd-atualizar';
if (chrome.alarms) {
  // O service worker acorda várias vezes por hora: só cria o alarme se ele ainda não existe (recriar zeraria a contagem).
  chrome.alarms.get(ALARME_RD, (existe) => {
    if (!existe) chrome.alarms.create(ALARME_RD, { delayInMinutes: 3, periodInMinutes: 60 });
  });
  chrome.alarms.onAlarm.addListener((alarme) => {
    if (alarme && alarme.name === ALARME_RD) chamar('/api/rd/atualizar', {}, { timeoutMs: 58000 }).catch(() => {});
    if (alarme && alarme.name === ALARME_AQUECER) {
      chamar('/api/cache/aquecer', {}, { timeoutMs: 58000 })
        .then((r) => {
          const ms = r && r.ok && r.data ? Number(r.data.proximoEmMs) : 0;
          if (ms > 0) agendarAquecimento(ms);
        })
        .catch(() => {});
    }
  });
}

// Cache do prompt do report: ~55min depois de um report a extensão avisa o servidor, que renova o cache
// se ele está para vencer e ainda houve report há pouco (o próximo report não paga a reescrita do prompt).
// O servidor responde quando bater de novo, ou para.
const ALARME_AQUECER = 'aquecer-cache';
const AQUECER_APOS_MS = 55 * 60 * 1000;
function agendarAquecimento(ms) {
  if (!chrome.alarms) return;
  chrome.alarms.create(ALARME_AQUECER, { when: Date.now() + Math.max(60 * 1000, ms) });
}
