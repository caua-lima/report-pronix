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

module.exports = { listar, criar, remover, porId };
