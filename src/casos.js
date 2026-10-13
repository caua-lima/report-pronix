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
  const j = (await db.getJson(CHAVE_DB, null)) || {};
  const mapa = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { porCloser: mapa(j.porCloser), doDrive: mapa(j.doDrive) };
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
  if (!dados.porCloser[closerId] && !dados.doDrive[closerId]) return;
  delete dados.porCloser[closerId];
  delete dados.doDrive[closerId];
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

// ---------------------------------------------------------------- casos lidos do Google Drive
// Cada transcrição nova na pasta do closer vira um caso (src/transcricoes.js). Ficam separados dos casos do
// pacote: importar o pacote de novo não apaga o que veio do Drive, e vice-versa. Não guardam nome de lead:
// só uma impressão (hash) do primeiro nome, para juntar as reuniões do mesmo lead e não contar duas vezes.

/** Impressão curta de um primeiro nome ("Bruno" e "bruno " dão a mesma): serve para comparar, não para ler. */
function impressaoDoNome(nome) {
  const primeiro = semAcento(nome).replace(/[^a-z ]+/g, ' ').trim().split(/\s+/)[0] || '';
  return primeiro.length >= 2 ? crypto.createHash('sha256').update('lead:' + primeiro).digest('hex').slice(0, 12) : '';
}

function normalizarCasoDoDrive(b) {
  const c = normalizarCaso(b, 'drive');
  if (!c) return null;
  const ids = (v) => (Array.isArray(v) ? v : []).map((x) => txt(x, 80)).filter((x) => /^[A-Za-z0-9_-]{4,80}$/.test(x)).slice(0, 12);
  c.arquivos = ids(b.arquivos);
  c.leadPrimeiros = (Array.isArray(b.leadPrimeiros) ? b.leadPrimeiros : []).map((x) => txt(x, 12)).filter((x) => /^[a-f0-9]{12}$/.test(x)).slice(0, 6);
  // Dia e hora de cada reunião que entrou no caso: o mesmo encontro em dois arquivos não conta duas vezes.
  c.momentos = (Array.isArray(b.momentos) ? b.momentos : []).map((x) => txt(x, 16)).filter((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x)).slice(-12);
  c.lidoEm = txt(b.lidoEm, 30) || new Date().toISOString();
  if (b.revisado) c.revisado = true; // o master corrigiu à mão: a leitura automática não mexe mais
  return c;
}

async function doDrive(closerId) {
  const lista = ((await ler()).doDrive || {})[closerId];
  return Array.isArray(lista) ? lista : [];
}

async function salvarDoDrive(closerId, lista) {
  if (!closerId) throw new Error('Closer não encontrado.');
  const dados = await ler();
  dados.doDrive = dados.doDrive && typeof dados.doDrive === 'object' ? dados.doDrive : {};
  const casos = (Array.isArray(lista) ? lista : []).map(normalizarCasoDoDrive).filter(Boolean).slice(-MAX_CASOS);
  if (casos.length) dados.doDrive[closerId] = casos;
  else delete dados.doDrive[closerId];
  await db.setJson(CHAVE_DB, dados);
  return casos;
}

/** Corrige (resultado, quem decide, presença, momento) ou apaga um caso lido do Drive. */
async function editarDoDrive(closerId, casoId, mudancas) {
  const lista = await doDrive(closerId);
  const i = lista.findIndex((c) => c.id === casoId);
  if (i === -1) return null;
  if (mudancas === null) {
    lista.splice(i, 1);
    await salvarDoDrive(closerId, lista);
    return { removido: true };
  }
  const m = mudancas && typeof mudancas === 'object' ? mudancas : {};
  const novo = { ...lista[i], revisado: true };
  if (RESULTADOS.includes(m.resultado)) novo.resultado = m.resultado;
  if (QUEM.includes(m.quem) || m.quem === '') novo.quem = m.quem;
  if (MOMENTOS.includes(m.momento) || m.momento === '') novo.momento = m.momento;
  if (m.todosNaCall === true || m.todosNaCall === false || m.todosNaCall === null) novo.todosNaCall = m.todosNaCall;
  lista[i] = novo;
  return (await salvarDoDrive(closerId, lista))[Math.min(i, lista.length - 1)];
}

