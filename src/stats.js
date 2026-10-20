'use strict';

// Histórico de reports gerados e do quanto cada um custou.
// Alimenta a aba "Reports gerados" do dashboard.

const crypto = require('crypto');
const db = require('./db');
const pdfStorage = require('./pdfStorage');
const { custoUSD } = require('./precos');
const { chaveDoPerfil } = require('./perfil');
const { chaveDoNivel } = require('./consciencia');

const CHAVE_DB = 'reports';
const LIMITE = 5000;

// Registro de consumo, separado dos reports: excluir um report tira ele do histórico
// mas o gasto com a IA já aconteceu. Guarda só o necessário para somar o gasto —
// nada de conteúdo de conversa.
const CHAVE_CONSUMO = 'consumo';
const LIMITE_CONSUMO = 20000;

/**
 * Registra um report gerado, com o consumo de tokens e o custo em dólares.
 * @param {{id?: string}} params.id — se o chamador já gerou o id (pra salvar o
 *   PDF sob a mesma chave em src/pdfStorage.js), passa aqui; senão gera um novo.
 */
async function registrar({
  id, usuarioId, usuarioNome, lead, contato, origem, uso, reportKey, arquivo, qualidade, captura, citacoesRemovidas, leitura, vinculo,
}) {
  const v = vinculoLimpo(vinculo);
  const quando = new Date().toISOString();
  const u = uso || {};
  const idFinal = id || crypto.randomBytes(5).toString('hex');
  const custo = custoUSD({
    modelo: u.modelo,
    entrada: u.entrada,
    saida: u.saida,
    cacheLeitura: u.cacheLeitura,
    cacheEscrita: u.cacheEscrita,
    quando,
  });
  await db.push(
    CHAVE_DB,
    {
      id: idFinal,
      usuarioId: usuarioId || '',
      usuarioNome: usuarioNome || '',
      lead: lead || '',
      // Nome/telefone que a extensão leu no cabeçalho da conversa (ou o nome digitado no modo manual).
      // É o que identifica "o mesmo lead" entre gerações — ver src/diario.js.
      contato: String(contato || '').trim().slice(0, 120),
      origem: origem || 'extensao', // extensao | manual
      quando,
      dia: emDiaLocal(quando), // dia no fuso do time, para o filtro do dashboard
      // Identifica a geração (idempotência/duplicidade) e o arquivo/modo usados —
      // reportKey e arquivo não guardam a conversa, só metadados.
      reportKey: reportKey || '',
      arquivo: arquivo || '',
      qualidade: qualidade || 'standard',
      // Preenchido manualmente pelo admin depois (closer que fez a call e o
      // resultado) — ver atualizarResultado(). Vazio = "não marcado ainda",
      // não confundir com "não teve venda": o admin decide o que significa
      // deixar em branco.
      closerId: '',
      closerNome: '',
      closerEmail: '',
      leadEmail: v.email, // e-mail do LEAD (não do closer): vem do card do RD e serve para achar o lead de novo
      // Vínculo com o lead no RD, lido do card que estava aberto na hora do report: é por ele (e não pelo
      // nome do contato no WhatsApp) que o desfecho da reunião é puxado depois. Ver src/vendasRd.js.
      telefone: v.telefone,
      rdContatoId: v.contatoId,
      rdDealId: v.dealId,
      resultado: '', // '' | 'venda_call' | 'venda_fup' | 'pix_compromisso'
      dataReuniao: '',
      dataFechamento: '',
      diasParaFechar: null,
      versao: 0, // sobe a cada edição do resultado — detecta dois admins editando o mesmo report
      // Como foi a leitura da conversa (áudios achados/transcritos etc.), enviado pela
      // extensão. null = veio do modo manual ou de uma extensão antiga.
      captura: captura || null,
      citacoesRemovidas: citacoesRemovidas || 0,
      // Leitura da IA sobre o lead e a prospecção (perfil, nível de consciência, BANT/SPIN, perguntas-chave).
      // É o que alimenta a aba "Resultados da reunião": qual closer fecha com qual perfil, o que funciona.
      // Não guarda a conversa — só a classificação e as perguntas do pré-vendedor.
      perfil: (leitura && leitura.perfil) || '',
      perfilEvidencia: (leitura && leitura.perfilEvidencia) || '',
      consciencia: (leitura && leitura.consciencia) || '',
      conscienciaPorque: (leitura && leitura.conscienciaPorque) || '',
      analise: (leitura && leitura.analise) || null,
      // Correções do master (vazio = vale a leitura da IA) e a anotação do que deu a reunião.
      perfilReal: '',
      conscienciaReal: '',
      obsReuniao: '',
      // Dados da venda, preenchidos na aba Resultados: qual produto, por quanto e como pagou.
      produto: '', // '' | 'performance' | 'acelera'
      ticket: 0, // valor fechado, em reais
      pagamento: '', // forma de pagamento (texto curto)
      vendidoNoRd: '', // quando o sistema viu o card marcado como vendido no RD (o tipo de venda é o master que diz)
      modelo: u.modelo || '',
      entrada: u.entrada || 0,
      saida: u.saida || 0,
      cacheLeitura: u.cacheLeitura || 0,
      cacheEscrita: u.cacheEscrita || 0,
      // Guardado junto porque o preço do modelo muda com o tempo (promoção, troca de
      // modelo): recalcular depois daria um número diferente do que foi cobrado.
      custo,
    },
    LIMITE
  );
  // Falha no registro de consumo não pode derrubar a entrega do report.
  await db
    .push(
      CHAVE_CONSUMO,
      {
        id: idFinal,
        quando,
        dia: emDiaLocal(quando),
        usuarioNome: usuarioNome || '',
        origem: origem || 'extensao',
        qualidade: qualidade || 'standard',
        modelo: u.modelo || '',
        custo,
      },
      LIMITE_CONSUMO
    )
    .catch((err) => console.error('Falha ao registrar o consumo:', err.message));
}

