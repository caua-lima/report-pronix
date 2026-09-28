'use strict';
// Regra do .zip do dia: do mesmo lead (mesmo SDR, mesmo dia), vale o report gerado por último.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chaveDoLead, marcarUltimos, nomesUnicos, nomeAscii } = require('../src/diario');

const r = (id, hora, extra = {}) => ({
  id, usuarioId: 'u1', usuarioNome: 'Ana', dia: '2026-09-28', quando: `2026-09-28T${hora}:00.000Z`, lead: 'Marcos', contato: 'Marcos', ...extra,
});
const usados = (lista) => marcarUltimos(lista).filter((x) => x.usar).map((x) => x.id);

test('3 reports do mesmo lead no dia: só o último vai', () => {
  const m = marcarUltimos([r('a', '13:00'), r('b', '14:00'), r('c', '15:00')]);
  assert.deepEqual(m.map((x) => x.usar), [false, false, true]);
  assert.deepEqual(m.map((x) => x.substituidoPor), ['c', 'c', null]);
  assert.deepEqual(m.map((x) => x.geracoes), [3, 3, 3]);
});

test('a ordem de entrada não importa: vale o horário', () => {
  assert.deepEqual(usados([r('c', '15:00'), r('a', '13:00'), r('b', '14:00')]), ['c']);
});

test('leads diferentes ficam todos', () => {
  assert.deepEqual(usados([r('a', '13:00'), r('b', '14:00', { contato: 'Júlia', lead: 'Júlia' })]), ['a', 'b']);
});

test('o contato manda: a IA ter devolvido nomes diferentes não separa o mesmo lead', () => {
  const lista = [
    r('a', '13:00', { contato: '+55 11 99999-0000', lead: 'Marcos' }),
    r('b', '14:00', { contato: '+55 11 99999-0000', lead: 'Marcos Souza' }),
  ];
  assert.deepEqual(usados(lista), ['b']);
});

test('acento, caixa e espaço não separam o mesmo lead', () => {
  assert.deepEqual(usados([r('a', '13:00', { contato: 'Márcia  Gonçalves' }), r('b', '14:00', { contato: 'marcia goncalves' })]), ['b']);
});

test('sem contato (report manual sem nome, reports antigos): usa o nome do lead', () => {
  assert.deepEqual(usados([r('a', '13:00', { contato: '' }), r('b', '14:00', { contato: undefined })]), ['b']);
});

test('cabeçalho lido errado ("online") não junta leads diferentes', () => {
  const lista = [
    r('a', '13:00', { contato: 'online', lead: 'Marcos' }),
    r('b', '14:00', { contato: 'online', lead: 'Júlia' }),
  ];
  assert.deepEqual(usados(lista), ['a', 'b']);
  assert.equal(chaveDoLead({ contato: 'Ativo(a) agora', lead: 'Pedro' }), 'pedro');
});

test('report sem nome nenhum nunca é agrupado com outro', () => {
  assert.deepEqual(usados([r('a', '13:00', { contato: '', lead: '' }), r('b', '14:00', { contato: '', lead: '' })]), ['a', 'b']);
});

test('o mesmo lead com SDRs diferentes, ou em dias diferentes, não se substitui', () => {
  const lista = [
    r('a', '13:00'),
    r('b', '14:00', { usuarioId: 'u2', usuarioNome: 'Bia' }),
    r('c', '15:00', { dia: '2026-09-29', quando: '2026-09-29T15:00:00.000Z' }),
  ];
  assert.deepEqual(usados(lista), ['a', 'b', 'c']);
});

test('empate de horário: vale o que veio depois na lista', () => {
  assert.deepEqual(usados([r('a', '13:00'), r('b', '13:00')]), ['b']);
});

test('não muda os objetos de entrada', () => {
  const entrada = [r('a', '13:00'), r('b', '14:00')];
  marcarUltimos(entrada);
  assert.equal(entrada[0].usar, undefined);
  assert.deepEqual(marcarUltimos(undefined), []);
});

test('nomes repetidos no .zip ganham (2), (3)...', () => {
  assert.deepEqual(nomesUnicos(['Report_Marcos.pdf', 'Report_Julia.pdf', 'report_marcos.pdf', 'Report_Marcos.pdf', 'sem-ponto']),
    ['Report_Marcos.pdf', 'Report_Julia.pdf', 'report_marcos (2).pdf', 'Report_Marcos (3).pdf', 'sem-ponto']);
});

test('nome do SDR vira nome de arquivo seguro (sem acento, sem espaço)', () => {
  assert.equal(nomeAscii('Cauã Lima'), 'Caua-Lima');
  assert.equal(nomeAscii('  /\\:*?  '), 'SDR');
  assert.equal(nomeAscii(''), 'SDR');
});
