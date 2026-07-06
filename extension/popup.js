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

// Pede a raspagem ao content script; injeta-o se ainda não estiver presente.
async function raspar(tabId) {
  const enviar = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'scrape' }, (resp) => {
        if (chrome.runtime.lastError) resolve({ __semScript: true });
        else resolve(resp);
      });
    });

  let resp = await enviar();
  if (resp && resp.__semScript) {
    // content script não carregou (WhatsApp aberto antes da extensão): injeta e tenta de novo.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (e) {
      throw new Error('Não consegui acessar a página. Recarregue o WhatsApp Web (F5) e tente de novo.');
    }
    resp = await enviar();
  }
  if (!resp) throw new Error('Sem resposta da página. Recarregue o WhatsApp Web e tente de novo.');
  if (!resp.ok) throw new Error(resp.erro || 'Falha ao ler a conversa.');
  return resp;
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
  $('report').classList.add('hidden');
  $('dl').classList.add('hidden');
  const server = getServer();

  try {
    const tab = await abaAtiva();
    if (!tab || !/^https:\/\/web\.whatsapp\.com\//.test(tab.url || '')) {
      throw new Error('Abra o WhatsApp Web (web.whatsapp.com) nesta aba primeiro.');
    }

    setStatus('Lendo a conversa (rolando o histórico)… não feche este popup.', { loading: true });
    const { mensagens, nome } = await raspar(tab.id);
    if (!mensagens || mensagens.length === 0) {
      throw new Error('Nenhuma mensagem encontrada. Abra uma conversa com mensagens e tente de novo.');
    }

    setStatus(`Lidas ${mensagens.length} mensagens. Gerando report…`, { loading: true });
    const r = await fetch(server + '/api/report-direto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensagens, nome }),
    }).catch(() => {
      throw new Error('Servidor local não respondeu. Rode "npm start" e confira a porta.');
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.erro || 'Erro ao gerar o relatório.');

    $('report').innerHTML = renderReport(data.dados);
    $('report').classList.remove('hidden');
    $('dl').href = server + '/api/download/' + encodeURIComponent(data.arquivo);
    $('dl').classList.remove('hidden');
    setStatus(`✅ Report gerado a partir de ${mensagens.length} mensagens.`);
  } catch (err) {
    setStatus(err.message, { erro: true });
  } finally {
    $('gerar').disabled = false;
  }
}

// Inicialização: carrega URL salva.
chrome.storage.local.get({ server: DEFAULT_SERVER }, (cfg) => {
  $('server').value = cfg.server || DEFAULT_SERVER;
});
$('server').addEventListener('change', () => {
  chrome.storage.local.set({ server: getServer() });
});
$('testar').addEventListener('click', testarConexao);
$('gerar').addEventListener('click', gerar);
