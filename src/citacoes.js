'use strict';

// Confere, sem IA, se as citações do report são falas reais do lead. Uma "fala
// do lead" que ele nunca disse é o pior erro possível num handoff: o closer cita
// na reunião algo que o lead não falou.
//
// A regra é propositalmente generosa para não jogar fora citação boa (o modelo
// pode tirar pontuação, juntar duas frases da mesma mensagem ou usar "..."):
//   1) a citação (sem acento/pontuação/caixa) aparece inteira nas falas do lead; ou
//   2) pelo menos 80% das palavras dela aparecem, NA MESMA ORDEM, numa única fala
//      (ou em duas falas seguidas) — só para citações com 4 palavras ou mais — e
//      todo número da citação aparece na fala (trocar "100 mil" por "200 mil" é
//      exatamente o erro que isto existe para pegar).
// Citação curta (1 a 3 palavras) só vale se aparecer inteira.

/** Minúsculo, sem acento e sem pontuação: só letras/números separados por espaço. */
const norm = (s) =>
  String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const LIMIAR_PALAVRAS = 0.8;

const temDigito = (t) => /\d/.test(t);

/** Tamanho da maior subsequência comum entre duas listas de palavras (ordem preservada). */
function subsequenciaComum(a, b) {
  let anterior = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const atual = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      atual[j] = a[i - 1] === b[j - 1] ? anterior[j - 1] + 1 : Math.max(anterior[j], atual[j - 1]);
    }
    anterior = atual;
  }
  return anterior[b.length];
}

/**
 * @param {string[]} citacoes citações devolvidas pela IA
 * @param {string[]} falas    falas do lead (uma por mensagem; no modo manual, as linhas do texto)
 * @returns {{mantidas: string[], removidas: string[]}}
 */
function verificarCitacoes(citacoes, falas) {
  const fontes = (Array.isArray(falas) ? falas : []).map(norm).filter(Boolean);
  const todas = ` ${fontes.join(' ')} `;
  // Janelas de comparação: cada fala e cada par de falas seguidas (o modelo às vezes junta duas).
  const janelas = [];
  fontes.forEach((f, i) => {
    janelas.push(f.split(' '));
    if (i + 1 < fontes.length) janelas.push((f + ' ' + fontes[i + 1]).split(' '));
  });

  const mantidas = [];
  const removidas = [];
  for (const original of Array.isArray(citacoes) ? citacoes : []) {
    const q = norm(original);
    if (!q) {
      removidas.push(original);
      continue;
    }
    if (todas.includes(` ${q} `)) {
      mantidas.push(original);
      continue;
    }
    const palavras = q.split(' ');
    if (palavras.length >= 4) {
      const numeros = palavras.filter(temDigito);
      const melhor = janelas.reduce((m, j) => {
        const conjunto = new Set(j);
        if (!numeros.every((n) => conjunto.has(n))) return m; // número que a fala não tem: reprova
        return Math.max(m, subsequenciaComum(palavras, j) / palavras.length);
      }, 0);
      if (melhor >= LIMIAR_PALAVRAS) {
        mantidas.push(original);
        continue;
      }
    }
    removidas.push(original);
  }
  return { mantidas, removidas };
}

/** Impede que a conversa "feche" a marca <conversa> e injete instruções fora dela. */
function neutralizarMarcas(texto) {
  return String(texto == null ? '' : texto).replace(/<\s*\/?\s*conversa\s*>/gi, '[conversa]');
}

module.exports = { verificarCitacoes, neutralizarMarcas, norm };
