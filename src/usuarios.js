'use strict';

// Cadastro simples de usuários (equipe de pré-vendas).
// O admin cria os usuários e entrega a chave; cada SDR cola a chave na extensão.
// Guardado em data/usuarios.json — cada usuário tem sua pasta em data/usuarios/<id>/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARQ = path.join(DATA_DIR, 'usuarios.json');

function ler() {
  try {
    const j = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    return Array.isArray(j.usuarios) ? j : { usuarios: [] };
  } catch (_) {
    return { usuarios: [] };
  }
}

function salvar(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ARQ, JSON.stringify(db, null, 2), 'utf8');
}

function listar() {
  return ler().usuarios;
}

function criar(nome) {
  const limpo = String(nome || '').trim();
  if (!limpo) throw new Error('Informe o nome do SDR.');
  const db = ler();
  if (db.usuarios.some((u) => u.nome.toLowerCase() === limpo.toLowerCase())) {
    throw new Error('Já existe um usuário com esse nome.');
  }
  const usuario = {
    id: crypto.randomBytes(6).toString('hex'),
    nome: limpo,
    chave: 'pnx_' + crypto.randomBytes(18).toString('base64url'),
    criadoEm: new Date().toISOString(),
  };
  db.usuarios.push(usuario);
  salvar(db);
  return usuario;
}

function remover(id) {
  const db = ler();
  const antes = db.usuarios.length;
  db.usuarios = db.usuarios.filter((u) => u.id !== id);
  salvar(db);
  // limpa os dados (voz/contadores) do usuário removido
  try {
    fs.rmSync(path.join(DATA_DIR, 'usuarios', id), { recursive: true, force: true });
  } catch (_) {
    /* ok */
  }
  return db.usuarios.length < antes;
}

function porChave(chave) {
  if (!chave) return null;
  return ler().usuarios.find((u) => u.chave === chave) || null;
}

/** Pasta de dados do usuário (voz, contadores do dia). */
function dirUsuario(id) {
  const d = path.join(DATA_DIR, 'usuarios', String(id));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = { listar, criar, remover, porChave, dirUsuario };
