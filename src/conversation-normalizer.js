'use strict';

// Camada de normalização: reduz o tamanho da conversa ANTES de montar o prompt
// (menos texto repetido = menos tokens = menos custo), sem perder sinal comercial.
// Roda sobre o histórico já no formato interno [{from, type, content, timestamp}]
// (mesmo formato que normalizarMensagem produz em src/report.js).

// Sinais que NUNCA podem ser cortados por causa do limite de tamanho — se uma
// mensagem antiga tiver um destes, ela fica mesmo estourando o orçamento de
// caracteres. Dor, orçamento, prazo, decisor, objeção, concorrência, próximos
// passos e compromissos são exatamente o que o handoff precisa preservar.
const SINAIS_COMERCIAIS = [
  'dor', 'objetivo', 'orçamento', 'orcamento', 'investimento', 'preço', 'preco',
  'prazo', 'decisor', 'decide', 'decido', 'concorrent', 'objeç', 'objec',
  'próximo passo', 'proximo passo', 'compromet', 'fechar', 'fechado',
  'proposta', 'contrato', 'urgente', 'urgência', 'urgencia', 'sócio', 'socio',
  'esposa', 'marido', 'faturo', 'faturamento', 'cnpj',
];

const MAX_CONVERSATION_CHARS_PADRAO = 24000;

function contemSinalComercial(texto) {
  const t = String(texto || '').toLowerCase();
  return SINAIS_COMERCIAIS.some((s) => t.includes(s));
}

// Heurística simples e documentada (~4 caracteres por token em PT-BR) — não é
// exata, mas não exige chamada externa nem dependência de tokenizer.
function estimarTokens(chars) {
  return Math.ceil((chars || 0) / 4);
}

function totalCaracteres(historico) {
  return historico.reduce((s, m) => s + String((m && m.content) || '').length, 0);
}

/** Remove mensagens vazias (defesa extra — normalizarMensagem já filtra a maioria). */
function removerVazias(historico) {
  return historico.filter((m) => m && String(m.content || '').trim());
}

/** Remove duplicata exata quando aparece IMEDIATAMENTE em seguida (reenvio, eco de captura). */
function removerDuplicadasConsecutivas(historico) {
  const out = [];
  for (const m of historico) {
    const anterior = out[out.length - 1];
    if (anterior && anterior.from === m.from && anterior.type === m.type && anterior.content === m.content) {
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Agrupa mensagens de TEXTO consecutivas do mesmo remetente num só registro —
 * menos prefixo repetido ("VENDEDOR:"/"LEAD:") no prompt, mesmo conteúdo.
 * Áudio nunca agrupa: cada áudio é uma transcrição própria, juntar apagaria
 * a fronteira entre duas falas gravadas separadamente.
 */
function agruparConsecutivas(historico) {
  const out = [];
  for (const m of historico) {
    const anterior = out[out.length - 1];
    if (anterior && anterior.from === m.from && anterior.type === 'texto' && m.type === 'texto') {
      anterior.content += '\n' + m.content;
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

/**
 * Aplica o teto de caracteres só quando a conversa excede. NUNCA corta
 * cegamente pelo início ou fim: percorre da mensagem mais recente para a mais
 * antiga, mantendo tudo que couber no orçamento — e, fora do orçamento, só o
 * que tiver sinal comercial (nunca descarta dor/orçamento/decisor/objeção).
 */
function aplicarLimite(historico, limite) {
  const total = totalCaracteres(historico);
  if (total <= limite) return { historico, resumida: false };

  const mantidas = [];
  let usado = 0;
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    const tam = String(m.content || '').length;
    if (usado + tam <= limite || contemSinalComercial(m.content)) {
      mantidas.push(m);
      usado += tam;
    }
  }
  mantidas.reverse();
  return { historico: mantidas, resumida: mantidas.length < historico.length };
}

/**
 * Normaliza a conversa (mensagens estruturadas) antes do prompt.
 * @param {Array} historicoOriginal [{from, type, content, timestamp}]
 * @param {{maxChars?: number, agrupar?: boolean}} opcoes
 */
function normalizarConversa(historicoOriginal, opcoes = {}) {
  const limite = opcoes.maxChars || Number(process.env.MAX_CONVERSATION_CHARS) || MAX_CONVERSATION_CHARS_PADRAO;
  const agrupar = opcoes.agrupar !== false;
  const original = Array.isArray(historicoOriginal) ? historicoOriginal : [];
  const caracteresAntes = totalCaracteres(original);
  const mensagensOriginais = original.length;

  let historico = removerVazias(original);
  historico = removerDuplicadasConsecutivas(historico);
  if (agrupar) historico = agruparConsecutivas(historico);
  const { historico: final, resumida } = aplicarLimite(historico, limite);

  const caracteresDepois = totalCaracteres(final);

  return {
    historico: final,
    resumida,
    stats: {
      mensagensOriginais,
      mensagensAproveitadas: final.length,
      caracteresAntes,
      caracteresDepois,
      tokensEstimadosAntes: estimarTokens(caracteresAntes),
      tokensEstimadosDepois: estimarTokens(caracteresDepois),
    },
  };
}

/**
 * Mesma normalização, para o modo manual (conversa colada como texto livre,
 * sem remetente estruturado). Trata cada linha como uma "mensagem" só para
 * poder reaproveitar a mesma lógica de limite/sinal comercial — sem agrupar
 * (não há remetente pra saber o que é consecutivo do mesmo lado).
 */
function normalizarTextoLivre(texto, opcoes = {}) {
  const linhas = String(texto || '')
    .split('\n')
    .map((l) => ({ from: null, type: 'texto', content: l }));
  const { historico, resumida, stats } = normalizarConversa(linhas, { ...opcoes, agrupar: false });
  return { texto: historico.map((m) => m.content).join('\n'), resumida, stats };
}

module.exports = {
  normalizarConversa,
  normalizarTextoLivre,
  contemSinalComercial,
  estimarTokens,
  SINAIS_COMERCIAIS,
};
