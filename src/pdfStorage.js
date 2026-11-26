'use strict';

// Guarda o PDF de cada report gerado, pra dar pra baixar depois (individual ou
// em massa). Chave PRÓPRIA (pdf_<id>), separada da lista de metadados em
// src/stats.js — se o PDF morasse dentro do registro de stats, cada vez que o
// dashboard abrisse a aba "Reports gerados" (que lê a lista inteira) baixaria
// todos os PDFs à toa. Usa db.getJson/setJson que já existem — sem primitivo novo.

const db = require('./db');

const chave = (id) => `pdf_${id}`;

// Os PDFs ficam guardados por mês: os de um mês somem sozinhos no fim do dia 5 do mês seguinte (horário de São
// Paulo). Um PDF tem uns 8 KB (11 KB no banco): mil por mês dão cerca de 11 MB, longe do limite do plano grátis.
const DIA_DA_LIMPEZA = 5;

/** Quando o PDF de um report gerado em `quando` deve sumir: 00:00 do dia 6 do mês seguinte, em São Paulo (UTC-3). */
function expiraEm(quando = new Date()) {
  const sp = new Date(new Date(quando).getTime() - 3 * 3600 * 1000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth() + 1, DIA_DA_LIMPEZA + 1, 3));
}

/** Salva o PDF (base64) de um report pelo id, com o prazo do mês dele. */
async function salvar(id, base64, arquivo, quando = new Date()) {
  if (!id) return false;
  const ate = expiraEm(quando).getTime();
  const ttl = Math.floor((ate - Date.now()) / 1000);
  if (ttl <= 0) return false; // o prazo do mês dele já passou
  await db.setJsonComPrazo(chave(id), { base64, arquivo: arquivo || '', expira: ate }, ttl);
  return true;
}

/** Lê o PDF salvo (base64 + nome do arquivo) ou null se não existir ou já tiver vencido. */
async function ler(id) {
  if (!id) return null;
  const g = await db.getJson(chave(id), null);
  return g && !(g.expira && g.expira <= Date.now()) ? g : null;
}

/** Remove o PDF salvo (ex.: quando o report é removido do histórico). */
async function remover(id) {
  if (!id) return;
  await db.apagar(chave(id));
}

module.exports = { salvar, ler, remover, expiraEm };
