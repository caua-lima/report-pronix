'use strict';

// Preço dos modelos, em dólar por milhão de tokens (tabela oficial da Anthropic).
// Se trocar de modelo no .env, acrescente a linha dele aqui — sem isso o custo sai zerado.

const TABELA = {
  'claude-sonnet-5': {
    entrada: 3,
    saida: 15,
    // Preço promocional de lançamento; depois desta data volta ao cheio sozinho.
    promo: { ate: '2026-08-31', entrada: 2, saida: 10 },
  },
  'claude-sonnet-4-6': { entrada: 3, saida: 15 },
  'claude-opus-4-8': { entrada: 5, saida: 25 },
  'claude-opus-4-7': { entrada: 5, saida: 25 },
  'claude-haiku-4-5': { entrada: 1, saida: 5 },
  'claude-fable-5': { entrada: 10, saida: 50 },
};

/** Preço vigente do modelo na data informada (aplica a promoção enquanto ela valer). */
function precoDe(modelo, quando) {
  const p = TABELA[modelo];
  if (!p) return null;
  const dia = String(quando || new Date().toISOString()).slice(0, 10);
  if (p.promo && dia <= p.promo.ate) {
    return { entrada: p.promo.entrada, saida: p.promo.saida, promo: true };
  }
  return { entrada: p.entrada, saida: p.saida, promo: false };
}

/**
 * Custo de uma chamada, em dólares. Considera o cache de prompt:
 * leitura de cache custa 0,1x o preço de entrada; escrita, 1,25x.
 * Modelo desconhecido (ou Ollama, que roda local) custa zero.
 */
function custoUSD({ modelo, entrada, saida, cacheLeitura, cacheEscrita, quando } = {}) {
  const p = precoDe(modelo, quando);
  if (!p) return 0;
  return (
    ((entrada || 0) / 1e6) * p.entrada +
    ((cacheLeitura || 0) / 1e6) * p.entrada * 0.1 +
    ((cacheEscrita || 0) / 1e6) * p.entrada * 1.25 +
    ((saida || 0) / 1e6) * p.saida
  );
}

module.exports = { custoUSD, precoDe, TABELA };