// O carimbo é gravado em UTC, mas o dashboard filtra por dia do Brasil. Sem converter,
// tudo que sai depois das 21h cairia no dia seguinte e sumiria do "Hoje".
const TZ = process.env.TZ_RELATORIO || 'America/Sao_Paulo';
const emDiaLocal = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // en-CA já sai como YYYY-MM-DD
};

const dia = (r) => r.dia || emDiaLocal(r.quando); // dia: gravado a partir de agora; quando: histórico
const hojeStr = () => emDiaLocal(new Date());

/**
 * Mesmo filtro usado por resumo() e listar() — de/ate em YYYY-MM-DD, sdr é o nome. Sai em ordem de
 * geração: os reports importados (que entram no fim da lista) ficam no lugar do dia deles.
 */
function filtrar(todos, { de, ate, sdr } = {}) {
  return todos.filter((r) => {
    const d = dia(r);
    if (de && d < de) return false;
    if (ate && d > ate) return false;
    if (sdr && (r.usuarioNome || '') !== sdr) return false;
    return true;
  }).sort((a, b) => String(a.quando || '').localeCompare(String(b.quando || '')));
}

/**
 * Report que veio de outro sistema (o Report Closer, da empresa), com o que já se sabe dele: quando foi
 * gerado, a leitura da IA, o closer, o resultado e a venda. Entra na mesma lista, sem consumo (a IA rodou
 * lá). O id, o dono e o closer já vêm resolvidos por src/importarReports.js; o resto é conferido aqui.
 */
