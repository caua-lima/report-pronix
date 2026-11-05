'use strict';
// Leitura do SDR (auditoria de 04/11/2026): original imutável, síntese só se preservar valores/negações/nomes,
// nenhum tópico some e nada aparece como aprovado sem o SDR aprovar. Sem IA (a síntese vem da geração principal).
const test = require('node:test');
const assert = require('node:assert/strict');

const visao = require('../src/visaoSdr');
const reportsSalvos = require('../src/reportsSalvos');

const TEXTO = 'lead bem quente, ja vende no ML uns 30k por mes e quer escalar. tem grana mas o socio decide junto, chama ele na call';

test('síntese que troca R$ 5 mil por R$ 50 mil não é aceita: vai o original', () => {
  const original = 'O lead confirmou que tem R$ 5 mil disponíveis para investir';
  const v = visao.montar({ texto: original, sintese: ['O lead confirmou que tem R$ 50 mil disponíveis para investir.'], autor: 'Cauã Lima' });
  assert.equal(v.statusRevisao, 'original');
  assert.deepEqual(v.sintese, [original]);
  assert.match(v.motivos.join(' '), /valores mudaram/);
  assert.equal(v.original, original, 'o original fica guardado inteiro');
});

test('síntese que só arruma a escrita (30k = R$ 30 mil) é aceita como conferida, não como aprovada', () => {
  const v = visao.montar({
    texto: TEXTO,
    sintese: ['Lead bem quente: já vende uns R$ 30 mil por mês no Mercado Livre e quer escalar.', 'Tem dinheiro, mas o sócio decide junto — chame o sócio para a call.'],
    autor: 'Cauã Lima',
  });
  assert.equal(v.statusRevisao, 'sintese_conferida');
  assert.equal(v.sintese.length, 2);
  assert.equal(visao.tituloDaLeitura(v.autor), 'Leitura de Cauã');
});

test('negação retirada ou nome trocado derrubam a síntese', () => {
  const sem = visao.conferirPreservacao('Ele não tem verba agora', ['Ele tem verba agora']);
  assert.equal(sem.ok, false);
  const nome = visao.conferirPreservacao('A sócia dele é a Juliana e ela decide junto', ['A sócia dele é a Fernanda e ela decide junto']);
  assert.equal(nome.ok, false);
  assert.match(nome.motivos.join(' '), /juliana/);
});

test('nove pontos: nenhum some (antes o limite de 8 cortava o último calado)', () => {
  const nove = Array.from({ length: 9 }, (_, i) => `Ponto importante número ${['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'][i]} sobre o lead`).join('\n');
  const topicos = visao.emTopicos(nove);
  assert.equal(topicos.length, 9);
  assert.match(topicos[8], /nove/);
  const v = visao.montar({ texto: nove, sintese: [], autor: 'Cauã' });
  assert.equal(v.sintese.length, 9, 'sem síntese, vai o original inteiro em tópicos');
});

test('texto acima do limite é recusado com o motivo (não é cortado calado)', () => {
  assert.throws(() => visao.textoRecebido('x'.repeat(visao.MAX_CARACTERES + 1)), (e) => e.status === 400 && /limite/.test(e.message));
  assert.equal(visao.textoRecebido('  ok  '), 'ok');
});

test('sem texto: não há leitura (e nada é atribuído ao SDR)', () => {
  assert.equal(visao.montar({ texto: '   ', sintese: ['inventado'] }), null);
});

test('revisão no painel: aprovar, editar e voltar ao original; o original nunca muda', () => {
  const v = visao.montar({ texto: TEXTO, sintese: [], autor: 'Cauã' });
  const aprovada = visao.revisar(v, { sintese: ['Minha versão editada, com 30 mil por mês.'] });
  assert.equal(aprovada.statusRevisao, 'aprovada');
  assert.equal(aprovada.original, TEXTO);
  const deVolta = visao.revisar(aprovada, { usarOriginal: true });
  assert.equal(deVolta.statusRevisao, 'original');
  assert.deepEqual(deVolta.sintese, visao.emTopicos(TEXTO));
});

test('salvar revisão: o cliente não reescreve o original nem o autor da leitura', () => {
  const guardado = { schemaVersion: 2, lead: 'Ana', revisao: 1, visaoSdr: visao.montar({ texto: TEXTO, sintese: [], autor: 'Cauã' }), tese: { titulo: 't', texto: 'x' } };
  const tentativa = { schemaVersion: 2, lead: 'Ana', tese: { titulo: 't', texto: 'y' }, visaoSdr: { ...guardado.visaoSdr, original: 'TEXTO TROCADO', autor: 'Outra pessoa', sintese: ['ok'], statusRevisao: 'aprovada' } };
  const salvo = reportsSalvos.aplicarRevisao(guardado, tentativa, 'Cauã');
  assert.equal(salvo.visaoSdr.original, TEXTO);
  assert.equal(salvo.visaoSdr.autor, 'Cauã');
  assert.equal(salvo.visaoSdr.statusRevisao, 'aprovada');
  assert.equal(salvo.revisao, 2);
  assert.equal(salvo.edicaoHumana, true);
  assert.equal(salvo.tese.texto, 'y');
});
