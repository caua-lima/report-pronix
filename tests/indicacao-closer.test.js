'use strict';
// "Qual closer para este lead?" (src/indicacaoCloser.js): o perfil do lead lido do handoff/report e a indicação
// pelo histórico de cada closer. Dados inventados; sem rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const ic = require('../src/indicacaoCloser');

test('perfil do lead lido do texto do report (estágio, capital, quem decide, motivação, perfil)', () => {
  const c = ic.caracteristicas([
    'Nome: Marcos',
    'Status: Loja física de moto peças, já vende no Mercado Livre',
    'Investimento: tem uns R$ 8 mil separados para começar',
    'Faturamento: fatura R$ 80 mil por mês na loja',
    'Decisor(es): decide junto com a esposa',
    'Motivação: quer escalar as vendas online',
    'Perfil: Analítico — mostre a conta.',
  ].join('\n'));
  assert.deepEqual(c, { estagio: 'ja_vende', capital: 'de_5k_a_15k', decisor: 'conjuge', motivo: 'escalar', perfil: 'analitico' });
});

test('faturamento não vira capital; "do zero" e "sozinho" são reconhecidos; o que não aparece fica vazio', () => {
  const c = ic.caracteristicas('Começando do zero, quer sair do CLT. Fatura nada ainda. Decide sozinho.');
  assert.equal(c.estagio, 'do_zero');
  assert.equal(c.motivo, 'sair_clt');
  assert.equal(c.decisor, 'sozinho');
  assert.equal(c.capital, '');
  assert.equal(c.perfil, '');
  assert.deepEqual(ic.valoresEmReais('vendeu 104 vezes em 15 dias e tem R$ 3.500 e 2 mil'), [3500, 2000]);
});

const item = (closer, resultado, c) => ({ closer, resultado, c: { estagio: '', capital: '', decisor: '', motivo: '', perfil: '', ...c } });

test('indica primeiro o closer que mais fecha com leads do mesmo perfil, com a porcentagem e o porquê', () => {
  const base = {
    atualizadoEm: '2026-11-12T12:00:00Z', desde: '2026-07-15', ate: '2026-11-12',
    itens: [
      // Paulo fecha com quem já vende; Zoe fecha com quem está começando.
      ...Array.from({ length: 6 }, (_, i) => item('Paulo', i < 5 ? 'venda' : 'perda', { estagio: 'ja_vende' })),
      ...Array.from({ length: 6 }, (_, i) => item('Paulo', i < 1 ? 'venda' : 'perda', { estagio: 'do_zero' })),
      ...Array.from({ length: 6 }, (_, i) => item('Zoe', i < 1 ? 'venda' : 'perda', { estagio: 'ja_vende' })),
      ...Array.from({ length: 6 }, (_, i) => item('Zoe', i < 5 ? 'venda' : 'perda', { estagio: 'do_zero' })),
      item('Novo', 'venda', { estagio: 'ja_vende' }), // só 1 reunião: não entra
      item('Paulo', 'aberto', { estagio: 'ja_vende' }), // em aberto: fora da conta
      item('Paulo', 'no_show', { estagio: 'ja_vende' }),
    ],
  };
  const jaVende = ic.indicar(base, { estagio: 'ja_vende' });
  assert.deepEqual(jaVende.ranking.map((r) => r.closer), ['Paulo', 'Zoe']);
  assert.ok(jaVende.ranking[0].chance > jaVende.ranking[1].chance);
  assert.match(jaVende.ranking[0].porque.join(' | '), /Estágio — já vende: 5 venda\(s\) em 6 reunião\(ões\)/);
  assert.match(jaVende.ranking[0].porque[0], /No geral: 6 venda\(s\) em 12 reunião\(ões\)/);
  assert.deepEqual(jaVende.perfil, [{ campo: 'Estágio', valor: 'já vende' }]);

  const doZero = ic.indicar(base, { estagio: 'do_zero' });
  assert.deepEqual(doZero.ranking.map((r) => r.closer), ['Zoe', 'Paulo']);

  // sem perfil nenhum: empate na taxa geral
  const nada = ic.indicar(base, {});
  assert.equal(nada.ranking[0].chance, nada.ranking[1].chance);
  assert.ok(!nada.ranking.some((r) => r.closer === 'Novo'), 'closer com menos de 3 reuniões decididas fica de fora');
});

test('a base guarda só closer, dia, resultado e o perfil (nada do texto nem do nome do lead)', async () => {
  process.env.KV_REST_API_URL = '';
  process.env.KV_REST_API_TOKEN = '';
  const base = await ic.salvarBase({ desde: '2026-07-15', ate: '2026-11-12', reunioes: [
    { closer: 'Paulo', dia: '2026-11-03', resultado: 'venda', lead: 'Ana Secreta', handoff: 'Ana Secreta já vende e decide com o sócio.' },
    { closer: 'Sem closer', dia: '2026-11-04', resultado: 'perda', handoff: 'x' },
  ] });
  assert.equal(base.itens.length, 1);
  assert.equal(JSON.stringify(base).includes('Ana Secreta'), false);
  assert.equal(base.itens[0].c.decisor, 'socio');
});
