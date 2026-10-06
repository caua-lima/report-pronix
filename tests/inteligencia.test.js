'use strict';
// Perfil do lead, escolha do closer, resultados da reunião, inteligência (closer × perfil, prospecção),
// calibragem do nível de consciência, base recomendada e a fila de modelos gratuitos.
// Tudo com IA simulada e banco temporário: sem rede e sem custo.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-intel-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS,
  ADMIN_PASSWORD: 'senha-de-teste',
  ANTHROPIC_API_KEY: 'chave-falsa',
  GROQ_API_KEY: 'chave-falsa',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
  LLM_PROVIDER: 'anthropic',
  PDF_SEM_COMPRESSAO: '1',
});
delete process.env.VERCEL;
delete process.env.GROQ_COACH_MODEL;
delete process.env.MASTER_NOME;

const app = require('../server');
const inteligencia = require('../src/inteligencia');
const baseMod = require('../src/base');
const { PADRAO } = require('../src/baseInicial');
const perfilMod = require('../src/perfil');
const { chatGroq } = require('../src/groq');
const { normalizarDados, aplicarPerfilNoResumo } = require('../src/report');

// ---------------------------------------------------------------- IA simulada
const fetchReal = global.fetch;
const chamadasAnthropic = [];
const chamadasGroq = [];
let leituraDaIa = {}; // o que a "IA" devolve de perfil/consciência/análise no próximo report
let groq = () => ({ status: 200, corpo: { choices: [{ message: { content: '{}' } }] } });

const ANALISE = {
  bant: { orcamento: 'sim', autoridade: 'sim', necessidade: 'sim', prazo: 'parcial' },
  spin: { situacao: true, problema: true, implicacao: true, necessidade: false },
  perguntas_chave: ['Se nada mudar em 6 meses, como fica?'],
  abordagem: 'Abriu pela operação e só depois falou de investimento.',
};
function respostaAnthropic() {
  return {
    model: 'claude-sonnet-5',
    usage: { input_tokens: 1000, output_tokens: 500 },
    content: [{
      type: 'tool_use',
      input: {
        lead: 'Marcos',
        resumo: [
          { rotulo: 'Investimento', valor: 'Confirmou R$3 mil' },
          { rotulo: 'Motivação', valor: 'Sair do CLT' },
          { rotulo: 'Decisor(es)', valor: 'Decide sozinho (não mencionou outra pessoa)' },
        ],
        secoes: [
          { titulo: 'Perfil e momento', numerada: false, itens: ['Começando do zero.'] },
          { titulo: 'O que o closer deve bater', numerada: true, itens: ['Mostrar o caminho.'] },
        ],
        citacoes: [],
        abertura: 'Oi Marcos, tudo bem? É isso mesmo?',
        consciencia: { nivel: 'solucao', porque: 'Disse que procura um passo a passo para começar.' },
        perfil: { tipo: 'Analítico', evidencia: 'Pediu os números antes de tudo.', conduzir: 'Trazer dados e o processo.' },
        conversa: ['O SDR perguntou do momento; Marcos contou que quer sair do CLT.'],
        analise: ANALISE,
        frase_impacto: 'Falta o caminho.',
        ...leituraDaIa,
      },
    }],
  };
}
const resp = (corpo, status = 200) => ({
  ok: status < 400, status,
  json: async () => corpo,
  text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
  clone() { return this; },
});
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return fetchReal(url, opts);
  if (u.includes('api.anthropic.com')) {
    chamadasAnthropic.push(JSON.parse(opts.body));
    return resp(respostaAnthropic());
  }
  if (u.includes('api.groq.com/openai/v1/chat/completions')) {
    const corpo = JSON.parse(opts.body);
    chamadasGroq.push(corpo);
    const r = groq(corpo);
    return resp(r.corpo, r.status);
  }
  throw new Error('chamada externa inesperada: ' + u);
};

