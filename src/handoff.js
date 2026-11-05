'use strict';

// O handoff editorial (schemaVersion 2, auditoria de 04/11/2026). Um objeto canônico alimenta a tela, o PDF e o
// texto do CRM. Ordem de leitura: identidade + tese → leitura do SDR → oportunidade → panorama → condução →
// abertura → contexto/evidências.
//
// Compatibilidade:
// - Reports antigos (sem schemaVersion) continuam abrindo: vistaEditorial() os adapta sem chamar IA nem inventar
//   fato (o que não tem lugar próprio vai para "Contexto").
// - Os campos antigos `resumo` e `secoes` são DERIVADOS do formato novo (sincronizarLegado) para quem ainda os lê
//   (texto do CRM antigo, afinidade, .docx). Nunca são editados direto num report novo.

const visaoSdr = require('./visaoSdr');

const SCHEMA_VERSAO = 2;
const TEMPLATE_VERSAO = 'editorial-1';

const ETAPAS = ['Conectar', 'Aprofundar', 'Avançar'];
// De onde vem cada campo do panorama. O PDF mostra só o texto; a tela mostra a origem.
const STATUS_PANORAMA = ['declarado', 'indicado', 'informado_sdr', 'leitura_sdr', 'a_alinhar'];
const CAMPOS_PANORAMA = [
  ['objetivo', 'Objetivo'],
  ['capital_operacao', 'Capital para a operação'],
  ['capacidade_acompanhamento', 'Investimento no acompanhamento'],
  ['timing', 'Momento'],
  ['decisao', 'Decisão'],
  ['combinado', 'Combinado'],
];
const ORIGENS = ['lead', 'sdr', 'leitura_sdr'];

const txt = (v, max = 2000) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const lista = (v, max, tam = 600) => (Array.isArray(v) ? v.map((x) => txt(x, tam)).filter(Boolean).slice(0, max) : []);
const daLista = (valor, permitidos, padrao) => (permitidos.includes(valor) ? valor : padrao);

/** Normaliza os campos editoriais (saída da IA ou edição do painel). Não toca nos campos internos/antigos. */
function normalizarEditorial(d) {
  const e = d && typeof d === 'object' ? d : {};
  const tese = e.tese && typeof e.tese === 'object' ? e.tese : { titulo: '', texto: txt(e.tese, 600) };
  const panorama = {};
  const pan = e.panorama && typeof e.panorama === 'object' ? e.panorama : {};
  CAMPOS_PANORAMA.forEach(([k]) => {
    const c = pan[k];
    const valor = c && typeof c === 'object' ? txt(c.valor, 500) : txt(c, 500);
    if (valor) panorama[k] = { valor, status: daLista(c && c.status, STATUS_PANORAMA, 'declarado') };
  });
  const conducao = (Array.isArray(e.conducao) ? e.conducao : [])
    .map((p, i) => ({
      etapa: daLista(txt(p && p.etapa, 20), ETAPAS, ETAPAS[Math.min(i, 2)]),
      acao: txt(p && p.acao, 600),
      objetivo: txt(p && p.objetivo, 400),
      ...(txt(p && p.pergunta, 300) ? { pergunta: txt(p.pergunta, 300) } : {}),
    }))
    .filter((p) => p.acao)
    .slice(0, 3);
  const oportunidade = (Array.isArray(e.oportunidade) ? e.oportunidade : [])
    .map((s) => ({ fato: txt(s && s.fato, 400), relevancia: txt(s && s.relevancia, 400), origem: daLista(s && s.origem, ORIGENS, 'lead') }))
    .filter((s) => s.fato)
    .slice(0, 3);
  // Ficha: linhas factuais que NÃO vêm da IA (linha do tempo das mensagens, profissão do formulário).
  const ficha = (Array.isArray(e.ficha) ? e.ficha : [])
    .map((r) => ({ rotulo: txt(r && r.rotulo, 60), valor: txt(r && r.valor, 300) }))
    .filter((r) => r.rotulo && r.valor)
    .slice(0, 6);
  return {
    ficha,
    negocio: txt(e.negocio, 300),
    tese: { titulo: txt(tese.titulo, 160), texto: txt(tese.texto, 700) },
    oportunidade,
    panorama,
    conducao,
    abertura: txt(e.abertura, 900),
    contexto: lista(e.contexto, 6),
  };
}

/** true = report no formato editorial (schemaVersion 2). */
const ehEditorial = (d) => !!d && Number(d.schemaVersion) >= SCHEMA_VERSAO;

/**
 * A vista que a tela e o PDF desenham — para os dois formatos. Report antigo é adaptado sem perder nada:
 * resumo vira panorama em linhas, "O que o closer deve bater" vira a condução (sem rótulos de etapa), a seção
 * "Visão do X pro lead" vira a leitura, o resto vai para contexto. frase_impacto (paráfrase, não fato) não entra.
 */
