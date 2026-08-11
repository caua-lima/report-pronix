'use strict';

// Guarda o PDF de cada report gerado, pra dar pra baixar depois (individual ou
// em massa). Chave PRÓPRIA (pdf_<id>), separada da lista de metadados em
// src/stats.js — se o PDF morasse dentro do registro de stats, cada vez que o
// dashboard abrisse a aba "Reports gerados" (que lê a lista inteira) baixaria
// todos os PDFs à toa. Usa db.getJson/setJson que já existem — sem primitivo novo.

const db = require('./db');

const chave = (id) => `pdf_${id}`;

/** Salva o PDF (base64) de um report pelo id. */
async function salvar(id, base64, arquivo) {
  if (!id) return;
  await db.setJson(chave(id), { base64, arquivo: arquivo || '' });
}

/** Lê o PDF salvo (base64 + nome do arquivo) ou null se não existir. */
async function ler(id) {
  if (!id) return null;
  return db.getJson(chave(id), null);
}

/** Remove o PDF salvo (ex.: quando o report é removido do histórico). */
async function remover(id) {
  if (!id) return;
  await db.setJson(chave(id), null);
}

module.exports = { salvar, ler, remover };