let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});
async function api(metodo, rota, { chave, admin, corpo } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (chave) headers['x-cr-key'] = chave;
  if (admin) headers['x-admin-pass'] = 'senha-de-teste';
  const r = await fetchReal(base + rota, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
let n = 0;
/** Gera um report de um lead novo (conversa diferente a cada vez, para não cair na idempotência). */
const gerar0 = (...a) => gerar(...a);
async function gerar(chave, nome, leitura = {}) {
  leituraDaIa = leitura;
  const r = await api('POST', '/api/report-direto', {
    chave,
    corpo: {
      nome,
      mensagens: [
        { from: 'eu', type: 'texto', content: 'Oi, me conta do seu momento.' },
        { from: 'eles', type: 'texto', content: `Quero sair do CLT e procuro um passo a passo. (${++n})` },
      ],
    },
  });
  leituraDaIa = {};
  return r;
}
function textoDoPdf(base64) {
  const s = Buffer.from(base64, 'base64').toString('latin1');
  const linhas = [];
  for (const m of s.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    linhas.push(Buffer.from([...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]).join(''), 'hex').toString('latin1'));
  }
  return linhas.join('\n');
}

// ---------------------------------------------------------------- preparo
test('preparo: master, gestor, dois SDRs e a lista de closers (só o master mexe nela)', async () => {
  const criar = async (nome, papel) => (await api('POST', '/api/admin/usuarios', { admin: true, corpo: { nome, papel } })).json.usuario;
  E.master = (await criar('Cauã Master', 'master')).chave;
  E.gestor = (await criar('Líder Gestor', 'gestor')).chave;
  const ana = await criar('Ana SDR', 'sdr');
  E.ana = ana.chave;
  E.bia = (await criar('Bia SDR', 'sdr')).chave;

  assert.equal((await api('POST', '/api/admin/closers', { chave: E.gestor, corpo: { nome: 'Intruso' } })).status, 403, 'gestor não mexe em closers');
  assert.equal((await api('POST', '/api/admin/closers', { chave: E.ana, corpo: { nome: 'Intruso' } })).status, 403);
  E.vitor = (await api('POST', '/api/admin/closers', { chave: E.master, corpo: { nome: 'Vitor Santos', email: 'vitor@pronix.com' } })).json.closer.id;
  E.rafa = (await api('POST', '/api/admin/closers', { chave: E.master, corpo: { nome: 'Rafa Lima' } })).json.closer.id;
  assert.equal((await api('DELETE', '/api/admin/closers/' + E.rafa, { chave: E.gestor })).status, 403);

  // quem gera report vê só id e nome (sem e-mail)
  const lista = await api('GET', '/api/closers', { chave: E.ana });
  assert.deepEqual(lista.json.closers, [{ id: E.vitor, nome: 'Vitor Santos' }, { id: E.rafa, nome: 'Rafa Lima' }]);
  assert.equal((await api('GET', '/api/closers', {})).status, 401);
});

// ---------------------------------------------------------------- report com perfil e análise
test('report: a IA recebe a régua de consciência, de perfil e de análise; o perfil vira linha do resumo e a análise não vai para o SDR', async () => {
  chamadasAnthropic.length = 0;
  const r = await gerar(E.master, 'Marcos');
  assert.equal(r.status, 200);
  E.r1 = r.json.id;
  assert.match(E.r1, /^[0-9a-f]{10}$/);

  const system = chamadasAnthropic[0].system[0].text;
  for (const trecho of ['COMO CLASSIFICAR — teste de cima para baixo', 'ARMADILHAS', 'PERFIL DO LEAD', '"dominante" (Dominante)', 'ANÁLISE DA PROSPECÇÃO',
    'AS PERGUNTAS QUE DESTRAVARAM', 'RÉGUA DE QUALIFICAÇÃO (SPIN e BANT', 'Hendel Favarin e Josef Rubin', 'Método DVP'.toUpperCase().slice(0, 6)]) {
    assert.ok(system.includes(trecho), 'faltou no prompt: ' + trecho);
  }
  const schema = chamadasAnthropic[0].tools[0].input_schema;
  assert.deepEqual(schema.properties.perfil.properties.tipo.enum, ['dominante', 'analitico', 'cetico', 'relacional', 'cauteloso', 'entusiasta']);
  assert.ok(schema.required.includes('perfil') && schema.required.includes('analise'));

  assert.deepEqual(r.json.dados.perfil, { tipo: 'analitico', evidencia: 'Pediu os números antes de tudo.', conduzir: 'Trazer dados e o processo.' });
  assert.deepEqual(r.json.dados.resumo[r.json.dados.resumo.length - 1], { rotulo: 'Perfil', valor: 'Analítico — Trazer dados e o processo.' });
  assert.equal(r.json.dados.analise, undefined, 'a análise interna não vai para quem gerou');
  assert.ok(textoDoPdf(r.json.arquivoBase64).includes('Trazer dados e o processo'), 'o perfil está no PDF');

  // vem pronto para escolher o closer; sem histórico ainda não há indicação
  assert.equal(r.json.closers.length, 2);
  assert.equal(r.json.sugestaoCloser, null);
});

test('perfil: aceita apelidos e acentos; desconhecido fica de fora; não duplica a linha do resumo', () => {
  assert.equal(perfilMod.chaveDoPerfil('Analítico'), 'analitico');
  assert.equal(perfilMod.chaveDoPerfil('CÉTICO'), 'cetico');
  assert.equal(perfilMod.chaveDoPerfil('emocional'), 'relacional');
  assert.equal(perfilMod.chaveDoPerfil('apressado'), 'dominante');
  assert.equal(perfilMod.chaveDoPerfil('qualquer'), null);
  assert.equal(perfilMod.normalizarPerfil({ tipo: 'misterioso', evidencia: 'x' }), null);
  assert.equal(perfilMod.PERFIS.length, 6);

  const d = normalizarDados({ lead: 'X', resumo: [{ rotulo: 'Perfil', valor: 'já veio da IA' }], secoes: [], perfil: { tipo: 'cetico', evidencia: 'e', conduzir: 'c' } });
  aplicarPerfilNoResumo(d);
  assert.equal(d.resumo.length, 1, 'não duplica');
  const semPerfil = normalizarDados({ lead: 'X', resumo: [], secoes: [] });
  aplicarPerfilNoResumo(semPerfil);
  assert.deepEqual(semPerfil.resumo, [], 'report sem perfil sai como antes');
  assert.equal(semPerfil.analise, null);
});

// ---------------------------------------------------------------- o SDR escolhe o closer
test('quem gerou marca o closer do próprio report; de outra pessoa não; closer inexistente é recusado', async () => {
  const ok = await api('POST', `/api/reports/${E.r1}/closer`, { chave: E.master, corpo: { closerId: E.vitor } });
  assert.deepEqual(ok.json, { ok: true, closerNome: 'Vitor Santos' });
  assert.equal((await api('POST', `/api/reports/${E.r1}/closer`, { chave: E.bia, corpo: { closerId: E.rafa } })).status, 404, 'report de outra SDR');
  assert.equal((await api('POST', `/api/reports/${E.r1}/closer`, { chave: E.master, corpo: { closerId: 'naoexiste' } })).status, 400);
  assert.equal((await api('POST', '/api/reports/naoexiste/closer', { chave: E.master, corpo: { closerId: E.vitor } })).status, 404);
  assert.equal((await api('POST', `/api/reports/${E.r1}/closer`, { chave: E.gestor, corpo: { closerId: E.vitor } })).status, 200, 'gestor marca de qualquer um');
});

// ---------------------------------------------------------------- resultados da reunião (só o master)
test('resultados da reunião: só o master vê; traz perfil, consciência e closer; aceita os resultados novos e a anotação', async () => {
  assert.equal((await api('GET', '/api/master/resultados', { chave: E.gestor })).status, 403);
  assert.equal((await api('GET', '/api/master/resultados', { chave: E.ana })).status, 403);
  assert.equal((await api('GET', '/api/master/inteligencia', { chave: E.gestor })).status, 403);

  const lista = await api('GET', '/api/master/resultados', { chave: E.master });
  assert.equal(lista.status, 200);
  const linha = lista.json.reports.find((x) => x.id === E.r1);
  assert.equal(linha.perfil, 'analitico');
  assert.equal(linha.consciencia, 'solucao');
  assert.equal(linha.conscienciaPorque, 'Disse que procura um passo a passo para começar.');
  assert.equal(linha.closerNome, 'Vitor Santos');
  assert.equal(linha.usuarioNome, 'Cauã Master');
  assert.deepEqual(lista.json.closers.map((c) => c.nome), ['Vitor Santos', 'Rafa Lima']);

  const salvar = (corpo) => api('PATCH', `/api/admin/reports/${E.r1}/resultado`, { chave: E.master, corpo });
  assert.equal((await salvar({ resultado: 'no_show' })).status, 200);
  assert.equal((await salvar({ resultado: 'sem_venda', obsReuniao: '  Travou   no sócio  ' })).status, 200);
  assert.equal((await salvar({ perfilReal: 'Cético' })).status, 200);
  const depois = (await api('GET', '/api/master/resultados', { chave: E.master })).json.reports.find((x) => x.id === E.r1);
  assert.equal(depois.resultado, 'sem_venda');
  assert.equal(depois.obsReuniao, 'Travou no sócio');
  assert.equal(depois.perfilReal, 'cetico');
  await salvar({ resultado: 'inventado' });
  assert.equal((await api('GET', '/api/master/resultados', { chave: E.master })).json.reports.find((x) => x.id === E.r1).resultado, '', 'resultado desconhecido não é gravado');
  await salvar({ resultado: 'sem_venda', perfilReal: '' });
});

test('resultados: do mesmo lead gerado duas vezes no dia, aparece só o último', async () => {
  const a = await gerar(E.master, 'Lead Repetido');
  const b = await gerar(E.master, 'Lead Repetido');
  const ids = (await api('GET', '/api/master/resultados', { chave: E.master })).json.reports.map((x) => x.id);
  assert.ok(ids.includes(b.json.id) && !ids.includes(a.json.id));
});

// ---------------------------------------------------------------- a IA aprende o nível de consciência
test('corrigir o nível de consciência ensina a IA: a correção entra no prompt dos próximos reports', async () => {
  chamadasAnthropic.length = 0;
  await gerar(E.master, 'Antes da correção');
  assert.ok(!chamadasAnthropic[0].system[0].text.includes('CALIBRAGEM DO NÍVEL DE CONSCIÊNCIA'));

  const r = await api('PATCH', `/api/admin/reports/${E.r1}/resultado`, {
    chave: E.master, corpo: { conscienciaReal: 'problema', notaConsciencia: 'Só falou da dor, não disse que procura ajuda.' },
  });
  assert.equal(r.status, 200);
  // marcar de novo o mesmo nível não cria outro exemplo
  await api('PATCH', `/api/admin/reports/${E.r1}/resultado`, { chave: E.master, corpo: { conscienciaReal: 'problema' } });

  chamadasAnthropic.length = 0;
  await gerar(E.master, 'Depois da correção');
  const system = chamadasAnthropic[0].system[0].text;
  assert.match(system, /CALIBRAGEM DO NÍVEL DE CONSCIÊNCIA/);
  assert.match(system, /Evidência: "Disse que procura um passo a passo para começar\." → a IA classificou "solucao" \(Consciente da solução\); o certo é "problema" \(Consciente do problema\)\. Motivo: Só falou da dor/);
  assert.equal((system.match(/→ a IA classificou/g) || []).length, 1, 'um exemplo por report');
  assert.ok(system.indexOf('CALIBRAGEM') < system.indexOf('EXEMPLO A'), 'fica no prefixo fixo (cacheado), antes dos exemplos');

  const intel = await api('GET', '/api/master/inteligencia', { chave: E.master });
  assert.equal(intel.json.calibragens, 1);
  const linha = (await api('GET', '/api/master/resultados', { chave: E.master })).json.reports.find((x) => x.id === E.r1);
  assert.equal(linha.conscienciaReal, 'problema');
});

// ---------------------------------------------------------------- inteligência (conta pura)
const rep = (closerId, closerNome, perfil, resultado, extra = {}) => ({ closerId, closerNome, perfil, resultado, ...extra });
const VENDA = 'venda_call';
const HISTORICO = [
  // Vitor: forte com analítico (3 de 4), fraco com relacional (0 de 3)
  rep('v', 'Vitor', 'analitico', VENDA), rep('v', 'Vitor', 'analitico', VENDA), rep('v', 'Vitor', 'analitico', 'venda_fup'), rep('v', 'Vitor', 'analitico', 'sem_venda'),
  rep('v', 'Vitor', 'relacional', 'sem_venda'), rep('v', 'Vitor', 'relacional', 'no_show'), rep('v', 'Vitor', 'relacional', 'sem_venda'),
  // Rafa: forte com relacional (3 de 3); 1 de 1 com analítico (amostra pequena)
  rep('r', 'Rafa', 'relacional', VENDA), rep('r', 'Rafa', 'relacional', VENDA), rep('r', 'Rafa', 'relacional', 'pix_compromisso'),
  rep('r', 'Rafa', 'analitico', VENDA),
  // não entram: sem resultado, e sem closer
  rep('r', 'Rafa', 'cetico', ''), rep('', '', 'cetico', VENDA),
  // closer que saiu da casa: 5 de 5 com analítico
  ...Array.from({ length: 5 }, () => rep('x', 'Ex-closer', 'analitico', VENDA)),
];
const ATIVOS = [{ id: 'v', nome: 'Vitor' }, { id: 'r', nome: 'Rafa' }];

test('indicação de closer: sai do histórico, exige amostra mínima e ignora quem saiu da casa', () => {
  const an = inteligencia.sugerirCloser(HISTORICO, 'analitico', ATIVOS);
  assert.deepEqual(an.sugestao, { closerId: 'v', nome: 'Vitor' }, 'Rafa tem 1 de 1: amostra pequena não passa na frente de 3 de 4');
  assert.equal(an.motivo, 'Vitor fechou 3 de 4 reuniões com lead analítico.');
  assert.ok(!an.ranking.some((c) => c.closerId === 'x'), 'ex-closer fora, mesmo com 5 de 5');

  const rel = inteligencia.sugerirCloser(HISTORICO, 'relacional', ATIVOS);
  assert.deepEqual(rel.sugestao, { closerId: 'r', nome: 'Rafa' });
  assert.equal(rel.motivo, 'Rafa fechou 3 de 3 reuniões com lead relacional.');

  const cet = inteligencia.sugerirCloser(HISTORICO, 'cetico', ATIVOS);
  assert.equal(cet.sugestao, null, 'sem dados: não indica ninguém (nada de achismo)');
  assert.match(cet.motivo, /Ainda sem dados suficientes de reuniões com lead cético/);
  assert.equal(inteligencia.sugerirCloser(HISTORICO, '', ATIVOS).sugestao, null);
  assert.equal(inteligencia.sugerirCloser([], 'analitico', ATIVOS).sugestao, null);
});

test('correção do master vale mais que a leitura da IA no cruzamento', () => {
  const lista = [
    rep('v', 'Vitor', 'analitico', VENDA, { perfilReal: 'cetico' }),
    rep('v', 'Vitor', 'analitico', VENDA, { perfilReal: 'cetico' }),
    rep('v', 'Vitor', 'analitico', VENDA, { perfilReal: 'cetico' }),
  ];
  assert.deepEqual(inteligencia.sugerirCloser(lista, 'cetico', ATIVOS).sugestao, { closerId: 'v', nome: 'Vitor' });
  assert.equal(inteligencia.sugerirCloser(lista, 'analitico', ATIVOS).sugestao, null);
});

test('painel: matriz closer × perfil, conversão por perfil e por consciência, e o que difere na prospecção que fecha', () => {
  const analise = (imp, orc) => ({
    bant: { orcamento: orc ? 'sim' : 'nao', autoridade: 'sim', necessidade: 'sim', prazo: 'nao' },
    spin: { situacao: true, problema: true, implicacao: imp, necessidade: false },
    perguntasChave: imp ? ['Se nada mudar, como fica em 6 meses?'] : ['Você tem CNPJ?'],
    abordagem: imp ? 'Explorou a implicação antes de apresentar.' : 'Foi direto ao preço.',
  });
  const lista = [
    rep('v', 'Vitor', 'analitico', VENDA, { consciencia: 'produto', analise: analise(true, true) }),
    rep('v', 'Vitor', 'analitico', VENDA, { consciencia: 'produto', analise: analise(true, true) }),
    rep('v', 'Vitor', 'analitico', VENDA, { consciencia: 'pronto', analise: analise(true, false) }),
    rep('v', 'Vitor', 'relacional', 'sem_venda', { consciencia: 'problema', analise: analise(false, true) }),
    rep('r', 'Rafa', 'relacional', 'em_followup', { consciencia: 'problema', conscienciaReal: 'inconsciente', analise: analise(false, false) }),
    rep('r', 'Rafa', 'relacional', 'no_show', { consciencia: 'pronto', analise: analise(true, true) }), // no-show: a reunião não aconteceu, fora
    rep('r', 'Rafa', 'relacional', '', { consciencia: 'pronto', analise: analise(true, true) }), // sem resultado: fora
  ];
  const p = inteligencia.painel(lista, ATIVOS);
  assert.equal(p.reunioesComResultado, 5);
  assert.equal(p.vendas, 3);
  const vitor = p.matriz.find((c) => c.closerId === 'v');
  assert.deepEqual(vitor.perfis.analitico, { total: 3, vendas: 3, taxa: 1 });
  assert.deepEqual(vitor.perfis.relacional, { total: 1, vendas: 0, taxa: 0 });
  assert.deepEqual(p.porPerfil.map((x) => [x.chave, x.vendas, x.total]), [['analitico', 3, 3], ['relacional', 0, 2]]);
  assert.deepEqual(
    p.porConsciencia.map((x) => [x.chave, x.vendas, x.total]).sort(),
    [['inconsciente', 0, 1], ['problema', 0, 1], ['produto', 2, 2], ['pronto', 1, 1]],
    'a correção do master (inconsciente) vale no lugar da leitura da IA'
  );
  assert.deepEqual(p.melhorCloserPorPerfil.find((m) => m.perfil === 'analitico').sugestao, { closerId: 'v', nome: 'Vitor' });

  const imp = p.prospeccao.criterios.find((c) => c.chave === 'spin.implicacao');
  assert.deepEqual([imp.ganhou, imp.perdeu], [1, 0], 'implicação apareceu em 100% das que fecharam e em 0% das que não');
  assert.equal(p.prospeccao.criterios[0].chave, 'spin.implicacao', 'o que mais diferencia vem primeiro');
  assert.equal(p.prospeccao.suficiente, true);
  assert.deepEqual([...new Set(p.prospeccao.perguntasQueFecharam.map((x) => x.pergunta))], ['Se nada mudar, como fica em 6 meses?']);

  const pouco = inteligencia.painel(lista.slice(0, 2), ATIVOS);
  assert.equal(pouco.prospeccao.suficiente, false, 'pouca amostra: avisa que é só indício');
});

// ---------------------------------------------------------------- do histórico real para a extensão
test('com histórico, o report já vem com o closer indicado para o perfil do lead', async () => {
  // 3 reuniões de lead analítico com o Vitor, todas com venda
  for (let i = 0; i < 3; i++) {
    const r = await gerar(E.master, 'Analítico ' + i);
    await api('POST', `/api/reports/${r.json.id}/closer`, { chave: E.master, corpo: { closerId: E.vitor } });
    await api('PATCH', `/api/admin/reports/${r.json.id}/resultado`, { chave: E.master, corpo: { resultado: 'venda_call' } });
  }
  const novo = await gerar(E.master, 'Lead novo analítico');
  assert.deepEqual(novo.json.sugestaoCloser, { closerId: E.vitor, nome: 'Vitor Santos' });
  assert.equal(novo.json.motivoSugestao, 'Vitor Santos fechou 3 de 4 reuniões com lead analítico.');

  const outro = await gerar(E.master, 'Lead novo cético', { perfil: { tipo: 'cetico', evidencia: 'e', conduzir: 'c' } });
  assert.equal(outro.json.sugestaoCloser, null, 'perfil sem histórico: sem indicação');

  const sug = await api('GET', '/api/closers?perfil=analitico', { chave: E.master });
  assert.deepEqual(sug.json.sugestao, { closerId: E.vitor, nome: 'Vitor Santos' });

  const intel = await api('GET', '/api/master/inteligencia', { chave: E.master });
  assert.equal(intel.json.matriz.find((c) => c.nome === 'Vitor Santos').perfis.analitico.vendas, 3);
});

// ---------------------------------------------------------------- insights (IA gratuita)
test('insights: recusa com poucas reuniões; com dados, manda SÓ números e perguntas para a IA gratuita', async () => {
  // até aqui: 1 sem_venda + 3 vendas = 4 reuniões com resultado
  const cedo = await api('POST', '/api/master/insights', { chave: E.master });
  assert.equal(cedo.status, 400);
  assert.match(cedo.json.erro, /pelo menos 5 reuniões/);

  // no-show não é reunião: não conta para chegar às 5
  const faltou = await gerar(E.master, 'Lead que faltou');
  await api('PATCH', `/api/admin/reports/${faltou.json.id}/resultado`, { chave: E.master, corpo: { resultado: 'no_show' } });
  assert.equal((await api('POST', '/api/master/insights', { chave: E.master })).status, 400);
  const r = await gerar(E.master, 'Quinto lead');
  await api('PATCH', `/api/admin/reports/${r.json.id}/resultado`, { chave: E.master, corpo: { resultado: 'em_followup' } });

  chamadasGroq.length = 0;
  groq = () => ({
    status: 200,
    corpo: { choices: [{ message: { content: JSON.stringify({
      closer_por_perfil: ['Vitor com analítico: 3 de 3.'],
      prospeccao_que_funciona: ['Implicação apareceu nas que fecharam.'],
      perguntas_para_o_padrao: ['Se nada mudar em 6 meses, como fica?'],
      melhorias_no_script: ['Perguntar do decisor antes do investimento.', ''],
      atencao: ['Amostra pequena.'],
    }) } }] },
  });
  assert.equal((await api('POST', '/api/master/insights', { chave: E.gestor })).status, 403);
  const ok = await api('POST', '/api/master/insights', { chave: E.master });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.insights.perguntasParaOPadrao, ['Se nada mudar em 6 meses, como fica?']);
  assert.deepEqual(ok.json.insights.melhoriasNoScript, ['Perguntar do decisor antes do investimento.']);
  assert.equal(ok.json.insights.baseadoEm, 5);

  const pedido = chamadasGroq[0];
  assert.equal(pedido.model, 'openai/gpt-oss-120b');
  const enviado = pedido.messages[1].content;
  assert.match(enviado, /Vitor Santos: Analítico 3\/4/);
  assert.match(enviado, /Se nada mudar em 6 meses, como fica\?/);
  assert.ok(!/Quero sair do CLT/.test(enviado), 'a fala dos leads não vai para a IA gratuita');
  assert.ok(!/chave-falsa/.test(JSON.stringify(pedido)));

  // fica guardado: abrir a aba mostra o último sem gerar de novo
  assert.deepEqual((await api('GET', '/api/master/inteligencia', { chave: E.master })).json.insights.atencao, ['Amostra pequena.']);
});

