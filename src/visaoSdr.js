'use strict';

// "Minha leitura sobre este lead": o que o SDR (só o master) escreve na hora de gerar o report.
//
// Desde a auditoria de 04/11/2026 a leitura é FONTE da geração, não um apêndice: o texto original entra no prompt
// principal (bloco <leitura_sdr>, separado da conversa) e orienta tese, condução e abertura. A mesma chamada devolve
// uma síntese em tópicos na voz do SDR — sem chamada extra só para arrumar a escrita.
//
// Regras desta camada (sem IA):
// - O ORIGINAL é imutável e fica guardado inteiro (limite explícito de MAX_CARACTERES, avisado antes do envio).
// - A síntese só é usada se preservar valores, negações e nomes do original (conferirPreservacao). Se mudar
//   "R$ 5 mil" para "R$ 50 mil", tirar um "não" ou trocar um nome, vale o original em tópicos.
// - Nenhum tópico some: o fallback divide o texto em tópicos sem limite de quantidade.
// - Status: "original" (vai o texto do SDR), "sintese_conferida" (síntese que passou na conferência, ainda não
//   aprovada por ele) e "aprovada" (ele aprovou ou editou no painel). Nada aparece como aprovado sem ele aprovar.

const MAX_CARACTERES = 3000;

const limpar = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** O texto do SDR em tópicos, sem IA: uma linha (ou frase) por tópico — todos, sem corte. */
function emTopicos(texto) {
  const bruto = String(texto || '');
  const linhas = bruto.split(/\n+/).map((l) => limpar(l.replace(/^[-•*\d.)\s]+/, ''))).filter(Boolean);
  if (linhas.length > 1) return linhas;
  return (bruto.match(/[^.!?]+[.!?]*/g) || []).map(limpar).filter(Boolean);
}

/**
 * Valores numéricos do texto, já na mesma escala: "30k", "30 mil", "R$ 30.000" e "30000" são todos 30000.
 * Devolve uma lista ordenada (com repetição) para comparar original e síntese.
 */
function valores(texto) {
  const t = semAcento(texto);
  const out = [];
  const re = /(\d+(?:[.,]\d+)*)\s*(k\b|mil\b|mi\b|milhao\b|milhoes\b|bi\b|bilhao\b|bilhoes\b|%)?/g;
  let m;
  while ((m = re.exec(t))) {
    let num = m[1];
    // "30.000" e "1.500.000": ponto como milhar. "2,5": vírgula decimal.
    if (/^\d{1,3}(\.\d{3})+$/.test(num)) num = num.replace(/\./g, '');
    else num = num.replace(',', '.');
    let v = Number(num);
    if (!Number.isFinite(v)) continue;
    const mult = m[2] || '';
    if (mult === 'k' || mult === 'mil') v *= 1e3;
    else if (/^(mi|milhao|milhoes)$/.test(mult)) v *= 1e6;
    else if (/^(bi|bilhao|bilhoes)$/.test(mult)) v *= 1e9;
    out.push(mult === '%' ? `${v}%` : String(Math.round(v * 100) / 100));
  }
  return out.sort();
}

const NEGACOES = /\b(nao|nunca|nem|jamais|sem|ninguem|nenhum|nenhuma)\b/g;
const contarNegacoes = (texto) => (semAcento(texto).match(NEGACOES) || []).length;

/** Nomes próprios do original (palavra com maiúscula fora do começo da frase; siglas curtas não contam). */
function nomes(texto) {
  const out = new Set();
  String(texto || '').split(/(?<=[.!?\n])\s*/).forEach((frase) => {
    frase.trim().split(/\s+/).slice(1).forEach((p) => {
      const w = p.replace(/[^\p{L}]/gu, '');
      if (w.length >= 3 && /^\p{Lu}\p{Ll}/u.test(w)) out.add(semAcento(w));
    });
  });
  return [...out];
}

/**
 * A síntese preserva o que importa do original? Valores (mesmos números, nem a mais nem a menos), negações (mesma
 * quantidade) e nomes próprios. Devolve os motivos quando não preserva — para o painel mostrar por que ficou o original.
 */
