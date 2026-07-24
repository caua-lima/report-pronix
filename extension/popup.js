'use strict';

const $ = (id) => document.getElementById(id);
// A equipe usa a nuvem: só cola a chave. Trocar para http://localhost:3000 ao testar local.
const DEFAULT_SERVER = 'https://report-closer.vercel.app';

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

// Report atual em memória: o SDR edita e o PDF é regerado a partir daqui.
let reportAtual = null;

// Ícone SVG inline (o popup não tem sistema de ícones do dashboard).
const svgIc = (d) =>
  `<svg viewBox="0 0 24 24" width="12" height="12" style="vertical-align:-2px;flex:none" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
// Trecho editável ligado a um caminho no objeto (ex.: "secoes.0.itens.1").
const ed = (caminho, texto) => `<span data-edit="${caminho}" contenteditable="true">${escapeHtml(texto || '')}</span>`;

function listaEditavel(itens, ordenada, base) {
  const tag = ordenada ? 'ol' : 'ul';
  const li = (itens || []).map((i, k) => `<li>${ed(base + '.' + k, i)}</li>`).join('');
  return `<${tag}>${li}</${tag}>`;
}

function renderReport(d) {
  const linhas = [];
  if (d.lead) linhas.push(`<tr><td class="rot">Lead</td><td>${ed('lead', d.lead)}</td></tr>`);
  (d.resumo || []).forEach((r, i) =>
    linhas.push(`<tr><td class="rot">${ed('resumo.' + i + '.rotulo', r.rotulo)}</td><td>${ed('resumo.' + i + '.valor', r.valor)}</td></tr>`)
  );
  const tabela = linhas.length ? `<table>${linhas.join('')}</table>` : '';
  const secoes = (d.secoes || [])
    .map((s, i) => `<h2>${ed('secoes.' + i + '.titulo', s.titulo)}</h2>${listaEditavel(s.itens, s.numerada, 'secoes.' + i + '.itens')}`)
    .join('');
  const cit = (d.citacoes && d.citacoes.length)
    ? `<h2>${svgIc('<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2.5-1.5 4-3.5 4"/><path d="M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2.5-1.5 4-3.5 4"/>')} Nas palavras do lead</h2>` +
      d.citacoes.map((c, i) => `<p class="frase">"${ed('citacoes.' + i, c)}"</p>`).join('')
    : '';
  const frase = d.frase_impacto
    ? `<h2>${svgIc('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>')} Frase de Impacto</h2><p class="frase">"${ed('frase_impacto', d.frase_impacto)}"</p>`
    : '';
  const abertura = d.abertura
    ? `<h2>${svgIc('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')} Como iniciar a reunião</h2><p class="frase">"${ed('abertura', d.abertura)}"</p>`
    : '';
  return tabela + secoes + cit + frase + abertura;
}

// Grava um valor no objeto seguindo o caminho "a.0.b".
function gravarNoCaminho(obj, caminho, valor) {
  const partes = caminho.split('.');
  let ref = obj;
  for (let i = 0; i < partes.length - 1; i++) ref = ref[partes[i]];
  ref[partes[partes.length - 1]] = valor;
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
    $('sdrNome').textContent = j.nome;
    setStatus(`Conectado como <b>${escapeHtml(j.nome)}</b>.`);
  } catch (err) {
    setStatus('' + (err.message === 'Failed to fetch' ? 'Servidor não respondeu — confira a URL.' : err.message), { erro: true });
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
      '<b>Report iniciado!</b> Acompanhe o aviso no canto inferior direito do WhatsApp. ' +
        'Você pode fechar este popup e continuar respondendo.'
    );
  } catch (err) {
    setStatus(err.message, { erro: true });
  } finally {
    $('gerar').disabled = false;
  }
}

// Atualiza o objeto em memória a cada edição do report na tela.
$('report').addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-edit]');
  if (!el || !reportAtual) return;
  gravarNoCaminho(reportAtual, el.dataset.edit, el.innerText.trim());
});

// Baixar PDF: regera a partir do report (editado ou não) via /api/pdf.
// Não chama a IA — é só desenho, então é de graça e reflete as edições.
async function baixarPdf() {
  if (!reportAtual) return;
  const btn = $('dl');
  const antes = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Gerando…';
  btn.style.pointerEvents = 'none';
  try {
    const r = await fetch(getServer() + '/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cr-key': getChave() },
      body: JSON.stringify({ dados: reportAtual }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.erro || 'Erro ao gerar o PDF.');
    const a = document.createElement('a');
    a.href = 'data:application/pdf;base64,' + data.arquivoBase64;
    a.download = data.arquivo || 'report.pdf';
    a.click();
  } catch (e) {
    setStatus(e.message === 'Failed to fetch' ? 'Servidor não respondeu.' : e.message, { erro: true });
  } finally {
    btn.innerHTML = antes;
    btn.style.pointerEvents = '';
  }
}

// Mostra o último report gerado (se houver) ao abrir o popup — já editável.
function carregarUltimo() {
  chrome.storage.local.get({ ultimoReport: null }, ({ ultimoReport }) => {
    if (!ultimoReport || !ultimoReport.dados) return;
    reportAtual = ultimoReport.dados;
    $('report').innerHTML = renderReport(reportAtual);
    $('report').classList.remove('hidden');
    $('editDica').classList.remove('hidden');
    $('dl').classList.remove('hidden');
    const quando = new Date(ultimoReport.quando).toLocaleString('pt-BR');
    setStatus(`Último report: ${ultimoReport.nome || 'lead'} · ${quando} · edite se quiser`);
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
$('dl').addEventListener('click', baixarPdf);
carregarUltimo();

