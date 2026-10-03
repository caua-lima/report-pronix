'use strict';

// Base de conhecimento da PRONIX (playbook): a empresa, a oferta, o perfil de cliente, o roteiro,
// a régua de qualificação (SPIN/BANT) e as objeções. O master edita pelo dashboard e o conteúdo
// entra em todo report e no coach — sem deploy e sem tocar na extensão.
//
// Campo que ninguém escreveu ainda vem com o texto recomendado de src/baseInicial.js.

const db = require('./db');
const crypto = require('crypto');
const { VERSAO, PADRAO, PADROES_ANTIGOS } = require('./baseInicial');

const digital = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex').slice(0, 16);

const CHAVE_DB = 'base';
const CAMPOS = ['empresa', 'oferta', 'perfil', 'script', 'qualificacao', 'objecoes'];
const LIMITE_CAMPO = 8000; // ~2 páginas por campo: o playbook vai em todo prompt

const texto = (v) => (typeof v === 'string' ? v : '');

async function ler() {
  const b = await db.getJson(CHAVE_DB, null);
  // Nada gravado: vale a base recomendada (sem escrever no banco).
  if (!b || typeof b !== 'object') return { ...PADRAO, atualizadoEm: null, versao: VERSAO, recomendada: true, temAnterior: false };

  // Base que já estava numa versão recomendada mais antiga (2 em diante): o campo que ninguém editou
  // recebe o texto novo; o que o master escreveu fica como está.
  if (Number(b.versao) >= 2 && Number(b.versao) < VERSAO) {
    const nova = { ...b, versao: VERSAO, atualizadoEm: new Date().toISOString() };
    CAMPOS.forEach((c) => {
      if (!texto(b[c]) || PADROES_ANTIGOS.has(digital(b[c]))) nova[c] = PADRAO[c];
    });
    await db.setJson(CHAVE_DB, nova);
    return ler();
  }

  // Base da primeira versão (4 campos): passa para a recomendada UMA vez, guardando o que havia
  // em "anterior" — o master restaura pela aba Base se preferir o texto antigo.
  if ((Number(b.versao) || 1) < VERSAO) {
    const anterior = {};
    ['script', 'oferta', 'objecoes', 'perfil'].forEach((c) => {
      if (texto(b[c])) anterior[c] = b[c];
    });
    const nova = { ...PADRAO, versao: VERSAO, atualizadoEm: new Date().toISOString(), anterior: { ...anterior, atualizadoEm: b.atualizadoEm || null } };
    await db.setJson(CHAVE_DB, nova);
    return { ...PADRAO, atualizadoEm: nova.atualizadoEm, versao: VERSAO, recomendada: true, temAnterior: Object.keys(anterior).length > 0 };
  }

  const out = {};
  CAMPOS.forEach((c) => {
    out[c] = texto(b[c]);
  });
  out.atualizadoEm = b.atualizadoEm || null;
  out.versao = VERSAO;
  out.recomendada = CAMPOS.every((c) => out[c] === PADRAO[c]);
  out.temAnterior = Boolean(b.anterior && Object.keys(b.anterior).some((k) => k !== 'atualizadoEm'));
  return out;
}

async function gravar(campos, extra = {}) {
  const atual = await ler(); // também faz a passagem de versão, se ainda faltar
  const guardado = (await db.getJson(CHAVE_DB, null)) || {};
  const nova = { versao: VERSAO, anterior: guardado.anterior, ...extra };
  CAMPOS.forEach((c) => {
    nova[c] = typeof (campos || {})[c] === 'string' ? campos[c].trim().slice(0, LIMITE_CAMPO) : atual[c];
  });
  nova.atualizadoEm = new Date().toISOString();
  await db.setJson(CHAVE_DB, nova);
  return ler();
}

const salvar = (campos) => gravar(campos);

/** Volta um campo (ou todos) para o texto recomendado. */
function usarRecomendada(campo) {
  const alvo = CAMPOS.includes(campo) ? { [campo]: PADRAO[campo] } : { ...PADRAO };
  return gravar(alvo);
}

/** Devolve os textos que existiam antes da passagem para a base recomendada. */
async function restaurarAnterior() {
  const guardado = (await db.getJson(CHAVE_DB, null)) || {};
  const a = guardado.anterior || {};
  const campos = {};
  ['script', 'oferta', 'objecoes', 'perfil'].forEach((c) => {
    if (texto(a[c])) campos[c] = a[c];
  });
  if (!Object.keys(campos).length) throw new Error('Não há base anterior guardada.');
  return gravar(campos);
}

const TITULOS = {
  empresa: 'A EMPRESA (quem é a PRONIX, quem são as pessoas, provas e método)',
  oferta: 'OFERTA E VALORES (o que a PRONIX vende e por quanto)',
  perfil: 'PERFIL DE CLIENTE IDEAL (quem é bom lead, os dois tipos e o que importa em cada um)',
  script: 'ROTEIRO (o que o pré-vendedor levanta e o que o closer faz na reunião)',
  qualificacao: 'RÉGUA DE QUALIFICAÇÃO (SPIN e BANT aplicados à pré-venda)',
  objecoes: 'OBJEÇÕES E DORES COMUNS (como a casa trata)',
};

/**
 * Monta o bloco do playbook para o prompt do report. Volta '' quando todos os campos estão vazios.
 */
async function paraPrompt() {
  const b = await ler();
  const partes = CAMPOS.filter((c) => b[c]).map((c) => `${TITULOS[c]}:\n${b[c]}`);
  if (!partes.length) return '';

  return (
    'PLAYBOOK DA EMPRESA — contexto para você INTERPRETAR melhor a conversa.\n\n' +
    partes.join('\n\n') +
    '\n\nCOMO USAR O PLAYBOOK (importante):\n' +
    '- Ele ajuda a ENTENDER o que foi dito. Ex.: sabendo o ticket da oferta, um "ok" ' +
    'do lead a um valor que o vendedor citou vira uma confirmação clara.\n' +
    '- Ele NÃO é fato sobre este lead. NUNCA reporte como dito algo que só está aqui: ' +
    'se o playbook diz que o ticket é R$3 mil e ninguém falou de dinheiro na conversa, ' +
    'esse valor NÃO vira a linha de Investimento. Prova da empresa, case, preço ou bônus só ' +
    'entram no relatório se apareceram na conversa.\n' +
    '- Se o lead foge do perfil ideal ou levanta uma objeção conhecida, vale sinalizar ' +
    'para o closer — desde que baseado no que ele realmente falou.\n' +
    '- Se o SDR não levantou algo importante do roteiro, pode apontar como ponto a cobrir ' +
    'na reunião (mas isso nunca substitui a qualificação mínima obrigatória).\n' +
    '- A RÉGUA DE QUALIFICAÇÃO é o critério do campo "analise" (BANT, SPIN, perguntas-chave).'
  );
}

/** Playbook para o coach (IA gratuita): os mesmos campos, com a instrução de uso dele. */
async function paraCoach() {
  const b = await ler();
  const partes = CAMPOS.filter((c) => b[c]).map((c) => `${TITULOS[c]}:\n${b[c]}`);
  if (!partes.length) return '';
  return (
    'PLAYBOOK DA EMPRESA — use para sugerir perguntas e respostas coerentes com a casa. ' +
    'Não cite preço nem prometa resultado ao lead: quem apresenta valores é o closer.\n\n' +
    partes.join('\n\n')
  );
}

module.exports = { ler, salvar, usarRecomendada, restaurarAnterior, paraPrompt, paraCoach, CAMPOS, LIMITE_CAMPO, PADRAO };
