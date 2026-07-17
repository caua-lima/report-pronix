'use strict';

// Histórico de reports gerados (alimenta a aba "Reports gerados" do dashboard).

const crypto = require('crypto');
const db = require('./db');

const CHAVE_DB = 'reports';
const LIMITE = 5000;

/** Registra um report gerado. */
async function registrar({ usuarioId, usuarioNome, lead, origem }) {
  await db.push(
    CHAVE_DB,
    {
      id: crypto.randomBytes(5).toString('hex'),
      usuarioId: usuarioId || '',
      usuarioNome: usuarioNome || '',
      lead: lead || '',
      origem: origem || 'extensao', // extensao | manual
      quando: new Date().toISOString(),
    },
    LIMITE
  );
}

const dia = (iso) => String(iso || '').slice(0, 10);

/** Resumo para o dashboard: totais, por usuário e os últimos gerados. */
async function resumo() {
  const reports = await db.range(CHAVE_DB);
  const hoje = new Date().toISOString().slice(0, 10);
  const seteDiasAtras = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);

  const porUsuario = new Map();
  reports.forEach((r) => {
    const nome = r.usuarioNome || '—';
    const u = porUsuario.get(nome) || { nome, total: 0, hoje: 0 };
    u.total++;
    if (dia(r.quando) === hoje) u.hoje++;
    porUsuario.set(nome, u);
  });

  return {
    total: reports.length,
    hoje: reports.filter((r) => dia(r.quando) === hoje).length,
    semana: reports.filter((r) => dia(r.quando) >= seteDiasAtras).length,
    porUsuario: [...porUsuario.values()].sort((a, b) => b.total - a.total),
    ultimos: reports.slice(-30).reverse(),
  };
}

module.exports = { registrar, resumo };
