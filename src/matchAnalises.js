'use strict';

// Análises do "Match com PH": com que tipo de lead o closer fecha mais, sempre nas reuniões realizadas em que
// o usuário foi o SDR (as mesmas da aba). Cada corte mostra reuniões, vendas, conversão (vendas ÷ reuniões),
// faturamento e ticket médio:
//  - do formulário do lead no RD: profissão, faixa de investimento (até 3 mil, 3 a 5 mil, mais de 5 mil),
//    faturamento, se já vende e o que busca. Vem dos campos do card; sem eles, da anotação do formulário
//    (lida uma vez por card e guardada);
//  - do report do usuário: o perfil comportamental e o nível de consciência (a correção do master vale mais);
//  - da própria reunião: dia da semana, origem do card, produto vendido, quanto tempo levou para fechar e os
//    motivos de quem não comprou.
// Conversão de um corte = das reuniões daquele tipo, quantas viraram venda (venda em qualquer data).

const db = require('./db');
const crm = require('./crm');
const { infoDoPerfil } = require('./perfil');

const MIN_AMOSTRA = 3; // corte com menos reuniões que isso não vira destaque
const FORM_POR_VEZ = Number(process.env.MATCH_FORM_POR_VEZ) || 60; // anotações lidas no RD por atualização
const FORM_TTL = 60 * 24 * 3600; // o formulário não muda: guardado por 60 dias

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = (s) => semAcento(s).replace(/[^a-z0-9]+/g, ' ').trim();
const valorTexto = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v == null ? '' : v)).replace(/\s+/g, ' ').trim();
const modelo = (v) => /\{\{/.test(v); // "{{data.Qual…}}" é campo de integração não preenchido

const ROTULOS = {
  profissao: /profiss|ocupac/,
  investimento: /invest/,
  faturamento: /fatur/,
  vende: /vende|vendo|momento/,
  busca: /busca|modalidade|objetivo/,
};

/** { profissao, investimento, faturamento, vende, busca } a partir de [{ rotulo, valor }]. */
function camposDoLead(lista) {
  const out = {};
  for (const [chave, re] of Object.entries(ROTULOS)) {
    const c = (lista || []).find((x) => re.test(semAcento(x.rotulo)) && valorTexto(x.valor) && !modelo(valorTexto(x.valor)));
    if (c) out[chave] = valorTexto(c.valor).slice(0, 120);
  }
  return out;
}

/** Do card do RD: os campos personalizados e a origem. */
function doCard(deal) {
  const lista = (Array.isArray(deal.deal_custom_fields) ? deal.deal_custom_fields : [])
    .map((c) => ({ rotulo: (c && c.custom_field && c.custom_field.label) || '', valor: c && c.value }))
    .filter((c) => !/^sdr$/i.test(String(c.rotulo).trim()));
  const out = camposDoLead(lista);
  const fonte = deal.deal_source && deal.deal_source.name;
  if (fonte) out.fonte = String(fonte).slice(0, 80);
  return out;
}

/**
 * "R$3.000 a R$5.000" -> "R$ 3 a 5 mil"; "+ de R$5.000" -> "Mais de R$ 5 mil"; "até R$3.000" -> "Até R$ 3 mil".
 * Com `investimento`, tudo cai nas três faixas do investimento (até 3, 3 a 5, mais de 5 mil); sem, a faixa fica como veio.
 */
function faixaDeValor(texto, { investimento = false } = {}) {
  const t = semAcento(texto);
  if (!t) return '';
  const nums = [...t.matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?\s*(mil\b|k\b)?/g)]
    .map((m) => { const n = Number(m[1].replace(/\./g, '')); return m[2] && n < 1000 ? n * 1000 : n; })
    .filter((n) => n > 0);
  const mil = (n) => (n >= 1000 ? `${String(Math.round(n / 100) / 10).replace('.', ',')} mil` : `${n}`);
  if (nums.length >= 2) {
    const [a, b] = nums;
    if (investimento && b <= 3000) return 'Até R$ 3 mil';
    if (investimento && a >= 3000 && b <= 5000) return 'R$ 3 a 5 mil';
    if (investimento && a >= 5000) return 'Mais de R$ 5 mil';
    return `R$ ${mil(a).replace(' mil', '')} a ${mil(b)}`;
  }
  if (nums.length === 1) {
    const n = nums[0];
    if (/\+|mais de|acima|a partir|superior/.test(t)) return investimento && n >= 5000 ? 'Mais de R$ 5 mil' : `Mais de R$ ${mil(n)}`;
    if (/ate|menos de|abaixo|inferior/.test(t)) return investimento && n <= 3000 ? 'Até R$ 3 mil' : `Até R$ ${mil(n)}`;
    if (!investimento) return `R$ ${mil(n)}`;
    return n < 3000 ? 'Até R$ 3 mil' : n <= 5000 ? 'R$ 3 a 5 mil' : 'Mais de R$ 5 mil';
  }
  return '';
}
const ORDEM_INVEST = ['Até R$ 3 mil', 'R$ 3 a 5 mil', 'Mais de R$ 5 mil'];

/** "Já vendo e quero aumentar" -> "Já vende"; "Quero começar" -> "Ainda não vende". */
function situacaoDeVenda(texto) {
  const v = semAcento(texto);
  if (!v) return '';
  if (/comec|ainda nao|nao vend|do zero|quero vender|^nao\b/.test(v)) return 'Ainda não vende';
  if (/ja vend|ja tenho|aumentar|escalar|^sim\b/.test(v)) return 'Já vende';
  return '';
}

/**
 * Card sem profissão e sem investimento nos campos: lê a anotação do formulário no RD (uma vez por card,
 * guardada). Faz no máximo FORM_POR_VEZ cards por atualização; os outros ficam para a próxima.
 */
async function completarPeloFormulario(reunioes) {
  const faltam = reunioes.filter((r) => r.fonte === 'rd' && r.contaReuniao && !r.lead_.profissao && !r.lead_.investimento);
  let lidos = 0;
  let pendentes = 0;
  const fila = [];
  for (const r of faltam) {
    const guardado = await db.cacheGet('form_deal_' + r.id).catch(() => null);
    if (guardado) {
      try { Object.assign(r.lead_, JSON.parse(guardado)); continue; } catch (_) { /* relê */ }
    }
    if (fila.length < FORM_POR_VEZ) fila.push(r);
    else pendentes++;
  }
  const ler = async (r) => {
    const a = await crm.rd('/activities', { deal_id: r.id, limit: 50 }).catch(() => null);
    const notas = ((a && a.activities) || []).map((x) => crm.limparTexto(x.text)).filter(Boolean);
    const nota = notas.find((t) => crm.extrairCampos(t).length >= 2);
    const campos = nota ? camposDoLead(crm.extrairCampos(nota)) : {};
    Object.assign(r.lead_, campos);
    lidos++;
    if (a) await db.cacheSet('form_deal_' + r.id, JSON.stringify(campos), FORM_TTL).catch(() => {});
  };
  for (let i = 0; i < fila.length; i += 6) await Promise.all(fila.slice(i, i + 6).map(ler));
  return { lidos, pendentes };
}

// ---------------------------------------------------------------- os cortes

function corte(reunioes, chaveDe, { ordem = null, max = 10 } = {}) {
  const grupos = new Map();
  for (const r of reunioes) {
    const bruto = chaveDe(r);
    const rotulo = bruto || 'Não informado';
    const k = bruto ? norm(bruto) : '~';
    const g = grupos.get(k) || { rotulo, reunioes: 0, vendas: 0, faturamento: 0 };
    g.reunioes++;
    if (r.estado === 'venda') { g.vendas++; g.faturamento += r.ticketTotal || 0; }
    grupos.set(k, g);
  }
  let lista = [...grupos.values()].map((g) => ({
    ...g, conversao: g.reunioes ? g.vendas / g.reunioes : 0, ticketMedio: g.vendas ? g.faturamento / g.vendas : 0,
  }));
  const naoInformado = lista.filter((g) => g.rotulo === 'Não informado');
  lista = lista.filter((g) => g.rotulo !== 'Não informado');
  if (ordem) lista.sort((a, b) => (ordem.indexOf(a.rotulo) + 1 || 99) - (ordem.indexOf(b.rotulo) + 1 || 99));
  else lista.sort((a, b) => b.reunioes - a.reunioes || b.conversao - a.conversao);
  if (lista.length > max) {
    const resto = lista.slice(max - 1);
    const outros = resto.reduce((o, g) => ({ rotulo: 'Outros', reunioes: o.reunioes + g.reunioes, vendas: o.vendas + g.vendas, faturamento: o.faturamento + g.faturamento }), { rotulo: 'Outros', reunioes: 0, vendas: 0, faturamento: 0 });
    outros.conversao = outros.reunioes ? outros.vendas / outros.reunioes : 0;
    outros.ticketMedio = outros.vendas ? outros.faturamento / outros.vendas : 0;
    lista = lista.slice(0, max - 1).concat([outros]);
  }
  const informadas = lista.reduce((t, g) => t + g.reunioes, 0);
  return { grupos: lista.concat(naoInformado), informadas };
}

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const diaDaSemana = (dia) => DIAS[new Date(dia + 'T12:00:00Z').getUTCDay()];
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const NIVEL = { inconsciente: 'Inconsciente do problema', problema: 'Consciente do problema', solucao: 'Consciente da solução', produto: 'Consciente da nossa entrega', pronto: 'Pronto para decidir' };
const PRODUTO = { performance: 'Pronix Performance', acelera: 'Pronix Acelera' };

/**
 * Todas as análises a partir das reuniões do levantamento (src/matchCloser.js).
 * Só entram as reuniões realizadas no período (contaReuniao).
 */
function analisar(todas) {
  const reunioes = todas.filter((r) => r.contaReuniao);
  const media = reunioes.length ? reunioes.filter((r) => r.estado === 'venda').length / reunioes.length : 0;
  const L = (r) => r.lead_ || {};
  const cortes = [
    { id: 'profissao', titulo: 'Profissão (formulário do lead)', ...corte(reunioes, (r) => L(r).profissao) },
    { id: 'investimento', titulo: 'Quanto disse que pode investir', ...corte(reunioes, (r) => faixaDeValor(L(r).investimento, { investimento: true }) || (L(r).investimento ? 'Outro valor' : ''), { ordem: ORDEM_INVEST }) },
    { id: 'faturamento', titulo: 'Faturamento informado', ...corte(reunioes, (r) => faixaDeValor(L(r).faturamento)) },
    { id: 'vende', titulo: 'Já vende online?', ...corte(reunioes, (r) => situacaoDeVenda(L(r).vende)) },
    { id: 'busca', titulo: 'O que busca', ...corte(reunioes, (r) => L(r).busca) },
    { id: 'perfil', titulo: 'Perfil do lead (report)', ...corte(reunioes, (r) => (infoDoPerfil(r.perfil) || {}).rotulo || '') },
    { id: 'consciencia', titulo: 'Nível de consciência (report)', ...corte(reunioes, (r) => NIVEL[r.consciencia] || '', { ordem: Object.values(NIVEL) }) },
    { id: 'dia', titulo: 'Dia da semana da reunião', ...corte(reunioes, (r) => (r.dataReuniao ? diaDaSemana(r.dataReuniao) : ''), { ordem: DIAS.slice(1).concat(DIAS[0]) }) },
    { id: 'fonte', titulo: 'Origem do card', ...corte(reunioes, (r) => L(r).fonte) },
  ].filter((c) => c.informadas > 0);

  // Vendas: produto e tempo até fechar.
  const vendas = reunioes.filter((r) => r.estado === 'venda');
  const porProduto = corte(vendas.map((r) => ({ ...r, estado: 'venda' })), (r) => PRODUTO[r.produto] || '').grupos
    .map((g) => ({ rotulo: g.rotulo, vendas: g.vendas, faturamento: g.faturamento, ticketMedio: g.ticketMedio, parte: vendas.length ? g.vendas / vendas.length : 0 }));
  const tempos = vendas.filter((r) => r.dataReuniao && r.diaVendaReal).map((r) => Math.max(0, diasEntre(r.dataReuniao, r.diaVendaReal)));
  const faixa = (min, max) => tempos.filter((d) => d >= min && d <= max).length;
  const tempo = tempos.length ? {
    medioDias: tempos.reduce((t, d) => t + d, 0) / tempos.length,
    faixas: [
      { rotulo: 'Na própria reunião', vendas: faixa(0, 0) }, { rotulo: 'Em até 7 dias', vendas: faixa(1, 7) },
      { rotulo: 'De 8 a 30 dias', vendas: faixa(8, 30) }, { rotulo: 'Depois de 30 dias', vendas: faixa(31, 99999) },
    ].map((f) => ({ ...f, parte: f.vendas / tempos.length })),
  } : null;

  // Quem não comprou: os motivos do RD.
  const perdas = reunioes.filter((r) => r.estado === 'nao_comprou');
  const motivos = new Map();
  perdas.forEach((r) => { const m = (r.motivo || 'Sem motivo informado').trim(); motivos.set(m, (motivos.get(m) || 0) + 1); });
  const motivosPerda = [...motivos.entries()].map(([rotulo, total]) => ({ rotulo, total, parte: perdas.length ? total / perdas.length : 0 }))
    .sort((a, b) => b.total - a.total).slice(0, 8);

  // Destaques: o corte que mais converte (com amostra) em cada análise, contra a média.
  const destaques = [];
  for (const c of cortes) {
    const validos = c.grupos.filter((g) => g.rotulo !== 'Não informado' && g.rotulo !== 'Outros' && g.reunioes >= MIN_AMOSTRA);
    if (validos.length < 2) continue;
    const melhor = validos.slice().sort((a, b) => b.conversao - a.conversao || b.reunioes - a.reunioes)[0];
    const pior = validos.slice().sort((a, b) => a.conversao - b.conversao || b.reunioes - a.reunioes)[0];
    if (melhor.conversao <= media) continue;
    destaques.push({ corte: c.id, titulo: c.titulo, melhor: melhor.rotulo, conversao: melhor.conversao, vendas: melhor.vendas, reunioes: melhor.reunioes, pior: pior.rotulo, conversaoPior: pior.conversao, vezesMedia: media ? melhor.conversao / media : 0 });
  }
  destaques.sort((a, b) => b.vezesMedia - a.vezesMedia);

  return { total: reunioes.length, vendas: vendas.length, media, minAmostra: MIN_AMOSTRA, cortes, porProduto, tempo, motivosPerda, destaques };
}

module.exports = { analisar, doCard, camposDoLead, faixaDeValor, situacaoDeVenda, completarPeloFormulario, corte };
