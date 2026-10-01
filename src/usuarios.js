'use strict';

// Cadastro dos acessos da equipe (sem e-mail: o admin cria pelo nome e entrega a chave).
// Guardado via src/db (Redis na Vercel, arquivo local no npm start).

const crypto = require('crypto');
const db = require('./db');

const CHAVE_DB = 'usuarios';

// Papéis: sdr (gera report), admin (vê tudo) e gestor (tudo do admin + o .zip do dia de todos os
// SDRs na aba "Reports do dia"). Quem já existia antes dos papéis entra como sdr — nunca como admin.
const PAPEIS = ['sdr', 'gestor', 'master'];
// O antigo "admin" deixou de existir: vira gestor (vê tudo, não mexe em usuários) — nunca master
// automaticamente. O master se define entrando com a ADMIN_PASSWORD e trocando o papel na aba Acessos.
const papelValido = (p) => (p === 'admin' ? 'gestor' : PAPEIS.includes(p) ? p : 'sdr');
// fichaCrm: a ficha do lead (RD) e o resumo rápido aparecem para esta pessoa? Ligado por padrão;
// o master desliga para quem não prospecta (ex.: gestor).
// coach: o botão "Coach da conversa" (IA gratuita que sugere abordagem, objeções e perguntas). Por padrão só
// o master vê; ele liga para quem quiser na aba Acessos (e a escolha dele é respeitada).
const normalizar = (u) => {
  const papel = papelValido(u.papel);
  return {
    ...u,
    papel,
    fichaCrm: typeof u.fichaCrm === 'boolean' ? u.fichaCrm : true,
    coach: typeof u.coach === 'boolean' ? u.coach : papel === 'master',
  };
};
/** Master e gestor veem e fazem tudo; só o master cria, edita e remove usuários. */
const ehAdmin = (u) => Boolean(u && (u.papel === 'master' || u.papel === 'gestor'));
const ehMaster = (u) => Boolean(u && u.papel === 'master');

async function ler() {
  const j = await db.getJson(CHAVE_DB, { usuarios: [] });
  const lista = Array.isArray(j && j.usuarios) ? j.usuarios : [];
  const usuarios = lista.map(normalizar);
  // Sem nenhum master (logo depois de o "admin" deixar de existir), o dono da ferramenta é promovido
  // uma única vez, pelo nome (MASTER_NOME, padrão "Cauã Lima"). Depois disso a escolha fica gravada e
  // só o master muda papéis.
  if (usuarios.length && !usuarios.some((u) => u.papel === 'master')) {
    const alvo = semAcento(process.env.MASTER_NOME || 'Cauã Lima');
    const dono = usuarios.find((u) => semAcento(u.nome) === alvo);
    if (dono) {
      dono.papel = 'master';
      await db.setJson(CHAVE_DB, { ...j, usuarios });
    }
  }
  return { usuarios };
}

const semAcento = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

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
    papel: papelValido(papel),
    chave: 'pnx_' + crypto.randomBytes(18).toString('base64url'),
    criadoEm: new Date().toISOString(),
  };
  dados.usuarios.push(usuario);
  await db.setJson(CHAVE_DB, dados);
  return usuario;
}

/** Troca o papel de um usuário. Nunca deixa o sistema sem nenhum master. */
async function definirPapel(id, papel) {
  if (!PAPEIS.includes(papel)) throw new Error('Papel inválido (use master, gestor ou sdr).');
  const dados = await ler();
  const u = dados.usuarios.find((x) => x.id === id);
  if (!u) return false;
  if (u.papel === 'master' && papel !== 'master' && dados.usuarios.filter((x) => x.papel === 'master').length <= 1) {
    throw new Error('Este é o único master: promova outro antes de mudar o papel dele.');
  }
  u.papel = papel;
  await db.setJson(CHAVE_DB, dados);
  return true;
}

/** Liga/desliga a ficha do lead (RD) e o resumo rápido para um usuário. */
async function definirFichaCrm(id, ligada) {
  const dados = await ler();
  const u = dados.usuarios.find((x) => x.id === id);
  if (!u) return false;
  u.fichaCrm = Boolean(ligada);
  await db.setJson(CHAVE_DB, dados);
  return true;
}

/** Liga/desliga o coach da conversa para um usuário. */
async function definirCoach(id, ligado) {
  const dados = await ler();
  const u = dados.usuarios.find((x) => x.id === id);
  if (!u) return false;
  u.coach = Boolean(ligado);
  await db.setJson(CHAVE_DB, dados);
  return true;
}

async function remover(id) {
  const dados = await ler();
  const alvo = dados.usuarios.find((u) => u.id === id);
  if (alvo && alvo.papel === 'master' && dados.usuarios.filter((x) => x.papel === 'master').length <= 1) {
    throw new Error('Não dá para remover o único master.');
  }
  const antes = dados.usuarios.length;
  dados.usuarios = dados.usuarios.filter((u) => u.id !== id);
  await db.setJson(CHAVE_DB, dados);
  return dados.usuarios.length < antes;
}

async function porChave(chave) {
  if (!chave) return null;
  return (await ler()).usuarios.find((u) => u.chave === chave) || null;
}

module.exports = { listar, criar, remover, definirPapel, definirFichaCrm, definirCoach, porChave, ehAdmin, ehMaster, PAPEIS };