async function importar(r) {
  const quando = r.quando;
  const v = vinculoLimpo({ telefone: r.telefone, email: r.leadEmail, contatoId: r.rdContatoId, dealId: r.rdDealId });
  const texto = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const marca = (x) => texto(x === true ? quando : x, 30);
  const registro = {
    id: r.id, usuarioId: r.usuarioId, usuarioNome: r.usuarioNome, lead: texto(r.lead, 120), contato: texto(r.contato, 120),
    origem: r.origem === 'rd' ? 'rd' : 'report-closer', quando, dia: emDiaLocal(quando), reportKey: '', arquivo: texto(r.arquivo, 120), qualidade: 'standard',
    closerId: r.closerId || '', closerNome: r.closerNome || '', closerEmail: '', closerOrigem: '', closerEm: r.closerId ? new Date().toISOString() : '',
    leadEmail: v.email, telefone: v.telefone, rdContatoId: v.contatoId, rdDealId: v.dealId,
    resultado: RESULTADOS_VALIDOS.has(r.resultado) ? r.resultado : '', resultadoOrigem: '',
    dataReuniao: DATA_OK.test(r.dataReuniao || '') ? r.dataReuniao : '', dataFechamento: DATA_OK.test(r.dataFechamento || '') ? r.dataFechamento : '',
    diasParaFechar: null, versao: 0, captura: null, citacoesRemovidas: 0,
    perfil: texto(r.perfil, 40), perfilEvidencia: texto(r.perfilEvidencia, 400), consciencia: texto(r.consciencia, 40), conscienciaPorque: texto(r.conscienciaPorque, 400),
    analise: r.analise && typeof r.analise === 'object' && !Array.isArray(r.analise) ? r.analise : null,
    perfilReal: texto(r.perfilReal, 40), conscienciaReal: texto(r.conscienciaReal, 40), obsReuniao: texto(r.obsReuniao, 500),
    produto: PRODUTOS_VALIDOS.includes(r.produto) ? r.produto : '', ticket: valorEmReais(r.ticket), pagamento: texto(r.pagamento, 80),
    vendidoNoRd: marca(r.vendidoNoRd), encerradoPeloRd: marca(r.encerradoPeloRd), rdSituacao: texto(r.rdSituacao, 160),
    modelo: '', entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0, custo: 0,
    importadoDe: r.origem === 'rd' ? 'rd' : 'report-closer', importadoEm: new Date().toISOString(),
  };
  await db.push(CHAVE_DB, registro, LIMITE);
  return registro;
}

/**
 * Lista os registros crus (sem agregação) que batem com o filtro — usado pelo
 * download em massa (GET /api/admin/reports/pdf-zip), que precisa do id e do
 * usuarioNome de cada report pra buscar o PDF e organizar por SDR no zip.
 * @param {{de?: string, ate?: string, sdr?: string}} filtro
 */
async function listar({ de, ate, sdr } = {}) {
  const todos = await db.range(CHAVE_DB);
  return filtrar(todos, { de, ate, sdr });
}

/**
 * Resumo para o dashboard, já filtrado.
 * @param {{de?: string, ate?: string, sdr?: string}} filtro datas em YYYY-MM-DD; sdr é o nome.
 */
