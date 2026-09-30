'use strict';

// Ficha do lead no RD Station CRM (API v1): ao abrir uma conversa no WhatsApp Web, a extensão
// pergunta ao servidor "quem é este telefone?" e mostra um cartão com a negociação do lead
// (etapa, funil, responsável) e as respostas do formulário que aparecem nas anotações.
//
// O token do CRM (RDSTATION_CRM_TOKEN) fica SÓ aqui no servidor: nunca vai para a extensão,
// para o navegador nem para log. Documentação: https://developers.rdstation.com/reference/crm-v1-contacts

const db = require('./db');

const BASE = 'https://crm.rdstation.com/api/v1';
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

/** Chamada à API do RD. Erro nunca carrega a URL (que tem o token). */
async function rd(caminho, params = {}) {
  const q = new URLSearchParams({ token: token() });
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  let r;
  try {
    r = await fetch(`${BASE}${caminho}?${q}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Number(process.env.CRM_TIMEOUT_MS) || 8000),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('O RD Station CRM demorou para responder. Tente de novo.');
    }
    throw new Error('Não consegui falar com o RD Station CRM.');
  }
  if (r.status === 401 || r.status === 403) {
    throw new Error('O RD Station CRM recusou o token (confira RDSTATION_CRM_TOKEN na Vercel).');
  }
  if (r.status === 429) throw new Error('O RD Station CRM limitou as consultas. Tente de novo em 1 minuto.');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`O RD Station CRM respondeu ${r.status}.`);
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

async function montarFicha(contato) {
  const idNeg = (() => {
    const d = escolherNegociacao(contato.deals);
    return d ? d.id || d._id : null;
  })();
  const [deal, atividades, users, rotulosContato] = await Promise.all([
    idNeg ? rd(`/deals/${encodeURIComponent(idNeg)}`) : null,
    idNeg ? rd('/activities', { deal_id: idNeg, limit: 50 }) : null,
    usuarios(),
    camposDoContato(),
  ]);
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
    totalNegociacoes: (contato.deals || []).length,
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
  const diag = { tentativas: [] };

  const chave = contatoId ? `crm:id:${contatoId}` : telefone.length >= 8 ? `crm:tel:${final8(telefone)}` : nome ? `crm:nome:${nome.toLowerCase()}` : '';
  if (!chave) return { configurado: true, encontrado: false };
  const ttl = ttlFicha();
  if (ttl && !opcoes.semCache) {
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
    if (contato && contato.name !== undefined) resultado = { configurado: true, encontrado: true, buscaPor: 'id', ficha: await montarFicha(contato) };
  } else {
    let contato = null;
    if (telefone.length >= 8) {
      for (const variante of variantesTelefone(telefone)) {
        const r = await rd('/contacts', { phone: variante, limit: 5 });
        const achados = (r && r.contacts) || [];
        const certo = achados.find((c) => contatoTemTelefone(c, telefone));
        diag.tentativas.push({ variante, resultados: achados.length, bateu: Boolean(certo) });
        if (certo) {
          contato = certo;
          diag.encontradaCom = variante;
          break;
        }
      }
      if (contato) resultado = { configurado: true, encontrado: true, buscaPor: 'telefone', ficha: await montarFicha(contato) };
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
        resultado = { configurado: true, encontrado: true, buscaPor: 'nome', ficha: await montarFicha(contato) };
      } else if (candidatos) {
        resultado = { configurado: true, encontrado: false, buscaPor: 'nome', candidatos };
      }
    }
  }

  // Não achou também fica em cache (menos tempo): trocar de conversa e voltar não repete a busca toda.
  if (ttl) await db.cacheSet(chave, JSON.stringify(resultado), resultado.encontrado ? ttl : Math.min(ttl, 120));
  return opcoes.diagnostico ? { ...resultado, diagnostico: diag } : resultado;
}

module.exports = {
  consultarLead,
  configurado,
  variantesTelefone,
  contatoTemTelefone,
  limparTexto,
  extrairCampos,
  consertarAcentos,
  palavrasDoNome,
  consultasPorNome,
  escolherNegociacao,
};
