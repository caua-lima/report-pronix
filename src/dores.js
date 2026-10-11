'use strict';

// Termômetro de dores: as dores que o LEAD demonstrou na conversa, cada uma com a intensidade de
// 1 a 5 e a prova (o que ele disse ou contou). A dor é o motivo da compra — por isso o termômetro
// vai no topo do report. E, como o report é uma VENDA do lead para o closer, só aparece dor de
// fato: de "incomoda" (3) para cima. Dor citada de passagem ou só deduzida fica fora do PDF.

const MAX_DORES = 3;
const NIVEL_MINIMO_VISIVEL = 3;
const ROTULOS = { 5: 'Dói agora', 4: 'Dói muito', 3: 'Incomoda', 2: 'Citou de passagem', 1: 'Só deduzida' };

/**
 * Lista vinda da IA ou da tela de edição -> formato limpo: no máximo 3, da mais forte para a mais
 * fraca, intensidade inteira de 1 a 5. Item sem dor escrita ou sem intensidade válida é descartado.
 */
function normalizarDores(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((d) => {
      if (!d || typeof d !== 'object') return null;
      const dor = typeof d.dor === 'string' ? d.dor.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      const n = Math.round(Number(d.intensidade));
      if (!dor || !Number.isFinite(n)) return null;
      const porque = typeof d.porque === 'string' ? d.porque.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      return { dor, intensidade: Math.max(1, Math.min(5, n)), porque };
    })
    .filter(Boolean)
    .sort((a, b) => b.intensidade - a.intensidade)
    .slice(0, MAX_DORES);
}

/** As dores que vão para o report: só as de fato (intensidade 3 ou mais). */
const doresVisiveis = (v) => normalizarDores(v).filter((d) => d.intensidade >= NIVEL_MINIMO_VISIVEL);
const rotuloDaIntensidade = (n) => ROTULOS[n] || '';

module.exports = { normalizarDores, doresVisiveis, rotuloDaIntensidade, MAX_DORES, NIVEL_MINIMO_VISIVEL, ROTULOS };