function conferirPreservacao(original, sintese) {
  const s = Array.isArray(sintese) ? sintese.join('\n') : String(sintese || '');
  const motivos = [];
  const vo = valores(original);
  const vs = valores(s);
  if (vo.join('|') !== vs.join('|')) motivos.push(`valores mudaram (${vo.join(', ') || 'nenhum'} → ${vs.join(', ') || 'nenhum'})`);
  if (contarNegacoes(original) !== contarNegacoes(s)) motivos.push('negação acrescentada ou retirada');
  const ns = semAcento(s);
  const faltam = nomes(original).filter((n) => !ns.includes(n));
  if (faltam.length) motivos.push(`nome(s) sumiram: ${faltam.join(', ')}`);
  if (!limpar(s)) motivos.push('síntese vazia');
  return { ok: motivos.length === 0, motivos };
}

/** O texto que chegou do cliente: até MAX_CARACTERES (o cliente avisa antes; aqui não se corta calado). */
function textoRecebido(bruto) {
  const texto = String(bruto || '').trim();
  if (texto.length > MAX_CARACTERES) {
    const e = new Error(`A sua leitura do lead tem ${texto.length} caracteres; o limite é ${MAX_CARACTERES}. Encurte e gere de novo.`);
    e.status = 400;
    throw e;
  }
  return texto;
}

/**
 * Monta o bloco visaoSdr do report a partir do original e da síntese proposta pela geração principal.
 * @returns {null | {original, sintese: string[], autor, atualizadoEm, statusRevisao, motivos?: string[]}}
 */
function montar({ texto, sintese, autor, agora = new Date() } = {}) {
  const original = String(texto || '').trim();
  if (!original) return null;
  const proposta = (Array.isArray(sintese) ? sintese : []).map(limpar).filter(Boolean);
  const conferida = proposta.length ? conferirPreservacao(original, proposta) : { ok: false, motivos: ['a geração não devolveu síntese'] };
  return {
    original,
    sintese: conferida.ok ? proposta : emTopicos(original),
    ...(conferida.ok ? {} : { sintesePropostaDescartada: proposta, motivos: conferida.motivos }),
    autor: limpar(autor).slice(0, 80),
    atualizadoEm: agora.toISOString(),
    statusRevisao: conferida.ok ? 'sintese_conferida' : 'original',
  };
}

/** O título que o closer lê: "Leitura de <primeiro nome>". */
function tituloDaLeitura(autor) {
  const primeiro = limpar(autor).split(/\s+/)[0] || 'SDR';
  return `Leitura de ${primeiro}`;
}

/** Os tópicos que vão para o PDF/tela: os aprovados/conferidos, ou o original em tópicos. */
function topicosVisiveis(v) {
  if (!v || !v.original) return [];
  if (Array.isArray(v.sintese) && v.sintese.length) return v.sintese.map(limpar).filter(Boolean);
  return emTopicos(v.original);
}

/**
 * Edição no painel: o SDR aprova a síntese, edita, ou volta para o original. A conferência não bloqueia a edição
 * dele (é a palavra dele), só registra que foi revisada por ele.
 */
function revisar(v, { sintese, usarOriginal } = {}, agora = new Date()) {
  if (!v || !v.original) return v;
  const novo = { ...v, atualizadoEm: agora.toISOString() };
  if (usarOriginal) {
    novo.sintese = emTopicos(v.original);
    novo.statusRevisao = 'original';
  } else {
    const itens = (Array.isArray(sintese) ? sintese : emTopicos(sintese)).map(limpar).filter(Boolean);
    novo.sintese = itens.length ? itens : emTopicos(v.original);
    novo.statusRevisao = 'aprovada';
  }
  delete novo.motivos;
  delete novo.sintesePropostaDescartada;
  return novo;
}

module.exports = {
  MAX_CARACTERES, emTopicos, valores, nomes, conferirPreservacao, textoRecebido, montar, tituloDaLeitura, topicosVisiveis, revisar,
};
