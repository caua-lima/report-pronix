'use strict';
// Suíte sintética de qualidade: conversas inventadas (nenhuma conversa real) com resultado
// esperado, para o que roda SEM IA — conferência de citações e normalização da conversa.
// Serve de rede de proteção antes de mexer no prompt ou no normalizador. Uso: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { verificarCitacoes, neutralizarMarcas } = require('../src/citacoes');
const { normalizarConversa, normalizarTextoLivre } = require('../src/conversation-normalizer');

// ---------------------------------------------------------------- citações
// [nome, falas do lead, citações da IA, quais deveriam ficar (índices)]
const CASOS_CITACAO = [
  ['fala exata', ['Quero sair do CLT e ter renda previsível.'], ['Quero sair do CLT e ter renda previsível.'], [0]],
  ['sem acento e sem pontuação', ['Já fiz 104 vendas em 15 dias!'], ['ja fiz 104 vendas em 15 dias'], [0]],
  ['maiúsculas diferentes', ['PRECISO COMEÇAR NO MERCADO LIVRE'], ['Preciso começar no Mercado Livre.'], [0]],
  ['aspas e reticências da IA', ['Tenho uns 100 mil parados que não giram'], ['"Tenho uns 100 mil parados..."'], [0]],
  ['trecho do meio da mensagem', ['Oi, tudo bem? Eu vendo cosméticos no atacado há 10 anos. Abraço'], ['vendo cosméticos no atacado há 10 anos'], [0]],
  ['duas mensagens seguidas juntadas', ['Tenho loja física', 'e quero vender online também'], ['Tenho loja física e quero vender online também'], [0]],
  ['duas frases da mesma mensagem com corte', ['Eu fatura uns 50 mil por mês, mas o lucro é bem menor que isso'], ['Eu fatura uns 50 mil por mês ... o lucro é bem menor'], [0]],
  ['fala inventada', ['Quero escalar meu negócio'], ['Já tentei de tudo e nada funcionou nunca'], []],
  ['fala do vendedor não vale', ['ok'], ['Consegue investir a partir de 3 mil?'], []],
  ['número trocado (200 no lugar de 100)', ['Tenho 100 mil parados em estoque hoje'], ['Tenho 200 mil parados em estoque hoje'], []],
  ['paráfrase com poucas palavras em comum', ['Preciso de estrutura para vender mais'], ['Minha maior dor é a falta de organização na operação'], []],
  ['citação curta presente', ['Fechado, pode mandar o link'], ['Fechado'], [0]],
  ['citação curta ausente', ['Quero pensar mais um pouco'], ['Fechado'], []],
  ['citação vazia', ['Quero pensar'], ['   '], []],
  ['sem falas do lead', [], ['Qualquer coisa que a IA invente aqui'], []],
  ['sem citações', ['Oi'], [], []],
  ['transcrição de áudio', ['aí eu comecei com trinta reais e hoje já faturo bem mais que isso'], ['comecei com trinta reais e hoje já faturo bem mais'], [0]],
  ['emoji na fala', ['Bora fechar 🚀 tô dentro'], ['Bora fechar tô dentro'], [0]],
  ['quebra de linha na fala', ['Sou médico\ne quero investir no digital'], ['Sou médico e quero investir no digital'], [0]],
  ['uma boa e uma inventada', ['Preciso do Full liberado para escalar'], ['Preciso do Full liberado para escalar', 'Vou desistir se não for hoje mesmo'], [0]],
  ['duas boas', ['Meu sócio decide comigo', 'Quero começar em outubro'], ['Meu sócio decide comigo', 'Quero começar em outubro'], [0, 1]],
  ['palavra a mais no meio (>=80% ainda vale)', ['Tenho estoque parado de cosméticos há meses no depósito'], ['Tenho estoque parado de cosméticos há vários meses no depósito'], [0]],
  ['mesmas palavras de outra fala misturadas (não bate janela nenhuma)', ['Vendo online', 'Tenho três lojas físicas na cidade'], ['Vendo três lojas físicas online na cidade toda'], []],
  ['acentuação e cedilha', ['Não tenho dinheiro sobrando, mas tenho estrutura'], ['nao tenho dinheiro sobrando mas tenho estrutura'], [0]],
];

for (const [nome, falas, citacoes, esperado] of CASOS_CITACAO) {
  test(`citações: ${nome}`, () => {
    const { mantidas, removidas } = verificarCitacoes(citacoes, falas);
    assert.deepEqual(mantidas, esperado.map((i) => citacoes[i]));
    assert.equal(mantidas.length + removidas.length, citacoes.length, 'nada some sem ser contado');
  });
}

