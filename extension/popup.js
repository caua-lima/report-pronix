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
  const linhas = [];
  if (d.lead) linhas.push(`<tr><td class="rot">Lead</td><td>${escapeHtml(d.lead)}</td></tr>`);
  (d.resumo || []).forEach((r) =>
    linhas.push(`<tr><td class="rot">${escapeHtml(r.rotulo)}</td><td>${escapeHtml(r.valor)}</td></tr>`)
  );
  const tabela = linhas.length ? `<table>${linhas.join('')}</table>` : '';
  const secoes = (d.secoes || [])
    .map((s) => `<h2>${escapeHtml(s.titulo)}</h2>${lista(s.itens, s.numerada)}`)
    .join('');
  const cit = (d.citacoes && d.citacoes.length)
    ? `<h2>💬 Nas palavras do lead</h2>` + d.citacoes.map((c) => `<p class="frase">"${escapeHtml(c)}"</p>`).join('')
    : '';
  const frase = d.frase_impacto
    ? `<h2>🎯 Frase de Impacto</h2><p class="frase">"${escapeHtml(d.frase_impacto)}"</p>`
    : '';
  return tabela + secoes + cit + frase;
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

function getChave() {
  return ($('chave').value || '').trim();
}

// Valida a chave contra o servidor e mostra de quem ela é.
async function testarConexao() {
  const server = getServer();
  const chave = getChave();
  if (!chave) {
    setStatus('Cole a sua chave de acesso (peça ao admin).', { erro: true });
    return;
  }
  setStatus('Validando…', { loading: true });
  try {
    const r = await fetch(server + '/api/eu', { headers: { 'x-cr-key': chave } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Chave inválida.');
    setStatus(`✅ Conectado como <b>${escapeHtml(j.nome)}</b>.`);
  } catch (err) {
    setStatus('❌ ' + (err.message === 'Failed to fetch' ? 'Servidor não respondeu — confira a URL.' : err.message), { erro: true });
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
    if (!ultimoReport.arquivoBase64) return;
    $('dl').href = 'data:application/pdf;base64,' + ultimoReport.arquivoBase64;
    $('dl').setAttribute('download', ultimoReport.arquivo || 'report.pdf');
    $('dl').classList.remove('hidden');
    const quando = new Date(ultimoReport.quando).toLocaleString('pt-BR');
    setStatus(`Último report: ${ultimoReport.nome || 'lead'} · ${quando}`);
  });
}

// Inicialização: carrega servidor e chave salvos.
chrome.storage.local.get({ server: DEFAULT_SERVER, chave: '' }, (cfg) => {
  $('server').value = cfg.server || DEFAULT_SERVER;
  $('chave').value = cfg.chave || '';
  if (cfg.chave) testarConexao();
});
$('server').addEventListener('change', () => {
  chrome.storage.local.set({ server: getServer() });
});
$('chave').addEventListener('change', () => {
  chrome.storage.local.set({ chave: getChave() });
});
$('testar').addEventListener('click', () => {
  chrome.storage.local.set({ server: getServer(), chave: getChave() }, testarConexao);
});
$('gerar').addEventListener('click', gerar);
carregarUltimo();

// Contadores do dia (rastreados pela extensão).
function carregarContadores() {
  const hoje = new Date().toISOString().slice(0, 10);
  chrome.storage.local.get(['crDia'], ({ crDia }) => {
    const d = crDia && crDia.data === hoje ? crDia : { iniciados: [], respostas: [], recontatos: [] };
    $('cIni').textContent = (d.iniciados || []).length;
    $('cResp').textContent = (d.respostas || []).length;
    $('cRec').textContent = (d.recontatos || []).length;
  });
}
carregarContadores();
