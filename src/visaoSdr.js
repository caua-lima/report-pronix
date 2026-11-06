'use strict';

// "Visão do <SDR> pro lead": o que o master escreve na hora de gerar o report, para o closer ler. A IA gratuita (Groq)
// só arruma o texto — mesma ideia, nada inventado, nada tirado — em tópicos curtos. Se ela falhar ou fugir do que foi
// escrito, entra o texto do próprio SDR, como ele escreveu. Vira a primeira seção do report (e do PDF).

const { chatGroq } = require('./groq');

const SYSTEM = [
  'Você recebe a visão que um SDR escreveu sobre um lead, para o closer que vai fazer a reunião.',
  'Reescreva em português do Brasil, em 1 a 5 tópicos curtos e claros, na voz do próprio SDR.',
  'Regras: mantenha exatamente o sentido e todas as informações; não invente nada; não tire nada importante; não mude',
  'opiniões nem suavize alertas; corrija a escrita e deixe direto. Sem introdução, sem conclusão.',
  'Responda só com JSON: {"itens": ["...", "..."]}',
].join(' ');

const limpar = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** O texto do SDR em tópicos, sem IA: uma linha (ou frase) por tópico. */
function emTopicos(texto) {
  const linhas = String(texto || '').split(/\n+/).map((l) => limpar(l.replace(/^[-•*\d.)\s]+/, ''))).filter(Boolean);
  const base = linhas.length > 1 ? linhas : (String(texto || '').match(/[^.!?]+[.!?]*/g) || []).map(limpar).filter(Boolean);
  return base.slice(0, 8);
}

function extrairItens(bruto) {
  try {
    const t = String(bruto || '');
    const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    const itens = (Array.isArray(j.itens) ? j.itens : []).map(limpar).filter(Boolean).slice(0, 6);
    return itens.every((i) => i.length <= 500) ? itens : [];
  } catch (_) {
    return [];
  }
}

/**
 * Reescreve a visão (com fallback para o texto original em tópicos).
 * @returns {Promise<{itens: string[], reescrita: boolean}>}
 */
async function reescrever(texto, { prazoMs = 15000 } = {}) {
  const original = String(texto || '').trim().slice(0, 3000);
  if (!original) return { itens: [], reescrita: false };
  try {
    const itens = extrairItens(await chatGroq({ system: SYSTEM, user: original, maxTokens: 700, prazoMs }));
    const total = itens.join(' ').length;
    // A IA só arruma: se voltou vazio, encolheu demais ou inflou (inventou), fica o texto do SDR.
    if (itens.length && total >= original.length * 0.4 && total <= original.length * 2.5 + 200) return { itens, reescrita: true };
  } catch (_) {
    /* sem IA agora: vai o texto do SDR */
  }
  return { itens: emTopicos(original), reescrita: false };
}

/** Põe a seção "Visão do <primeiro nome> pro lead" no começo do report. */
async function aplicar(dados, { texto, sdr } = {}) {
  const { itens } = await reescrever(texto);
  if (!itens.length || !dados) return dados;
  const primeiro = String(sdr || 'SDR').trim().split(/\s+/)[0] || 'SDR';
  const titulo = `Visão do ${primeiro} pro lead`;
  dados.secoes = [{ titulo, numerada: false, itens }, ...(Array.isArray(dados.secoes) ? dados.secoes.filter((s) => s && s.titulo !== titulo) : [])];
  return dados;
}

module.exports = { aplicar, reescrever, emTopicos };