// ---------------------------------------------------------------- fila de modelos gratuitos
test('IA gratuita: modelo fora do ar ou no limite passa para o próximo; tudo no limite vira aviso claro', async () => {
  chamadasGroq.length = 0;
  groq = (c) => (c.model === 'openai/gpt-oss-120b'
    ? { status: 404, corpo: { error: { message: 'The model does not exist' } } }
    : { status: 200, corpo: { choices: [{ message: { content: '{"ok":1}' } }] } });
  assert.equal(await chatGroq({ system: 's', user: 'u' }), '{"ok":1}');
  assert.deepEqual(chamadasGroq.map((c) => c.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.equal(chamadasGroq[0].reasoning_effort, 'low');
  assert.deepEqual(chamadasGroq[0].response_format, { type: 'json_object' });

  // parâmetro recusado (400): tenta de novo no mesmo modelo, sem os extras
  chamadasGroq.length = 0;
  groq = (c) => (c.response_format
    ? { status: 400, corpo: { error: { message: 'response_format is unsupported' } } }
    : { status: 200, corpo: { choices: [{ message: { content: 'texto' } }] } });
  assert.equal(await chatGroq({ system: 's', user: 'u' }), 'texto');
  assert.deepEqual(chamadasGroq.map((c) => [c.model, Boolean(c.response_format)]), [['openai/gpt-oss-120b', true], ['openai/gpt-oss-120b', false]]);

  // modelo escolhido pelo admin vem primeiro
  chamadasGroq.length = 0;
  groq = () => ({ status: 200, corpo: { choices: [{ message: { content: 'x' } }] } });
  await chatGroq({ system: 's', user: 'u', modelo: 'meu/modelo' });
  assert.equal(chamadasGroq[0].model, 'meu/modelo');
  assert.equal(chamadasGroq[0].reasoning_effort, undefined);

  // limite em todos
  chamadasGroq.length = 0;
  groq = () => ({ status: 429, corpo: { error: { message: 'rate limit' } } });
  await assert.rejects(() => chatGroq({ system: 's', user: 'u' }), /limite gratuito da IA foi atingido/);
  assert.equal(chamadasGroq.length, 4, 'tentou a fila inteira');

  groq = () => ({ status: 401, corpo: {} });
  await assert.rejects(() => chatGroq({ system: 's', user: 'u' }), /GROQ_API_KEY inválida/);
  groq = () => ({ status: 200, corpo: { choices: [{ message: { content: '{}' } }] } });
});

// ---------------------------------------------------------------- base de conhecimento
const arqBase = () => path.join(DADOS, 'base.json');

test('base: sem nada gravado vale a recomendada; ela cita a empresa, os sócios, SPIN e BANT', async () => {
  if (fs.existsSync(arqBase())) fs.rmSync(arqBase());
  const b = await baseMod.ler();
  assert.equal(b.recomendada, true);
  assert.equal(b.temAnterior, false);
  assert.deepEqual(baseMod.CAMPOS, ['empresa', 'oferta', 'perfil', 'script', 'qualificacao', 'objecoes']);
  for (const c of baseMod.CAMPOS) assert.ok(b[c].length > 800 && b[c].length <= baseMod.LIMITE_CAMPO, c + ' com conteúdo e dentro do limite');
  assert.match(b.empresa, /Hugo Vasconcelos/);
  assert.match(b.empresa, /Gustavo Dias/);
  assert.match(b.empresa, /Hendel Favarin e Josef Rubin/);
  assert.match(b.empresa, /DEMANDA[\s\S]*VIABILIDADE[\s\S]*POSICIONAMENTO/);
  assert.match(b.oferta, /PRX PERFORMANCE[\s\S]*12x de R\$1\.332 a R\$1\.552[\s\S]*PRX ACELERA[\s\S]*12x R\$2\.491/);
  assert.match(b.oferta, /NÃO é "resultado garantido"/, 'a garantia vai como está no contrato');
  // aprendizados das reuniões que fecharam
  assert.match(b.script, /O QUE O CLOSER REALMENTE USA DO RELATÓRIO[\s\S]*LIQUIDEZ[\s\S]*TETO TOTAL[\s\S]*CARTÃO[\s\S]*EXPERIÊNCIA ANTERIOR[\s\S]*CONCORRENTE/);
  assert.match(b.qualificacao, /O que te fez procurar isso AGORA[\s\S]*Se eu te desse R\$3\.000 hoje[\s\S]*O que faltou lá\?/);
  assert.match(b.objecoes, /não tenho esse valor agora[\s\S]*é a parcela ou o total\?[\s\S]*não prometa data/);
  assert.match(b.perfil, /COMO CADA PERFIL DE LEAD COSTUMA FECHAR[\s\S]*Analítico[\s\S]*Cético[\s\S]*Cauteloso/);
  // nada de dado de cliente das reuniões analisadas na base
  const tudo = JSON.stringify(PADRAO);
  for (const nome of ['Natan', 'Glauco', 'Fernanda', 'Rigon', 'Paroneti', 'Eliane', 'Alisson Leonardo', 'Anderson', 'Hinterholz', 'Polese', 'David Araujo', 'Hullarr']) {
    assert.ok(!tudo.includes(nome), 'nome de cliente não entra na base: ' + nome);
  }
  assert.ok(!/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/.test(tudo), 'sem CPF');
  assert.match(b.oferta, /70% dos encontros/);
  assert.match(b.qualificacao, /NECESSIDADE[\s\S]*ORÇAMENTO[\s\S]*AUTORIDADE[\s\S]*PRAZO/);
  assert.match(b.qualificacao, /SITUAÇÃO[\s\S]*PROBLEMA[\s\S]*IMPLICAÇÃO[\s\S]*NECESSIDADE DE SOLUÇÃO/);
  assert.match(b.script, /DEDICAÇÃO[\s\S]*DIREÇÃO[\s\S]*INVESTIMENTO ASSERTIVO/);
  assert.ok(!/última linha|10K à vista|9,5k/i.test(JSON.stringify(PADRAO)), 'pisos de negociação não entram na base');
  assert.ok(!fs.existsSync(arqBase()), 'ler não grava nada');
});

test('base antiga (4 campos) passa para a recomendada uma vez, guardando os textos; dá para restaurar e para editar', async () => {
  fs.writeFileSync(arqBase(), JSON.stringify({ script: 'ROTEIRO ANTIGO', oferta: 'OFERTA ANTIGA', objecoes: '', perfil: 'PERFIL ANTIGO', atualizadoEm: '2026-09-01T10:00:00.000Z' }));
  const b = await baseMod.ler();
  assert.equal(b.script, PADRAO.script);
  assert.equal(b.temAnterior, true);
  const gravado = JSON.parse(fs.readFileSync(arqBase(), 'utf8'));
  assert.equal(gravado.versao, 3);
  assert.deepEqual(gravado.anterior, { script: 'ROTEIRO ANTIGO', oferta: 'OFERTA ANTIGA', perfil: 'PERFIL ANTIGO', atualizadoEm: '2026-09-01T10:00:00.000Z' });

  // pelo painel: gestor edita um campo; os outros ficam
  const s = await api('POST', '/api/admin/base', { chave: E.gestor, corpo: { empresa: '  Empresa editada  ' } });
  assert.equal(s.json.base.empresa, 'Empresa editada');
  assert.equal(s.json.base.script, PADRAO.script);
  assert.equal(s.json.base.recomendada, false);

  const rest = await api('POST', '/api/admin/base/restaurar', { chave: E.master });
  assert.equal(rest.json.base.script, 'ROTEIRO ANTIGO');
  assert.equal(rest.json.base.oferta, 'OFERTA ANTIGA');
  assert.equal(rest.json.base.objecoes, PADRAO.objecoes, 'campo que estava vazio antes continua com o recomendado');
  assert.equal(rest.json.base.empresa, 'Empresa editada', 'restaurar não mexe nos campos novos');

  const um = await api('POST', '/api/admin/base/recomendada', { chave: E.master, corpo: { campo: 'script' } });
  assert.equal(um.json.base.script, PADRAO.script);
  assert.equal(um.json.base.oferta, 'OFERTA ANTIGA');
  const todos = await api('POST', '/api/admin/base/recomendada', { chave: E.master, corpo: {} });
  assert.equal(todos.json.base.recomendada, true);
  assert.equal((await api('POST', '/api/admin/base/recomendada', { chave: E.ana, corpo: {} })).status, 401);

  // segunda leitura não "passa de versão" de novo
  assert.equal((await baseMod.ler()).temAnterior, true);
  fs.rmSync(arqBase());
  assert.equal((await api('POST', '/api/admin/base/restaurar', { chave: E.master })).status, 400);
});

test('/api/eu diz o que o master liberou para a chave (a extensão mostra no popup)', async () => {
  const m = await api('GET', '/api/eu', { chave: E.master });
  assert.equal(m.json.coach, true);
  assert.equal(m.json.fichaCrm, true);
  const s = await api('GET', '/api/eu', { chave: E.ana });
  assert.equal(s.json.coach, false);
});

// ---------------------------------------------------------------- por enquanto, só os leads do master
test('resultados e inteligência usam só os reports do master; a equipe entra apenas com escopo=todos', async () => {
  const daAna = await gerar0(E.ana, 'Lead da Ana');
  assert.deepEqual(daAna.json.closers, [], 'SDR não recebe a escolha de closer no aviso final');
  assert.equal(daAna.json.sugestaoCloser, null);
  // a Ana ainda consegue marcar pelo próprio report (rota), mas isso não entra nos dados do master
  await api('POST', `/api/reports/${daAna.json.id}/closer`, { chave: E.ana, corpo: { closerId: E.rafa } });
  await api('PATCH', `/api/admin/reports/${daAna.json.id}/resultado`, { chave: E.master, corpo: { resultado: 'venda_call' } });

  const meus = (await api('GET', '/api/master/resultados', { chave: E.master })).json.reports;
  assert.ok(meus.length > 0 && meus.every((r) => r.usuarioNome === 'Cauã Master'));
  assert.ok(!meus.some((r) => r.id === daAna.json.id));
  const todos = (await api('GET', '/api/master/resultados?escopo=todos', { chave: E.master })).json.reports;
  assert.ok(todos.some((r) => r.id === daAna.json.id));
  // pela senha reserva não existe "meus": vem a equipe
  assert.ok((await api('GET', '/api/master/resultados', { admin: true })).json.reports.some((r) => r.id === daAna.json.id));

  const intelMeus = (await api('GET', '/api/master/inteligencia', { chave: E.master })).json;
  const intelTodos = (await api('GET', '/api/master/inteligencia?escopo=todos', { chave: E.master })).json;
  assert.equal(intelTodos.reunioesComResultado, intelMeus.reunioesComResultado + 1);
  assert.ok(!intelMeus.matriz.some((c) => c.nome === 'Rafa Lima'), 'a venda do lead da Ana não entra na conta do master');
  assert.ok(intelTodos.matriz.some((c) => c.nome === 'Rafa Lima'));
});

test('base v2 → v3: campo que ninguém editou recebe o texto novo; o que o master escreveu fica', async () => {
  const { PADROES_ANTIGOS } = require('../src/baseInicial');
  const crypto = require('crypto');
  const digital = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
  // simula um texto recomendado antigo: qualquer texto cuja impressão digital esteja na lista
  const antigo = 'TEXTO RECOMENDADO ANTIGO';
  PADROES_ANTIGOS.add(digital(antigo));
  fs.writeFileSync(arqBase(), JSON.stringify({
    versao: 2, empresa: antigo, oferta: antigo, perfil: 'PERFIL QUE O MASTER ESCREVEU', script: antigo, qualificacao: '', objecoes: antigo,
    anterior: { script: 'ROTEIRO DA V1' }, atualizadoEm: '2026-10-03T10:00:00.000Z',
  }));
  const b = await baseMod.ler();
  assert.equal(b.empresa, PADRAO.empresa);
  assert.equal(b.script, PADRAO.script);
  assert.equal(b.qualificacao, PADRAO.qualificacao, 'campo vazio também recebe o recomendado');
  assert.equal(b.perfil, 'PERFIL QUE O MASTER ESCREVEU', 'edição do master não é sobrescrita');
  assert.equal(b.recomendada, false);
  const gravado = JSON.parse(fs.readFileSync(arqBase(), 'utf8'));
  assert.equal(gravado.versao, 3);
  assert.deepEqual(gravado.anterior, { script: 'ROTEIRO DA V1' }, 'o que estava guardado da v1 continua restaurável');
  assert.equal((await baseMod.ler()).perfil, 'PERFIL QUE O MASTER ESCREVEU', 'segunda leitura não mexe de novo');
  PADROES_ANTIGOS.delete(digital(antigo));
  fs.rmSync(arqBase());
});

test('perfil: o "como conduzir" traz o que funcionou nas reuniões (garantia como no contrato para o cético)', () => {
  const p = (k) => perfilMod.infoDoPerfil(k).conduzir;
  assert.match(p('cetico'), /garantia exatamente como está no contrato/);
  assert.match(p('analitico'), /lucro e retorno \(não de faturamento\)/);
  assert.match(p('cauteloso'), /forma de pagamento que ele sustente/);
  assert.match(p('dominante'), /responder direto/);
});

// ---------------------------------------------------------------- no-show fora do .zip do dia
test('no-show não vai para o líder: sai do .zip do dia e aparece desmarcado na lista', async () => {
  const foi = await gerar(E.master, 'Lead Que Foi ' + Date.now());
  const faltou = await gerar(E.master, 'Lead Que Faltou ' + Date.now());
  await api('PATCH', `/api/admin/reports/${faltou.json.id}/resultado`, { chave: E.master, corpo: { resultado: 'no_show' } });

  const lista = (await api('GET', '/api/meus-reports', { chave: E.master })).json.reports;
  const doQueFaltou = lista.find((r) => r.id === faltou.json.id);
  const doQueFoi = lista.find((r) => r.id === foi.json.id);
  assert.deepEqual([doQueFaltou.usar, doQueFaltou.noShow], [false, true]);
  assert.deepEqual([doQueFoi.usar, doQueFoi.noShow], [true, false]);
  const equipe = (await api('GET', '/api/equipe-reports', { chave: E.master })).json.reports;
  assert.equal(equipe.find((r) => r.id === faltou.json.id).usar, false);

  const z = await fetch(base + '/api/meus-reports/zip', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cr-key': E.master }, body: '{}' });
  assert.equal(z.status, 200);
  const noZip = lista.filter((r) => r.usar).length;
  assert.equal(Number(z.headers.get('X-Reports-No-Zip')), noZip, 'o .zip leva só os que valem (sem o no-show)');
  await z.arrayBuffer();

  // desfeito o no-show, volta a valer
  await api('PATCH', `/api/admin/reports/${faltou.json.id}/resultado`, { chave: E.master, corpo: { resultado: '' } });
  assert.equal((await api('GET', '/api/meus-reports', { chave: E.master })).json.reports.find((r) => r.id === faltou.json.id).usar, true);
});

// ---------------------------------------------------------------- "cauteloso" não é o perfil padrão
test('perfil: report e coach recebem o mesmo critério de decisão, e "cauteloso" exige hesitação dita', () => {
  const regra = perfilMod.comoDecidirPerfil();
  const ordem = ['"cetico"', '"analitico"', '"dominante"', '"entusiasta"', '"relacional"', '"cauteloso"'].map((x) => regra.indexOf(x));
  assert.ok(ordem.every((p, i) => p > -1 && (i === 0 || p > ordem[i - 1])), 'testa os perfis em ordem, com o cauteloso por último');
  assert.match(regra, /"cauteloso": SÓ com hesitação dita/);
  assert.match(regra, /"cauteloso" não é o perfil padrão[\s\S]*confirmar a reunião[\s\S]*decide sozinho NÃO é cautela/);
  assert.equal(regra.split('\n').length, 8);
  const { SYSTEM_PROMPT, PROMPT_VERSAO } = require('../src/report');
  assert.equal(PROMPT_VERSAO, 'v7');
  assert.ok(SYSTEM_PROMPT.includes(regra), 'o report usa o critério');
  assert.ok(require('../src/coach').SYSTEM_BASE.includes(regra), 'o coach usa o mesmo');
});
