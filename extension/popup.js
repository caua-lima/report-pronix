'use strict';

const $ = (id) => document.getElementById(id);
// A equipe usa a nuvem: só cola a chave. Trocar para http://localhost:3000 ao testar local.
const DEFAULT_SERVER = 'https://report-closer.vercel.app';

// txt é texto puro (nome, erro de servidor etc. nunca viram HTML). Passe html:true
// só com HTML que você mesmo montou, escapando o que vem de fora.
function setStatus(txt, { erro = false, loading = false, html = false } = {}) {
  const el = $('status');
  el.className = 'status' + (erro ? ' erro' : '');
  el.textContent = '';
  if (loading) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    el.appendChild(sp);
  }
  if (html) el.insertAdjacentHTML('beforeend', txt || '');
  else el.appendChild(document.createTextNode(txt || ''));
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

// Qual site está aberto: cada um tem seu content script e sua leitura de DOM.
const PLATAFORMAS = [
  { regex: /^https:\/\/web\.whatsapp\.com\//, arquivo: 'content.js', nome: 'WhatsApp Web' },
  { regex: /^https:\/\/www\.instagram\.com\/direct\//, arquivo: 'content-instagram.js', nome: 'Instagram Direct' },
];
const plataformaDaAba = (url) => PLATAFORMAS.find((p) => p.regex.test(url || ''));

// Envia "start" ao content script; injeta-o se ainda não estiver presente.
async function enviarStart(tabId, server, arquivoContentScript) {
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
      await chrome.scripting.executeScript({ target: { tabId }, files: [arquivoContentScript] });
    } catch (_) {
      throw new Error('Não consegui acessar a página. Recarregue-a (F5) e tente de novo.');
    }
    resp = await enviar();
  }
  if (!resp || (!resp.ok && !resp.__semScript)) {
    throw new Error('Recarregue a página (F5) e tente de novo.');
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
    const dono = await impressaoDaChave(chave);
    chrome.storage.local.get({ ultimoReport: null }, ({ ultimoReport }) => {
      if (ultimoReport && ultimoReport.dono !== dono) {
        chrome.storage.local.remove('ultimoReport');
        esconderReport();
      }
    });
    setStatus(`Conectado como <b>${escapeHtml(j.nome)}</b>.`, { html: true });
  } catch (err) {
    setStatus('' + (err.message === 'Failed to fetch' ? 'Servidor não respondeu — confira a URL.' : err.message), { erro: true });
  }
}

async function gerar() {
  $('gerar').disabled = true;
  try {
    const tab = await abaAtiva();
    const plataforma = tab && plataformaDaAba(tab.url);
    if (!plataforma) {
      throw new Error('Abra o WhatsApp Web ou uma conversa no Instagram Direct nesta aba primeiro.');
    }
    const server = getServer();
    setStatus('Iniciando…', { loading: true });
    await enviarStart(tab.id, server, plataforma.arquivo);
    setStatus(
      '<b>Report iniciado!</b> Acompanhe o aviso no canto inferior direito da tela. ' +
        'Você pode fechar este popup, mas não troque de conversa até o report ficar pronto.',
      { html: true }
    );
  } catch (err) {
    setStatus(err.message, { erro: true });
  } finally {
    $('gerar').disabled = false;
  }
}

// Atualiza o objeto em memória a cada edição do report na tela — e guarda a edição, para não
// se perder se o popup fechar (é comum: o SDR clica fora e o popup some).
let salvarTimer = null;
let reportQuando = 0; // qual report (pelo carimbo) está na tela: edição de um não pode sobrescrever outro
function persistirEdicao() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(() => {
    chrome.storage.local.get({ ultimoReport: null }, ({ ultimoReport }) => {
      if (!ultimoReport || !reportAtual || ultimoReport.quando !== reportQuando) return;
      ultimoReport.dados = reportAtual;
      ultimoReport.versao = (ultimoReport.versao || 0) + 1;
      ultimoReport.editadoEm = Date.now();
      chrome.storage.local.set({ ultimoReport });
    });
  }, 400);
}
$('report').addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-edit]');
  if (!el || !reportAtual) return;
  gravarNoCaminho(reportAtual, el.dataset.edit, el.innerText.trim());
  persistirEdicao();
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

// Impressão digital da chave (a chave em si nunca é gravada junto do report).
async function impressaoDaChave(chave) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((chave || '').trim()));
    return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return '';
  }
}
const mesmoServidor = (a, b) => String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, '');

// Esconde o report da tela (troca de chave, por exemplo).
function esconderReport() {
  reportAtual = null;
  reportQuando = 0;
  $('report').classList.add('hidden');
  $('editDica').classList.add('hidden');
  $('dl').classList.add('hidden');
}

// Mostra o último report gerado ao abrir o popup — já editável. Só o de QUEM está logado nesta
// chave e neste servidor: report é conversa de lead, não pode aparecer para outra pessoa que usa o mesmo navegador.
function carregarUltimo() {
  chrome.storage.local.get({ ultimoReport: null, chave: '', server: DEFAULT_SERVER }, async (cfg) => {
    const ultimoReport = cfg.ultimoReport;
    if (!ultimoReport || !ultimoReport.dados) return;
    const dono = await impressaoDaChave(cfg.chave);
    if (!dono || ultimoReport.dono !== dono || !mesmoServidor(ultimoReport.server, cfg.server)) return;
    reportAtual = ultimoReport.dados;
    reportQuando = ultimoReport.quando;
    $('report').innerHTML = renderReport(reportAtual);
    $('report').classList.remove('hidden');
    $('editDica').classList.remove('hidden');
    $('dl').classList.remove('hidden');
    const quando = new Date(ultimoReport.quando).toLocaleString('pt-BR');
    setStatus(`Último report: ${ultimoReport.nome || 'lead'} · ${quando} · ${ultimoReport.versao ? 'editado · ' : ''}edite se quiser`);
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

