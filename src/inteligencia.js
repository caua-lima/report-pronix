'use strict';

// Inteligência comercial: cruza a leitura de cada report (perfil do lead, nível de consciência,
// BANT/SPIN, perguntas-chave) com o closer e o resultado da reunião que o master marcou.
//
// Tudo aqui é CONTA em cima do histórico — sem IA e sem custo. Só o texto de "insights" usa IA,
// e é a gratuita (Groq), acionada por botão.
//
// Regra de honestidade: só entra na conta o report que tem closer E resultado marcados (no-show fica
// de fora: a reunião não aconteceu). E nenhuma
// recomendação sai de amostra pequena: abaixo de MIN_AMOSTRA a resposta é "ainda sem dados".

const db = require('./db');
const { PERFIS, infoDoPerfil } = require('./perfil');
const { NIVEIS } = require('./consciencia');
const { ehVenda } = require('./stats');
const { chatGroq } = require('./groq');

const MIN_AMOSTRA = 3; // reuniões de um closer com um perfil para a taxa valer como recomendação
const MIN_GERAL = 5; // reuniões com resultado para mostrar padrões de prospecção

const perfilDe = (r) => r.perfilReal || r.perfil || '';
const nivelDe = (r) => r.conscienciaReal || r.consciencia || '';
// No-show não é reunião: o lead não apareceu, então não conta como venda perdida de ninguém.
const comResultado = (r) => Boolean(r.resultado) && r.resultado !== 'no_show';
const taxa = (v, t) => (t ? v / t : 0);

/** Reports que entram na conta: com resultado marcado (e, para o cruzamento, com closer). */
function base(reports) {
  return (reports || []).filter(comResultado);
}

/** Closer × perfil: quantas reuniões e quantas vendas de cada closer com cada tipo de lead. */
function matrizCloserPerfil(reports) {
  const porCloser = new Map();
  base(reports)
    .filter((r) => r.closerId && perfilDe(r))
    .forEach((r) => {
      const c = porCloser.get(r.closerId) || { closerId: r.closerId, nome: r.closerNome || '—', total: 0, vendas: 0, perfis: {} };
      c.nome = r.closerNome || c.nome;
      const p = perfilDe(r);
      const cel = c.perfis[p] || { total: 0, vendas: 0 };
      cel.total++;
      c.total++;
      if (ehVenda(r.resultado)) {
        cel.vendas++;
        c.vendas++;
      }
      c.perfis[p] = cel;
      porCloser.set(r.closerId, c);
    });
  return [...porCloser.values()]
    .map((c) => ({
      ...c,
      taxa: taxa(c.vendas, c.total),
      perfis: Object.fromEntries(Object.entries(c.perfis).map(([k, v]) => [k, { ...v, taxa: taxa(v.vendas, v.total) }])),
    }))
    .sort((a, b) => b.taxa - a.taxa || b.total - a.total);
}

/**
 * Qual closer para um perfil de lead. Ordena por taxa suavizada ((vendas+1)/(total+2)) para um
 * closer com 1 venda em 1 reunião não passar na frente de um com 8 em 10.
 * @param {object[]} closersAtivos lista atual de closers ({id, nome}) — só recomenda quem ainda está na casa
 */
function sugerirCloser(reports, perfil, closersAtivos) {
  const info = infoDoPerfil(perfil);
  if (!info) return { perfil: '', sugestao: null, motivo: 'Perfil do lead ainda não identificado.', ranking: [] };
  const ativos = new Map((closersAtivos || []).map((c) => [c.id, c.nome]));
  const ranking = matrizCloserPerfil(reports)
    .filter((c) => ativos.has(c.closerId) && c.perfis[perfil])
    .map((c) => {
      const cel = c.perfis[perfil];
      return { closerId: c.closerId, nome: ativos.get(c.closerId), total: cel.total, vendas: cel.vendas, taxa: cel.taxa, nota: (cel.vendas + 1) / (cel.total + 2) };
    })
    .sort((a, b) => b.nota - a.nota || b.total - a.total);
  const validos = ranking.filter((c) => c.total >= MIN_AMOSTRA);
  if (!validos.length) {
    return {
      perfil,
      perfilRotulo: info.rotulo,
      sugestao: null,
      motivo: `Ainda sem dados suficientes de reuniões com lead ${info.rotulo.toLowerCase()} (precisa de ${MIN_AMOSTRA} com resultado por closer).`,
      ranking,
    };
  }
  const m = validos[0];
  return {
    perfil,
    perfilRotulo: info.rotulo,
    sugestao: { closerId: m.closerId, nome: m.nome },
    motivo: `${m.nome} fechou ${m.vendas} de ${m.total} reuniões com lead ${info.rotulo.toLowerCase()}.`,
    ranking,
  };
}

