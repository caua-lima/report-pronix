'use strict';
// Linha do tempo do contato no report: das datas das mensagens, sem IA. Conversas inventadas.
const test = require('node:test');
const assert = require('node:assert/strict');
const { linhaDoTempo, linhasDoResumo, aplicarNoReport } = require('../src/linhaDoTempo');

// Sábado, 17/10/2026, 15h em Brasília.
const AGORA = Date.parse('2026-10-17T18:00:00Z');
const em = (dia, hora = '14:00') => new Date(`${dia}T${hora}:00-03:00`).toISOString();
const eu = (dia, content, hora) => ({ from: 'eu', content, timestamp: em(dia, hora) });
const lead = (dia, content, hora) => ({ from: 'eles', content, timestamp: em(dia, hora) });
const linhas = (msgs) => linhasDoResumo(linhaDoTempo(msgs, { agora: AGORA }));

test('mais de 7 dias de conversa: "Conversando com o lead desde 23/09"; com 7 ou menos, não diz', () => {
  assert.deepEqual(linhas([eu('2026-09-23', 'Oi, tudo bem?'), lead('2026-09-23', 'Tudo'), lead('2026-10-17', 'Bom dia')]),
    [{ rotulo: 'Contato', valor: 'Conversando com o lead desde 23/09 (24 dias)' }]);
  assert.deepEqual(linhas([eu('2026-10-10', 'Oi'), lead('2026-10-17', 'Oi')]), [], 'exatamente 7 dias: não entra');
  assert.deepEqual(linhas([eu('2026-10-09', 'Oi'), lead('2026-10-17', 'Oi')]).map((l) => l.valor), ['Conversando com o lead desde 09/10 (8 dias)']);
});

test('confirmou na quarta para sábado: "Confirmado desde quarta-feira"; reconfirmou no dia, diz também', () => {
  const base = [eu('2026-10-14', 'Posso confirmar sua reunião de sábado às 15h?', '10:00'), lead('2026-10-14', 'Sim!', '10:20')];
  assert.deepEqual(linhas(base), [{ rotulo: 'Confirmação', valor: 'Confirmado desde quarta-feira (14/10)' }]);
  const comReconfirmacao = base.concat([eu('2026-10-17', 'Bom dia! Reunião confirmada hoje às 15h?', '09:00'), lead('2026-10-17', 'Confirmado 👍', '09:10')]);
  assert.deepEqual(linhas(comReconfirmacao), [{ rotulo: 'Confirmação', valor: 'Confirmado desde quarta-feira (14/10) · reconfirmado no dia (sábado, 17/10)' }]);
});

test('confirmou só 1 ou 2 dias antes também aparece; só no próprio dia, não', () => {
  assert.deepEqual(linhas([lead('2026-10-16', 'Tá confirmado, estarei lá')]).map((l) => l.valor), ['Confirmado desde sexta-feira (16/10)']);
  assert.deepEqual(linhas([lead('2026-10-15', 'confirmo sim')]).map((l) => l.valor), ['Confirmado desde quinta-feira (15/10)']);
  assert.deepEqual(linhas([eu('2026-10-17', 'Confirmado pra hoje?', '09:00'), lead('2026-10-17', 'sim', '09:05')]), []);
});

test('o que não é confirmação: "não", remarcação, "sim" sem pedido de confirmação; remarcou, vale a confirmação de depois', () => {
  assert.deepEqual(linhas([eu('2026-10-14', 'Confirmado sábado?'), lead('2026-10-14', 'não vou conseguir, vamos remarcar?')]), []);
  assert.deepEqual(linhas([eu('2026-10-14', 'Você tem interesse?'), lead('2026-10-14', 'sim')]), [], 'sim para outra pergunta');
  assert.deepEqual(linhas([eu('2026-10-10', 'Confirmado?', '09:00'), lead('2026-10-13', 'ok', '09:00')]), [], 'resposta mais de 48 h depois do pedido');
  const remarcou = [
    lead('2026-10-12', 'Confirmado para quinta!'),
    lead('2026-10-14', 'Preciso remarcar, pode ser sábado?'),
    eu('2026-10-15', 'Remarquei para sábado 15h. Confirma?', '11:00'), lead('2026-10-15', 'Combinado', '11:30'),
  ];
  assert.deepEqual(linhas(remarcou).map((l) => l.valor), ['Confirmado desde quinta-feira (15/10)']);
  assert.equal(linhaDoTempo([{ from: 'eles', content: 'Oi' }], { agora: AGORA }), null, 'sem data nas mensagens, nada');
});

test('no report: as linhas entram no começo do resumo, sem repetir rótulo que a IA já usou', () => {
  const msgs = [eu('2026-09-23', 'Oi'), eu('2026-10-14', 'Posso confirmar sábado?', '10:00'), lead('2026-10-14', 'Pode sim, confirmado', '10:05')];
  const dados = aplicarNoReport({ resumo: [{ rotulo: 'Decisor(es)', valor: 'Ele e a esposa' }] }, msgs, { agora: AGORA });
  assert.deepEqual(dados.resumo.map((r) => r.rotulo), ['Contato', 'Confirmação', 'Decisor(es)']);
  const comContato = aplicarNoReport({ resumo: [{ rotulo: 'Contato', valor: 'da IA' }] }, msgs, { agora: AGORA });
  assert.deepEqual(comContato.resumo.map((r) => r.rotulo), ['Confirmação', 'Contato']);
});
