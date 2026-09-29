'use strict';

// Nível de consciência do lead (escala de Eugene Schwartz), classificado pela IA só com o que o
// lead disse/demonstrou na conversa. O report é uma VENDA do lead para o closer: o selo só
// aparece quando o lead está de "consciente da solução" para cima — abaixo disso fica fora do
// PDF (um "nível 1 de 5" desanima o closer e não ajuda a conduzir a call).

const NIVEIS = [
  { chave: 'inconsciente', numero: 1, rotulo: 'Inconsciente do problema' },
  { chave: 'problema', numero: 2, rotulo: 'Consciente do problema' },
  { chave: 'solucao', numero: 3, rotulo: 'Consciente da solução' },
  { chave: 'produto', numero: 4, rotulo: 'Consciente da nossa entrega' },
  { chave: 'pronto', numero: 5, rotulo: 'Pronto para decidir' },
];
const NIVEL_MINIMO_VISIVEL = 3;

/** "Solução", "SOLUCAO", "solucao" -> 'solucao'. Qualquer outra coisa -> null. */
function chaveDoNivel(v) {
  const k = String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  return NIVEIS.some((n) => n.chave === k) ? k : null;
}

/** { nivel, porque } vindo da IA ou da tela de edição -> formato limpo, ou null se inválido. */
function normalizarConsciencia(c) {
  if (!c || typeof c !== 'object') return null;
  const nivel = chaveDoNivel(c.nivel);
  if (!nivel) return null;
  const porque = typeof c.porque === 'string' ? c.porque.trim().slice(0, 400) : '';
  return { nivel, porque };
}

const infoDoNivel = (c) => (c && NIVEIS.find((n) => n.chave === c.nivel)) || null;

/** Só aparece no report quando é bom (de "consciente da solução" para cima). */
const mostrarConsciencia = (c) => {
  const info = infoDoNivel(c);
  return Boolean(info && info.numero >= NIVEL_MINIMO_VISIVEL);
};

module.exports = { NIVEIS, NIVEL_MINIMO_VISIVEL, chaveDoNivel, normalizarConsciencia, infoDoNivel, mostrarConsciencia };