async function resumo({ de, ate, sdr } = {}) {
  const todos = await db.range(CHAVE_DB);
  const dentro = filtrar(todos, { de, ate, sdr });

  const soma = (lista) => lista.reduce((t, r) => t + (r.custo || 0), 0);

  // Gasto de reports que foram excluídos do histórico (o dinheiro já foi pra IA).
  // Se a lista de reports está no limite, os mais antigos saíram por corte — não por
  // exclusão —, então só conta o consumo a partir do report mais antigo que ainda existe.
  let excluidos = [];
  let resumosRapidos = [];
  let aquecimentos = [];
  try {
    const ativos = new Set(todos.map((r) => r.id));
    const corte = todos.length >= LIMITE ? todos[0].quando : '';
    const consumo = await db.range(CHAVE_CONSUMO);
    // Resumos rápidos do cartão do WhatsApp não são reports: têm a conta deles.
    resumosRapidos = consumo.filter((c) => c.tipo === 'resumo');
    // Batidas que mantêm o cache do prompt vivo (src/aquecimento.js): também não são reports.
    aquecimentos = consumo.filter((c) => c.tipo === 'aquecimento');
    excluidos = consumo.filter((c) => c.tipo !== 'resumo' && c.tipo !== 'aquecimento' && !ativos.has(c.id) && (!corte || c.quando >= corte));
  } catch (err) {
    console.error('Falha ao ler o consumo:', err.message);
  }
  const excluidosDentro = filtrar(excluidos, { de, ate, sdr });

  // Por SDR
  const porUsuario = new Map();
  dentro.forEach((r) => {
    const nome = r.usuarioNome || '—';
    const u = porUsuario.get(nome) || { nome, total: 0, custo: 0, entrada: 0, saida: 0 };
    u.total++;
    u.custo += r.custo || 0;
    u.entrada += r.entrada || 0;
    u.saida += r.saida || 0;
    porUsuario.set(nome, u);
  });

  // Por closer (quem foi marcado manualmente) — base pra entender depois quem
  // fecha mais e com que tipo de lead. resultado vazio = sem venda (é o admin
  // quem decide isso deixando em branco, não é "não preenchido ainda").
  const porCloser = new Map();
  dentro.forEach((r) => {
    if (!r.closerId) return;
    const c = porCloser.get(r.closerId) || {
      closerId: r.closerId,
      nome: r.closerNome || '—',
      total: 0,
      vendas: 0,
      vendaCall: 0,
      vendaFup: 0,
      pixCompromisso: 0,
    };
    c.total++;
    if (ehVenda(r.resultado)) c.vendas++;
    if (r.resultado === 'venda_call') c.vendaCall++;
    if (r.resultado === 'venda_fup') c.vendaFup++;
    if (r.resultado === 'pix_compromisso') c.pixCompromisso++;
    porCloser.set(r.closerId, c);
  });

  // Por dia (para ver o gasto diário)
  const porDia = new Map();
  dentro.forEach((r) => {
    const d = dia(r);
    const x = porDia.get(d) || { dia: d, total: 0, custo: 0 };
    x.total++;
    x.custo += r.custo || 0;
    porDia.set(d, x);
  });

  // Por dia e por mês, sobre TODO o histórico — a pergunta "quanto gasta por mês"
  // só faz sentido olhando pra tudo, não só pro período filtrado no topo.
  const porDiaGeral = new Map();
  const porMesGeral = new Map();
  todos.forEach((r) => {
    const d = dia(r);
    const m = d.slice(0, 7); // YYYY-MM
    const custo = r.custo || 0;
    const xd = porDiaGeral.get(d) || { dia: d, total: 0, custo: 0 };
    xd.total++;
    xd.custo += custo;
    porDiaGeral.set(d, xd);
    const xm = porMesGeral.get(m) || { mes: m, total: 0, custo: 0 };
    xm.total++;
    xm.custo += custo;
    porMesGeral.set(m, xm);
  });

  const hoje = hojeStr();
  return {
    // Do período filtrado — sempre em ordem cronológica: da primeira pra última.
    total: dentro.length,
    consumoExcluido: { total: excluidosDentro.length, custo: soma(excluidosDentro) },
    custo: soma(dentro),
    custoMedio: dentro.length ? soma(dentro) / dentro.length : 0,
    tokensEntrada: dentro.reduce((t, r) => t + (r.entrada || 0), 0),
    tokensSaida: dentro.reduce((t, r) => t + (r.saida || 0), 0),
    // Baseline para decidir custo/qualidade com número, não com achismo:
    // taxaCache = parte da entrada que o cache do prompt devolveu barato; as demais mostram
    // quantos reports saíram de leitura parcial (áudio que faltou) e quantas citações não bateram com o lead.
    qualidade: (() => {
      const leitura = dentro.reduce((t, r) => t + (r.cacheLeitura || 0), 0);
      const escrita = dentro.reduce((t, r) => t + (r.cacheEscrita || 0), 0);
      const entrada = dentro.reduce((t, r) => t + (r.entrada || 0), 0);
      const total = leitura + escrita + entrada;
      return {
        taxaCache: total ? leitura / total : 0,
        // Report que achou o prefixo no cache (leu mais do que escreveu) x o que pagou a escrita.
        reportsCacheQuente: dentro.filter((r) => (r.cacheLeitura || 0) > (r.cacheEscrita || 0)).length,
        reportsComCache: dentro.filter((r) => (r.cacheLeitura || 0) + (r.cacheEscrita || 0) > 0).length,
        tokensCacheLeitura: leitura,
        tokensCacheEscrita: escrita,
        comCaptura: dentro.filter((r) => r.captura).length,
        capturaParcial: dentro.filter((r) => r.captura && r.captura.incompleta).length,
        citacoesRemovidas: dentro.reduce((t, r) => t + (r.citacoesRemovidas || 0), 0),
      };
    })(),
    porUsuario: [...porUsuario.values()].sort((a, b) => b.total - a.total),
    porCloser: [...porCloser.values()]
      .map((c) => ({ ...c, taxa: c.total ? c.vendas / c.total : 0 }))
      .sort((a, b) => b.taxa - a.taxa || b.total - a.total),
    porDia: [...porDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1)),
    ultimos: dentro.slice(-60),
    // Sempre sobre tudo, para o filtro não esconder o retrato geral
    geral: {
      consumoExcluido: { total: excluidos.length, custo: soma(excluidos) },
      resumosRapidos: { total: resumosRapidos.length, custo: soma(resumosRapidos) },
      aquecimentos: { total: aquecimentos.length, custo: soma(aquecimentos), noPeriodo: filtrar(aquecimentos, { de, ate }).length, custoNoPeriodo: soma(filtrar(aquecimentos, { de, ate })) },
      total: todos.length,
      custo: soma(todos),
      hoje: todos.filter((r) => dia(r) === hoje).length,
      custoHoje: soma(todos.filter((r) => dia(r) === hoje)),
      custoMes: soma(todos.filter((r) => dia(r) >= hoje.slice(0, 8) + '01')),
      mediaDiaria: porDiaGeral.size ? soma(todos) / porDiaGeral.size : 0,
      mediaMensal: porMesGeral.size ? soma(todos) / porMesGeral.size : 0,
      porMes: [...porMesGeral.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1)),
      sdrs: [...new Set(todos.map((r) => r.usuarioNome).filter(Boolean))].sort(),
    },
  };
}

