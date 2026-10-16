'use strict';

const $ = (id) => document.getElementById(id);
// A equipe usa a nuvem: só cola a chave. Trocar para http://localhost:3000 ao testar local.
const DEFAULT_SERVER = 'https://report-pronix.vercel.app';

// txt é texto puro (nome, erro de servidor etc. nunca viram HTML). Passe html:true
// só com HTML que você mesmo montou, escapando o que vem de fora.
// Sobe a cada mensagem: quem terminou um trabalho em segundo plano (validar a chave) confere se
// ninguém escreveu nada depois dele antes de escrever por cima.
let statusVersao = 0;

/** Versão instalada e o que o master liberou para esta chave — para conferir de relance se está tudo certo. */
function mostrarInfoExt(eu) {
  const el = $('infoExt');
  if (!el) return;
  let versao = '';
  try {
    versao = chrome.runtime.getManifest().version;
  } catch (_) {
    /* fora da extensão (testes) */
  }
  const partes = [];
  if (versao) partes.push('Extensão v' + versao);
  if (eu && typeof eu.coach === 'boolean') partes.push('Coach: ' + (eu.coach ? 'liberado' : 'não liberado'));
  if (eu && eu.automacao === true) partes.push('Automação do RD: ligada');
  if (eu && eu.fichaCrm === false) partes.push('Ficha do lead: desligada pelo master');
  el.textContent = partes.join(' · ');
}
function setStatus(txt, { erro = false, loading = false, html = false } = {}) {
  statusVersao++;
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

// Nível de consciência: o report só mostra quando é bom (de "consciente da solução" para cima).
const NIVEIS_VISIVEIS = { solucao: 'Consciente da solução', produto: 'Consciente da nossa entrega', pronto: 'Pronto para decidir' };

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
  // O selo do report: o título escrito para o lead (ou o nome do nível, em report antigo), a fala dele e o porquê.
  const nivel = d.consciencia && (d.consciencia.titulo || NIVEIS_VISIVEIS[d.consciencia.nivel]);
  const tituloNivel = d.consciencia && d.consciencia.titulo ? ed('consciencia.titulo', d.consciencia.titulo) : escapeHtml(nivel || '');
  const falaNivel = d.consciencia && d.consciencia.fala ? `<p class="frase">“${escapeHtml(d.consciencia.fala)}”</p>` : '';
  const sinais = d.sinais_compra || [];
  // Termômetro de dores: só dor de fato (3 ou mais), na ordem em que vieram (da mais forte para a mais fraca).
  const dores = (d.dores || []).map((x, i) => ({ ...x, i })).filter((x) => x && x.dor && x.intensidade >= 3);
  const termo = (n) => `<span class="termo" title="${n} de 5">${[1, 2, 3, 4, 5].map((k) => `<i class="${k <= n ? 'on n' + n : ''}"></i>`).join('')}</span>`;
  const blocoDores = dores.length
    ? '<p><b>Termômetro de dores</b></p>' + dores.map((x) => `<p style="margin:6px 0 2px">${termo(x.intensidade)}<b>${ed('dores.' + x.i + '.dor', x.dor)}</b></p>` + (x.porque ? `<p class="frase">${ed('dores.' + x.i + '.porque', x.porque)}</p>` : '')).join('')
    : '';
  const temperatura = nivel || sinais.length || dores.length
    ? `<h2>${svgIc('<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>')} Temperatura do lead</h2>` +
      blocoDores +
      (nivel ? `<p><b>Momento do lead:</b> ${tituloNivel}</p>${falaNivel}<p class="frase">${ed('consciencia.porque', d.consciencia.porque)}</p>` : '') +
      (sinais.length ? `<p><b>Sinais de compra</b></p>${listaEditavel(sinais, false, 'sinais_compra')}` : '')
    : '';
  const conversa = (d.conversa || []).length
    ? `<h2>${svgIc('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')} Como foi a conversa</h2>${listaEditavel(d.conversa, false, 'conversa')}`
    : '';
  return tabela + temperatura + conversa + secoes + cit + frase + abertura;
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
// "arquivos" = o que injetar se a página ainda não tiver o script, na mesma ordem do manifest.
const PLATAFORMAS = [
  { regex: /^https:\/\/web\.whatsapp\.com\//, arquivos: ['agenda.js', 'afinidade.js', 'content.js'], nome: 'WhatsApp Web' },
  { regex: /^https:\/\/www\.instagram\.com\/direct\//, arquivos: ['afinidade.js', 'content-instagram.js'], nome: 'Instagram Direct' },
];
const plataformaDaAba = (url) => PLATAFORMAS.find((p) => p.regex.test(url || ''));

// Envia "start" ao content script; injeta-o se ainda não estiver presente.
async function enviarStart(tabId, server, arquivosContentScript, afinidade) {
  const enviar = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'start', server, afinidade: afinidade || null }, (resp) => {
        if (chrome.runtime.lastError) resolve({ __semScript: true });
        else resolve(resp);
      });
    });

  let resp = await enviar();
  if (resp && resp.__semScript) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: arquivosContentScript });
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
  // O SDR pode clicar em "Gerar" ou no .zip enquanto a chave valida: aí a mensagem dele é mais nova e
  // o "Conectado como…" não pode apagá-la (o nome no topo do popup continua sendo atualizado).
  const minhaVersao = statusVersao;
  const podeEscrever = () => statusVersao === minhaVersao;
  try {
    const r = await fetch(server + '/api/eu', { headers: { 'x-cr-key': chave } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Chave inválida.');
    $('sdrNome').textContent = j.nome;
    mostrarInfoExt(j);
    mostrarAnalises(j.analises, j.analisesFaltando);
    chrome.storage.local.set({ analises: Array.isArray(j.analises) ? j.analises : [] });
    const dono = await impressaoDaChave(chave);
    chrome.storage.local.get({ ultimoReport: null }, ({ ultimoReport }) => {
      if (ultimoReport && ultimoReport.dono !== dono) {
        chrome.storage.local.remove('ultimoReport');
        esconderReport();
      }
    });
    if (podeEscrever()) setStatus(`Conectado como <b>${escapeHtml(j.nome)}</b>.`, { html: true });
  } catch (err) {
    if (podeEscrever()) {
      setStatus('' + (err.message === 'Failed to fetch' ? 'Servidor não respondeu — confira a URL.' : err.message), { erro: true });
    }
  }
}

/**
 * Botões "Analisar Match com <closer>": um por closer com inteligência cadastrada no painel.
 * Clicar gera SÓ a análise de afinidade com esse closer (nota de 0 a 10 e PDF): nenhum report é gerado.
 */
function mostrarAnalises(lista, faltando) {
  const caixa = $('analises');
  if (!caixa) return;
  const closers = (Array.isArray(lista) ? lista : []).filter((c) => c && c.id).slice(0, 6);
  caixa.textContent = '';
  // Para o master, sem nenhum botão: diz o que falta para ele aparecer (o servidor só manda "faltando" ao master).
  const semBotao = !closers.length && Array.isArray(faltando);
  caixa.classList.toggle('hidden', !closers.length && !semBotao);
  if (semBotao) {
    const aviso = document.createElement('div');
    aviso.className = 'hint';
    aviso.id = 'analisesFalta';
    aviso.textContent = faltando.length
      ? `Botão "Analisar Match com ${String(faltando[0]).slice(0, 20)}": falta cadastrar a inteligência dele no painel (Closers → Inteligência).`
      : 'Botão "Analisar Match com o closer": cadastre o closer no painel (aba Closers) e a inteligência dele.';
    caixa.appendChild(aviso);
  }
  closers.forEach((c) => {
    const apelido = String(c.apelido || c.nome || '').slice(0, 20);
    const b = document.createElement('button');
    b.className = 'ghost analise';
    b.dataset.closer = c.id;
    b.textContent = `Analisar Match com ${apelido}`; // texto puro: nome de closer nunca vira HTML
    b.title = `Gera o report e analisa o match do lead com ${c.nome || apelido}`;
    b.addEventListener('click', () => gerar({ id: c.id, apelido, nome: String(c.nome || '').slice(0, 80) }));
    caixa.appendChild(b);
  });
  if (closers.length) {
    const dica = document.createElement('div');
    dica.className = 'hint';
    dica.textContent = 'Gera o report normal e mostra o match de 0 a 10 com o porquê e a base da nota. O PDF traz também os pontos de atenção e como conduzir a call.';
    caixa.appendChild(dica);
  }
}

async function gerar(afinidade) {
  const botoes = [$('gerar'), ...document.querySelectorAll('#analises button')];
  botoes.forEach((b) => { b.disabled = true; });
  try {
    const tab = await abaAtiva();
    const plataforma = tab && plataformaDaAba(tab.url);
    if (!plataforma) {
      throw new Error('Abra o WhatsApp Web ou uma conversa no Instagram Direct nesta aba primeiro.');
    }
    const server = getServer();
    setStatus('Iniciando…', { loading: true });
    await enviarStart(tab.id, server, plataforma.arquivos, afinidade);
    setStatus(
      afinidade
        ? `<b>Analisando o match com ${escapeHtml(afinidade.apelido)}…</b> Só a análise: nenhum report é gerado. Acompanhe o aviso no canto inferior direito da tela e não troque de conversa até ele ficar pronto.`
        : '<b>Report iniciado!</b> Acompanhe o aviso no canto inferior direito da tela. ' +
          'Você pode fechar este popup, mas não troque de conversa até o report ficar pronto.',
      { html: true }
    );
  } catch (err) {
    setStatus(err.message, { erro: true });
  } finally {
    botoes.forEach((b) => { b.disabled = false; });
  }
}

// .zip de hoje: os reports desta chave gerados hoje, só o último de cada lead — mesma regra da aba
// "Reports do dia" do site (o servidor decide quais entram).
async function baixarZipDoDia() {
  const chave = getChave();
  if (!chave) {
    setStatus('Cole a sua chave de acesso (peça ao admin).', { erro: true });
    return;
  }
  const btn = $('zipDia');
  btn.disabled = true;
  setStatus('Preparando o .zip de hoje…', { loading: true });
  try {
    const r = await fetch(getServer() + '/api/meus-reports/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cr-key': chave },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.erro || `Erro ${r.status}`);
    }
    const blob = await r.blob();
    const m = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (m && m[1]) || 'reports.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    const n = r.headers.get('X-Reports-No-Zip');
    setStatus(`.zip de hoje baixado${n ? ` com ${n} report(s)` : ''} — o último de cada lead.`);
  } catch (e) {
    const tempo = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    setStatus(tempo ? 'O servidor demorou demais. Tente de novo.' : e.message === 'Failed to fetch' ? 'Servidor não respondeu.' : e.message, { erro: true });
  } finally {
    btn.disabled = false;
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
chrome.storage.local.get({ server: DEFAULT_SERVER, chave: '', analises: [] }, (cfg) => {
  $('server').value = cfg.server || DEFAULT_SERVER;
  $('chave').value = cfg.chave || '';
  // Os botões de análise aparecem na hora (do último acesso); a validação da chave atualiza a lista.
  if (cfg.chave) mostrarAnalises(cfg.analises);
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
$('gerar').addEventListener('click', () => gerar());
$('zipDia').addEventListener('click', baixarZipDoDia);

// Ficha do RD Station no WhatsApp: ligada por padrão; o content script escuta a mudança na hora.
chrome.storage.local.get({ fichaCrm: true }, (c) => {
  $('fichaCrm').checked = c.fichaCrm !== false;
});
$('fichaCrm').addEventListener('change', () => chrome.storage.local.set({ fichaCrm: $('fichaCrm').checked }));
$('dl').addEventListener('click', baixarPdf);
carregarUltimo();

