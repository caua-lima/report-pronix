'use strict';
// Closer do handoff preenchido sozinho (pelo RD ou pela agenda). Banco em pasta temporária, sem rede.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-closerauto-'));
Object.assign(process.env, { CR_DATA_DIR: DADOS, KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });
delete process.env.VERCEL;

const stats = require('../src/stats');
const closers = require('../src/closers');
const closerAuto = require('../src/closerAuto');
test.after(() => fs.rmSync(DADOS, { recursive: true, force: true }));

const CAUA = { id: 'u1', nome: 'Cauã Lima' };
const fichaRd = (etapa, funil, responsavel, nome = 'Rodrigo Araujo dos Santos') => ({ nome, negociacao: { etapa, funil, responsavel } });
const report = (id, contato, extra = {}) => stats.registrar({ id, usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Rodrigo', contato, origem: 'extensao', ...extra });
const closerDe = async (id) => (await stats.buscarPorId(id)).closerNome;

let paulo;
test.before(async () => {
  paulo = await closers.criar('Paulo Henrique');
  await closers.criar('Vitor Augusto');
});

test('acha o closer cadastrado pelo nome do RD ou da agenda; ambíguo ou desconhecido não escolhe', async () => {
  const lista = await closers.listar();
  assert.equal(closerAuto.acharCloser(lista, 'Paulo Henrique Pagoti de Oliveira Silva').nome, 'Paulo Henrique');
  assert.equal(closerAuto.acharCloser(lista, 'VITOR AUGUSTO manoel').nome, 'Vitor Augusto');
  assert.equal(closerAuto.acharCloser(lista, 'Paulo Roberto'), null, 'só o primeiro nome não basta');
  assert.equal(closerAuto.acharCloser(lista, ''), null);
  assert.equal(closerAuto.acharCloser([{ id: 'a', nome: 'Paulo' }, { id: 'b', nome: 'Paulo Henrique' }], 'Paulo Henrique Silva'), null, 'dois cadastros casam: não escolhe');
});

test('no RD, o responsável só é o closer depois de "Reunião Realizada" ou no funil dos closers', () => {
  assert.equal(closerAuto.closerDoRd(fichaRd('Reunião Realizada', 'SMQLs Automaticos', 'Paulo Henrique')), 'Paulo Henrique');
  assert.equal(closerAuto.closerDoRd(fichaRd('Proposta', 'Funil de Closers', 'Paulo Henrique')), 'Paulo Henrique');
  for (const etapa of ['Em contato', 'Fluxo de FUP', 'Negociação Avançada', 'Não Compraram', 'Vendido']) {
    assert.equal(closerAuto.closerDoRd(fichaRd(etapa, 'Funil Comercial', 'Paulo Henrique')), 'Paulo Henrique', etapa + ': etapa do funil dos closers');
  }
  assert.equal(closerAuto.closerDoRd(fichaRd('Qualificado', 'SMQLs Automaticos', 'Cauã Lima')), '', 'antes da reunião o responsável é o pré-vendedor');
  assert.equal(closerAuto.closerDoRd({ nome: 'x', negociacao: null }), '');
});

test('reunião realizada no RD: os handoffs do lead sem closer são preenchidos; quem já tem closer não muda', async () => {
  await report('r1', '+55 11 91133-3043');
  await report('r2', '+55 11 91133-3043');
  await report('r3', '+55 11 91133-3043');
  await stats.atualizarResultado('r3', { closerId: 'outro', closerNome: 'Closer Já Marcado' });
  await report('r4', '+55 21 98888-0000'); // outro lead
  await stats.registrar({ id: 'r5', usuarioId: 'u2', usuarioNome: 'Bia', lead: 'Rodrigo', contato: '+55 11 91133-3043' }); // de outro SDR

  const conversa = { telefone: '5511911333043', nome: '+55 11 91133-3043' };
  const r = await closerAuto.preencher({ usuario: CAUA, conversa, ficha: fichaRd('Reunião Realizada', 'Closers', 'Paulo Henrique Pagoti de Oliveira Silva'), reuniao: null });
  assert.deepEqual(r, { closerNome: 'Paulo Henrique', origem: 'rd', preenchidos: 2 });
  assert.equal(await closerDe('r1'), 'Paulo Henrique');
  assert.equal(await closerDe('r2'), 'Paulo Henrique');
  assert.equal((await stats.buscarPorId('r1')).closerId, paulo.id);
  assert.equal(await closerDe('r3'), 'Closer Já Marcado', 'closer já marcado não é trocado');
  assert.equal(await closerDe('r4'), '', 'report de outro lead não é tocado');
  assert.equal(await closerDe('r5'), '', 'nem o de outro pré-vendedor');
  // abrir a conversa de novo logo depois não relê nem regrava
  assert.equal(await closerAuto.preencher({ usuario: CAUA, conversa, ficha: fichaRd('Reunião Realizada', 'Closers', 'Paulo Henrique'), reuniao: null }), null);
});

test('pela agenda: a reunião está na agenda do closer (contato salvo com nome); no-show fica de fora', async () => {
  await report('a1', 'Giumar PRONIX Pedroso');
  await report('a2', 'Giumar PRONIX Pedroso');
  await stats.atualizarResultado('a2', { resultado: 'no_show' });
  const r = await closerAuto.preencher({
    usuario: CAUA, conversa: { telefone: '', nome: 'Giumar PRONIX Pedroso' },
    ficha: fichaRd('Qualificado', 'SMQLs Automaticos', 'Cauã Lima', 'Giumar Pedroso'), reuniao: { closer: 'Vitor Augusto Manoel dos Santos' },
  });
  assert.deepEqual(r, { closerNome: 'Vitor Augusto', origem: 'agenda', preenchidos: 1 });
  assert.equal(await closerDe('a1'), 'Vitor Augusto');
  assert.equal(await closerDe('a2'), '');
});

test('não preenche: closer que não está cadastrado, card ainda com o pré-vendedor, ou sem pista nenhuma', async () => {
  await report('n1', '+55 31 97777-1111');
  const conversa = { telefone: '5531977771111', nome: '' };
  assert.equal(await closerAuto.preencher({ usuario: CAUA, conversa, ficha: fichaRd('Reunião Realizada', 'Closers', 'Fulano Não Cadastrado'), reuniao: null }), null);
  assert.equal(await closerAuto.preencher({ usuario: CAUA, conversa, ficha: fichaRd('Respondeu', 'SMQLs Automaticos', 'Cauã Lima'), reuniao: null }), null);
  assert.equal(await closerAuto.preencher({ usuario: CAUA, conversa, ficha: fichaRd('Qualificado', 'SMQLs Automaticos', 'Cauã Lima'), reuniao: { closer: '' } }), null);
  assert.equal(await closerDe('n1'), '');
});
