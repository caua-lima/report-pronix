'use strict';
// Leitura do agendamento nas mensagens (extension/agenda.js): sem IA, sem rede, só texto e datas.
const test = require('node:test');
const assert = require('node:assert/strict');
const agenda = require('../extension/agenda.js');

// Sexta-feira, 02/10/2026, 10:00 (horário local do teste): a data das mensagens.
const BASE = new Date(2026, 9, 2, 10, 0);
const ler = (texto, base = BASE) => agenda.lerAgendamento(texto, base);

test('agendamento escrito por inteiro: data, dia da semana, amanhã, hoje', () => {
  assert.equal(ler('Perfeito! Sua reunião ficou agendada para quinta-feira (08/10) às 15h.'), '2026-10-08T15:00');
  assert.equal(ler('Agendado então: amanhã às 14h30 com o nosso especialista'), '2026-10-03T14:30');
  assert.equal(ler('Fica marcado pra hoje 19h, te mando o link'), '2026-10-02T19:00');
  assert.equal(ler('Reunião confirmada dia 15 às 10:00'), '2026-10-15T10:00');
  assert.equal(ler('Call marcada para segunda às 9h'), '2026-10-05T09:00', 'a próxima segunda');
  assert.equal(ler('Reunião marcada para sexta às 16h'), '2026-10-09T16:00', 'dito numa sexta: a sexta que vem');
  assert.equal(ler('Remarcado para 10 de novembro às 11h'), '2026-11-10T11:00');
  assert.equal(ler('Ficou para depois de amanhã às 20h a nossa call'), '2026-10-04T20:00');
  assert.equal(ler('reunião agendada 05/01 às 10h'), '2027-01-05T10:00', 'data que já passou este ano é a do ano que vem');
  assert.equal(ler('reunião agendada 07/10/2026 às 10h'), '2026-10-07T10:00');
});

test('formas de escrever o horário', () => {
  assert.equal(ler('Agendado amanhã às 3 da tarde'), '2026-10-03T15:00');
  assert.equal(ler('Agendado amanhã às 3'), '2026-10-03T15:00', '"às 3" numa reunião é da tarde');
  assert.equal(ler('Agendado amanhã às 9 da manhã'), '2026-10-03T09:00');
  assert.equal(ler('Agendado amanhã 8 da noite'), '2026-10-03T20:00');
  assert.equal(ler('Agendado amanhã ao meio-dia'), '2026-10-03T12:00');
  assert.equal(ler('Agendado amanhã às 15:30h'), '2026-10-03T15:30');
  assert.equal(ler('Agendado amanhã 15 horas'), '2026-10-03T15:00');
  assert.equal(ler('Agendado amanhã as 15hrs'), '2026-10-03T15:00');
  assert.equal(ler('Agendado amanhã às 15'), '2026-10-03T15:00');
  assert.equal(ler('AGENDADO AMANHÃ ÀS 15H'), '2026-10-03T15:00');
  assert.equal(ler('Reunião amanhã das 15 às 16h'), '2026-10-03T15:00', 'intervalo: vale o começo');
});

test('o que NÃO é agendamento', () => {
  assert.equal(ler('Te chamo amanhã às 15h'), '', 'sem palavra de compromisso');
  assert.equal(ler('A reunião dura 1h e você precisa de 2 horas por dia para o projeto, começamos amanhã'), '', 'duração não é horário');
  assert.equal(ler('Tenho horário amanhã às 10h ou às 15h, qual fica melhor?'), '', 'opções, não agendamento');
  assert.equal(ler('Consigo reunião amanhã às 10h ou às 15h.'), '', 'opções mesmo sem interrogação');
  assert.equal(ler('Reunião marcada, te aviso o horário'), '', 'sem dia nem hora');
  assert.equal(ler('Reunião amanhã, combinado'), '', 'sem hora');
  assert.equal(ler('Reunião às 15h, combinado'), '', 'sem dia');
  assert.equal(ler('Na segunda parcela da reunião de vendas às 15h'), '', '"segunda parcela" não é dia da semana');
  assert.equal(ler('A reunião do dia 10 de manhã foi boa'), '', '"dia 10 de manhã" não é 10 horas');
  assert.equal(ler(''), '');
  assert.equal(ler('x'.repeat(5000) + ' reunião amanhã às 15h'), '', 'texto gigante não é lido');
});

test('várias frases: afirmação vale mais que pergunta; o dia pode estar em outra frase', () => {
  assert.equal(ler('Você prefere amanhã às 10h? Deixei agendado para quinta às 15h.'), '2026-10-08T15:00');
  assert.equal(ler('Reunião agendada para amanhã. Às 15h, ok?'), '2026-10-03T15:00', 'só sobrou a pergunta: usa ela');
  assert.equal(ler('Fica agendado para amanhã às 15h, pode ser?'), '2026-10-03T15:00');
  assert.equal(ler('Investimento a partir de R$ 3.000. Reunião agendada amanhã às 15h.'), '2026-10-03T15:00', '"3.000" não quebra a frase');
  assert.equal(ler('Tinha ficado para hoje às 10h. Remarcamos para segunda às 16h.'), '2026-10-05T16:00', 'vale a última frase');
});

const msg = (from, content, hora) => ({ from, type: 'texto', content, timestamp: hora ? new Date(hora).toISOString() : null });

