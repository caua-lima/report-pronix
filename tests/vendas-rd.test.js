'use strict';
// Venda marcada no RD pelo closer: o sistema só lê e anota no report. RD simulado, banco temporário.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-vendasrd-'));
Object.assign(process.env, { CR_DATA_DIR: DADOS, KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' });
delete process.env.VERCEL;

const stats = require('../src/stats');
const crm = require('../src/crm');
const vendasRd = require('../src/vendasRd');
test.after(() => fs.rmSync(DADOS, { recursive: true, force: true }));

// RD simulado: quem tem card ganho
const consultas = [];
const GANHOS = new Set(['5511911110001', 'Marcos PRONIX Pereira']);
crm.configurado = () => true;
crm.consultarLead = async (busca) => {
  consultas.push(busca);
  const chave = busca.telefone || busca.nome;
  if (chave === 'quebra') throw new Error('RD fora do ar');
  return { configurado: true, encontrado: true, ficha: { nome: 'x', negociacoes: [{ id: 'a', ganha: false }, { id: 'b', ganha: GANHOS.has(chave) }] } };
};
const report = (id, contato, extra = {}) => stats.registrar({ id, usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead ' + id, contato, origem: 'extensao', ...extra });
const vendido = async (id) => Boolean((await stats.buscarPorId(id)).vendidoNoRd);

test('como achar no RD o lead de um report: telefone quando o contato é número, senão o nome', () => {
  assert.deepEqual(vendasRd.buscaDoReport({ contato: '+55 11 91111-0001' }), { telefone: '5511911110001' });
  assert.deepEqual(vendasRd.buscaDoReport({ contato: 'Marcos PRONIX Pereira' }), { nome: 'Marcos PRONIX Pereira' });
  assert.deepEqual(vendasRd.buscaDoReport({ contato: '', lead: 'Ana' }), { nome: 'Ana' });
  assert.equal(vendasRd.buscaDoReport({ contato: '', lead: '' }), null);
});

test('puxar vendas do RD: anota "vendido no RD" só em quem tem card ganho; não escolhe o tipo de venda', async () => {
  await report('v1', '+55 11 91111-0001'); // ganho no RD
  await report('v2', 'Marcos PRONIX Pereira'); // ganho no RD (contato salvo com nome)
  await report('v3', '+55 11 92222-0002'); // ainda não
  await report('v4', '+55 11 91111-0001');
  await stats.atualizarResultado('v4', { resultado: 'venda_call' }); // já tem venda marcada: não mexe
  await report('v5', '+55 11 91111-0001');
  await stats.atualizarResultado('v5', { resultado: 'no_show' }); // não aconteceu: fora
  await report('v6', 'quebra'); // o RD falha neste: os outros seguem

  const r = await vendasRd.sincronizar(await stats.listar({}));
  assert.deepEqual(r, { conferidos: 4, vendidos: 2, restantes: 0 });
  assert.deepEqual([await vendido('v1'), await vendido('v2'), await vendido('v3'), await vendido('v4'), await vendido('v5')], [true, true, false, false, false]);
  assert.equal((await stats.buscarPorId('v1')).resultado, '', 'o tipo de venda (call, FUP, pix) continua sendo escolha do master');

  // de novo: quem já foi anotado não é consultado outra vez
  consultas.length = 0;
  const r2 = await vendasRd.sincronizar(await stats.listar({}));
  assert.deepEqual(r2, { conferidos: 2, vendidos: 0, restantes: 0 });
  assert.ok(!consultas.some((c) => c.telefone === '5511911110001'));
});

test('muitos reports: confere um lote por clique e diz quantos faltam', async () => {
  for (let i = 0; i < 15; i++) await report('m' + i, '+55 21 9' + String(8000000 + i));
  const r = await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id.startsWith('m')));
  assert.deepEqual(r, { conferidos: 12, vendidos: 0, restantes: 3 });
});

test('ao abrir a conversa: card vendido na ficha anota os reports daquele lead (só os do próprio usuário)', async () => {
  await report('c1', '+55 31 97777-1111');
  await stats.registrar({ id: 'c2', usuarioId: 'u2', usuarioNome: 'Bia', lead: 'x', contato: '+55 31 97777-1111' });
  const conversa = { telefone: '5531977771111', nome: '' };
  const semVenda = { nome: 'x', negociacoes: [{ id: 'a', ganha: false }] };
  assert.equal(await vendasRd.anotarPelaFicha({ usuario: { id: 'u1', nome: 'Cauã Lima' }, conversa, ficha: semVenda }), 0);
  assert.equal(await vendido('c1'), false);
  const comVenda = { nome: 'x', negociacoes: [{ id: 'a', ganha: true }] };
  assert.equal(await vendasRd.anotarPelaFicha({ usuario: { id: 'u1', nome: 'Cauã Lima' }, conversa, ficha: comVenda }), 1);
  assert.equal(await vendido('c1'), true);
  assert.equal(await vendido('c2'), false);
});

test('a ficha do RD diz quais cards foram ganhos', () => {
  assert.equal(vendasRd.temVenda({ negociacoes: [{ ganha: false }, { ganha: true }] }), true);
  assert.equal(vendasRd.temVenda({ negociacoes: [{ ganha: false }] }), false);
  assert.equal(vendasRd.temVenda(null), false);
});
