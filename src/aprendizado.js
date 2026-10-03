'use strict';

// O que a ferramenta aprende com o uso, SEM treinar modelo e sem custo: são exemplos guardados
// que entram no prompt das próximas gerações.
//
// Nível de consciência: quando o master corrige o nível de um report (aba "Resultados da reunião"),
// a correção vira exemplo — "com esta evidência a IA disse X, o certo era Y". O prompt passa a
// carregar os últimos exemplos e o julgamento vai ficando calibrado com a régua da casa.

const db = require('./db');
const { NIVEIS, chaveDoNivel } = require('./consciencia');

const CHAVE = 'aprendizado_consciencia';
const LIMITE = 200;
const NO_PROMPT = 8; // quantos exemplos entram no prompt (cada um custa alguns tokens em todo report)

const rotulo = (k) => (NIVEIS.find((n) => n.chave === k) || {}).rotulo || k;
const limpar = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Guarda uma correção de nível feita pelo master. Ignora quando não mudou nada. */
async function registrarAjusteConsciencia({ reportId, de, para, evidencia, nota }) {
  const a = chaveDoNivel(de);
  const b = chaveDoNivel(para);
  if (!b || a === b) return false;
  await db.push(
    CHAVE,
    {
      reportId: String(reportId || '').slice(0, 20),
      de: a || '',
      para: b,
      evidencia: limpar(evidencia, 300),
      nota: limpar(nota, 200),
      quando: new Date().toISOString(),
    },
    LIMITE
  );
  return true;
}

async function ajustes() {
  try {
    return await db.range(CHAVE);
  } catch (_) {
    return [];
  }
}

/** Bloco para o system do report. '' quando ainda não há correções. */
async function blocoConscienciaParaPrompt() {
  const todos = await ajustes();
  // Um exemplo por report (a última correção vale) e só os que têm a evidência escrita.
  const porReport = new Map();
  todos.forEach((x) => porReport.set(x.reportId || x.quando, x));
  const uteis = [...porReport.values()].filter((x) => x.evidencia).slice(-NO_PROMPT);
  if (!uteis.length) return '';
  return (
    'CALIBRAGEM DO NÍVEL DE CONSCIÊNCIA — correções feitas pelo gestor em reports anteriores. ' +
    'Use como régua: em evidência parecida, classifique como ele corrigiu.\n' +
    uteis
      .map(
        (x) =>
          `- Evidência: "${x.evidencia}" → a IA classificou "${x.de || '?'}" (${rotulo(x.de)}); o certo é "${x.para}" (${rotulo(x.para)})` +
          (x.nota ? `. Motivo: ${x.nota}` : '')
      )
      .join('\n')
  );
}

module.exports = { registrarAjusteConsciencia, blocoConscienciaParaPrompt, ajustes };