test('na conversa: vale a ÚLTIMA mensagem minha que marca (remarcou? vale o novo); mensagem do lead não conta', () => {
  const conversa = [
    msg('eu', 'Oi! Tudo bem?', '2026-10-01T09:00:00'),
    msg('eles', 'Pode ser amanhã às 9h a reunião', '2026-10-01T09:05:00'),
    msg('eu', 'Reunião agendada para amanhã às 15h', '2026-10-01T09:10:00'),
    msg('eles', 'Não vou conseguir', '2026-10-02T14:00:00'),
    msg('eu', 'Sem problema, remarquei para segunda às 10h', '2026-10-02T14:05:00'),
    msg('eu', 'Te mando o link no dia', '2026-10-02T14:06:00'),
  ];
  const r = agenda.detectarAgendamento(conversa, BASE);
  assert.deepEqual(r, { quando: '2026-10-05T10:00', fonteTs: new Date('2026-10-02T14:05:00').getTime() });
  // sem a remarcação, vale a primeira (e "amanhã" conta a partir do dia da MENSAGEM, não de hoje)
  assert.equal(agenda.detectarAgendamento(conversa.slice(0, 4), BASE).quando, '2026-10-02T15:00');
  assert.equal(agenda.detectarAgendamento([msg('eles', 'reunião agendada amanhã às 15h', '2026-10-01T09:00:00')], BASE), null);
  assert.equal(agenda.detectarAgendamento([], BASE), null);
  assert.equal(agenda.detectarAgendamento(null, BASE), null);
});

test('lead escolhe entre as opções e eu só confirmo ("Agendado!")', () => {
  const r = agenda.detectarAgendamento([
    msg('eu', 'Tenho horário amanhã às 10h ou às 15h, qual fica melhor?', '2026-10-02T09:00:00'),
    msg('eles', '15h', '2026-10-02T09:05:00'),
    msg('eu', 'Perfeito, agendado! Te mando o link', '2026-10-02T09:06:00'),
  ], BASE);
  assert.deepEqual(r, { quando: '2026-10-03T15:00', fonteTs: new Date('2026-10-02T09:06:00').getTime() });

  // o lead diz o dia e o horário
  assert.equal(agenda.detectarAgendamento([
    msg('eu', 'Que dia fica bom pra você?', '2026-10-02T09:00:00'),
    msg('eles', 'pode ser segunda às 14h', '2026-10-02T09:05:00'),
    msg('eu', 'Combinado então', '2026-10-02T09:06:00'),
  ], BASE).quando, '2026-10-05T14:00');

  // dois dias oferecidos: vale o dia que está junto do horário escolhido
  assert.equal(agenda.detectarAgendamento([
    msg('eu', 'Consigo amanhã às 10h ou segunda às 16h', '2026-10-02T09:00:00'),
    msg('eles', '16', '2026-10-02T09:05:00'),
    msg('eu', 'Confirmado!', '2026-10-02T09:06:00'),
  ], BASE).quando, '2026-10-05T16:00');

  // "Agendado!" sem nada antes que diga quando: nada
  assert.equal(agenda.detectarAgendamento([
    msg('eles', 'ok', '2026-10-02T09:05:00'),
    msg('eu', 'Agendado!', '2026-10-02T09:06:00'),
  ], BASE), null);
});

test('áudio transcrito (sem horário na mensagem) herda a data da mensagem anterior', () => {
  const r = agenda.detectarAgendamento([
    msg('eu', 'Oi', '2026-10-06T09:00:00'),
    { from: 'eu', type: 'audio', content: 'então fica agendada a nossa reunião pra amanhã às quinze horas e trinta', timestamp: null },
    { from: 'eu', type: 'audio', content: 'Fechou, reunião confirmada pra amanhã às 15h30', timestamp: null },
    { from: 'eu', type: 'audio', content: '[áudio]', timestamp: null },
  ], BASE);
  assert.deepEqual(r, { quando: '2026-10-07T15:30', fonteTs: new Date('2026-10-06T09:00:00').getTime() });
  // sem nenhuma data nas mensagens: conta a partir de "agora"
  assert.deepEqual(agenda.detectarAgendamento([{ from: 'eu', content: 'reunião agendada amanhã às 9h' }], BASE), { quando: '2026-10-03T09:00', fonteTs: 0 });
});

test('lead respondeu = mensagem dele DEPOIS de uma minha', () => {
  const m = (...de) => de.map((from) => ({ from, content: 'x' }));
  assert.equal(agenda.leadRespondeu(m('eu', 'eles')), true);
  assert.equal(agenda.leadRespondeu(m('eu', 'eu', 'eles', 'eu')), true);
  assert.equal(agenda.leadRespondeu(m('eu', 'eu')), false, 'só eu falei');
  assert.equal(agenda.leadRespondeu(m('eles', 'eu')), false, 'ele escreveu antes; ainda não respondeu a minha');
  assert.equal(agenda.leadRespondeu(m('eles')), false);
  assert.equal(agenda.leadRespondeu([]), false);
  assert.equal(agenda.leadRespondeu(null), false);
});

test('texto do cartão: hoje, amanhã, dia da semana e "passou"', () => {
  const agora = new Date(2026, 9, 2, 10, 0);
  assert.deepEqual(agenda.descrever('2026-10-02T15:00', agora), { texto: 'hoje às 15:00', passou: false });
  assert.deepEqual(agenda.descrever('2026-10-02T09:00', agora), { texto: 'hoje às 09:00', passou: true });
  assert.deepEqual(agenda.descrever('2026-10-03T15:30', agora), { texto: 'amanhã às 15:30', passou: false });
  assert.deepEqual(agenda.descrever('2026-10-08T15:00', agora), { texto: 'qui, 08/10 às 15:00', passou: false });
  assert.deepEqual(agenda.descrever('2026-09-28T15:00', agora), { texto: 'seg, 28/09 às 15:00', passou: true });
  assert.deepEqual(agenda.descrever('2026-10-01T15:00', agora), { texto: 'ontem às 15:00', passou: true });
  assert.equal(agenda.descrever('amanhã', agora), null);
  assert.equal(agenda.descrever('', agora), null);
});
