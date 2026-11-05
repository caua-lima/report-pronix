'use strict';

// Confere, sem IA, se as citações do report são falas reais do lead. Uma "fala
// do lead" que ele nunca disse é o pior erro possível num handoff: o closer cita
// na reunião algo que o lead não falou.
//
// Citação é LITERAL: depois de tirar acento, pontuação e caixa, ela tem de aparecer
// como trecho CONTÍNUO de uma fala do lead (ou de duas falas seguidas, que o modelo às
// vezes junta). A única folga é o "..." da IA: cada pedaço entre reticências tem de ser
// contínuo, na ordem, na mesma fala — e o que foi pulado não pode ter negação, número
// nem condição ("não", "sem", "se", "só"). Antes valia 80% das palavras na ordem, e
// "Eu tenho dinheiro para investir agora" passava diante de "Eu NÃO tenho dinheiro...".

/** Minúsculo, sem acento e sem pontuação: só letras/números separados por espaço. */
const norm = (s) =>
  String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Palavras que mudam o sentido do que vem em volta: não podem sumir num corte "...". */
const MUDA_SENTIDO = new Set(['nao', 'nunca', 'nem', 'jamais', 'sem', 'ninguem', 'nenhum', 'nenhuma', 'nada', 'se', 'so', 'somente', 'apenas', 'talvez', 'caso']);
const MAX_PALAVRAS_PULADAS = 25;

/** Pedaços da citação separados pelas reticências da IA. */
const pedacos = (citacao) => String(citacao).split(/\.{3,}|…/).map(norm).filter(Boolean);

/** true se os pedaços aparecem, contínuos e na ordem, na janela, sem pular nada que mude o sentido. */
function cabeNaJanela(partes, janela) {
  const fonte = ` ${janela} `;
  let desde = 0;
  for (let i = 0; i < partes.length; i++) {
    const achou = fonte.indexOf(` ${partes[i]} `, desde);
    if (achou === -1) return false;
    if (i > 0) {
      const pulado = fonte.slice(desde, achou).trim().split(' ').filter(Boolean);
      if (pulado.length > MAX_PALAVRAS_PULADAS) return false;
      if (pulado.some((p) => MUDA_SENTIDO.has(p) || /\d/.test(p))) return false;
    }
    desde = achou + partes[i].length + 1;
  }
  return true;
}

/**
 * @param {string[]} citacoes citações devolvidas pela IA
 * @param {string[]} falas    falas do lead (uma por mensagem; no modo manual, as linhas atribuídas ao lead)
 * @returns {{mantidas: string[], removidas: string[]}}
 */
function verificarCitacoes(citacoes, falas) {
  const fontes = (Array.isArray(falas) ? falas : []).map(norm).filter(Boolean);
  // Janelas de comparação: cada fala e cada par de falas seguidas (o modelo às vezes junta duas).
  const janelas = [];
  fontes.forEach((f, i) => {
    janelas.push(f);
    if (i + 1 < fontes.length) janelas.push(f + ' ' + fontes[i + 1]);
  });

  const mantidas = [];
  const removidas = [];
  for (const original of Array.isArray(citacoes) ? citacoes : []) {
    const partes = typeof original === 'string' ? pedacos(original) : [];
    if (partes.length && janelas.some((j) => cabeNaJanela(partes, j))) mantidas.push(original);
    else removidas.push(original);
  }
  return { mantidas, removidas };
}

// Quem fala em cada linha do texto colado (modo manual): "Nome: texto", "[14:32, 04/11] Nome: texto", "VENDEDOR: texto".
const LINHA_COM_AUTOR = /^\s*(?:\[[^\]]{1,40}\]\s*)?(?:\d{1,2}[:h]\d{2}\s*[-–]?\s*)?([^:\n]{1,40}?)\s*(?:\((?:a|á)udio[^)]*\))?\s*:\s*(.*)$/i;
const AUTOR_VENDEDOR = /^(vendedor|vendedora|sdr|eu|pre[- ]?vendedor|atendente|consultor|consultora)$/i;

/**
 * Falas do lead no texto colado. Linhas com autor do lado do vendedor (o nome do SDR, "Eu", "VENDEDOR") saem;
 * sem nenhuma linha com autor reconhecível, não dá para saber quem falou e vale o texto todo (como antes).
 */
function falasDoLeadNoTexto(texto, sdr) {
  const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const primeiroSdr = norm(String(sdr || '').split(/\s+/)[0] || '');
  const ehVendedor = (autor) => {
    const a = norm(autor);
    return AUTOR_VENDEDOR.test(a) || (primeiroSdr && (a === primeiroSdr || a.startsWith(primeiroSdr + ' ')));
  };
  let comAutor = 0;
  const doLead = [];
  for (const l of linhas) {
    const m = LINHA_COM_AUTOR.exec(l);
    if (m && m[1] && !/^https?$/i.test(m[1].trim())) {
      comAutor++;
      if (!ehVendedor(m[1])) doLead.push(m[2]);
    } else doLead.push(l);
  }
  return comAutor ? doLead : linhas;
}

/** Impede que a conversa (ou a leitura do SDR) "feche" as marcas <conversa>/<leitura_sdr> e injete instruções fora delas. */
function neutralizarMarcas(texto) {
  return String(texto == null ? '' : texto).replace(/<\s*\/?\s*conversa\s*>/gi, '[conversa]').replace(/<\s*\/?\s*leitura_sdr\s*>/gi, '[leitura_sdr]');
}

// "Nas palavras do lead" é a vitrine: fala que EMPURRA a decisão para trás não entra (preço caro, "vou
// pensar", desconfiança, falta de dinheiro para pagar, hesitação sobre o momento). DOR NÃO É OBJEÇÃO:
// "estou cansado de depender de indicação", "não deu certo sozinho", "as vendas caíram" costumam ser o melhor
// motivo de compra e ficam. O fato que muda a condução (verba, decisor, receio) continua no panorama e no plano
// da reunião; aqui só se decide o que vai para a vitrine. "cara" (gíria) e "não" sozinho NÃO contam.
const DESANIMA = new RegExp(
  [
    '\\bcaros?\\b', 'muito car[oa]', '(t[aá]|achei|meio|bem) car[oa]', 'car[ií]ssim', 'salgad',
    'vou pensar', 'preciso pensar', 'deixa eu pensar', 'vou ver', 'depois eu vejo', 'mais pra frente', 'agora n[aã]o',
    'n[aã]o sei se', 'd[uú]vidas?\\b', 'duvido',
    '(medo|receio) de (perder|investir|gastar|pagar|cair)', 'golpe', 'engan', 'n[aã]o confio', 'desconfi',
    'n[aã]o tenho (dinheiro|grana|condi)', 'sem (dinheiro|grana|condi)', 'n[aã]o (consigo|posso|d[aá] (pra|para)) (pagar|investir)',
  ].join('|'),
  'i'
);

/** true = fala que pode desanimar o closer (fica fora do report). */
const citacaoDesanimadora = (texto) => DESANIMA.test(String(texto || ''));

module.exports = { verificarCitacoes, neutralizarMarcas, norm, citacaoDesanimadora, falasDoLeadNoTexto };
