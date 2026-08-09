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
function calcularReportKey({ historicoNormalizado, promptVersao, qualidade }) {
  const base =
    JSON.stringify(historicoNormalizado || []) +
    '|' +
    (promptVersao || '') +
    '|' +
    (qualidade || 'standard');
  return crypto.createHash('sha256').update(base).digest('hex');
}

module.exports = { calcularReportKey };
