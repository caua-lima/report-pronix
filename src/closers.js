'use strict';

// Cadastro dos closers (quem conduz a call) — não tem chave/login, é só um
// roster pra marcar quem fez cada reunião e puxar o e-mail depois se precisar.
// Guardado via src/db (Redis na Vercel, arquivo local no npm start).

const crypto = require('crypto');
const db = require('./db');

const CHAVE_DB = 'closers';

async function ler() {
  const j = await db.getJson(CHAVE_DB, { closers: [] });
  const lista = Array.isArray(j && j.closers) ? j.closers : [];
  return { closers: lista };
}

async function listar() {
  return (await ler()).closers;
}

async function criar(nome, email) {
  const limpo = String(nome || '').trim();
  if (!limpo) throw new Error('Informe o nome do closer.');
  const emailLimpo = String(email || '').trim().toLowerCase();
  const dados = await ler();
  if (dados.closers.some((c) => c.nome.toLowerCase() === limpo.toLowerCase())) {
    throw new Error('Já existe um closer com esse nome.');
  }
  const closer = {
    id: crypto.randomBytes(6).toString('hex'),
    nome: limpo,
    email: emailLimpo,
    criadoEm: new Date().toISOString(),
  };
  dados.closers.push(closer);
  await db.setJson(CHAVE_DB, dados);
  return closer;
}

async function remover(id) {
  const dados = await ler();
  const antes = dados.closers.length;
  dados.closers = dados.closers.filter((c) => c.id !== id);
  await db.setJson(CHAVE_DB, dados);
  return dados.closers.length < antes;
}

async function porId(id) {
  if (!id) return null;
  return (await ler()).closers.find((c) => c.id === id) || null;
}

const MAX_INTELIGENCIA = 8000;
const MAX_APELIDO = 20;

/** Como o botão chama o closer ("Esse lead é bom para o PH?"): o apelido ou o primeiro nome. */
const apelidoDe = (c) => (c && (c.apelido || String(c.nome || '').trim().split(/\s+/)[0])) || '';

/**
 * Inteligência do closer: o que as calls dele ensinaram (com que tipo de lead fecha, como conduz,
 * onde trava). É texto destilado, sem nome nem dado de lead — é o que alimenta a análise de
 * afinidade (src/afinidade.js). Texto vazio desliga a análise para este closer.
 */
async function definirInteligencia(id, { apelido, inteligencia } = {}) {
  const dados = await ler();
  const c = dados.closers.find((x) => x.id === id);
  if (!c) return null;
  if (apelido !== undefined) c.apelido = String(apelido || '').replace(/\s+/g, ' ').trim().slice(0, MAX_APELIDO);
  if (inteligencia !== undefined) {
    c.inteligencia = String(inteligencia || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_INTELIGENCIA);
    c.inteligenciaEm = c.inteligencia ? new Date().toISOString() : '';
  }
  await db.setJson(CHAVE_DB, dados);
  return c;
}

/** Closers com análise de afinidade disponível (só id, nome e apelido — a inteligência não sai daqui). */
async function comAnalise() {
  return (await listar()).filter((c) => c.inteligencia).map((c) => ({ id: c.id, nome: c.nome, apelido: apelidoDe(c) }));
}

module.exports = { listar, criar, remover, porId, definirInteligencia, comAnalise, apelidoDe, MAX_INTELIGENCIA };
