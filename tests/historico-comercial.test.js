'use strict';
// O lead já passou pelos closers? Comprou, fez reunião, teve reunião marcada, passou pelo funil dos closers — o SDR vê
// isso antes de chamar (aviso no topo do painel e no cartão). Função pura; leads inventados.
const test = require('node:test');
const assert = require('node:assert/strict');
const crm = require('../src/crm');

const FUNIS = [
  { id: 'f1', nome: 'SMQLs', etapas: [{ id: 'a', nome: 'Contato iniciado', ordem: 0, categoria: 'contato' }, { id: 'b', nome: 'Respondeu', ordem: 1, categoria: 'resposta' }, { id: 'q', nome: 'Desqualificados', ordem: 2, categoria: 'perda', perdido: true }] },
  { id: 'f2', nome: 'CLOSERS', etapas: [{ id: 'c', nome: 'Reunião agendada', ordem: 0, categoria: 'reuniao_agendada' }, { id: 'd', nome: 'Reunião realizada', ordem: 1, categoria: 'reuniao_realizada' }, { id: 'e', nome: 'Vendido', ordem: 2, categoria: 'venda', ganho: true }] },
];
const h = (id, quando) => ({ deal_stage_id: id, start_date: quando });
const card = (id, extra) => ({ id, name: 'PRXC | Fulano ' + id, user: { name: 'Paulo Henrique Pagoti' }, win: null, ...extra });
const novo = card('n1', { user: { name: 'Ana SDR' }, deal_stage: { id: 'a', name: 'Contato iniciado' }, deal_pipeline: { name: 'SMQLs' } });

test('fez reunião num card antigo (perdido depois): "JÁ FEZ REUNIÃO" com a data e o closer', () => {
  const velho = card('v1', { win: false, deal_stage: { id: 'q', name: 'Desqualificados' }, deal_pipeline: { name: 'SMQLs' }, deal_stage_histories: [h('a', '2026-05-01T12:00:00Z'), h('c', '2026-05-02T12:00:00Z'), h('d', '2026-05-03T12:00:00Z'), h('q', '2026-05-20T12:00:00Z')] });
  const r = crm.historicoComercial([velho, novo], FUNIS, 'n1');
  assert.equal(r.resumo.tipo, 'reuniao');
  assert.equal(r.resumo.texto, 'JÁ FEZ REUNIÃO em 03/05/26 com Paulo Henrique');
  assert.equal(r.eventos.length, 1);
  assert.match(r.eventos[0].texto, /Fez reunião em 03\/05\/26 com Paulo Henrique Pagoti \(card "PRXC \| Fulano v1"\)/);
});

test('comprou vale mais que tudo; reunião só marcada; só passou pelo funil dos closers', () => {
  const comprou = card('v2', { win: true, closed_at: '2026-03-10T15:00:00Z', deal_stage: { id: 'e', name: 'Vendido' }, deal_pipeline: { name: 'CLOSERS' } });
  const marcada = card('v3', { win: false, deal_stage: { id: 'q', name: 'Desqualificados' }, deal_stage_histories: [h('a', '2026-04-01T12:00:00Z'), h('c', '2026-04-02T12:00:00Z'), h('q', '2026-04-03T12:00:00Z')] });
  let r = crm.historicoComercial([marcada, comprou, novo], FUNIS, 'n1');
  assert.equal(r.resumo.texto, 'JÁ COMPROU em 10/03/26 com Paulo Henrique');
  assert.deepEqual(r.eventos.map((e) => e.tipo), ['comprou', 'agendada'], 'todos os cards entram; o mais forte primeiro');
  r = crm.historicoComercial([marcada, novo], FUNIS, 'n1');
  assert.equal(r.resumo.texto, 'JÁ TEVE REUNIÃO MARCADA em 02/04/26 com Paulo Henrique');
  const soClosers = card('v4', { deal_stage: { id: 'x', name: 'Triagem' }, deal_pipeline: { name: 'CLOSERS 2' } });
  r = crm.historicoComercial([soClosers, novo], [...FUNIS, { id: 'f3', nome: 'CLOSERS 2', etapas: [{ id: 'x', nome: 'Triagem', ordem: 0 }] }], 'n1');
  assert.equal(r.resumo.tipo, 'closers');
});

test('lead novo: nada; a reunião MARCADA do próprio card não é aviso (já está na ficha), a FEITA é', () => {
  assert.equal(crm.historicoComercial([novo], FUNIS, 'n1'), null);
  const agoraMarcada = card('n2', { deal_stage: { id: 'c', name: 'Reunião agendada' }, deal_pipeline: { name: 'CLOSERS' } });
  assert.equal(crm.historicoComercial([agoraMarcada], FUNIS, 'n2'), null);
  // o card desta conversa já fez reunião e voltou para o contato (recuperação): avisa
  const voltou = card('n3', { deal_stage: { id: 'a', name: 'Contato iniciado' }, deal_pipeline: { name: 'SMQLs' }, deal_stage_histories: [h('c', '2026-06-01T12:00:00Z'), h('d', '2026-06-02T12:00:00Z'), h('a', '2026-10-20T12:00:00Z')] });
  const r = crm.historicoComercial([voltou], FUNIS, 'n3');
  assert.equal(r.resumo.tipo, 'reuniao');
  assert.equal(r.eventos[0].atual, true);
  assert.match(r.eventos[0].texto, /, este\)$/);
});

test('CRM sem categoria nas etapas (RD): pelo nome da etapa', () => {
  const rd = [{ id: 'r1', nome: 'Funil', etapas: [{ id: 's1', nome: 'Contato iniciado', ordem: 0 }, { id: 's6', nome: 'Reunião Realizada', ordem: 1 }] }];
  const velho = card('v5', { win: false, deal_stage: { id: 's6', name: 'Reunião Realizada' }, updated_at: '2026-02-02T12:00:00Z' });
  assert.equal(crm.historicoComercial([velho, novo], rd, 'n1').resumo.tipo, 'reuniao');
});
