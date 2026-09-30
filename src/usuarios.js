'use strict';

// Cadastro dos acessos da equipe (sem e-mail: o admin cria pelo nome e entrega a chave).
// Guardado via src/db (Redis na Vercel, arquivo local no npm start).

const crypto = require('crypto');
const db = require('./db');

const CHAVE_DB = 'usuarios';

// Quem já existia antes dos papéis entra como sdr — nunca como admin.
// fichaCrm: quem vê a ficha do RD Station no WhatsApp (e o resumo rápido). Liberado para todos;
// o admin pode desligar para alguém na aba Acessos (aí fica false, e essa escolha é respeitada).
const normalizar = (u) => {
  const papel = u.papel === 'admin' ? 'admin' : 'sdr';
  return { ...u, papel, fichaCrm: typeof u.fichaCrm === 'boolean' ? u.fichaCrm : true };
};

async function ler() {
  const j = await db.getJson(CHAVE_DB, { usuarios: [] });
  const lista = Array.isArray(j && j.usuarios) ? j.usuarios : [];
  return { usuarios: lista.map(normalizar) };
}

async function listar() {
  return (await ler()).usuarios;
}

async function criar(nome, papel) {
  const limpo = String(nome || '').trim();
  if (!limpo) throw new Error('Informe o nome do SDR.');
  const dados = await ler();
  if (dados.usuarios.some((u) => u.nome.toLowerCase() === limpo.toLowerCase())) {
    throw new Error('Já existe um usuário com esse nome.');
  }
  const usuario = {
    id: crypto.randomBytes(6).toString('hex'),
    nome: limpo,
    papel: papel === 'admin' ? 'admin' : 'sdr',
    chave: 'pnx_' + crypto.randomBytes(18).toString('base64url'),
    criadoEm: new Date().toISOString(),
  };
  dados.usuarios.push(usuario);
  await db.setJson(CHAVE_DB, dados);
  return usuario;
}

async function remover(id) {
  const dados = await ler();
  const antes = dados.usuarios.length;
  dados.usuarios = dados.usuarios.filter((u) => u.id !== id);
  await db.setJson(CHAVE_DB, dados);
  return dados.usuarios.length < antes;
}

/** Liga/desliga a ficha do RD Station para um usuário. */
async function definirFichaCrm(id, ligada) {
  const dados = await ler();
  const u = dados.usuarios.find((x) => x.id === id);
  if (!u) return false;
  u.fichaCrm = Boolean(ligada);
  await db.setJson(CHAVE_DB, dados);
  return true;
}

async function porChave(chave) {
  if (!chave) return null;
  return (await ler()).usuarios.find((u) => u.chave === chave) || null;
}

module.exports = { listar, criar, remover, porChave, definirFichaCrm };
