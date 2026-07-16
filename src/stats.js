'use strict';

// Histórico de reports gerados (para o dashboard).
// Interface pensada para trocar o armazenamento (arquivo -> banco) sem mexer no resto.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARQ = path.join(DATA_DIR, 'reports.json');
const LIMITE = 5000;

function ler() {
  try {
    const j = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    return Array.isArray(j.reports) ? j : { reports: [] };
  } catch (_) {
    return { reports: [] };
  }
}

function salvar(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ARQ, JSON.stringify(db, null, 2), 'utf8');
}

/** Registra um report gerado. */
function registrar({ usuarioId, usuarioNome, lead, origem }) {
  const db = ler();
  db.reports.push({
    id: crypto.randomBytes(5).toString('hex'),
    usuarioId: usuarioId || '',
    usuarioNome: usuarioNome || '',
    lead: lead || '',
    origem: origem || 'extensao', // extensao | manual
    quando: new Date().toISOString(),
  });
  if (db.reports.length > LIMITE) db.reports = db.reports.slice(-LIMITE);
  salvar(db);
}

const dia = (iso) => String(iso || '').slice(0, 10);

/** Resumo para o dashboard: totais, por usuário e os últimos gerados. */
function resumo() {
  const reports = ler().reports;
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