/** Conversão por uma dimensão qualquer (perfil, nível de consciência...). */
function conversaoPor(reports, chaveDe, rotuloDe) {
  const m = new Map();
  base(reports).forEach((r) => {
    const k = chaveDe(r);
    if (!k) return;
    const x = m.get(k) || { chave: k, rotulo: rotuloDe(k), total: 0, vendas: 0 };
    x.total++;
    if (ehVenda(r.resultado)) x.vendas++;
    m.set(k, x);
  });
  return [...m.values()].map((x) => ({ ...x, taxa: taxa(x.vendas, x.total) })).sort((a, b) => b.total - a.total);
}

/** O que a prospecção das reuniões que fecharam tem de diferente das que não fecharam. */
function padroesDeProspeccao(reports) {
  const lista = base(reports).filter((r) => r.analise);
  const ganhou = lista.filter((r) => ehVenda(r.resultado));
  const perdeu = lista.filter((r) => !ehVenda(r.resultado));
  const pct = (grupo, teste) => (grupo.length ? grupo.filter(teste).length / grupo.length : 0);
  const criterio = (nome, rotulo, teste) => ({
    chave: nome,
    rotulo,
    ganhou: pct(ganhou, teste),
    perdeu: pct(perdeu, teste),
    diferenca: pct(ganhou, teste) - pct(perdeu, teste),
  });
  const criterios = [
    criterio('bant.orcamento', 'Investimento levantado (BANT: orçamento)', (r) => r.analise.bant.orcamento === 'sim'),
    criterio('bant.autoridade', 'Decisor esclarecido (BANT: autoridade)', (r) => r.analise.bant.autoridade === 'sim'),
    criterio('bant.necessidade', 'Dor/objetivo concreto (BANT: necessidade)', (r) => r.analise.bant.necessidade === 'sim'),
    criterio('bant.prazo', 'Urgência/prazo levantado (BANT: prazo)', (r) => r.analise.bant.prazo === 'sim'),
    criterio('spin.situacao', 'Perguntas de situação (SPIN)', (r) => r.analise.spin.situacao),
    criterio('spin.problema', 'Perguntas de problema (SPIN)', (r) => r.analise.spin.problema),
    criterio('spin.implicacao', 'Perguntas de implicação (SPIN)', (r) => r.analise.spin.implicacao),
    criterio('spin.necessidade', 'Perguntas de necessidade de solução (SPIN)', (r) => r.analise.spin.necessidade),
  ].sort((a, b) => b.diferenca - a.diferenca);

  const perguntas = (grupo) =>
    grupo
      .flatMap((r) => (r.analise.perguntasChave || []).map((p) => ({ pergunta: p, lead: r.lead || '', sdr: r.usuarioNome || '' })))
      .slice(-30);
  return {
    comAnalise: lista.length,
    vendas: ganhou.length,
    semVenda: perdeu.length,
    suficiente: lista.length >= MIN_GERAL && ganhou.length > 0 && perdeu.length > 0,
    criterios,
    perguntasQueFecharam: perguntas(ganhou),
    perguntasQueNaoFecharam: perguntas(perdeu),
    abordagensQueFecharam: ganhou.map((r) => r.analise.abordagem).filter(Boolean).slice(-15),
  };
}

/** Painel inteiro da aba "Resultados da reunião". */
function painel(reports, closersAtivos) {
  const comRes = base(reports);
  const rotuloPerfil = (k) => (infoDoPerfil(k) || {}).rotulo || k;
  const rotuloNivel = (k) => (NIVEIS.find((n) => n.chave === k) || {}).rotulo || k;
  return {
    minAmostra: MIN_AMOSTRA,
    reunioesComResultado: comRes.length,
    vendas: comRes.filter((r) => ehVenda(r.resultado)).length,
    semCloser: comRes.filter((r) => !r.closerId).length,
    perfis: PERFIS.map((p) => ({ chave: p.chave, rotulo: p.rotulo })),
    matriz: matrizCloserPerfil(reports),
    porPerfil: conversaoPor(reports, perfilDe, rotuloPerfil),
    porConsciencia: conversaoPor(reports, nivelDe, rotuloNivel),
    prospeccao: padroesDeProspeccao(reports),
    melhorCloserPorPerfil: PERFIS.map((p) => {
      const s = sugerirCloser(reports, p.chave, closersAtivos);
      return { perfil: p.chave, rotulo: p.rotulo, sugestao: s.sugestao, motivo: s.motivo };
    }),
  };
}

const CHAVE_INSIGHTS = 'insights_ultimo';

/**
 * Texto de insights (melhorias de script, perguntas para a qualificação padrão), escrito pela IA
 * gratuita em cima dos NÚMEROS e das perguntas — a conversa dos leads não vai junto.
 */
