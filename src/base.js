'use strict';

// Base de conhecimento da PRONIX (playbook): script de qualificação, oferta,
// objeções e perfil de cliente ideal. O admin edita pelo dashboard e o conteúdo
// entra em todo report — sem deploy e sem tocar na extensão.

const db = require('./db');

const CHAVE_DB = 'base';
const CAMPOS = ['script', 'oferta', 'objecoes', 'perfil'];
const LIMITE_CAMPO = 8000; // ~2 páginas por campo: o playbook vai em todo prompt

const VAZIA = { script: '', oferta: '', objecoes: '', perfil: '', atualizadoEm: null };

async function ler() {
  const b = await db.getJson(CHAVE_DB, null);
  if (!b || typeof b !== 'object') return { ...VAZIA };
  const out = { ...VAZIA };
  CAMPOS.forEach((c) => {
    out[c] = typeof b[c] === 'string' ? b[c] : '';
  });
  out.atualizadoEm = b.atualizadoEm || null;
  return out;
}

async function salvar(campos) {
  const atual = await ler();
  const nova = { ...atual };
  CAMPOS.forEach((c) => {
    if (typeof (campos || {})[c] === 'string') nova[c] = campos[c].trim().slice(0, LIMITE_CAMPO);
  });
  nova.atualizadoEm = new Date().toISOString();
  await db.setJson(CHAVE_DB, nova);
  return nova;
}

const TITULOS = {
  script: 'SCRIPT DE QUALIFICAÇÃO (o que o SDR deve levantar na conversa)',
  oferta: 'OFERTA E VALORES (o que a PRONIX vende e por quanto)',
  objecoes: 'OBJEÇÕES COMUNS (o que costuma travar e como é contornado)',
  perfil: 'PERFIL DE CLIENTE IDEAL (quem é bom lead e quem não é)',
};

/**
 * Monta o bloco do playbook para o prompt. Volta '' quando não há nada cadastrado
 * (aí o relatório sai exatamente como saía antes).
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
    'esse valor NÃO vira a linha de Investimento.\n' +
    '- Se o lead foge do perfil ideal ou levanta uma objeção conhecida, vale sinalizar ' +
    'para o closer — desde que baseado no que ele realmente falou.\n' +
    '- Se o SDR não levantou algo importante do script, pode apontar como ponto a cobrir ' +
    'na reunião (mas isso nunca substitui a qualificação mínima obrigatória).'
  );
}

module.exports = { ler, salvar, paraPrompt, CAMPOS, LIMITE_CAMPO };