const diasEntreDatas = (a, b) => Math.abs(Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000;

/**
 * Tudo o que se sabe das calls do closer: o pacote das transcrições, as lidas do Drive e as reuniões com
 * resultado marcado. A mesma reunião pode chegar pelo Drive e por um report: aí vale a do Drive (tem mais
 * detalhe), reconhecida pelo primeiro nome do lead em datas próximas.
 */
async function doCloser(closerId, reports) {
  const drive = await doDrive(closerId);
  const jaNoDrive = (r) => {
    const h = impressaoDoNome(r.lead || r.contato);
    const dia = r.dataReuniao || r.dia || '';
    return Boolean(h) && drive.some((c) => (c.leadPrimeiros || []).includes(h) && c.data && dia && diasEntreDatas(c.data, dia) <= 12);
  };
  const dosResultados = dosReports((reports || []).filter((r) => r && !jaNoDrive(r)), closerId);
  return (await importados(closerId)).concat(drive, dosResultados);
}

/**
 * Casos parecidos com um lead: as contas dos recortes em que ele se encaixa (quem decide, momento, presença)
 * e alguns exemplos reais, do mais parecido para o menos — os que fecharam e os que não, com o motivo.
 * @param {object[]} casos
 * @param {{quem?: string, momento?: string, todosNaCall?: boolean|null}} alvo
 */
function parecidos(casos, alvo = {}) {
  const lista = casos || [];
  const quem = QUEM.includes(alvo.quem) ? alvo.quem : '';
  const momento = MOMENTOS.includes(alvo.momento) ? alvo.momento : '';
  const pres = alvo.todosNaCall === true || alvo.todosNaCall === false ? alvo.todosNaCall : null;
  const rotuloPres = pres === true ? 'todos os decisores na call' : 'faltando decisor na call';
  const linhas = [];
  const add = (rotulo, filtro) => {
    const l = lista.filter(filtro);
    if (l.length && !linhas.some((x) => x.total === l.length && x.rotulo === rotulo)) {
      linhas.push({ rotulo, total: l.length, vendas: l.filter((c) => c.resultado === 'venda').length, acordos: l.filter((c) => c.resultado === 'acordo').length });
    }
  };
  if (quem && momento && pres !== null) add(`${ROTULO_QUEM[quem]}, ${ROTULO_MOMENTO[momento]}, ${rotuloPres}`, (c) => c.quem === quem && c.momento === momento && c.todosNaCall === pres);
  if (quem && pres !== null) add(`${ROTULO_QUEM[quem]}, ${rotuloPres}`, (c) => c.quem === quem && c.todosNaCall === pres);
  if (quem && momento) add(`${ROTULO_QUEM[quem]}, ${ROTULO_MOMENTO[momento]}`, (c) => c.quem === quem && c.momento === momento);
  if (quem) add(`Quem decide: ${ROTULO_QUEM[quem]}`, (c) => c.quem === quem);
  if (momento) add(`Momento: ${ROTULO_MOMENTO[momento]}`, (c) => c.momento === momento);
  if (pres !== null) add(pres ? 'Todos os decisores na call' : 'Faltando decisor na call', (c) => c.todosNaCall === pres);

  // Exemplos: só caso com descrição, pontuado por quantas dimensões batem; no empate, o mais recente.
  const pontos = (c) => (quem && c.quem === quem ? 2 : 0) + (momento && c.momento === momento ? 1 : 0) + (pres !== null && c.todosNaCall === pres ? 1 : 0);
  const candidatos = lista.filter((c) => c.perfil && pontos(c) >= 2).sort((a, b) => pontos(b) - pontos(a) || String(b.data).localeCompare(String(a.data)));
  const exemplo = (c) => ({ resultado: c.resultado, perfil: c.perfil, motivo: c.motivo || '', reunioes: c.reunioes || null, travas: (c.travas || []).slice(0, 2) });
  const exemplos = candidatos.filter((c) => c.resultado === 'venda').slice(0, 3).map(exemplo)
    .concat(candidatos.filter((c) => c.resultado !== 'venda').slice(0, 3).map(exemplo));
  return { linhas, exemplos };
}

/** Os casos parecidos em texto, para a IA usar ao montar o plano da call. '' se não há nada. */
function textoDosParecidos(p) {
  if (!p || (!p.linhas.length && !p.exemplos.length)) return '';
  const partes = p.linhas.map((l) => `${l.rotulo}: ${l.vendas} venda(s) em ${l.total} caso(s)` + (l.acordos ? ` (+${l.acordos} acordo(s) a pagar)` : ''));
  p.exemplos.forEach((e) => {
    partes.push((e.resultado === 'venda' ? 'FECHOU' : e.resultado === 'acordo' ? 'ACORDO, PAGAR DEPOIS' : 'NÃO FECHOU') + ': ' + e.perfil +
      (e.resultado !== 'venda' && e.motivo ? ` (${e.motivo})` : '') + (e.travas.length ? ` [trava: ${e.travas.join(', ')}]` : ''));
  });
  return partes.join('\n');
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
  doDrive, salvarDoDrive, editarDoDrive, impressaoDoNome, parecidos, textoDosParecidos, QUEM, MOMENTOS, RESULTADOS,
};