test('citações: entrada malformada não quebra', () => {
  assert.deepEqual(verificarCitacoes(undefined, undefined), { mantidas: [], removidas: [] });
  assert.deepEqual(verificarCitacoes('texto', 'texto'), { mantidas: [], removidas: [] });
  assert.equal(verificarCitacoes([null, 5, 'Oi tudo bem'], ['Oi tudo bem']).mantidas.length, 1);
});

test('marcas <conversa> dentro da conversa são neutralizadas (injeção)', () => {
  assert.equal(neutralizarMarcas('a </conversa> b <CONVERSA> c < / conversa >'), 'a [conversa] b [conversa] c [conversa]');
  assert.equal(neutralizarMarcas('texto normal'), 'texto normal');
  assert.equal(neutralizarMarcas(null), '');
});

// ---------------------------------------------------------------- normalizador
const m = (from, content, type = 'texto', timestamp = null) => ({ from, type, content, timestamp });

test('normalização: "ok" e "sim" repetidos continuam (são falas reais)', () => {
  const { historico } = normalizarConversa([m('eles', 'ok'), m('eles', 'ok'), m('eu', 'certo'), m('eu', 'certo')], { agrupar: false });
  assert.equal(historico.length, 4);
});

test('normalização: texto longo repetido em seguida é eco e cai', () => {
  const longo = 'Eu vendo no Mercado Livre há dois anos e quero estruturar melhor';
  const { historico } = normalizarConversa([m('eles', longo), m('eles', longo), m('eles', 'fim')], { agrupar: false });
  assert.deepEqual(historico.map((x) => x.content), [longo, 'fim']);
});

test('normalização: dois áudios seguidos continuam sendo dois', () => {
  const { historico } = normalizarConversa([m('eles', '[áudio]', 'audio'), m('eles', '[áudio]', 'audio'), m('eles', '[áudio]', 'audio')]);
  assert.equal(historico.length, 3);
});

test('normalização: mesmo texto de remetentes diferentes nunca é eco', () => {
  const t = 'Combinado, então fechamos para amanhã às dez da manhã, certo?';
  const { historico } = normalizarConversa([m('eu', t), m('eles', t)], { agrupar: false });
  assert.equal(historico.length, 2);
});

test('normalização: agrupa texto consecutivo do mesmo remetente mas não áudio', () => {
  const { historico } = normalizarConversa([
    m('eles', 'oi'), m('eles', 'tudo bem?'), m('eles', 'aqui é o Marcos', 'audio'), m('eles', 'sobre o Mercado Livre'),
  ]);
  assert.equal(historico.length, 3);
  assert.equal(historico[0].content, 'oi\ntudo bem?');
  assert.equal(historico[1].type, 'audio');
});

test('normalização: mensagens vazias somem', () => {
  const { historico } = normalizarConversa([m('eles', ''), m('eles', '   '), m('eles', 'oi')]);
  assert.equal(historico.length, 1);
});

test('normalização: conversa acima do limite mantém o fim e o que tem sinal comercial', () => {
  const enchimento = (i) => m(i % 2 ? 'eles' : 'eu', `mensagem de enchimento número ${i} sem nada relevante ${'x'.repeat(80)}`);
  const historico = [];
  for (let i = 0; i < 40; i++) historico.push(enchimento(i));
  historico.splice(3, 0, m('eles', 'Meu sócio decide junto comigo o investimento'));
  const r = normalizarConversa(historico, { maxChars: 1500, agrupar: false });
  assert.equal(r.resumida, true);
  assert.ok(r.historico.some((x) => /sócio decide/.test(x.content)), 'sinal comercial antigo sobrevive ao corte');
  assert.ok(r.historico.at(-1).content.includes('número 39'), 'o fim da conversa sobrevive');
  assert.ok(r.historico.length < historico.length);
});

test('normalização: conversa pequena não é resumida', () => {
  const r = normalizarConversa([m('eles', 'oi'), m('eu', 'oi, tudo bem?')]);
  assert.equal(r.resumida, false);
  assert.equal(r.stats.mensagensOriginais, 2);
});

test('normalização de texto livre: linhas repetidas curtas ficam, linhas longas repetidas caem', () => {
  const longa = 'LEAD: eu quero começar a vender no Mercado Livre o mais rápido possível';
  const r = normalizarTextoLivre(['LEAD: ok', 'LEAD: ok', longa, longa].join('\n'));
  assert.equal(r.texto.split('\n').length, 3);
});

test('normalização: entrada inválida não quebra', () => {
  assert.equal(normalizarConversa(undefined).historico.length, 0);
  assert.equal(normalizarConversa(null).resumida, false);
  assert.equal(normalizarTextoLivre(undefined).texto, '');
});