function vistaEditorial(d) {
  const dados = d && typeof d === 'object' ? d : {};
  const leituraDe = (v, autor) => (v ? { titulo: visaoSdr.tituloDaLeitura(v.autor || autor), itens: visaoSdr.topicosVisiveis(v), status: v.statusRevisao || 'original' } : null);
  if (ehEditorial(dados)) {
    const e = normalizarEditorial(dados);
    return {
      formato: 'editorial',
      lead: txt(dados.lead, 120),
      ficha: e.ficha,
      negocio: e.negocio,
      tese: e.tese,
      leitura: leituraDe(dados.visaoSdr, dados.sdr),
      oportunidade: e.oportunidade,
      panorama: CAMPOS_PANORAMA.filter(([k]) => e.panorama[k]).map(([k, rotulo]) => ({ chave: k, rotulo, ...e.panorama[k] })),
      conducao: e.conducao.map((p) => ({ ...p, rotulo: p.etapa })),
      abertura: e.abertura,
      evidencias: lista(dados.citacoes, 3),
      contexto: e.contexto,
      conversa: lista(dados.conversa, 6),
    };
  }
  // ---- formato antigo
  const secoes = Array.isArray(dados.secoes) ? dados.secoes.filter((s) => s && s.titulo && Array.isArray(s.itens) && s.itens.length) : [];
  const ehVisao = (s) => /^vis[aã]o d[oa] .+ pro lead$/i.test(String(s.titulo).trim());
  const ehAcao = (s) => /closer deve bater|como fechar|plano|condu/i.test(String(s.titulo));
  const visao = secoes.find(ehVisao);
  const acao = secoes.find((s) => !ehVisao(s) && ehAcao(s));
  const outras = secoes.filter((s) => s !== visao && s !== acao);
  const c = dados.consciencia || {};
  return {
    formato: 'legado',
    lead: txt(dados.lead, 120),
    ficha: [],
    negocio: '',
    tese: { titulo: txt(c.titulo, 160), texto: '' },
    leitura: visao ? { titulo: String(visao.titulo).replace(/^vis[aã]o d[oa] (\S+).*$/i, 'Leitura de $1'), itens: lista(visao.itens, 50), status: 'original' } : null,
    oportunidade: lista(dados.sinais_compra, 5).map((f) => ({ fato: f, relevancia: '', origem: 'lead' })),
    panorama: (Array.isArray(dados.resumo) ? dados.resumo : []).filter((r) => r && r.rotulo && r.valor).map((r) => ({ chave: '', rotulo: txt(r.rotulo, 80), valor: txt(r.valor, 500), status: '' })),
    conducao: acao ? lista(acao.itens, 10).map((a) => ({ etapa: '', rotulo: '', acao: a, objetivo: '' })) : [],
    abertura: txt(dados.abertura, 900),
    evidencias: lista(dados.citacoes, 3),
    contexto: outras.flatMap((s) => lista(s.itens, 20).map((i) => `${txt(s.titulo, 60)}: ${i}`)),
    conversa: lista(dados.conversa, 6),
  };
}

/**
 * Deriva `resumo` e `secoes` do formato editorial para quem ainda lê o formato antigo (texto do CRM, afinidade,
 * .docx). Recalculado a cada geração/edição; o painel não edita estes campos num report editorial.
 */
function sincronizarLegado(dados) {
  if (!ehEditorial(dados)) return dados;
  const v = vistaEditorial(dados);
  const resumo = v.ficha.map((r) => ({ ...r }));
  if (v.negocio) resumo.push({ rotulo: 'Negócio', valor: v.negocio });
  v.panorama.forEach((p) => resumo.push({ rotulo: p.rotulo, valor: p.valor }));
  const secoes = [];
  if (v.tese.texto || v.tese.titulo) secoes.push({ titulo: 'Tese da oportunidade', numerada: false, itens: [[v.tese.titulo, v.tese.texto].filter(Boolean).join(' — ')] });
  if (v.leitura && v.leitura.itens.length) secoes.push({ titulo: v.leitura.titulo, numerada: false, itens: v.leitura.itens });
  if (v.oportunidade.length) secoes.push({ titulo: 'Oportunidade em foco', numerada: false, itens: v.oportunidade.map((o) => (o.relevancia ? `${o.fato} — ${o.relevancia}` : o.fato)) });
  if (v.conducao.length) {
    secoes.push({
      titulo: 'Condução da reunião',
      numerada: true,
      itens: v.conducao.map((p) => [`${p.etapa}: ${p.acao}`, p.objetivo && `Objetivo: ${p.objetivo}`, p.pergunta && `Pergunta: ${p.pergunta}`].filter(Boolean).join(' ')),
    });
  }
  if (v.contexto.length) secoes.push({ titulo: 'Contexto', numerada: false, itens: v.contexto });
  dados.resumo = resumo;
  dados.secoes = secoes;
  return dados;
}

module.exports = {
  SCHEMA_VERSAO, TEMPLATE_VERSAO, ETAPAS, STATUS_PANORAMA, CAMPOS_PANORAMA,
  normalizarEditorial, ehEditorial, vistaEditorial, sincronizarLegado,
};
