'use strict';
// Trava do decisor: com contato compartilhado ou áudio do lead sem transcrição, o report não pode dizer "Decide sozinho".
// Caso real (19/11/2026): lead com sócio (contato "Fabricio Fontes" compartilhado e citado nos áudios) saiu "decide sozinho".
const test = require('node:test');
const assert = require('node:assert/strict');
const { corrigirDecisorSemProva, SYSTEM_PROMPT } = require('../src/report');

const relatorio = (valor) => ({ resumo: [{ rotulo: 'Investimento', valor: 'R$ 3 a 5 mil' }, { rotulo: 'Decisor(es)', valor }] });

test('contato compartilhado pelo lead: "Decide sozinho" vira "Pode decidir com <nome>"', () => {
  const d = relatorio('Decide sozinho (não mencionou outra pessoa)');
  const conversa = [{ from: 'eu', content: 'Oi' }, { from: 'eles', content: '[contato compartilhado: Fabricio Fontes]' }, { from: 'eles', content: 'Sim irmão' }];
  assert.equal(corrigirDecisorSemProva(d, conversa), true);
  assert.match(d.resumo[1].valor, /^Pode decidir com Fabricio Fontes — o lead compartilhou o contato/);
});

test('áudio do lead sem transcrição: não afirma "decide sozinho"', () => {
  const d = relatorio('Decide sozinho (não mencionou outra pessoa)');
  assert.equal(corrigirDecisorSemProva(d, [{ from: 'eles', content: '[áudio]' }, { from: 'eles', content: '[áudio]' }, { from: 'eles', content: 'ok' }]), true);
  assert.match(d.resumo[1].valor, /há 2 áudio\(s\) dele sem transcrição — confirmar no início da call/);
});

test('sem sinal de terceiro e tudo transcrito: "decide sozinho" fica; decisor já com terceiro também fica', () => {
  const sozinho = relatorio('Decide sozinho (não mencionou outra pessoa)');
  assert.equal(corrigirDecisorSemProva(sozinho, [{ from: 'eles', content: 'eu decido' }, { from: 'eu', content: '[áudio]' }]), false, 'áudio do vendedor não conta');
  assert.equal(sozinho.resumo[1].valor, 'Decide sozinho (não mencionou outra pessoa)');
  const comSocio = relatorio('Decide com o sócio Fabricio — não estará na call');
  assert.equal(corrigirDecisorSemProva(comSocio, [{ from: 'eles', content: '[contato compartilhado: Fabricio Fontes]' }]), false);
  assert.equal(comSocio.resumo[1].valor, 'Decide com o sócio Fabricio — não estará na call');
});

test('o prompt manda procurar sinais de terceiro e proíbe "decide sozinho" com áudio do lead sem transcrição', () => {
  assert.match(SYSTEM_PROMPT, /SINAIS DE TERCEIRO[\s\S]*\[contato compartilhado: Nome\]/);
  assert.match(SYSTEM_PROMPT, /Áudio sem transcrição \("\[áudio\]"\) do LEAD[\s\S]*PROIBIDO escrever "Decide sozinho/);
});
