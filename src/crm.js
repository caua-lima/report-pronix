'use strict';

// Ficha do lead no RD Station CRM (API v1): ao abrir uma conversa no WhatsApp Web, a extensão
// pergunta ao servidor "quem é este telefone?" e mostra um cartão com a negociação do lead
// (etapa, funil, responsável) e as respostas do formulário que aparecem nas anotações.
//
// O token do CRM (RDSTATION_CRM_TOKEN) fica SÓ aqui no servidor: nunca vai para a extensão,
// para o navegador nem para log. Documentação: https://developers.rdstation.com/reference/crm-v1-contacts

const db = require('./db');

// Dois CRMs com a mesma API: o RD Station e o PronixCRM (crm.pronixhub.com.br), que copia a API v1 do RD.
// O token decide qual: "pcrm_…" é do PronixCRM. CRM_API_URL força a base; CRM_API_TOKEN tem prioridade
// sobre RDSTATION_CRM_TOKEN. Diferenças do PronixCRM tratadas aqui: o token vai no cabeçalho (Bearer), toda
// escrita leva a "versao" lida, mudar de etapa é POST /deals/:id/stage, perder é POST /deals/:id/lost, a lista
// de contatos não traz as negociações (vêm de /deals?contact_id=) e o detalhe do contato vem em { contact }.
const BASE_RD = 'https://crm.rdstation.com/api/v1';
const BASE_PRONIX = 'https://crm.pronixhub.com.br/api/v1';
const CHAVE_CARDS = 'crm_cards'; // { chave do lead: id do card que o SDR escolheu }
const TZ = process.env.TZ_RELATORIO || 'America/Sao_Paulo';

const token = () => String(process.env.CRM_API_TOKEN || process.env.RDSTATION_CRM_TOKEN || '').trim();
const configurado = () => Boolean(token());
const base = () => String(process.env.CRM_API_URL || (token().startsWith('pcrm_') ? BASE_PRONIX : BASE_RD)).trim().replace(/\/+$/, '');
/** O servidor está falando com o PronixCRM (e não com o RD Station)? */
const ehPronix = () => !/crm\.rdstation\.com/i.test(base());
/** Endereço da negociação na tela do CRM, para abrir direto. */
function linkDoCard(id) {
  const s = /^[A-Za-z0-9_-]{1,40}$/.test(String(id || '')) ? String(id) : '';
  if (!s) return '';
  return ehPronix() ? `${base().replace(/\/api\/v\d+$/, '')}/#/deals/${s}` : `https://crm.rdstation.com/app/deals/${s}`;
}

