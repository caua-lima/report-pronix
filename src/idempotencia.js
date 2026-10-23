'use strict';

const crypto = require('crypto');

/**
 * Chave estável de uma geração de report: a MESMA conversa normalizada + a
 * mesma versão de prompt + o mesmo modo de qualidade sempre produzem a mesma
 * chave. Usada para não cobrar a IA duas vezes pela mesma conversa sem
 * intenção explícita do usuário (ver /api/report-direto e /api/report-texto
 * em server.js — checam a chave antes de gerar, e um "forcarNovo" no pedido
 * pula a checagem).
 */
function calcularReportKey({ historicoNormalizado, promptVersao, qualidade, contato }) {
  // O lead entra na chave: o mesmo roteiro mandado a dois leads (e respostas iguais) não pode dar "report igual".
  const lead = String(contato || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const base =
    (lead ? lead + '|' : '') +
    JSON.stringify(historicoNormalizado || []) +
    '|' +
    (promptVersao || '') +
    '|' +
    (qualidade || 'standard');
  return crypto.createHash('sha256').update(base).digest('hex');
}

module.exports = { calcularReportKey };
