'use strict';

// Casos do closer: cada negociação que ele conduziu, reduzida ao que explica o desfecho — quem
// decidia, se todos os decisores estavam na call, o momento do lead e como terminou. Sem nome nem
// contato de lead. Vêm de dois lugares:
//  - das transcrições analisadas, importadas em pacote pelo master (aba Closers);
//  - dos reports: lead que passou pela análise de afinidade com este closer e teve o resultado da
//    reunião marcado. Esses não ficam guardados aqui: saem dos reports na hora, então o padrão
//    acompanha cada resultado novo.
// O padrão (vendas por quem decide, por presença e por momento) entra na análise de afinidade.

const crypto = require('crypto');
const db = require('./db');
const stats = require('./stats');

const CHAVE_DB = 'closers_casos';
const MAX_CASOS = 600;
const QUEM = ['sozinho', 'casal', 'socios', 'familia'];
const MOMENTOS = ['loja', 'online', 'zero'];
const RESULTADOS = ['venda', 'acordo', 'nao'];

const txt = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "casal", "com sócio", "Família (o pai paga)"... -> uma das quatro chaves ('' se não der para dizer). */
function chaveDeQuem(v) {
  const t = semAcento(v);
  if (/^sozinh/.test(t)) return 'sozinho';
  if (/famil|\bpai\b|\bmae\b|irma|filh/.test(t)) return 'familia';
  if (/soci/.test(t)) return 'socios';
  if (/casal|espos|marido|conjuge|namorad/.test(t)) return 'casal';
  if (/sozinh/.test(t)) return 'sozinho';
  return '';
}

/** "loja física", "já vende online", "do zero"... -> 'loja' | 'online' | 'zero' | ''. */
function chaveDoMomento(v) {
  const t = semAcento(v);
  if (/loja|fisic|fabrica|industria|distribuidora/.test(t)) return 'loja';
  if (/online|ja vende|marketplace|mercado livre/.test(t)) return 'online';
  if (/zero|comecando|iniciante|transicao|clt/.test(t)) return 'zero';
  return '';
}

/** true/false, "sim"/"não" -> booleano; qualquer outra coisa -> null (não se sabe). */
function simNao(v) {
  if (v === true || v === false) return v;
  const t = semAcento(v).trim();
  if (/^sim\b/.test(t)) return true;
  if (/^nao\b/.test(t) && !/claro/.test(t)) return false;
  return null;
}

function normalizarCaso(b, origem) {
  if (!b || typeof b !== 'object') return null;
  const resultado = RESULTADOS.includes(b.resultado) ? b.resultado : '';
  if (!resultado) return null;
  const inteiro = (v, max) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x > 0 && x <= max ? x : null;
  };
  return {
    id: txt(b.id, 48) || 'c_' + crypto.randomBytes(5).toString('hex'),
    origem,
    data: /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data : '',
    quem: QUEM.includes(b.quem) ? b.quem : chaveDeQuem(b.quem),
    todosNaCall: simNao(b.todosNaCall),
    momento: MOMENTOS.includes(b.momento) ? b.momento : chaveDoMomento(b.momento),
    reunioes: inteiro(b.reunioes, 20),
    minutos: inteiro(b.minutos, 2000),
    resultado,
    motivo: txt(b.motivo, 80),
    perfil: txt(b.perfil, 160),
    travas: (Array.isArray(b.travas) ? b.travas : []).map((t) => txt(t, 60)).filter(Boolean).slice(0, 4),
  };
}

async function ler() {
  const j = await db.getJson(CHAVE_DB, { porCloser: {} });
  return j && j.porCloser && typeof j.porCloser === 'object' ? j : { porCloser: {} };
}

/** Casos importados das transcrições deste closer. */
async function importados(closerId) {
  const lista = (await ler()).porCloser[closerId];
  return Array.isArray(lista) ? lista : [];
}

/** Troca os casos de transcrição do closer pelos do pacote (importar de novo não duplica). */
async function importar(closerId, lista) {
  if (!closerId) throw new Error('Closer não encontrado.');
  const casos = (Array.isArray(lista) ? lista : [])
    .slice(0, MAX_CASOS)
    .map((c) => normalizarCaso(c, 'transcricao'))
    .filter(Boolean);
  const dados = await ler();
  if (casos.length) dados.porCloser[closerId] = casos;
  else delete dados.porCloser[closerId];
  await db.setJson(CHAVE_DB, dados);
  return casos.length;
}

async function removerDoCloser(closerId) {
  const dados = await ler();
  if (!dados.porCloser[closerId]) return;
  delete dados.porCloser[closerId];
  await db.setJson(CHAVE_DB, dados);
}

/**
 * Casos que saem dos reports: a afinidade foi pedida para este closer (é ela que diz quem decide e
 * o momento do lead) e a reunião terminou em venda ou em "não comprou". Em aberto e no-show não contam.
 */
function dosReports(reports, closerId) {
  return (reports || [])
    .filter((r) => r && r.afinidade && r.afinidade.closerId === closerId && (r.closerId || closerId) === closerId)
    .map((r) => {
      const resultado = stats.ehVenda(r.resultado) ? 'venda' : r.resultado === 'sem_venda' ? 'nao' : '';
      if (!resultado) return null;
      return normalizarCaso(
        {
          id: 'r_' + r.id, data: r.dataReuniao || r.dia, resultado,
          quem: r.afinidade.composicao, todosNaCall: r.afinidade.decisoresNaCall, momento: r.afinidade.momento,
        },
        'resultado'
      );
    })
    .filter(Boolean);
}