/** Cache das fichas (padrão 5 min): trocar de conversa e voltar não consulta o RD de novo. */
function ttlFicha() {
  const v = process.env.CRM_CACHE_TTL_SEG;
  if (v === undefined || v === '') return 300;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Chamada à API do RD. Erro nunca carrega a URL (que tem o token).
 * Sem `corpo` é leitura (GET); com `corpo` é escrita num card: mudar de etapa (automação do cartão) ou,
 * na limpeza do funil pedida pelo master, desqualificar com perda (src/limpezaRd.js).
 */
async function rd(caminho, params = {}, { metodo = 'GET', corpo } = {}) {
  const pronix = ehPronix();
  const q = new URLSearchParams(pronix ? {} : { token: token() });
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  const escrita = metodo !== 'GET';
  let r;
  try {
    const cab = { Accept: 'application/json', ...(escrita ? { 'Content-Type': 'application/json' } : {}), ...(pronix ? { Authorization: `Bearer ${token()}` } : {}) };
    const qs = q.toString();
    r = await fetch(`${base()}${caminho}${qs ? '?' + qs : ''}`, {
      method: metodo,
      headers: cab,
      ...(escrita ? { body: JSON.stringify(corpo || {}) } : {}),
      signal: AbortSignal.timeout(Number(process.env.CRM_TIMEOUT_MS) || 8000),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('O RD Station CRM demorou para responder. Tente de novo.');
    }
    throw new Error('Não consegui falar com o RD Station CRM.');
  }
  if (pronix && !r.ok && r.status !== 404) {
    // O PronixCRM diz o motivo: { codigo, mensagem }. A mensagem é para gente; vai como está.
    const e = await r.json().catch(() => null);
    const msg = (e && e.mensagem) || `o CRM respondeu ${r.status}`;
    if (r.status === 401) throw new Error('O CRM recusou o token (confira CRM_API_TOKEN / RDSTATION_CRM_TOKEN na Vercel).');
    if (r.status === 429) throw new Error('O CRM limitou as consultas. Tente de novo em 1 minuto.');
    throw new Error(`O CRM não aceitou: ${msg}`);
  }
  if (r.status === 401 || r.status === 403) {
    // Na escrita o RD só aceita quem é responsável pelo card (ou do mesmo time do dono do token).
    if (escrita) throw new Error('O RD Station não deixou alterar este card: o token precisa ser de quem é responsável por ele (ou do mesmo time).');
    throw new Error('O RD Station CRM recusou o token (confira RDSTATION_CRM_TOKEN na Vercel).');
  }
  if (r.status === 429) throw new Error('O RD Station CRM limitou as consultas. Tente de novo em 1 minuto.');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(escrita ? `O RD Station recusou a mudança de etapa (${r.status}).` : `O RD Station CRM respondeu ${r.status}.`);
  return r.json().catch(() => null);
}

// ---------------------------------------------------------------- telefone

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const final8 = (s) => soDigitos(s).slice(-8);

/**
 * Formas de escrever o mesmo telefone brasileiro, na ordem de busca. O WhatsApp entrega
 * "5571999998888" (às vezes sem o 9 do celular); no RD o número pode estar sem o 55, com o 9,
 * sem o 9 ou formatado. A busca para no primeiro que achar.
 */
function variantesTelefone(entrada) {
  const d = soDigitos(entrada);
  if (d.length < 8) return [];
  const v = [];
  const add = (x) => {
    if (x && !v.includes(x)) v.push(x);
  };
  const brasil = d.startsWith('55') && (d.length === 12 || d.length === 13);
  const nacional = brasil ? d.slice(2) : d;
  // O número como veio e, no Brasil, a mesma linha com/sem o 9 do celular.
  const formas = [nacional];
  if (nacional.length === 11 && nacional[2] === '9') formas.push(nacional.slice(0, 2) + nacional.slice(3));
  else if (nacional.length === 10) formas.push(nacional.slice(0, 2) + '9' + nacional.slice(2));
  const ehBr = brasil || nacional.length === 10 || nacional.length === 11;
  for (const n of formas) {
    // O card do RD mostra "(11) 96763-6300": esse formato vai primeiro; depois só dígitos, com e sem 55.
    if (ehBr && n.length === 11) add(`(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`);
    if (ehBr && n.length === 10) add(`(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`);
    add(n);
    if (ehBr) add('55' + n);
  }
  return v;
}

/** O contato tem mesmo este telefone? Compara os 8 últimos dígitos (independe de 55, DDD e do 9). */
function contatoTemTelefone(contato, telefone) {
  const alvo = final8(telefone);
  if (alvo.length < 8) return false;
  return (contato.phones || []).some(
    (p) => final8(p.phone) === alvo || final8(p.whatsapp_full_internacional) === alvo
  );
}

// ---------------------------------------------------------------- texto das anotações

// Texto que alguma integração gravou no RD com a codificação errada chega como "EmpresÃ¡rio",
// "SÃ£o Paulo". Cada par/trio desses é o UTF-8 de UMA letra lido como Latin-1/Windows-1252:
// dá para desfazer sem adivinhar. Texto normal ("SÃO PAULO", "ÂNGELA") não é tocado.
const CP1252 = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const CONT = '[\\u0080-\\u00BF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]';
const QUEBRADO = new RegExp(`[ÂÃ]${CONT}|â${CONT}${CONT}`, 'g');
const byteDe = (c) => (c.charCodeAt(0) <= 0xff ? c.charCodeAt(0) : CP1252[c]);
function consertarAcentos(s) {
  return String(s == null ? '' : s).replace(QUEBRADO, (m) => {
    const bytes = [...m].map(byteDe);
    if (bytes.some((b) => b === undefined)) return m;
    const letra = Buffer.from(bytes).toString('utf8');
    return letra.length === 1 && letra !== '\uFFFD' ? letra : m;
  });
}

/** Anotação do RD pode vir em HTML (<p>, <br>): vira texto puro, uma linha por parágrafo. */
function limparTexto(html) {
  return consertarAcentos(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** "Profissão: Lojista/Comerciante" -> { rotulo: 'Profissão', valor: 'Lojista/Comerciante' } (uma por linha). */
function extrairCampos(texto) {
  const campos = [];
  for (const linha of String(texto || '').split('\n')) {
    const m = /^([^:]{2,40}):\s*(.+)$/.exec(linha.trim());
    // "http://..." não é campo: rótulo não pode terminar em http/https
    // Valor que ficou como modelo não preenchido ("{{data.Qual modalidade…}}", de uma integração) não é resposta.
    if (m && !/https?$/i.test(m[1].trim()) && !/\{\{.*\}\}/.test(m[2])) campos.push({ rotulo: m[1].trim(), valor: m[2].trim().slice(0, 300) });
  }
  return campos;
}

const quandoBR = (iso) => {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
};

// ---------------------------------------------------------------- listas auxiliares (cache 1h)

async function listaEmCache(chave, buscar) {
  const guardado = await db.cacheGet(chave);
  if (guardado) {
    try {
      return JSON.parse(guardado);
    } catch (_) {
      /* refaz */
    }
  }
  const lista = await buscar().catch(() => null);
  if (lista) await db.cacheSet(chave, JSON.stringify(lista), 3600);
  return lista || [];
}

const usuarios = () =>
  listaEmCache('crm:usuarios', async () => {
    const r = await rd('/users');
    return ((r && r.users) || []).map((u) => ({ id: u.id || u._id, nome: u.name }));
  });

const camposDoContato = () =>
  listaEmCache('crm:campos-contato', async () => {
    const r = await rd('/custom_fields', { for: 'contact' });
    const lista = Array.isArray(r) ? r : (r && r.custom_fields) || [];
    return lista.map((c) => ({ id: c.id || c._id, rotulo: c.label }));
  });

// ---------------------------------------------------------------- a ficha

const valorTexto = (v) => consertarAcentos(Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v == null ? '' : v)).trim().slice(0, 300);

/** Negociação que importa para a prospecção: a em aberto mais recente; senão, a última. */
function escolherNegociacao(deals) {
  const lista = Array.isArray(deals) ? deals : [];
  if (!lista.length) return null;
  const abertas = lista.filter((d) => !d.closed_at && d.win !== true && d.win !== false);
  return (abertas.length ? abertas : lista)[(abertas.length ? abertas : lista).length - 1];
}

const idDe = (d) => String((d && (d.id || d._id)) || '');
const estaAberta = (d) => !d.closed_at && d.win !== true && d.win !== false;
const instante = (d) => Date.parse((d && (d.updated_at || d.created_at)) || '') || 0;

/**
 * Qual card abrir quando o lead tem vários (contato duplicado, inscrito de novo): o que o SDR já
 * escolheu para este lead; senão, o em aberto com atividade mais recente; senão, o mais recente.
 * @param {object[]} detalhes negociações com os detalhes do RD (updated_at, closed_at, win...)
 */
function escolherCard(detalhes, preferido) {
  const lista = (detalhes || []).filter(Boolean);
  if (!lista.length) return null;
  if (preferido) {
    const p = lista.find((d) => idDe(d) === String(preferido));
    if (p) return p;
  }
  const abertas = lista.filter(estaAberta);
  const base = abertas.length ? abertas : lista;
  // Empate no horário: o que aparece depois na lista do RD (o mais novo).
  return base.reduce((melhor, d) => (instante(d) >= instante(melhor) ? d : melhor), base[0]);
}

const MAX_CARDS = 8; // quantas negociações do lead olhar (cada uma é uma chamada ao RD)

/**
 * PronixCRM: a lista de contatos não traz as negociações de cada um (o RD traz) nem os campos personalizados
 * do contato. Busca as duas coisas, para a ficha sair igual à do RD. As negociações vêm da mais nova para a
 * mais antiga; aqui ficam da mais antiga para a mais nova, como no RD (a ficha olha as do fim).
 */
/**
 * PronixCRM: a busca em /contacts acha pelo telefone ou e-mail, mas a lista volta com phones e emails vazios.
 * Lê o detalhe de cada contato achado (uma vez por consulta) para a conferência do telefone e do e-mail valer.
 * No RD a lista já vem completa: devolve como está.
 */
async function comDetalhe(contatos, detalhados) {
  if (!ehPronix()) return contatos;
  return Promise.all(contatos.slice(0, 10).map(async (c) => {
    const id = idDe(c);
    if (!id) return c;
    if (!detalhados.has(id)) {
      // O detalhe e as negociações do contato vão juntos (uma ida ao CRM a menos na fila da ficha).
      detalhados.set(id, Promise.all([
        rd(`/contacts/${encodeURIComponent(id)}`).then((r) => (r && (r.contact || r)) || null).catch(() => null),
        rd('/deals', { contact_id: id, limit: 50 }).then((r) => (r && r.deals) || null).catch(() => null),
      ]));
    }
    const [d, deals] = await detalhados.get(id);
    const base = deals ? { ...c, deals: deals.slice().reverse() } : c; // do mais antigo para o mais novo, como no RD
    return d ? { ...base, phones: d.phones || c.phones || [], emails: d.emails || c.emails || [], contact_custom_fields: d.contact_custom_fields || c.contact_custom_fields, _detalhado: true } : base;
  }));
}

async function completarContatos(contatos) {
  await Promise.all(contatos.map(async (c) => {
    if (!Array.isArray(c.deals)) {
      const r = await rd('/deals', { contact_id: idDe(c), limit: 50 }).catch(() => null);
      c.deals = ((r && r.deals) || []).slice().reverse();
    }
  }));
  // O contato principal precisa dos e-mails (a reunião no Google Agenda é achada por eles), dos telefones e
  // dos campos: achado por nome ou por id, ele chega sem nada disso.
  const principal = contatos[0];
  const semDados = (c) => !Array.isArray(c.contact_custom_fields) || !(c.emails || []).length || !(c.phones || []).length;
  if (principal && semDados(principal) && !principal._detalhado) {
    const r = await rd(`/contacts/${encodeURIComponent(idDe(principal))}`).catch(() => null);
    const d = r && (r.contact || r);
    if (d) {
      if (Array.isArray(d.contact_custom_fields)) principal.contact_custom_fields = d.contact_custom_fields;
      if ((d.emails || []).length) principal.emails = d.emails;
      if ((d.phones || []).length) principal.phones = d.phones;
      principal._detalhado = true;
    }
  }
}

async function montarFicha(contato, extras = [], preferido = '') {
  const todosContatos = [contato].concat(extras);
  if (ehPronix()) await completarContatos(todosContatos);
  // Negociações de todos os contatos duplicados, sem repetir.
  const vistos = new Set();
  const dealsBrutos = [];
  todosContatos.forEach((c) => (c.deals || []).forEach((d) => {
    const id = idDe(d);
    if (id && !vistos.has(id)) {
      vistos.add(id);
      dealsBrutos.push(d);
    }
  }));
  const candidatos = dealsBrutos.slice(-MAX_CARDS);
  // PronixCRM: a lista já diz qual card é o provável (aberto, mexido por último): as anotações dele, os usuários e
  // os campos começam a vir JUNTO com o detalhe das negociações, em vez de esperar por ele.
  const provavel = ehPronix() ? escolherCard(candidatos, preferido) : null;
  const idProvavel = provavel ? idDe(provavel) : null;
  const atividadesProvavel = idProvavel ? atividadesDoCard(idProvavel).catch(() => null) : null;
  const usuariosJa = usuarios();
  const camposJa = camposDoContato();
  // os funis (cache de 1h): é por eles que cada card diz desde quando está na tentativa de contato atual
  const funisJa = funis().catch(() => []);
  usuariosJa.catch(() => {});
  camposJa.catch(() => {});
  const detalhes = (await Promise.all(candidatos.map((d) => rd(`/deals/${encodeURIComponent(idDe(d))}`).catch(() => null)))).map(
    (det, i) => (det ? { ...candidatos[i], ...det } : candidatos[i])
  );
  const escolhido = escolherCard(detalhes, preferido);
  const idNeg = escolhido ? idDe(escolhido) : null;
  const deal = escolhido || null;
  const [atividades, users, rotulosContato, listaFunis] = await Promise.all([
    idNeg ? (idNeg === idProvavel ? atividadesProvavel : atividadesDoCard(idNeg)) : null,
    usuariosJa,
    camposJa,
    funisJa,
  ]);
  const nomeDe = new Map();
  const cards = detalhes.map((d) => ({
    id: idDe(d),
    nome: consertarAcentos(d.name || ''),
    etapa: (d.deal_stage && d.deal_stage.name) || '',
    funil: (d.deal_pipeline && d.deal_pipeline.name) || '',
    responsavel: (d.user && d.user.name) || '',
    criadaEm: quandoBR(d.created_at),
    // Desde quando está na tentativa de contato atual: só resposta do lead depois disso move para "Respondeu".
    contatoDesde: inicioDaTentativa(d, acharEtapa(listaFunis || [], { etapaId: idDe(d.deal_stage), etapaNome: (d.deal_stage && d.deal_stage.name) || '', funilNome: (d.deal_pipeline && d.deal_pipeline.name) || '' })),
    aberta: estaAberta(d),
    ganha: d.win === true, // o closer marcou a venda no RD
    perdida: d.win === false, // marcou como perdida
    valor: Number(d.amount_total) || 0, // valor da negociação no RD
    motivoPerda: consertarAcentos((d.deal_lost_reason && d.deal_lost_reason.name) || ''),
    notaPerda: consertarAcentos(d.deal_lost_note || '').slice(0, 300),
    // Produtos que o closer colocou no card (é de onde sai o produto da venda).
    produtos: (Array.isArray(d.deal_products) ? d.deal_products : []).map((p) => consertarAcentos(String((p && (p.name || (p.product && p.product.name))) || '')).trim().slice(0, 80)).filter(Boolean).slice(0, 5),
    fechadaEm: d.closed_at || '',
    atualizadaEm: d.updated_at || '',
    escolhida: idDe(d) === idNeg,
    url: linkDoCard(idDe(d)), // o painel lateral abre cada negociação direto no CRM
  })).reverse(); // o mais novo primeiro
  void nomeDe;
  const nomeUsuario = new Map(users.map((u) => [u.id, u.nome]));

  // Anotações, da mais nova para a mais antiga. A que tem "Campo: valor" em 2+ linhas é o formulário.
  const notas = ((atividades && atividades.activities) || [])
    .map((a) => ({ texto: limparTexto(a.text), data: a.date || a.created_at || '', autor: nomeUsuario.get(a.user_id) || '' }))
    .filter((a) => a.texto)
    .sort((a, b) => String(b.data).localeCompare(String(a.data)));
  const idxForm = notas.findIndex((n) => extrairCampos(n.texto).length >= 2);
  const formulario =
    idxForm === -1
      ? null
      : { campos: extrairCampos(notas[idxForm].texto), autor: notas[idxForm].autor, quando: quandoBR(notas[idxForm].data) };
  const anotacoes = notas
    .filter((_, i) => i !== idxForm)
    .slice(0, 3)
    .map((n) => ({ autor: n.autor, quando: quandoBR(n.data), texto: n.texto.slice(0, 500) }));

  // Campos personalizados da negociação e do contato, sem repetir o que o formulário já mostra
  // ("Vende online?" e "Vende online" são o mesmo campo). Os de anúncio/origem ([AD]..., LP, UTM...)
  // ficam de fora: não ajudam a prospectar.
  const chaveRotulo = (r) => normalizarNome(r);
  const jaTem = new Set(((formulario && formulario.campos) || []).map((c) => chaveRotulo(c.rotulo)));
  const campos = [];
  const addCampo = (rotulo, valor) => {
    const r = consertarAcentos(String(rotulo || '')).trim();
    const v = valorTexto(valor);
    if (!r || !v || jaTem.has(chaveRotulo(r))) return;
    jaTem.add(chaveRotulo(r));
    if (!ehCampoDeCampanha(r)) campos.push({ rotulo: r, valor: v }); // anúncio/origem: fora da ficha
  };
  ((deal && deal.deal_custom_fields) || []).forEach((c) => addCampo(c.custom_field && c.custom_field.label, c.value));
  const rotulo = new Map(rotulosContato.map((c) => [c.id, c.rotulo]));
  (contato.contact_custom_fields || []).forEach((c) => addCampo(rotulo.get(c.custom_field_id), c.value));

  const id = deal && (deal.id || deal._id);
  return {
    contatoId: idDe(contato),
    crmNome: ehPronix() ? 'Pronix CRM' : 'RD Station', // o cartão diz de qual CRM veio
    nome: consertarAcentos(contato.name || ''),
    telefones: (contato.phones || []).map((p) => p.phone).filter(Boolean).slice(0, 3),
    emails: (contato.emails || []).map((e) => e.email).filter(Boolean).slice(0, 2),
    negociacao: deal
      ? {
          nome: deal.name || '',
          etapa: (deal.deal_stage && deal.deal_stage.name) || '',
          funil: (deal.deal_pipeline && deal.deal_pipeline.name) || '',
          responsavel: (deal.user && deal.user.name) || '',
          fonte: (deal.deal_source && deal.deal_source.name) || '',
          campanha: (deal.campaign && deal.campaign.name) || '',
          criadaEm: quandoBR(deal.created_at),
          url: linkDoCard(id),
        }
      : null,
    totalNegociacoes: dealsBrutos.length,
    negociacoes: cards,
    contatosComEsteTelefone: todosContatos.length,
    formulario,
    campos,
    anotacoes,
  };
}

// ---------------------------------------------------------------- busca

/** Sem acento, minúsculo, só letras/números: para comparar nomes e rótulos. */
const normalizarNome = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const ehCampoDeCampanha = (rotulo) =>
  /^\[ad\]|^utm|^lp$|varia[cç][aã]o lp|^(ad|an[uú]ncio)\b|criativo|conjunto|campanha|pixel|gclid|fbclid/i.test(String(rotulo || '').trim());

// Palavras que o time põe no nome salvo do WhatsApp e que não fazem parte do nome da pessoa
// ("Armando PRONIX Moretti", "Lead Ana Souza"). Dá para acrescentar outras em CRM_PALAVRAS_IGNORADAS.
const IGNORADAS_PADRAO = ['pronix', 'prxc', 'lead', 'leads', 'cliente', 'sdr', 'closer'];
function palavrasIgnoradas() {
  const extras = String(process.env.CRM_PALAVRAS_IGNORADAS || '')
    .split(',')
    .map((p) => normalizarNome(p))
    .filter(Boolean);
  return new Set(IGNORADAS_PADRAO.concat(extras));
}

/**
 * Palavras do nome salvo que identificam a pessoa (sem as etiquetas do time, números e emojis),
 * como estão escritas (com acento, para a busca do RD) e normalizadas (para comparar).
 */
function palavrasComOriginal(nome) {
  const ignoradas = palavrasIgnoradas();
  return String(nome || '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[\s|/\\_.,;:–—-]+/)
    .map((p) => ({ original: p.replace(/[^\p{L}\p{N}'’]/gu, ''), norm: normalizarNome(p) }))
    .filter((p) => p.original && p.norm.length >= 2 && !/^\d+$/.test(p.norm) && !p.norm.includes(' ') && !ignoradas.has(p.norm));
}
const palavrasDoNome = (nome) => palavrasComOriginal(nome).map((p) => p.norm);

/**
 * Buscas pelo nome, da mais específica para a mais ampla: o nome como está salvo, o nome limpo
 * (sem "PRONIX" e afins), nome + sobrenome e, por último, só o primeiro nome.
 */
function consultasPorNome(nome) {
  const partes = palavrasComOriginal(nome);
  const orig = partes.map((p) => p.original);
  const q = [];
  const add = (x) => {
    const t = String(x || '').trim();
    if (t && !q.some((y) => normalizarNome(y) === normalizarNome(t))) q.push(t);
  };
  add(String(nome || '').trim());
  if (orig.length) add(orig.join(' '));
  if (orig.length > 2) add(`${orig[0]} ${orig[orig.length - 1]}`);
  if (orig.length > 1) add(orig[0]);
  return { consultas: q, palavras: partes.map((p) => p.norm) };
}

/** O nome do RD tem todas as palavras do nome salvo? ("armando moretti" cabe em "Armando Moretti Filho") */
const temTodasAsPalavras = (contato, palavras) => {
  const doRd = new Set(normalizarNome(contato.name).split(' '));
  return palavras.length > 0 && palavras.every((p) => doRd.has(p));
};

const pareceTelefone = (s) => soDigitos(s).length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(String(s || ''));
const candidato = (c) => ({ id: c.id || c._id, nome: c.name || '', telefone: ((c.phones || [])[0] || {}).phone || '' });

/** Identifica o lead da busca (já com telefone só em dígitos e nome limpo): é a chave do cache e do card lembrado. */
const chaveDaBusca = ({ telefone, nome, contatoId, email }) =>
  contatoId ? `id:${contatoId}` : telefone.length >= 8 ? `tel:${final8(telefone)}` : email ? `email:${email}` : nome ? `nome:${nome.toLowerCase()}` : '';

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const emailsDoContato = (c) => ((c && c.emails) || []).map((e) => String((e && (e.email || e)) || '').trim().toLowerCase()).filter(Boolean);

/**
 * Vários contatos com o mesmo nome são a MESMA pessoa quando se ligam por telefone (8 últimos dígitos)
 * ou e-mail em comum — é o lead que se inscreveu mais de uma vez. Contato sem telefone nem e-mail não prova nada.
 */
function saoAMesmaPessoa(contatos) {
  const lista = (contatos || []).filter(Boolean);
  if (lista.length < 2) return lista.length === 1;
  const chaves = lista.map((c) => new Set(
    ((c.phones || []).map((p) => soDigitos(p && p.phone)).filter((d) => d.length >= 8).map((d) => 't' + final8(d))).concat(emailsDoContato(c).map((e) => 'e' + e))
  ));
  if (chaves.some((k) => !k.size)) return false;
  const ligados = new Set([0]);
  let cresceu = true;
  while (cresceu) {
    cresceu = false;
    lista.forEach((_, i) => {
      if (ligados.has(i)) return;
      if ([...ligados].some((j) => [...chaves[i]].some((k) => chaves[j].has(k)))) { ligados.add(i); cresceu = true; }
    });
  }
  return ligados.size === lista.length;
}

/**
 * @param {{telefone?: string, nome?: string, contatoId?: string, email?: string}} busca
 * @param {{diagnostico?: boolean, semCache?: boolean}} opcoes
 * @returns {Promise<{configurado: boolean, encontrado?: boolean, ficha?: object, candidatos?: object[], buscaPor?: string, diagnostico?: object}>}
 */
async function consultarLead(busca = {}, opcoes = {}) {
  if (!configurado()) return { configurado: false };
  const telefone = soDigitos(busca.telefone);
  const nome = String(busca.nome || '').trim().slice(0, 80);
  const contatoId = /^[A-Za-z0-9_-]{1,40}$/.test(String(busca.contatoId || '')) ? String(busca.contatoId) : '';
  const dealPedido = /^[A-Za-z0-9_-]{1,40}$/.test(String(busca.dealId || '')) ? String(busca.dealId) : '';
  const email = EMAIL_OK.test(String(busca.email || '').trim()) ? String(busca.email).trim().toLowerCase().slice(0, 120) : '';
  const diag = { tentativas: [] };
  const detalhados = new Map(); // PronixCRM: detalhe de cada contato achado, lido uma vez nesta consulta

  const chaveBase = chaveDaBusca({ telefone, nome, contatoId, email });
  if (!chaveBase) return { configurado: true, encontrado: false };
  const chave = 'crm:' + chaveBase;
  // O card que o SDR escolheu para este lead fica lembrado (vale para todos): da próxima vez abre o certo.
  const lembrados = (await db.getJson(CHAVE_CARDS, {}).catch(() => ({}))) || {};
  if (dealPedido && busca.lembrar) {
    lembrados[chaveBase] = dealPedido;
    await db.setJson(CHAVE_CARDS, lembrados).catch(() => {});
  }
  const preferido = dealPedido || lembrados[chaveBase] || '';
  const ttl = ttlFicha();
  if (ttl && !opcoes.semCache && !dealPedido) {
    const guardado = await db.cacheGet(chave);
    if (guardado) {
      try {
        return { ...JSON.parse(guardado), cache: true };
      } catch (_) {
        /* refaz */
      }
    }
  }

  let resultado = { configurado: true, encontrado: false };
  if (contatoId) {
    const r = await rd(`/contacts/${encodeURIComponent(contatoId)}`);
    const contato = r && (r.contact || r);
    if (contato && contato.name !== undefined) resultado = { configurado: true, encontrado: true, buscaPor: 'id', ficha: await montarFicha(contato, [], preferido) };
  } else {
    let contato = null;
    if (telefone.length >= 8) {
      // Lead que se inscreveu mais de uma vez costuma ter mais de um contato com o mesmo telefone
      // (às vezes escrito de outro jeito): junta todos, para as negociações de todos entrarem na escolha.
      const iguais = [];
      // O PronixCRM já acha o telefone com ou sem o 55 e com ou sem o nono dígito: uma consulta basta.
      for (const variante of (ehPronix() ? variantesTelefone(telefone).slice(0, 1) : variantesTelefone(telefone))) {
        const r = await rd('/contacts', { phone: variante, limit: 10 });
        const achados = await comDetalhe((r && r.contacts) || [], detalhados);
        const certos = achados.filter((c) => contatoTemTelefone(c, telefone));
        diag.tentativas.push({ variante, resultados: achados.length, bateu: certos.length > 0 });
        certos.forEach((c) => {
          if (!iguais.some((x) => idDe(x) === idDe(c))) iguais.push(c);
        });
        if (certos.length && !diag.encontradaCom) diag.encontradaCom = variante;
      }
      if (iguais.length) {
        contato = iguais[0];
        resultado = { configurado: true, encontrado: true, buscaPor: 'telefone', ficha: await montarFicha(iguais[0], iguais.slice(1), preferido) };
      }
    }
    // Pelo e-mail do lead (o que o report guardou do card): só vale contato que tem mesmo esse e-mail.
    if (!contato && email) {
      for (const params of [{ email, limit: 10 }, { q: email, limit: 10 }]) {
        const r = await rd('/contacts', params);
        const achados = await comDetalhe((r && r.contacts) || [], detalhados);
        const certos = achados.filter((c) => emailsDoContato(c).includes(email));
        diag.tentativas.push({ email: params.email ? 'filtro' : 'busca', resultados: achados.length, bateu: certos.length > 0 });
        if (!certos.length) continue;
        contato = certos[0];
        resultado = { configurado: true, encontrado: true, buscaPor: 'email', ficha: await montarFicha(certos[0], certos.slice(1), preferido) };
        break;
      }
    }
    // Sem telefone (contato salvo com nome) ou telefone não achado: tenta pelo nome.
    if (!contato && nome && !pareceTelefone(nome)) {
      const { consultas, palavras } = consultasPorNome(nome);
      let candidatos = null;
      let repetidos = [];
      for (const q of consultas) {
        const r = await rd('/contacts', { q, limit: 20 });
        const achados = (r && r.contacts) || [];
        diag.tentativas.push({ nome: q, resultados: achados.length });
        if (!achados.length) continue;
        // Escolhe sozinho só quando não há dúvida: um único contato com TODAS as palavras do nome
        // salvo; ou um único resultado para a busca do nome inteiro/limpo (não a do primeiro nome).
        const comTodas = achados.filter((c) => temTodasAsPalavras(c, palavras));
        const soPrimeiroNome = palavras.length > 1 && normalizarNome(q) === palavras[0];
        if (comTodas.length === 1) {
          contato = comTodas[0];
        } else if (comTodas.length > 1 && saoAMesmaPessoa(comTodas)) {
          // O mesmo lead cadastrado mais de uma vez: as negociações de todos os cadastros entram.
          contato = comTodas[0];
          repetidos = comTodas.slice(1);
        } else if (achados.length === 1 && !soPrimeiroNome) {
          contato = achados[0];
        } else if (!candidatos) {
          candidatos = (comTodas.length > 1 ? comTodas : achados).slice(0, 5).map(candidato);
        }
        if (contato) {
          diag.encontradaCom = q;
          break;
        }
      }
      if (contato) {
        resultado = { configurado: true, encontrado: true, buscaPor: 'nome', ficha: await montarFicha(contato, repetidos, preferido) };
      } else if (candidatos) {
        resultado = { configurado: true, encontrado: false, buscaPor: 'nome', candidatos };
      }
    }
  }

  // Não achou também fica em cache (menos tempo): trocar de conversa e voltar não repete a busca toda.
  if (ttl) await db.cacheSet(chave, JSON.stringify(resultado), resultado.encontrado ? ttl : Math.min(ttl, 120));
  return opcoes.diagnostico ? { ...resultado, diagnostico: diag } : resultado;
}

/** Nomes dos produtos de um card (rota própria do RD): usado quando a ficha do card vendido veio sem eles. */
async function produtosDoCard(dealId) {
  if (!configurado() || !/^[A-Za-z0-9_-]{1,40}$/.test(String(dealId || ''))) return [];
  try {
    const r = await rd(`/deals/${encodeURIComponent(dealId)}/${ehPronix() ? 'products' : 'deal_products'}`);
    const lista = Array.isArray(r) ? r : (r && (r.deal_products || r.products)) || [];
    return lista.map((p) => consertarAcentos(String((p && (p.name || (p.product && p.product.name))) || '')).trim()).filter(Boolean).slice(0, 5);
  } catch (_) {
    return []; // sem produto não se inventa: o campo fica para quem preenche
  }
}

// ---------------------------------------------------------------- etapas do funil (mover para "Respondeu")
//
// A escrita automática no RD: quando o lead responde no WhatsApp, o card que ainda está ANTES de "Respondeu"
// (ex.: "Contato iniciado") avança para "Respondeu". Nunca volta um card, nunca mexe em card fechado e
// nunca troca de funil. CRM_MOVER_ETAPA=0 desliga; CRM_ETAPA_RESPONDEU troca o nome da etapa de destino.

const moverLigado = () => !/^(0|false|nao|não|off)$/i.test(String(process.env.CRM_MOVER_ETAPA || '').trim());
const nomeRespondeu = () => String(process.env.CRM_ETAPA_RESPONDEU || 'Respondeu').trim();
const nomeQualificado = () => String(process.env.CRM_ETAPA_QUALIFICADO || 'Qualificado').trim();

/** O card está na etapa "Qualificado" do funil? (é uma das origens da etiqueta no cartão do WhatsApp) */
const ehEtapaQualificado = (etapa) => Boolean(etapa) && normalizarNome(etapa) === normalizarNome(nomeQualificado());

/** Funis com as etapas na ordem do funil: [{ id, nome, etapas: [{ id, nome, ordem, perdido, ganho, categoria, exigeCloser }] }]. Cache de 1h. */
async function funis() {
  const guardado = await db.cacheGet('crm:funis3');
  if (guardado) {
    try {
      return JSON.parse(guardado);
    } catch (_) {
      /* refaz */
    }
  }
  let r;
  try {
    r = await rd('/deal_pipelines', { limit: 200 });
  } catch (e) {
    // RD fora do ar ou plano sem acesso aos funis: não repete a consulta a cada conversa aberta.
    await db.cacheSet('crm:funis3', '[]', 120);
    throw e;
  }
  const lista = Array.isArray(r) ? r : (r && (r.deal_pipelines || r.pipelines)) || [];
  const saida = [];
  for (const p of lista) {
    let etapas = p.deal_stages;
    if (!Array.isArray(etapas)) {
      const det = await rd(`/deal_pipelines/${encodeURIComponent(idDe(p))}`).catch(() => null);
      etapas = (det && det.deal_stages) || [];
    }
    const ordenadas = etapas
      .map((e, i) => ({ id: idDe(e), nome: consertarAcentos(e.name || ''), o: Number.isFinite(Number(e.order)) ? Number(e.order) : i, i, perdido: e.eh_perdido === true, ganho: e.eh_ganho === true, categoria: e.categoria || null, exigeCloser: e.exige_closer === true }))
      .sort((a, b) => a.o - b.o || a.i - b.i)
      .map((e, ordem) => ({ id: e.id, nome: e.nome, ordem, perdido: e.perdido, ganho: e.ganho, categoria: e.categoria, exigeCloser: e.exigeCloser }));
    saida.push({ id: idDe(p), nome: consertarAcentos(p.name || ''), etapas: ordenadas });
  }
  // Lista vazia fica pouco tempo no cache: pode ter sido uma falha passageira do RD.
  await db.cacheSet('crm:funis3', JSON.stringify(saida), saida.some((f) => f.etapas.length) ? 3600 : 120);
  return saida;
}

const mesmoNome = (a, b) => normalizarNome(a) === normalizarNome(b);

/** Em que funil o card está: pelo id da etapa; sem id, pelo nome da etapa (e do funil, se houver mais de um). */
function acharEtapa(lista, { etapaId, etapaNome, funilNome }) {
  for (const f of lista) {
    const e = etapaId && f.etapas.find((x) => x.id === String(etapaId));
    if (e) return { funil: f, etapa: e };
  }
  if (!etapaNome) return null;
  const candidatos = lista.filter((f) => f.etapas.some((x) => mesmoNome(x.nome, etapaNome)));
  const f = candidatos.find((x) => funilNome && mesmoNome(x.nome, funilNome)) || (candidatos.length === 1 ? candidatos[0] : null);
  return f ? { funil: f, etapa: f.etapas.find((x) => mesmoNome(x.nome, etapaNome)) } : null;
}

const etapaRespondeu = (funil) => funil.etapas.find((x) => mesmoNome(x.nome, nomeRespondeu())) || null;

/**
 * Desde quando o card está na tentativa de contato ATUAL (ISO). Só uma mensagem do lead depois disso é resposta a
 * esta tentativa — numa recuperação, a conversa traz o histórico antigo (o lead respondeu meses atrás) e isso não
 * pode mover o card para "Respondeu".
 *  - pelo histórico de etapas do card: a entrada na sequência de etapas ANTES de "Respondeu" em que ele está agora,
 *    no funil atual (card antigo que voltou para o contato, ou foi para o funil de recuperação, recomeça ali);
 *  - nunca antes de o card ser criado; histórico que não bate com o funil: a última troca de etapa.
 * @returns {string} '' quando não dá para saber (aí nada se move)
 */
function inicioDaTentativa(deal, onde) {
  if (!deal) return '';
  const criado = Date.parse(deal.created_at || '') || 0;
  const hist = (Array.isArray(deal.deal_stage_histories) ? deal.deal_stage_histories : [])
    .filter((h) => h && h.deal_stage_id && Number.isFinite(Date.parse(h.start_date || '')))
    .sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));
  const alvo = onde && onde.funil ? etapaRespondeu(onde.funil) : null;
  let inicio = 0;
  if (alvo) {
    for (let i = hist.length - 1; i >= 0; i--) {
      const v = hist[i].deal_stage_id;
      const idEtapa = v && typeof v === 'object' ? idDe(v) : String(v);
      const e = onde.funil.etapas.find((x) => x.id === idEtapa);
      if (!e || e.ordem >= alvo.ordem) break;
      inicio = Date.parse(hist[i].start_date);
    }
  }
  if (!inicio && hist.length) inicio = Date.parse(hist[hist.length - 1].start_date);
  const t = Math.max(criado, inicio);
  return t ? new Date(t).toISOString() : '';
}

/** O card escolhido da ficha está em aberto e ANTES de "Respondeu"? É o que diz à extensão se vale tentar mover. */
async function antesDeRespondeu(ficha) {
  if (!moverLigado() || !ficha || !ficha.negociacao) return false;
  const card = (ficha.negociacoes || []).find((c) => c.escolhida);
  if (!card || !card.aberta) return false;
  const onde = acharEtapa(await funis(), { etapaNome: ficha.negociacao.etapa, funilNome: ficha.negociacao.funil });
  const alvo = onde && etapaRespondeu(onde.funil);
  return Boolean(alvo && onde.etapa.ordem < alvo.ordem);
}

/**
 * Move o card do lead para "Respondeu". Confere tudo de novo no RD na hora (a ficha pode estar em cache):
 * o card tem de ser deste lead, estar em aberto e numa etapa anterior a "Respondeu" do MESMO funil — e a resposta
 * do lead (respostaEm, a data/hora da mensagem dele no WhatsApp) tem de ser DEPOIS do início desta tentativa de
 * contato (inicioDaTentativa). Sem a data, ou com data de antes (o histórico antigo de uma recuperação), não move.
 * @param {{telefone?: string, nome?: string, contatoId?: string, dealId?: string, respostaEm?: string}} busca
 * @returns {Promise<{movido: boolean, de?: string, para?: string, motivo?: string}>}
 */
async function moverParaRespondeu(busca = {}, { usuarioNome = '' } = {}) {
  if (!configurado()) return { movido: false, motivo: 'sem-crm' };
  if (!moverLigado()) return { movido: false, motivo: 'desligado' };
  const idOk = (v) => (/^[A-Za-z0-9_-]{1,40}$/.test(String(v || '')) ? String(v) : '');
  const lead = await consultarLead({ telefone: busca.telefone, nome: busca.nome, contatoId: busca.contatoId });
  const cards = (lead.ficha && lead.ficha.negociacoes) || [];
  const pedido = idOk(busca.dealId);
  const card = pedido ? cards.find((c) => c.id === pedido) : cards.find((c) => c.escolhida);
  if (!card) return { movido: false, motivo: 'card-nao-e-do-lead' };

  const deal = await rd(`/deals/${encodeURIComponent(card.id)}`);
  if (!deal) return { movido: false, motivo: 'card-nao-encontrado' };
  if (!estaAberta(deal)) return { movido: false, motivo: 'card-fechado' };
  const atual = deal.deal_stage || {};
  const onde = acharEtapa(await funis(), {
    etapaId: idDe(atual), etapaNome: atual.name, funilNome: deal.deal_pipeline && deal.deal_pipeline.name,
  });
  if (!onde) return { movido: false, motivo: 'funil-desconhecido' };
  const alvo = etapaRespondeu(onde.funil);
  if (!alvo) return { movido: false, motivo: 'sem-etapa' };
  if (onde.etapa.ordem >= alvo.ordem) return { movido: false, motivo: 'ja-adiante', etapa: onde.etapa.nome };
  // A resposta é a esta tentativa? (extensão antiga não manda a data: não move — melhor esperar que mover errado)
  const resposta = Date.parse(String(busca.respostaEm || ''));
  if (!Number.isFinite(resposta)) return { movido: false, motivo: 'sem-data-da-resposta' };
  const desde = Date.parse(inicioDaTentativa(deal, onde));
  if (!Number.isFinite(desde)) return { movido: false, motivo: 'sem-inicio-da-tentativa' };
  // O WhatsApp mostra a hora sem os segundos: a resposta vale a partir do minuto em que a tentativa começou.
  if (resposta < Math.floor(desde / 60000) * 60000) return { movido: false, motivo: 'resposta-antes-da-tentativa' };
  if (resposta > Date.now() + 10 * 60000) return { movido: false, motivo: 'resposta-no-futuro' };

  const resp = await mudarEtapa(deal, alvo.id);
  if (!resp) throw new Error('O RD Station não achou o card para mudar de etapa.');
  const nova = idDe(resp.deal_stage);
  if (nova && nova !== alvo.id) throw new Error('O RD Station respondeu, mas o card não mudou de etapa.');

  // A ficha em cache ainda diz a etapa antiga: a próxima consulta busca de novo.
  await esquecerLead(busca);
  await db
    .push('crm_movimentos', { quando: new Date().toISOString(), card: card.id, de: onde.etapa.nome, para: alvo.nome, por: usuarioNome }, 500)
    .catch(() => {});
  return { movido: true, de: onde.etapa.nome, para: alvo.nome };
}

/**
 * Muda o card de etapa. PronixCRM: POST /deals/:id/stage com a versão lida (sem ela, 409); RD: PUT com a etapa.
 * @param {object} deal o card lido agora (precisa do id e, no PronixCRM, da versao)
 */
async function mudarEtapa(deal, etapaId) {
  const rd = module.exports.rd; // a exportada: é a que os testes simulam
  const id = encodeURIComponent(idDe(deal));
  if (ehPronix()) return rd(`/deals/${id}/stage`, {}, { metodo: 'POST', corpo: { deal_stage_id: etapaId, versao: deal.versao } });
  return rd(`/deals/${id}`, {}, { metodo: 'PUT', corpo: { deal_stage_id: etapaId } });
}

/**
 * Marca o card como perdido, com o motivo. PronixCRM: POST /deals/:id/lost — a etapa vai junto só se for uma
 * etapa de perda do funil (senão o CRM recusa); o SDR é coluna própria lá, e não se grava. RD: PUT com win false,
 * a etapa e os campos (com o SDR). Devolve o que o CRM respondeu; erro se ele recusou.
 */
async function perderCard(deal, { motivoId, etapaId, camposRd, nota } = {}) {
  const rd = module.exports.rd; // a exportada: é a que os testes simulam
  const id = encodeURIComponent(idDe(deal));
  if (ehPronix()) {
    const dePerda = etapaId ? (await funis()).some((f) => f.etapas.some((e) => e.id === etapaId && e.perdido)) : false;
    const r = await rd(`/deals/${id}/lost`, {}, {
      metodo: 'POST',
      corpo: { versao: deal.versao, deal_lost_reason_id: motivoId, ...(nota ? { deal_lost_note: nota } : {}), ...(dePerda ? { deal_stage_id: etapaId } : {}) },
    });
    if (r && Array.isArray(r.falhas) && r.falhas.length) throw new Error(`O CRM não marcou a perda: ${r.falhas.map((f) => f.mensagem || f.erro || f.codigo || '').join('; ')}`);
    return r || {};
  }
  return rd(`/deals/${id}`, {}, { metodo: 'PUT', corpo: { ...(etapaId ? { deal_stage_id: etapaId } : {}), deal: { win: false, deal_lost_reason_id: motivoId, deal_custom_fields: camposRd || [] } } });
}

// ---------------------------------------------------------------- listas no PronixCRM
// Na lista de /deals o PronixCRM respeita deal_pipeline_id, deal_stage_id, sdr_id, contact_id e a janela de
// datas (created_at_period / updated_at_period), mas IGNORA win, user_id e closed_at_period — e a lista não traz
// closed_at, os campos personalizados nem o motivo da perda. Quem precisa disso lista pelo que ele respeita,
// confere o resto aqui e lê o detalhe das que interessam.

/** Dia AAAA-MM-DD como instante no fuso do Brasil (o PronixCRM pede data com fuso). */
const instanteDoDia = (dia, fimDoDia = false) => `${dia}T${fimDoDia ? '23:59:59' : '00:00:00'}-03:00`;

/** O usuário do CRM pelo nome: o nome inteiro; senão o primeiro nome, se só um tiver; senão todas as palavras. */
async function usuarioDoCrm(nome) {
  const lista = await module.exports.usuariosRd().catch(() => []);
  const n = normalizarNome(nome);
  if (!n) return null;
  const primeiro = n.split(' ')[0];
  const exato = lista.find((u) => normalizarNome(u.nome) === n);
  if (exato) return exato;
  const mesmoPrimeiro = lista.filter((u) => normalizarNome(u.nome).split(' ')[0] === primeiro);
  if (mesmoPrimeiro.length === 1) return mesmoPrimeiro[0];
  return lista.find((u) => { const p = new Set(normalizarNome(u.nome).split(' ')); return n.split(' ').every((x) => p.has(x)); }) || null;
}

/** Todas as negociações de um filtro, pelo cursor (até maxPaginas de 200). Formato da lista, sem o detalhe. */
async function listarNegociacoes(filtros = {}, { maxPaginas = 40 } = {}) {
  const todas = [];
  let cursor = '';
  for (let i = 0; i < maxPaginas; i++) {
    const r = await module.exports.rd('/deals', { ...filtros, limit: 200, ...(cursor ? { cursor } : {}) });
    const pagina = (r && r.deals) || [];
    todas.push(...pagina);
    cursor = (r && r.proximo_cursor) || '';
    if (!cursor || pagina.length < 200) break;
  }
  return todas;
}

/**
 * O detalhe de várias negociações (com closed_at, campos, motivo, produtos, contatos e histórico de etapas),
 * 8 de cada vez. Recebe ids ou as negociações da lista: com updated_at, o detalhe fica guardado por id + updated_at
 * (20 dias) — abrir o Match de novo só relê o que mudou, e o limite do CRM (600 por minuto) não estoura.
 */
async function detalhesDe(itens, { concorrencia = 8, porSegundo = 8, prazoMs = 0 } = {}) {
  const vistos = new Set();
  const lista = (itens || [])
    .map((x) => (typeof x === 'object' && x ? { id: idDe(x), versao: String(x.updated_at || '') } : { id: String(x || ''), versao: '' }))
    .filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x.id) && !vistos.has(x.id) && vistos.add(x.id));
  const chave = (x) => `crm:det:${x.id}:${x.versao}`;
  // Ritmo: no máximo porSegundo leituras novas por segundo (o CRM aceita 600 por minuto, e a extensão de todo
  // mundo usa o mesmo token). Com prazoMs, para quando o tempo acaba (a Vercel corta em 60 s) e diz quantas
  // faltaram — o que já foi lido fica guardado, e a próxima rodada continua dali.
  const t0 = Date.now();
  let lidasDaRede = 0;
  let parar = false;
  const ler = async (x) => {
    if (x.versao) {
      const g = await db.cacheGet(chave(x)).catch(() => null);
      if (g) { try { return JSON.parse(g); } catch (_) { /* relê */ } }
    }
    if (parar) return null;
    lidasDaRede++;
    const d = await module.exports.rd(`/deals/${encodeURIComponent(x.id)}`).catch((e) => {
      if (/limitou as consultas/.test(e.message)) parar = true; // 429: para e deixa o resto para a próxima
      return null;
    });
    if (d && x.versao) await db.cacheSet(chave(x), JSON.stringify(d), 20 * 24 * 3600).catch(() => {}); // a chave muda quando a negociação muda
    return d;
  };
  const saida = [];
  let i = 0;
  for (; i < lista.length && !parar; i += concorrencia) {
    if (prazoMs && Date.now() - t0 > prazoMs) break;
    const lote = await Promise.all(lista.slice(i, i + concorrencia).map(ler));
    saida.push(...lote.filter(Boolean));
    const adiantado = lidasDaRede / porSegundo * 1000 - (Date.now() - t0);
    if (adiantado > 0) await new Promise((r) => setTimeout(r, adiantado));
  }
  saida.pendentes = Math.max(0, lista.length - saida.length);
  return saida;
}

/**
 * As atividades (anotações, formulário) de UMA negociação. No PronixCRM, GET /activities ignora o deal_id e devolve
 * as de TODAS as negociações — o cartão mostrava o formulário de outro lead. Lá o certo é /deals/:id/activities;
 * e, por garantia, só fica a atividade que diz ser desta negociação.
 */
async function atividadesDoCard(dealId, limit = 50) {
  const rd = module.exports.rd;
  if (!ehPronix()) return rd('/activities', { deal_id: dealId, limit });
  const r = await rd(`/deals/${encodeURIComponent(dealId)}/activities`, { limit });
  const lista = (r && r.activities) || [];
  return { activities: lista.filter((a) => !a.deal_id || String(a.deal_id) === String(dealId)) };
}

/** Os funis dos closers (nome com "closer"): é onde fica o card depois da reunião. */
async function funisDosClosers() {
  return (await funis()).filter((f) => /closer/i.test(f.nome));
}

/** Depois de escrever num card: a ficha do lead em cache está velha, a próxima consulta busca de novo. */
async function esquecerLead(busca = {}) {
  const idOk = (v) => (/^[A-Za-z0-9_-]{1,40}$/.test(String(v || '')) ? String(v) : '');
  const chave = chaveDaBusca({
    telefone: soDigitos(busca.telefone), nome: String(busca.nome || '').trim().slice(0, 80), contatoId: idOk(busca.contatoId),
  });
  if (chave) await db.cacheDel('crm:' + chave);
}

module.exports = {
  // Para a limpeza do funil (src/limpezaRd.js): a chamada crua ao RD, os funis, os usuários e a chave geral de escrita.
  rd,
  ehPronix,
  linkDoCard,
  instanteDoDia,
  usuarioDoCrm,
  listarNegociacoes,
  detalhesDe,
  funisDosClosers,
  atividadesDoCard,
  mudarEtapa,
  perderCard,
  funis,
  usuariosRd: usuarios,
  moverLigado,
  esquecerLead,
  consultarLead,
  produtosDoCard,
  saoAMesmaPessoa,
  antesDeRespondeu,
  moverParaRespondeu,
  inicioDaTentativa,
  ehEtapaQualificado,
  configurado,
  variantesTelefone,
  contatoTemTelefone,
  limparTexto,
  extrairCampos,
  consertarAcentos,
  palavrasDoNome,
  consultasPorNome,
  escolherNegociacao,
  escolherCard,
};
