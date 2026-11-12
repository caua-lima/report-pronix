'use strict';

// "Qual closer para este lead?" (só o master). Cruza o histórico do CRM — reuniões realizadas de cada closer, com o
// resultado (venda, perda, no-show) e o handoff que o lead levou — com o report de um lead novo, e indica os dois
// closers com mais chance de fechar, com a porcentagem e o porquê.
//
// Sem IA e sem custo: o perfil do lead é lido do texto do handoff/report por regras (estágio, capital, quem decide,
// motivação e perfil comportamental). A chance de cada closer é a taxa de venda dele com leads do mesmo perfil,
// puxada para a taxa geral dele quando há poucas reuniões (cada número vem com quantas reuniões o sustentam).
// A transcrição da call não entra: a API pública do Pronix CRM não a entrega (fica fora por decisão do CRM).
//
// Guardado: só closer, dia, resultado e o perfil — nada do texto nem nome do lead.

const db = require('./db');

const CHAVE_BASE = 'ic_base1';
const DIAS_BASE = 120;

const ROTULOS = {
  estagio: { titulo: 'Estágio', valores: { do_zero: 'começando do zero', ja_vende: 'já vende' } },
  capital: { titulo: 'Capital', valores: { ate_5k: 'até R$ 5 mil', de_5k_a_15k: 'R$ 5 a 15 mil', acima_15k: 'acima de R$ 15 mil' } },
  decisor: { titulo: 'Quem decide', valores: { sozinho: 'decide sozinho', conjuge: 'decide com o cônjuge', socio: 'decide com sócio', familia: 'decide com a família' } },
  motivo: { titulo: 'Motivação', valores: { sair_clt: 'sair do CLT', renda_extra: 'renda extra', escalar: 'escalar o que já vende', estoque: 'girar estoque parado' } },
  perfil: { titulo: 'Perfil', valores: { analitico: 'analítico', dominante: 'dominante', relacional: 'relacional', cauteloso: 'cauteloso', cetico: 'cético', entusiasta: 'entusiasta' } },
};
const CAMPOS = Object.keys(ROTULOS);

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Valores em reais mencionados numa linha ("R$ 5 mil", "5k", "R$ 15.000", "3 mil"). */
function valoresEmReais(texto) {
  const linha = String(texto || '').toLowerCase();
  const out = [];
  const re = /(?:r\$\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(mil|k)?\b/g;
  let m;
  while ((m = re.exec(linha))) {
    const temMoeda = /r\$/.test(linha.slice(Math.max(0, m.index - 4), m.index + 3));
    let v = /^\d{1,3}([.,]\d{3})+$/.test(m[1]) ? Number(m[1].replace(/[.,]/g, '')) : Number(m[1].replace(',', '.'));
    if (m[2]) v *= 1000;
    if (!m[2] && !temMoeda) continue; // número solto (dias, vendas, %) não é dinheiro
    if (v >= 300) out.push(v);
  }
  return out;
}

/**
 * O perfil do lead lido do texto do handoff/report. Cada campo: um valor de ROTULOS ou '' (não deu para saber).
 */
function caracteristicas(texto) {
  const t = norm(texto);
  const linhas = t.split(/\n+/);
  const c = { estagio: '', capital: '', decisor: '', motivo: '', perfil: '' };

  // Estágio: já vende (faturamento, loja, empresa, vendas no marketplace) x começando do zero.
  const jaVende = /\b(ja vende|ja vendo|ja faz vendas|(fatura|faturamento|faturo)[^.\n]{0,30}\d|vendas? por (mes|dia|semana)|loja (fisica|online|propria)|tem (uma |a )?(loja|empresa|distribuidora|fabrica)|cnpj|e-?commerce|vende (no|na|pelo|pela) (mercado livre|shopee|amazon|magalu|instagram|loja))/.test(t);
  const doZero = /\b(do zero|comecando|comecar agora|nunca vendeu|nunca vendi|ainda nao vende|nao vende (online|ainda)|iniciante|primeira venda|sem experiencia)/.test(t);
  c.estagio = jaVende ? 'ja_vende' : doZero ? 'do_zero' : '';

  // Capital: o maior valor numa linha de investimento/reserva (faturamento não é verba).
  const sobreVerba = linhas.filter((l) => /(invest|reserva|capital|separad|guardad|disponiv|verba|caixa|consegue|tem (uns|uma|cerca)|aporte|estoque inicial)/.test(l) && !/fatur/.test(l));
  const valores = sobreVerba.flatMap(valoresEmReais);
  if (valores.length) {
    const v = Math.max(...valores);
    c.capital = v <= 5000 ? 'ate_5k' : v <= 15000 ? 'de_5k_a_15k' : 'acima_15k';
  }

  // Quem decide: nas linhas que falam de decisão; "sozinho" vale em qualquer lugar.
  const sobreDecisao = linhas.filter((l) => /(decid|decis|decisor|aprova|consult|ver com|conversar com|junto com|participa)/.test(l)).join(' ');
  if (/(esposa|marido|mulher|conjuge|namorad[oa]|companheir[oa]|noiv[oa])/.test(sobreDecisao)) c.decisor = 'conjuge';
  else if (/\bsoci[oa]s?\b/.test(sobreDecisao)) c.decisor = 'socio';
  else if (/\b(pai|mae|irmao|irma|familia|filh[oa]s?)\b/.test(sobreDecisao)) c.decisor = 'familia';
  else if (/(decide sozinh|decido sozinh|sozinh[oa] (decide|na decisao)|ele mesmo decide|ela mesma decide|nao depende de ninguem|decisao (e )?(so )?dele|decisao (e )?(so )?dela)/.test(t)) c.decisor = 'sozinho';

  // Motivação.
  if (/\bclt\b|sair do emprego|carteira assinada|largar o emprego|deixar o emprego/.test(t)) c.motivo = 'sair_clt';
  else if (/estoque parado|girar (o )?estoque|escoar|giro lento/.test(t)) c.motivo = 'estoque';
  else if (/escalar|crescer as vendas|aumentar (as )?vendas|faturar mais|dobrar (as vendas|o faturamento)/.test(t)) c.motivo = 'escalar';
  else if (/renda extra|complementar a renda|segunda renda|renda a mais|outra fonte de renda/.test(t)) c.motivo = 'renda_extra';

  // Perfil comportamental: a linha "Perfil:" do report.
  const p = /perfil(?: do lead)?\s*[:\-–]\s*(analitico|dominante|relacional|cauteloso|cetico|entusiasta)/.exec(t);
  if (p) c.perfil = p[1];
  return c;
}

/** Monta a base a partir do levantamento das realizadas (src/handoffsRealizadas.js) e guarda (7 dias). */
async function salvarBase(levantamento) {
  const itens = (levantamento.reunioes || [])
    .filter((x) => x.closer && x.closer !== 'Sem closer')
    .map((x) => ({ closer: x.closer, dia: x.dia, resultado: x.resultado || 'aberto', temHandoff: Boolean(x.handoff), c: x.handoff ? caracteristicas(x.handoff) : null }));
  const base = { atualizadoEm: new Date().toISOString(), desde: levantamento.desde, ate: levantamento.ate, itens };
  await db.cacheSet(CHAVE_BASE, JSON.stringify(base), 7 * 86400).catch(() => {});
  return base;
}
async function lerBase() {
  const g = await db.cacheGet(CHAVE_BASE).catch(() => null);
  if (!g) return null;
  try {
    return JSON.parse(g);
  } catch (_) {
    return null;
  }
}

/** Reunião com resultado conhecido: venda (1) ou não-venda (0). Em aberto e no-show ficam fora da conta. */
const decidida = (x) => x.resultado === 'venda' || x.resultado === 'perda';

/** Resumo da base para a tela: por closer, reuniões decididas e vendas. */
function resumoDaBase(base) {
  const porCloser = new Map();
  (base.itens || []).forEach((x) => {
    const c = porCloser.get(x.closer) || { closer: x.closer, reunioes: 0, decididas: 0, vendas: 0 };
    c.reunioes++;
    if (decidida(x)) c.decididas++;
    if (x.resultado === 'venda') c.vendas++;
    porCloser.set(x.closer, c);
  });
  return [...porCloser.values()].sort((a, b) => b.decididas - a.decididas);
}

const PESO_GERAL = 5; // quantas reuniões "valem" a taxa do time ao estimar a taxa geral do closer
const PESO_PERFIL = 3; // idem, da taxa geral do closer ao estimar a taxa dele num perfil
const MINIMO_REUNIOES = 3;

/**
 * Indica os closers para um lead (as características dele) com a base do CRM.
 * @returns {{ranking: Array<{closer, chance, reunioes, vendas, porque: string[]}>, perfil, taxaDoTime}}
 */
function indicar(base, c) {
  const itens = (base.itens || []).filter(decidida);
  const vendasTime = itens.filter((x) => x.resultado === 'venda').length;
  const taxaTime = itens.length ? vendasTime / itens.length : 0;
  const closers = [...new Set(itens.map((x) => x.closer))];
  const conhecidos = CAMPOS.filter((k) => c && c[k]);
  const ranking = closers.map((closer) => {
    const dele = itens.filter((x) => x.closer === closer);
    const vendas = dele.filter((x) => x.resultado === 'venda').length;
    const taxaGeral = (vendas + PESO_GERAL * taxaTime) / (dele.length + PESO_GERAL);
    const porque = [];
    const taxas = conhecidos.map((k) => {
      const iguais = dele.filter((x) => x.c && x.c[k] === c[k]);
      const v = iguais.filter((x) => x.resultado === 'venda').length;
      if (iguais.length) porque.push(`${ROTULOS[k].titulo} — ${ROTULOS[k].valores[c[k]]}: ${v} venda(s) em ${iguais.length} reunião(ões)`);
      return (v + PESO_PERFIL * taxaGeral) / (iguais.length + PESO_PERFIL);
    });
    const chance = taxas.length ? (taxaGeral + taxas.reduce((s, x) => s + x, 0)) / (1 + taxas.length) : taxaGeral;
    porque.unshift(`No geral: ${vendas} venda(s) em ${dele.length} reunião(ões) decidida(s)`);
    return { closer, chance: Math.round(chance * 100), reunioes: dele.length, vendas, porque };
  })
    .filter((r) => r.reunioes >= MINIMO_REUNIOES)
    .sort((a, b) => b.chance - a.chance || b.reunioes - a.reunioes);
  const perfil = conhecidos.map((k) => ({ campo: ROTULOS[k].titulo, valor: ROTULOS[k].valores[c[k]] }));
  return { ranking, perfil, taxaDoTime: Math.round(taxaTime * 100), base: { reunioes: itens.length, atualizadoEm: base.atualizadoEm, desde: base.desde, ate: base.ate } };
}

module.exports = { caracteristicas, salvarBase, lerBase, resumoDaBase, indicar, valoresEmReais, DIAS_BASE, ROTULOS, MINIMO_REUNIOES };
