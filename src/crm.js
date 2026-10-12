'use strict';

// Ficha do lead no RD Station CRM (API v1): ao abrir uma conversa no WhatsApp Web, a extensão
// pergunta ao servidor "quem é este telefone?" e mostra um cartão com a negociação do lead
// (etapa, funil, responsável) e as respostas do formulário que aparecem nas anotações.
//
// O token do CRM (RDSTATION_CRM_TOKEN) fica SÓ aqui no servidor: nunca vai para a extensão,
// para o navegador nem para log. Documentação: https://developers.rdstation.com/reference/crm-v1-contacts

const db = require('./db');

const BASE = 'https://crm.rdstation.com/api/v1';
const CHAVE_CARDS = 'crm_cards'; // { chave do lead: id do card que o SDR escolheu }
const TZ = process.env.TZ_RELATORIO || 'America/Sao_Paulo';

const token = () => String(process.env.RDSTATION_CRM_TOKEN || '').trim();
const configurado = () => Boolean(token());

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
  const q = new URLSearchParams({ token: token() });
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  const escrita = metodo !== 'GET';
  let r;
  try {
    r = await fetch(`${BASE}${caminho}?${q}`, {
      method: metodo,
      headers: escrita ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      ...(escrita ? { body: JSON.stringify(corpo || {}) } : {}),
      signal: AbortSignal.timeout(Number(process.env.CRM_TIMEOUT_MS) || 8000),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('O RD Station CRM demorou para responder. Tente de novo.');
    }
    throw new Error('Não consegui falar com o RD Station CRM.');
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
    if (m && !/https?$/i.test(m[1].trim())) campos.push({ rotulo: m[1].trim(), valor: m[2].trim().slice(0, 300) });
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

async function montarFicha(contato, extras = [], preferido = '') {
  const todosContatos = [contato].concat(extras);
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
  const detalhes = (await Promise.all(candidatos.map((d) => rd(`/deals/${encodeURIComponent(idDe(d))}`).catch(() => null)))).map(
    (det, i) => (det ? { ...candidatos[i], ...det } : candidatos[i])
  );
  const escolhido = escolherCard(detalhes, preferido);
  const idNeg = escolhido ? idDe(escolhido) : null;
  const deal = escolhido || null;
  const [atividades, users, rotulosContato] = await Promise.all([
    idNeg ? rd('/activities', { deal_id: idNeg, limit: 50 }) : null,
    usuarios(),
    camposDoContato(),
  ]);
  const nomeDe = new Map();
  const cards = detalhes.map((d) => ({
    id: idDe(d),
    nome: consertarAcentos(d.name || ''),
    etapa: (d.deal_stage && d.deal_stage.name) || '',
    funil: (d.deal_pipeline && d.deal_pipeline.name) || '',
    responsavel: (d.user && d.user.name) || '',
    criadaEm: quandoBR(d.created_at),
    aberta: estaAberta(d),
    ganha: d.win === true, // o closer marcou a venda no RD
    perdida: d.win === false, // marcou como perdida
    valor: Number(d.amount_total) || 0, // valor da negociação no RD
    motivoPerda: consertarAcentos((d.deal_lost_reason && d.deal_lost_reason.name) || ''),
    notaPerda: consertarAcentos(d.deal_lost_note || '').slice(0, 300),
    fechadaEm: d.closed_at || '',
    atualizadaEm: d.updated_at || '',
    escolhida: idDe(d) === idNeg,
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
          url: id && /^[A-Za-z0-9_-]+$/.test(String(id)) ? `https://crm.rdstation.com/app/deals/${id}` : '',
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
const chaveDaBusca = ({ telefone, nome, contatoId }) =>
  contatoId ? `id:${contatoId}` : telefone.length >= 8 ? `tel:${final8(telefone)}` : nome ? `nome:${nome.toLowerCase()}` : '';

/**
 * @param {{telefone?: string, nome?: string, contatoId?: string}} busca
 * @param {{diagnostico?: boolean, semCache?: boolean}} opcoes
 * @returns {Promise<{configurado: boolean, encontrado?: boolean, ficha?: object, candidatos?: object[], buscaPor?: string, diagnostico?: object}>}
 */
async function consultarLead(busca = {}, opcoes = {}) {
  if (!configurado()) return { configurado: false };
  const telefone = soDigitos(busca.telefone);
  const nome = String(busca.nome || '').trim().slice(0, 80);
  const contatoId = /^[A-Za-z0-9_-]{1,40}$/.test(String(busca.contatoId || '')) ? String(busca.contatoId) : '';
  const dealPedido = /^[A-Za-z0-9_-]{1,40}$/.test(String(busca.dealId || '')) ? String(busca.dealId) : '';
  const diag = { tentativas: [] };

  const chaveBase = chaveDaBusca({ telefone, nome, contatoId });
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
      for (const variante of variantesTelefone(telefone)) {
        const r = await rd('/contacts', { phone: variante, limit: 10 });
        const achados = (r && r.contacts) || [];
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
    // Sem telefone (contato salvo com nome) ou telefone não achado: tenta pelo nome.
    if (!contato && nome && !pareceTelefone(nome)) {
      const { consultas, palavras } = consultasPorNome(nome);
      let candidatos = null;
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
        resultado = { configurado: true, encontrado: true, buscaPor: 'nome', ficha: await montarFicha(contato, [], preferido) };
      } else if (candidatos) {
        resultado = { configurado: true, encontrado: false, buscaPor: 'nome', candidatos };
      }
    }
  }

  // Não achou também fica em cache (menos tempo): trocar de conversa e voltar não repete a busca toda.
  if (ttl) await db.cacheSet(chave, JSON.stringify(resultado), resultado.encontrado ? ttl : Math.min(ttl, 120));
  return opcoes.diagnostico ? { ...resultado, diagnostico: diag } : resultado;
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

/** Funis do RD com as etapas na ordem do funil: [{ id, nome, etapas: [{ id, nome, ordem }] }]. Cache de 1h. */
async function funis() {
  const guardado = await db.cacheGet('crm:funis');
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
    await db.cacheSet('crm:funis', '[]', 120);
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
      .map((e, i) => ({ id: idDe(e), nome: consertarAcentos(e.name || ''), o: Number.isFinite(Number(e.order)) ? Number(e.order) : i, i }))
      .sort((a, b) => a.o - b.o || a.i - b.i)
      .map((e, ordem) => ({ id: e.id, nome: e.nome, ordem }));
    saida.push({ id: idDe(p), nome: consertarAcentos(p.name || ''), etapas: ordenadas });
  }
  // Lista vazia fica pouco tempo no cache: pode ter sido uma falha passageira do RD.
  await db.cacheSet('crm:funis', JSON.stringify(saida), saida.some((f) => f.etapas.length) ? 3600 : 120);
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
 * o card tem de ser deste lead, estar em aberto e numa etapa anterior a "Respondeu" do MESMO funil.
 * @param {{telefone?: string, nome?: string, contatoId?: string, dealId?: string}} busca
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

  const resp = await rd(`/deals/${encodeURIComponent(card.id)}`, {}, { metodo: 'PUT', corpo: { deal_stage_id: alvo.id } });
  if (!resp) throw new Error('O RD Station não achou o card para mudar de etapa.');
  const nova = idDe(resp.deal_stage);
  if (nova && nova !== alvo.id) throw new Error('O RD Station respondeu, mas o card não mudou de etapa.');

  // A ficha em cache ainda diz a etapa antiga: a próxima consulta busca de novo.
  const chave = chaveDaBusca({
    telefone: soDigitos(busca.telefone), nome: String(busca.nome || '').trim().slice(0, 80), contatoId: idOk(busca.contatoId),
  });
  if (chave) await db.cacheDel('crm:' + chave);
  await db
    .push('crm_movimentos', { quando: new Date().toISOString(), card: card.id, de: onde.etapa.nome, para: alvo.nome, por: usuarioNome }, 500)
    .catch(() => {});
  return { movido: true, de: onde.etapa.nome, para: alvo.nome };
}

module.exports = {
  // Para a limpeza do funil (src/limpezaRd.js): a chamada crua ao RD, os funis, os usuários e a chave geral de escrita.
  rd,
  funis,
  usuariosRd: usuarios,
  moverLigado,
  consultarLead,
  antesDeRespondeu,
  moverParaRespondeu,
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
