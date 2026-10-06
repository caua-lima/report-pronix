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
  assert.deepEqual(r, { conferidos: 4, vendidos: 2, encerrados: 0, restantes: 0 });
  assert.deepEqual([await vendido('v1'), await vendido('v2'), await vendido('v3'), await vendido('v4'), await vendido('v5')], [true, true, false, false, false]);
  assert.equal((await stats.buscarPorId('v1')).resultado, '', 'o tipo de venda (call, FUP, pix) continua sendo escolha do master');

  // de novo: quem já foi anotado não é consultado outra vez
  consultas.length = 0;
  const r2 = await vendasRd.sincronizar(await stats.listar({}));
  assert.deepEqual(r2, { conferidos: 2, vendidos: 0, encerrados: 0, restantes: 0 });
  assert.ok(!consultas.some((c) => c.telefone === '5511911110001'));
});

test('muitos reports: confere um lote por clique e diz quantos faltam', async () => {
  for (let i = 0; i < 15; i++) await report('m' + i, '+55 21 9' + String(8000000 + i));
  const r = await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id.startsWith('m')));
  assert.deepEqual(r, { conferidos: 12, vendidos: 0, encerrados: 0, restantes: 3 });
  // a rodada seguinte pega os que ficaram para trás (os conferidos há mais tempo vêm primeiro)
  const r2 = await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id.startsWith('m')), { porVez: 3 });
  assert.equal(r2.conferidos, 3);
  assert.ok((await stats.listar({})).filter((x) => x.id.startsWith('m')).every((x) => x.rdConferidoEm), 'todos passaram pela conferência');
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

// ---------------------------------------------------------------- não comprou: encerra com o motivo do RD
const cardPerdido = (extra = {}) => ({ id: 'p', ganha: false, perdida: true, motivoPerda: 'Sem dinheiro no momento', notaPerda: 'vai tentar em janeiro', fechadaEm: new Date(Date.now() + 3600000).toISOString(), ...extra });

test('desfecho no RD: perdido ou em "Não compraram" vira "não fechou" com o motivo; card antigo do lead não conta', () => {
  const report = { quando: new Date().toISOString() };
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [cardPerdido()] }, report), { perda: true, motivo: 'Sem dinheiro no momento — vai tentar em janeiro' });
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [cardPerdido({ motivoPerda: '', notaPerda: '' })] }, report), { perda: true, motivo: 'Marcado como perdido no RD (sem motivo informado).' });
  // movido para a etapa "Não compraram" sem marcar perdido
  const naEtapa = { id: 'e', ganha: false, perdida: false, etapa: 'Não Compraram', atualizadaEm: new Date(Date.now() + 3600000).toISOString() };
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [naEtapa] }, report), { perda: true, motivo: 'Movido para "Não Compraram" no RD.' });
  // card perdido ANTES de o report existir (inscrição antiga do mesmo lead): não é o desfecho desta reunião
  assert.equal(vendasRd.desfecho({ negociacoes: [cardPerdido({ fechadaEm: '2020-01-01T10:00:00Z' })] }, report), null);
  // perdeu num card e comprou em outro: comprou
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [cardPerdido(), { id: 'g', ganha: true, fechadaEm: new Date(Date.now() + 7200000).toISOString() }] }, report), { venda: true });
  assert.equal(vendasRd.desfecho({ negociacoes: [{ id: 'a', ganha: false, perdida: false, etapa: 'Reunião Realizada' }] }, report), null);
});

test('não comprou no RD: o report é encerrado sozinho com o motivo, sem apagar o que já estava anotado', async () => {
  const antes = crm.consultarLead;
  crm.consultarLead = async (busca) => ({ configurado: true, encontrado: true, ficha: { nome: 'x', negociacoes: busca.telefone === '5541933330001' || busca.telefone === '5541933330002' ? [cardPerdido()] : [] } });
  try {
    await report('p1', '+55 41 93333-0001');
    await report('p2', '+55 41 93333-0002');
    await stats.atualizarResultado('p2', { resultado: 'em_followup', obsReuniao: 'pediu para falar depois do dia 10' });
    await report('p3', '+55 41 93333-0003'); // sem desfecho no RD
    const r = await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id.startsWith('p')));
    assert.deepEqual(r, { conferidos: 3, vendidos: 0, encerrados: 2, restantes: 0 });
    const p1 = await stats.buscarPorId('p1');
    assert.equal(p1.resultado, 'sem_venda');
    assert.equal(p1.obsReuniao, 'RD: Sem dinheiro no momento — vai tentar em janeiro');
    assert.ok(p1.encerradoPeloRd);
    const p2 = await stats.buscarPorId('p2');
    assert.equal(p2.resultado, 'sem_venda', 'estava em follow-up: o RD encerra');
    assert.equal(p2.obsReuniao, 'pediu para falar depois do dia 10 | RD: Sem dinheiro no momento — vai tentar em janeiro');
    assert.equal((await stats.buscarPorId('p3')).resultado, '');
    // encerrado não é conferido de novo
    assert.equal((await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 'p1'))).conferidos, 0);
  } finally {
    crm.consultarLead = antes;
  }
});