/** Tudo o que se sabe das calls do closer: transcrições importadas + reuniões com resultado marcado. */
async function doCloser(closerId, reports) {
  return (await importados(closerId)).concat(dosReports(reports, closerId));
}

const ROTULO_QUEM = { sozinho: 'sozinho(a)', casal: 'casal', socios: 'sócios', familia: 'depende de pai, irmão ou filho' };
const ROTULO_MOMENTO = { loja: 'loja ou empresa física', online: 'já vende online', zero: 'começando do zero' };
const ROTULO_TEMPO = { a: 'menos de 1h', b: '1h a 2h', c: '2h a 3h', d: '3h ou mais' };

/** As contas do padrão: para cada recorte, quantos casos, quantas vendas e quantos acordos a pagar. */
function padrao(casos) {
  const conta = () => ({ total: 0, vendas: 0, acordos: 0 });
  const p = { geral: conta(), origem: { transcricao: 0, resultado: 0 }, quem: {}, presenca: {}, quemPresenca: {}, momento: {}, reunioes: {}, tempo: {} };
  const soma = (mapa, chave, c) => {
    if (!chave) return;
    const x = mapa[chave] || (mapa[chave] = conta());
    x.total++;
    if (c.resultado === 'venda') x.vendas++;
    if (c.resultado === 'acordo') x.acordos++;
  };
  for (const c of casos || []) {
    soma(p, 'geral', c);
    p.origem[c.origem === 'resultado' ? 'resultado' : 'transcricao']++;
    const presenca = c.todosNaCall === true ? 'todos' : c.todosNaCall === false ? 'faltou' : '';
    soma(p.quem, c.quem, c);
    soma(p.presenca, presenca, c);
    if (c.quem && presenca) soma(p.quemPresenca, c.quem + ':' + presenca, c);
    soma(p.momento, c.momento, c);
    if (c.reunioes) soma(p.reunioes, c.reunioes >= 2 ? 'duas' : 'uma', c);
    if (c.minutos) soma(p.tempo, c.minutos < 60 ? 'a' : c.minutos < 120 ? 'b' : c.minutos < 180 ? 'c' : 'd', c);
  }
  return p;
}

const fracao = (x, comPct) => `${x.vendas} de ${x.total}` + (comPct && x.total >= 5 ? ` (${Math.round((100 * x.vendas) / x.total)}%)` : '');

/** O padrão em poucas linhas, para a IA cruzar com o lead ("vendas de total"). Vazio se não há casos. */
function textoDoPadrao(p) {
  if (!p || !p.geral.total) return '';
  const serie = (mapa, rotulos, ordem) => ordem.filter((k) => mapa[k]).map((k) => `${rotulos[k]}: ${fracao(mapa[k], true)}`).join('; ');
  const linhas = [
    `Casos das calls dele: ${p.geral.total} (${p.origem.transcricao} de transcrições, ${p.origem.resultado} de reuniões com resultado marcado). ` +
      `Vendas: ${fracao(p.geral, true)}` + (p.geral.acordos ? `; mais ${p.geral.acordos} acordo(s) com pagamento para depois.` : '.'),
  ];
  const quem = serie(p.quem, ROTULO_QUEM, QUEM);
  if (quem) linhas.push('Vendas por quem decide: ' + quem + '.');
  const pres = [p.presenca.todos && `todos os decisores na call: ${fracao(p.presenca.todos, true)}`, p.presenca.faltou && `faltou alguém: ${fracao(p.presenca.faltou, true)}`].filter(Boolean).join('; ');
  if (pres) linhas.push('Por presença: ' + pres + '.');
  const cruz = [
    ['casal:todos', 'casal com os dois na call'], ['casal:faltou', 'casal com um só na call'],
    ['socios:todos', 'sócios todos na call'], ['socios:faltou', 'sócios faltando um'],
    ['familia:faltou', 'família com quem manda fora da call'],
  ].filter(([k]) => p.quemPresenca[k]).map(([k, r]) => `${r}: ${fracao(p.quemPresenca[k], false)}`).join('; ');
  if (cruz) linhas.push('Cruzando: ' + cruz + '.');
  const mom = serie(p.momento, ROTULO_MOMENTO, MOMENTOS);
  if (mom) linhas.push('Por momento do lead: ' + mom + '.');
  const reun = [p.reunioes.uma && `uma reunião: ${fracao(p.reunioes.uma, true)}`, p.reunioes.duas && `duas ou mais: ${fracao(p.reunioes.duas, true)}`].filter(Boolean).join('; ');
  if (reun) linhas.push('Por número de reuniões: ' + reun + '.');
  const tempo = serie(p.tempo, ROTULO_TEMPO, ['a', 'b', 'c', 'd']);
  if (tempo) linhas.push('Por tempo de conversa: ' + tempo + '.');
  return linhas.join('\n');
}

module.exports = {
  importar, importados, removerDoCloser, dosReports, doCloser, padrao, textoDoPadrao, normalizarCaso,
  chaveDeQuem, chaveDoMomento, simNao, ROTULO_QUEM, ROTULO_MOMENTO, ROTULO_TEMPO, MAX_CASOS,
};