async function gerarInsights(reports, closersAtivos) {
  const p = painel(reports, closersAtivos);
  if (p.reunioesComResultado < MIN_GERAL) {
    throw new Error(`Marque o resultado de pelo menos ${MIN_GERAL} reuniões para gerar insights (hoje são ${p.reunioesComResultado}).`);
  }
  const pc = (v) => Math.round(v * 100) + '%';
  const linhas = [];
  linhas.push(`Reuniões com resultado: ${p.reunioesComResultado}; vendas: ${p.vendas}.`);
  linhas.push('CONVERSÃO POR PERFIL DE LEAD: ' + (p.porPerfil.map((x) => `${x.rotulo} ${x.vendas}/${x.total}`).join('; ') || 'sem dados'));
  linhas.push('CONVERSÃO POR NÍVEL DE CONSCIÊNCIA: ' + (p.porConsciencia.map((x) => `${x.rotulo} ${x.vendas}/${x.total}`).join('; ') || 'sem dados'));
  linhas.push(
    'CLOSER × PERFIL (vendas/reuniões): ' +
      (p.matriz
        .map((c) => `${c.nome}: ` + Object.entries(c.perfis).map(([k, v]) => `${(infoDoPerfil(k) || {}).rotulo || k} ${v.vendas}/${v.total}`).join(', '))
        .join(' | ') || 'sem dados')
  );
  linhas.push(
    'NA PROSPECÇÃO, % das reuniões que FECHARAM vs. das que NÃO fecharam em que o critério apareceu: ' +
      p.prospeccao.criterios.map((c) => `${c.rotulo}: ${pc(c.ganhou)} vs ${pc(c.perdeu)}`).join('; ')
  );
  const lista = (titulo, itens) => (itens.length ? `${titulo}:\n` + itens.map((x) => `- ${x}`).join('\n') : '');
  linhas.push(lista('PERGUNTAS DO PRÉ-VENDEDOR NAS REUNIÕES QUE FECHARAM', p.prospeccao.perguntasQueFecharam.map((x) => x.pergunta)));
  linhas.push(lista('PERGUNTAS NAS QUE NÃO FECHARAM', p.prospeccao.perguntasQueNaoFecharam.map((x) => x.pergunta)));
  linhas.push(lista('COMO FOI A ABORDAGEM NAS QUE FECHARAM', p.prospeccao.abordagensQueFecharam));

  const system =
    'Você é um gestor comercial experiente (SPIN Selling e BANT) analisando os números de um time de pré-vendas e closers ' +
    'que vende mentoria para quem quer vender no Mercado Livre. Escreva em português do Brasil, direto e prático.\n' +
    'REGRAS: use SÓ os números e as perguntas fornecidos; não invente dado. Com amostra pequena (menos de 5 reuniões num grupo), ' +
    'diga que é indício, não conclusão. Nada de teoria genérica: cada item cita o número que o sustenta.\n' +
    'Responda SOMENTE com um JSON: {"closer_por_perfil":["..."],"prospeccao_que_funciona":["..."],' +
    '"perguntas_para_o_padrao":["..."],"melhorias_no_script":["..."],"atencao":["..."]} — até 4 itens curtos em cada lista. ' +
    '"perguntas_para_o_padrao" são perguntas prontas para entrar na qualificação padrão; "atencao" são limites da amostra.';
  const bruto = await chatGroq({ system, user: linhas.filter(Boolean).join('\n\n'), modelo: process.env.GROQ_COACH_MODEL, maxTokens: 1200 });
  let j;
  try {
    j = JSON.parse(bruto);
  } catch (_) {
    const i = bruto.indexOf('{');
    const f = bruto.lastIndexOf('}');
    if (i === -1 || f <= i) throw new Error('A IA não devolveu os insights. Tente de novo.');
    j = JSON.parse(bruto.slice(i, f + 1));
  }
  const lst = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 400)).filter(Boolean).slice(0, 5) : []);
  const insights = {
    closerPorPerfil: lst(j.closer_por_perfil),
    prospeccaoQueFunciona: lst(j.prospeccao_que_funciona),
    perguntasParaOPadrao: lst(j.perguntas_para_o_padrao),
    melhoriasNoScript: lst(j.melhorias_no_script),
    atencao: lst(j.atencao),
    geradoEm: new Date().toISOString(),
    baseadoEm: p.reunioesComResultado,
  };
  await db.setJson(CHAVE_INSIGHTS, insights).catch(() => {});
  return insights;
}

const ultimosInsights = () => db.getJson(CHAVE_INSIGHTS, null).catch(() => null);

module.exports = { painel, sugerirCloser, matrizCloserPerfil, padroesDeProspeccao, gerarInsights, ultimosInsights, MIN_AMOSTRA, MIN_GERAL };
