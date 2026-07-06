'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = 'http://localhost:3000';

function setStatus(txt, { erro = false, loading = false } = {}) {
  const el = $('status');
  el.className = 'status' + (erro ? ' erro' : '');
  el.innerHTML = (loading ? '<span class="spinner"></span>' : '') + (txt || '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function lista(arr, ordenada) {
  const tag = ordenada ? 'ol' : 'ul';
  const itens = (arr || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  return `<${tag}>${itens}</${tag}>`;
}

function renderReport(d) {
  return `
    <table>
      <tr><td class="rot">Lead</td><td>${escapeHtml(d.lead)}</td></tr>
      <tr><td class="rot">Status</td><td>${escapeHtml(d.status)}</td></tr>
      <tr><td class="rot">Nicho</td><td>${escapeHtml(d.nicho)}</td></tr>
      <tr><td class="rot">Investimento</td><td>${escapeHtml(d.investimento)}</td></tr>
    </table>
    <h2>👤 Perfil & Contexto</h2>${lista(d.perfil_contexto)}
    <h2>📍 Momento Atual</h2>${lista(d.momento_atual)}
    <h2>📈 Sinais de Tração</h2>${lista(d.sinais_tracao)}
    <h2>💰 Capacidade & Decisão</h2>${lista(d.capacidade_decisao)}
    <h2>📅 Agendamento & Status</h2>${lista(d.agendamento_status)}
    <h2>🎯 Leitura Estratégica</h2>${lista(d.leitura_estrategica)}
    <h2>✅ O que o closer deve bater</h2>${lista(d.closer_deve_bater, true)}
    <h2>💬 Frase de Impacto</h2>
    <p class="frase">"${escapeHtml(d.frase_impacto)}"</p>`;
}

function getServer() {
  return ($('server').value || DEFAULT_SERVER).trim().replace(/\/$/, '');
}

async function abaAtiva() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Envia "start" ao content script; injeta-o se ainda não estiver presente.
async function enviarStart(tabId, server) {
  const enviar = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'start', server }, (resp) => {
        if (chrome.runtime.lastError) resolve({ __semScript: true });
        else resolve(resp);
      });
    });

  let resp = await enviar();
  if (resp && resp.__semScript) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (_) {
      throw new Error('Não consegui acessar a página. Recarregue o WhatsApp Web (F5) e tente de novo.');
    }
    resp = await enviar();
  }
  if (!resp || (!resp.ok && !resp.__semScript)) {
    throw new Error('Recarregue o WhatsApp Web (F5) e tente de novo.');
  }
}

async function testarConexao() {
  const server = getServer();
  setStatus('Testando conexão…', { loading: true });
  try {
    const r = await fetch(server + '/api/status');
    const j = await r.json();
    setStatus(`✅ Servidor OK (provedor: ${j.provider}).`);
  } catch (_) {
    setStatus('❌ Servidor não respondeu. Rode "npm start" na pasta do projeto.', { erro: true });
  }
}

async function gerar() {
  $('gerar').disabled = true;
  try {
    const tab = await abaAtiva();
    if (!tab || !/^https:\/\/web\.whatsapp\.com\//.test(tab.url || '')) {
      throw new Error('Abra o WhatsApp Web (web.whatsapp.com) nesta aba primeiro.');
    }
    const server = getServer();
    setStatus('Iniciando…', { loading: true });
    await enviarStart(tab.id, server);
    setStatus(
      '🚀 <b>Report iniciado!</b> Acompanhe o aviso no canto inferior direito do WhatsApp. ' +
        'Você pode fechar este popup e continuar respondendo.'
    );
  } catch (err) {
    setStatus(err.message, { erro: true });
  } finally {
    $('gerar').disabled = false;
  }
}

// Mostra o último report gerado (se houver) ao abrir o popup.
function carregarUltimo() {
  chrome.storage.local.get({ ultimoReport: null }, ({ ultimoReport }) => {
    if (!ultimoReport) return;
    $('report').innerHTML = renderReport(ultimoReport.dados);
    $('report').classList.remove('hidden');
    $('dl').href = ultimoReport.server + '/api/download/' + encodeURIComponent(ultimoReport.arquivo);
    $('dl').classList.remove('hidden');
    const quando = new Date(ultimoReport.quando).toLocaleString('pt-BR');
    setStatus(`Último report: ${ultimoReport.nome || 'lead'} · ${quando}`);
  });
}

// Inicialização.
chrome.storage.local.get({ server: DEFAULT_SERVER }, (cfg) => {
  $('server').value = cfg.server || DEFAULT_SERVER;
});
$('server').addEventListener('change', () => {
  chrome.storage.local.set({ server: getServer() });
});
$('testar').addEventListener('click', testarConexao);
$('gerar').addEventListener('click', gerar);
carregarUltimo();