/**
 * Remove um report do histórico (para tirar testes que sujam os números).
 * @returns {Promise<boolean>} true se achou e removeu.
 */
async function remover(id) {
  if (!id) return false;
  const removeu = await db.removerDaLista(CHAVE_DB, (r) => r.id === id);
  if (removeu) await pdfStorage.remover(id).catch(() => {});
  return removeu;
}

/**
 * Acha o report mais recente com a mesma reportKey (idempotência — evita
 * gerar/cobrar de novo a mesma conversa sem intenção explícita).
 * Varredura linear: a base já é limitada a LIMITE registros, não precisa de
 * índice — mesmo padrão simples usado em removerDaLista.
 * @returns {Promise<object|null>}
 */
async function buscarPorChave(reportKey) {
  if (!reportKey) return null;
  const todos = await db.range(CHAVE_DB);
  for (let i = todos.length - 1; i >= 0; i--) {
    if (todos[i].reportKey === reportKey) return todos[i];
  }
  return null;
}

/** Registro completo de um report pelo id, ou null. */
async function buscarPorId(id) {
  if (!id) return null;
  const todos = await db.range(CHAVE_DB);
  return todos.find((r) => r.id === id) || null;
}

const ID_RD = /^[A-Za-z0-9_-]{1,40}$/;
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** { telefone, email, contatoId, dealId } -> só o que é válido (o resto vira ''). */
function vinculoLimpo(v) {
  const x = v && typeof v === 'object' ? v : {};
  const tel = String(x.telefone || '').replace(/\D/g, '');
  const email = String(x.email || '').trim().toLowerCase();
  return {
    telefone: tel.length >= 10 && tel.length <= 15 ? tel : '',
    email: EMAIL_OK.test(email) ? email.slice(0, 120) : '',
    contatoId: ID_RD.test(String(x.contatoId || '')) ? String(x.contatoId) : '',
    dealId: ID_RD.test(String(x.dealId || '')) ? String(x.dealId) : '',
  };
}
// Marcas da conferência no RD: não são edição de ninguém, então não sobem a versão do report
// (quem está com a tela aberta não leva "alterado por outra pessoa" por causa da rodada automática).
const SO_CONFERENCIA = new Set(['rdConferidoEm', 'rdSituacao', 'rdContatoId', 'rdDealId', 'telefone', 'rdVendaLida']);

// '' = ainda não marcado. Os três primeiros são venda; os outros dizem o que houve com a reunião.
const RESULTADOS_VALIDOS = new Set(['', 'venda_call', 'venda_fup', 'pix_compromisso', 'sem_venda', 'no_show', 'em_followup']);
const RESULTADOS_VENDA = new Set(['venda_call', 'venda_fup', 'pix_compromisso']);
const ehVenda = (r) => RESULTADOS_VENDA.has(r);
const PRODUTOS_VALIDOS = ['performance', 'acelera'];
/** "R$ 15.984,00", "15984" ou 15984.5 -> número em reais (0 se não der para ler). */
function valorEmReais(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0;
  let t = String(v || '').replace(/[^\d.,]/g, '');
  if (!t) return 0;
  // vírgula é o decimal brasileiro; ponto sozinho com 3 casas depois é separador de milhar
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 10000000 ? Math.round(n * 100) / 100 : 0;
}
const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;

/** Diferença em dias corridos entre duas datas YYYY-MM-DD (b - a). null se alguma faltar/for inválida. */
function diasEntre(a, b) {
  if (!DATA_OK.test(a || '') || !DATA_OK.test(b || '')) return null;
  const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
  return Math.round(ms / 864e5);
}

/**
 * Marca manualmente quem fez a call de um report e o resultado — é o admin
 * quem alimenta isso aos poucos, reeditando quando quiser (não é preenchido
 * pela IA nem no momento da geração).
 * @param {{closerId?: string, closerNome?: string, closerEmail?: string,
 *   leadEmail?: string, resultado?: string, dataReuniao?: string,
 *   dataFechamento?: string}} campos
 * @returns {Promise<boolean>} true se achou o report e atualizou.
 */
async function atualizarResultado(id, campos = {}, { versaoEsperada } = {}) {
  if (!id) return false;
  // Só mexe no que veio no pedido: editar um campo não pode apagar os outros.
  const tem = (k) => Object.prototype.hasOwnProperty.call(campos, k) && campos[k] !== undefined;
  let versao = 0;
  const achou = await db.atualizarNaLista(
    CHAVE_DB,
    (r) => r.id === id,
    (r) => {
      const atual = Number(r.versao) || 0;
      // Quem editou baseado numa versão antiga não sobrescreve o que outra pessoa salvou depois.
      if (versaoEsperada != null && Number(versaoEsperada) !== atual) {
        const e = new Error('Este report foi alterado por outra pessoa. Atualize a tela e edite de novo.');
        e.codigo = 'CONFLITO';
        e.atual = r;
        throw e;
      }
      const novo = { ...r };
      if (tem('closerId')) {
        novo.closerId = campos.closerId || '';
        novo.closerNome = campos.closerNome || '';
        novo.closerEmail = campos.closerEmail || '';
        // De onde o closer veio: 'rd' ou 'agenda' quando o sistema preencheu sozinho; '' quando foi escolhido à mão.
        novo.closerOrigem = novo.closerId && ['rd', 'agenda'].includes(campos.closerOrigem) ? campos.closerOrigem : '';
        novo.closerEm = novo.closerId ? new Date().toISOString() : '';
      }
      if (tem('leadEmail')) novo.leadEmail = String(campos.leadEmail || '').trim().toLowerCase().slice(0, 200);
      if (tem('telefone')) novo.telefone = vinculoLimpo({ telefone: campos.telefone }).telefone;
      if (tem('rdContatoId')) novo.rdContatoId = vinculoLimpo({ contatoId: campos.rdContatoId }).contatoId;
      if (tem('rdDealId')) novo.rdDealId = vinculoLimpo({ dealId: campos.rdDealId }).dealId;
      // O que o RD mostrou na última conferência (etapa, funil, responsável) — ou que o lead não foi achado.
      if (tem('rdSituacao')) novo.rdSituacao = String(campos.rdSituacao || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (tem('rdVendaLida')) novo.rdVendaLida = String(campos.rdVendaLida || '').slice(0, 30);
      if (tem('resultado')) {
        novo.resultado = RESULTADOS_VALIDOS.has(campos.resultado) ? campos.resultado : '';
        // 'rd' quando foi a conferência no RD que deu o resultado (ele acompanha o card); '' quando foi à mão.
        novo.resultadoOrigem = novo.resultado && campos.resultadoOrigem === 'rd' ? 'rd' : '';
      }
      if (tem('dataReuniao')) novo.dataReuniao = DATA_OK.test(campos.dataReuniao || '') ? campos.dataReuniao : '';
      if (tem('produto')) novo.produto = PRODUTOS_VALIDOS.includes(campos.produto) ? campos.produto : '';
      if (tem('ticket')) novo.ticket = valorEmReais(campos.ticket);
      if (tem('pagamento')) novo.pagamento = String(campos.pagamento || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (tem('vendidoNoRd')) novo.vendidoNoRd = String(campos.vendidoNoRd || '').slice(0, 30);
      // Marcas da leitura do RD: quando foi conferido por último e se foi o RD que encerrou ("não comprou").
      if (tem('rdConferidoEm')) novo.rdConferidoEm = String(campos.rdConferidoEm || '').slice(0, 30);
      if (tem('encerradoPeloRd')) novo.encerradoPeloRd = String(campos.encerradoPeloRd || '').slice(0, 30);
      if (tem('obsReuniao')) novo.obsReuniao = String(campos.obsReuniao || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (tem('perfilReal')) novo.perfilReal = chaveDoPerfil(campos.perfilReal) || '';
      if (tem('conscienciaReal')) novo.conscienciaReal = chaveDoNivel(campos.conscienciaReal) || '';
      if (tem('dataFechamento')) {
        novo.dataFechamento = DATA_OK.test(campos.dataFechamento || '') ? campos.dataFechamento : '';
      }
      novo.diasParaFechar = diasEntre(novo.dataReuniao, novo.dataFechamento);
      const soConferencia = Object.keys(campos).filter(tem).every((k) => SO_CONFERENCIA.has(k));
      if (!soConferencia) {
        novo.versao = atual + 1;
        novo.atualizadoEm = new Date().toISOString();
      }
      versao = Number(novo.versao) || 0;
      return novo;
    }
  );
  return achou ? { versao } : false;
}

/**
 * Guarda no report a nota de afinidade com um closer (a última pedida). Não mexe na versão do
 * resultado: é anotação da análise, não edição do master. Serve para, depois, comparar a nota
 * com o que a reunião deu.
 */
async function anotarAfinidade(id, afinidade) {
  if (!id || !afinidade) return false;
  const nota = Math.round(Number(afinidade.nota));
  if (!Number.isFinite(nota)) return false;
  return db.atualizarNaLista(
    CHAVE_DB,
    (r) => r.id === id,
    (r) => ({
      ...r,
      afinidade: {
        closerId: String(afinidade.closerId || '').slice(0, 40),
        closerNome: String(afinidade.closerNome || '').slice(0, 80),
        nota: Math.max(0, Math.min(10, nota)),
        // Quem decide, o momento do lead e se os decisores vão à call: com o resultado da reunião
        // marcado, este report vira mais um caso do closer (src/casos.js).
        composicao: String(afinidade.composicao || '').slice(0, 60),
        momento: String(afinidade.momento || '').slice(0, 20),
        decisoresNaCall: afinidade.decisoresNaCall === true ? true : afinidade.decisoresNaCall === false ? false : null,
        em: new Date().toISOString(),
      },
    })
  );
}

/** Consumo de IA que não é report (resumo rápido do cartão): entra no gasto, não na lista de reports. */
async function registrarResumoRapido({ usuarioNome, uso }) {
  const quando = new Date().toISOString();
  const u = uso || {};
  await db.push(
    CHAVE_CONSUMO,
    {
      id: 'rr_' + crypto.randomBytes(5).toString('hex'),
      tipo: 'resumo',
      quando,
      dia: emDiaLocal(quando),
      usuarioNome: usuarioNome || '',
      origem: 'resumo-rapido',
      modelo: u.modelo || '',
      custo: custoUSD({ modelo: u.modelo, entrada: u.entrada, saida: u.saida, cacheLeitura: u.cacheLeitura, cacheEscrita: u.cacheEscrita, quando }),
    },
    LIMITE_CONSUMO
  );
}

/** Batida que mantém o cache do prompt vivo: entra no gasto, não na lista de reports. */
async function registrarAquecimento({ usuarioNome, uso }) {
  const quando = new Date().toISOString();
  const u = uso || {};
  await db.push(
    CHAVE_CONSUMO,
    {
      id: 'aq_' + crypto.randomBytes(5).toString('hex'),
      tipo: 'aquecimento',
      quando,
      dia: emDiaLocal(quando),
      usuarioNome: usuarioNome || '',
      origem: 'aquecimento-cache',
      modelo: u.modelo || '',
      custo: custoUSD({ modelo: u.modelo, entrada: u.entrada, saida: u.saida, cacheLeitura: u.cacheLeitura, cacheEscrita: u.cacheEscrita, quando }),
    },
    LIMITE_CONSUMO
  );
}

module.exports = {
  registrarAquecimento,
  registrar, importar, resumo, listar, remover, buscarPorChave, buscarPorId, atualizarResultado, anotarAfinidade, hojeStr, registrarResumoRapido,
  RESULTADOS_VALIDOS, PRODUTOS_VALIDOS, valorEmReais, ehVenda, emDiaLocal, vinculoLimpo,
};
