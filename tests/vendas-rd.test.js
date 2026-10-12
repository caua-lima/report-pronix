'use strict';
// Venda marcada no RD pelo closer: o sistema só lê o RD e leva para o report o resultado (venda em call ou
// em follow-up), o produto e o ticket. RD simulado, banco temporário.
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

test('puxar vendas do RD: quem tem card ganho vira venda em call sozinho; o que foi marcado à mão não muda', async () => {
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
  assert.equal((await stats.buscarPorId('v1')).resultado, 'venda_call', 'vendido sem passar pelo follow-up: venda em call');
  assert.equal((await stats.buscarPorId('v3')).resultado, '');
  assert.ok(!(await stats.buscarPorId('v4')).vendidoNoRd, 'venda já marcada à mão nem é consultada');

  // venda ainda sem produto nem ticket continua sendo conferida (o closer pode preencher depois), sem contar de novo
  consultas.length = 0;
  const r2 = await vendasRd.sincronizar(await stats.listar({}));
  assert.deepEqual(r2, { conferidos: 4, vendidos: 0, encerrados: 0, restantes: 0 });
  // completa (produto e ticket): não é mais consultada
  await stats.atualizarResultado('v1', { produto: 'performance', ticket: 18624 });
  await stats.atualizarResultado('v2', { produto: 'acelera', ticket: 24000 });
  consultas.length = 0;
  const r3 = await vendasRd.sincronizar(await stats.listar({}));
  assert.deepEqual(r3, { conferidos: 2, vendidos: 0, encerrados: 0, restantes: 0 });
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
  const quando = new Date(Date.now() + 7200000).toISOString();
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [cardPerdido(), { id: 'g', ganha: true, fechadaEm: quando }] }, report), { venda: true, cardId: 'g', fechadaEm: quando });
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

// ---------------------------------------------------------------- etapas do funil dos closers
test('funil dos closers: "Vendido" é venda mesmo sem marcar ganho, "Fluxo de FUP" vira em follow-up, "Não Compraram" encerra', async () => {
  const report = { quando: new Date().toISOString() };
  const card = (etapa) => ({ id: 'x', ganha: false, perdida: false, etapa, atualizadaEm: new Date(Date.now() + 3600000).toISOString() });
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [card('Vendido')] }, report), { venda: true, cardId: 'x' });
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [card('Fluxo de FUP')] }, report), { fup: true });
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [card('Não Compraram')] }, report), { perda: true, motivo: 'Movido para "Não Compraram" no RD.' });
  assert.equal(vendasRd.desfecho({ negociacoes: [card('Em contato')] }, report), null);
  assert.equal(vendasRd.desfecho({ negociacoes: [card('Negociação Avançada')] }, report), null);

  const antes = crm.consultarLead;
  crm.consultarLead = async () => ({ configurado: true, encontrado: true, ficha: { nome: 'x', negociacoes: [card('Fluxo de FUP')] } });
  try {
    await report0('f1');
    await report0('f2');
    await stats.atualizarResultado('f2', { resultado: 'pix_compromisso' }); // já tem venda: nem entra
    const r = await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id.startsWith('f')));
    assert.deepEqual(r, { conferidos: 1, vendidos: 0, encerrados: 0, restantes: 0 });
    assert.equal((await stats.buscarPorId('f1')).resultado, 'em_followup');
    // continua acompanhado: quando o closer mover para "Vendido", vira o selo de venda
    crm.consultarLead = async () => ({ configurado: true, encontrado: true, ficha: { nome: 'x', negociacoes: [card('Vendido')] } });
    assert.equal((await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 'f1'))).vendidos, 1);
    const f1 = await stats.buscarPorId('f1');
    assert.ok(f1.vendidoNoRd);
    assert.equal(f1.resultado, 'venda_fup', 'passou pelo follow-up antes de vender: venda em follow-up');
  } finally {
    crm.consultarLead = antes;
  }
});
const report0 = (id) => stats.registrar({ id, usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead ' + id, contato: 'Contato ' + id, origem: 'extensao' });

test('a conferência no RD também preenche o closer do report quando o card já está com ele no funil dos closers', async () => {
  const closers = require('../src/closers');
  const paulo = await closers.criar('Paulo Henrique');
  const antes = crm.consultarLead;
  crm.consultarLead = async () => ({ configurado: true, encontrado: true, ficha: {
    nome: 'x', negociacao: { etapa: 'Em contato', funil: 'Comercial', responsavel: 'Paulo Henrique Pagoti' },
    negociacoes: [{ id: 'k', ganha: false, perdida: false, etapa: 'Em contato' }],
  } });
  try {
    await stats.registrar({ id: 'k1', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead k1', contato: 'Contato k1' });
    await stats.registrar({ id: 'k2', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead k2', contato: 'Contato k2' });
    await stats.atualizarResultado('k2', { closerId: 'outro', closerNome: 'Já Marcado' });
    await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id.startsWith('k')));
    assert.deepEqual([(await stats.buscarPorId('k1')).closerId, (await stats.buscarPorId('k1')).closerNome], [paulo.id, 'Paulo Henrique']);
    assert.equal((await stats.buscarPorId('k2')).closerNome, 'Já Marcado', 'closer já marcado não muda');
  } finally {
    crm.consultarLead = antes;
  }
});

test('dados da venda: produto, ticket (em reais, em qualquer formato) e pagamento; o valor do card vendido vira o ticket se estiver vazio', async () => {
  assert.deepEqual(['R$ 15.984,00', '15984', '15.984', '1.552,50', 29892.5, '', 'abc'].map(stats.valorEmReais), [15984, 15984, 15984, 1552.5, 29892.5, 0, 0]);
  await stats.registrar({ id: 't1', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead t1', contato: 'Contato t1' });
  await stats.atualizarResultado('t1', { produto: 'acelera', ticket: 'R$ 29.892,00', pagamento: '  Cartão   12x ' });
  let r = await stats.buscarPorId('t1');
  assert.deepEqual([r.produto, r.ticket, r.pagamento], ['acelera', 29892, 'Cartão 12x']);
  await stats.atualizarResultado('t1', { produto: 'inventado' });
  assert.equal((await stats.buscarPorId('t1')).produto, '', 'produto fora da lista não entra');

  const antes = crm.consultarLead;
  const vendido = (valor) => ({ configurado: true, encontrado: true, ficha: { nome: 'x', negociacoes: [{ id: 'g', ganha: true, valor, fechadaEm: new Date(Date.now() + 3600000).toISOString() }] } });
  try {
    await stats.registrar({ id: 't2', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead t2', contato: 'Contato t2' });
    await stats.registrar({ id: 't3', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead t3', contato: 'Contato t3' });
    await stats.atualizarResultado('t3', { ticket: 10000 });
    crm.consultarLead = async () => vendido(21900);
    await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 't2' || x.id === 't3'));
    assert.equal((await stats.buscarPorId('t2')).ticket, 21900, 'valor do card no RD');
    assert.equal((await stats.buscarPorId('t3')).ticket, 10000, 'ticket já preenchido não é trocado');
  } finally {
    crm.consultarLead = antes;
  }
});

// ---------------------------------------------------------------- a venda vem completa do RD
test('venda no RD: tipo (call ou follow-up), produto, ticket e data de fechamento vêm do card; o que foi preenchido à mão fica', async () => {
  assert.deepEqual([['Pronix Performance'], ['PRONIX  Acelera 2.0'], ['Outro produto'], [], ['x', 'pronix performance']].map(vendasRd.produtoPeloNome), ['performance', 'acelera', '', '', 'performance']);
  const amanha = new Date(Date.now() + 86400000).toISOString();
  const ganho = (extra = {}) => ({ id: 'g1', ganha: true, etapa: 'Vendido', funil: 'CLOSERS', responsavel: 'Paulo Henrique Pagoti', valor: 18624, produtos: ['Pronix Performance'], fechadaEm: amanha, ...extra });
  assert.deepEqual(vendasRd.desfecho({ negociacoes: [ganho()] }, { quando: new Date().toISOString() }), { venda: true, cardId: 'g1', valor: 18624, produto: 'performance', fechadaEm: amanha });

  const antes = crm.consultarLead;
  const produtosAntes = crm.produtosDoCard;
  const pedidosDeProduto = [];
  crm.produtosDoCard = async (id) => { pedidosDeProduto.push(id); return id === 'semlista' ? ['PRONIX Acelera'] : []; };
  let cards = [ganho()];
  crm.consultarLead = async () => ({ configurado: true, encontrado: true, ficha: { nome: 'x', negociacoes: cards } });
  const so = async (id) => vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === id));
  try {
    // 1) direto da reunião para vendido: venda em call, com tudo do card
    await stats.registrar({ id: 'w1', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead w1', contato: 'Contato w1' });
    assert.equal((await so('w1')).vendidos, 1);
    let r = await stats.buscarPorId('w1');
    assert.deepEqual([r.resultado, r.produto, r.ticket, r.dataFechamento, Boolean(r.vendidoNoRd)], ['venda_call', 'performance', 18624, stats.emDiaLocal(amanha), true]);
    assert.deepEqual(pedidosDeProduto, [], 'o produto veio na ficha: nenhuma consulta a mais');
    assert.equal((await so('w1')).conferidos, 0, 'venda completa não é conferida de novo');

    // 2) fechou depois do dia da reunião: follow-up
    await stats.registrar({ id: 'w2', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead w2', contato: 'Contato w2' });
    await stats.atualizarResultado('w2', { dataReuniao: '2026-01-05' });
    await so('w2');
    assert.equal((await stats.buscarPorId('w2')).resultado, 'venda_fup');

    // 3) produto, ticket e tipo preenchidos à mão não são trocados
    await stats.registrar({ id: 'w3', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead w3', contato: 'Contato w3' });
    await stats.atualizarResultado('w3', { produto: 'acelera', ticket: 9000, dataFechamento: '2026-02-02' });
    await so('w3');
    r = await stats.buscarPorId('w3');
    assert.deepEqual([r.resultado, r.produto, r.ticket, r.dataFechamento], ['venda_call', 'acelera', 9000, '2026-02-02']);

    // 4) a ficha veio sem os produtos: pergunta os produtos do card ao RD; produto desconhecido fica vazio
    cards = [ganho({ id: 'semlista', produtos: [] })];
    await stats.registrar({ id: 'w4', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead w4', contato: 'Contato w4' });
    await so('w4');
    assert.equal((await stats.buscarPorId('w4')).produto, 'acelera');
    assert.deepEqual(pedidosDeProduto, ['semlista']);
    cards = [ganho({ id: 'outro', produtos: ['Consultoria avulsa'], valor: 0 })];
    await stats.registrar({ id: 'w5', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead w5', contato: 'Contato w5' });
    await so('w5');
    r = await stats.buscarPorId('w5');
    assert.deepEqual([r.resultado, r.produto, r.ticket], ['venda_call', '', 0], 'sem produto conhecido e sem valor: os campos ficam para quem preenche');
    // ...e continua sendo conferida enquanto falta (o closer preencheu depois)
    cards = [ganho({ id: 'outro', produtos: ['Pronix Performance'], valor: 15984 })];
    assert.deepEqual(await so('w5'), { conferidos: 1, vendidos: 0, encerrados: 0, restantes: 0 });
    r = await stats.buscarPorId('w5');
    assert.deepEqual([r.produto, r.ticket], ['performance', 15984]);

    // 5) anotado como vendido antes desta versão (sem tipo): é completado uma vez
    await stats.registrar({ id: 'w6', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Lead w6', contato: 'Contato w6' });
    await stats.atualizarResultado('w6', { vendidoNoRd: '2026-01-01T10:00:00.000Z' });
    cards = [ganho({ produtos: [], valor: 0, id: 'antigo' })];
    assert.equal((await so('w6')).conferidos, 1);
    assert.equal((await stats.buscarPorId('w6')).resultado, 'venda_call');
    assert.equal((await so('w6')).conferidos, 0, 'venda antiga já lida não volta para a fila');
  } finally {
    crm.consultarLead = antes;
    crm.produtosDoCard = produtosAntes;
  }
});

test('follow-up: FUP agendado e Fluxo de FUP sempre; "Em contato" e "Negociação avançada" só no funil dos closers', () => {
  const c = (etapa, funil) => ({ etapa, funil });
  assert.deepEqual([c('FUP Agendado'), c('Fluxo de FUP', 'x'), c('Em contato', 'CLOSERS'), c('Negociação Avançada', 'Closers 2026'), c('Em contato', 'SMQLs'), c('Reunião Realizada', 'CLOSERS'), c('Respondeu', 'SMQLs')].map(vendasRd.emFollowUp), [true, true, true, true, false, false, false]);
});

// ---------------------------------------------------------------- achar o lead certo no RD
test('vínculo: busca pelo e-mail, depois telefone, id do contato e só então o contato do WhatsApp; achou, grava no report', async () => {
  assert.deepEqual(vendasRd.buscasDoReport({ rdContatoId: 'k1', telefone: '5571999998888', leadEmail: 'Lead@Exemplo.com', contato: 'Bruno PRONIX Mello' }), [{ email: 'lead@exemplo.com' }, { telefone: '5571999998888' }, { contatoId: 'k1' }, { nome: 'Bruno PRONIX Mello' }]);
  assert.deepEqual(vendasRd.buscasDoReport({ contato: '+55 71 99999-8888', telefone: '5571999998888' }), [{ telefone: '5571999998888' }], 'sem repetir a mesma busca');
  assert.deepEqual(vendasRd.buscasDoReport({ contato: '', lead: '' }), []);

  const antes = crm.consultarLead;
  const feitas = [];
  const FICHA = { contatoId: 'k9', nome: 'Bruno Mello', telefones: ['(71) 99999-8888'], emails: ['Bruno@Exemplo.com'], campos: [], negociacao: { etapa: 'Respondeu', funil: 'SMQLs automáticas', responsavel: 'Cauã Lima' },
    negociacoes: [{ id: 'n1', etapa: 'Respondeu', funil: 'SMQLs automáticas', responsavel: 'Cauã Lima', escolhida: true }] };
  crm.consultarLead = async (b) => { feitas.push(b); return b.email === 'bruno@exemplo.com' || b.contatoId === 'k9' ? { configurado: true, encontrado: true, ficha: FICHA } : { configurado: true, encontrado: false }; };
  try {
    // o nome do WhatsApp não acha; o e-mail guardado do card acha
    await stats.registrar({ id: 'y1', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Bruno PRONIX Mello', contato: 'Bruno PRONIX Mello', vinculo: { email: 'bruno@exemplo.com' } });
    await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 'y1'));
    assert.deepEqual(feitas, [{ email: 'bruno@exemplo.com' }]);
    let r = await stats.buscarPorId('y1');
    assert.deepEqual([r.rdContatoId, r.telefone, r.leadEmail, r.rdSituacao], ['k9', '71999998888', 'bruno@exemplo.com', 'Respondeu · SMQLs automáticas · Cauã Lima']);
    assert.equal(r.versao, 0, 'conferência e vínculo não contam como edição: quem está com a tela aberta não leva conflito');
    // da próxima vez: e-mail de novo e, como ainda não apareceu card com closer, o telefone também
    // (o card da reunião pode estar em outro cadastro do mesmo lead); o id do contato fica de reserva
    feitas.length = 0;
    await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 'y1'));
    assert.deepEqual(feitas, [{ email: 'bruno@exemplo.com' }, { telefone: '71999998888' }]);

    // sem vínculo e sem achar pelo nome: a linha diz o que falta
    await stats.registrar({ id: 'y2', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Diego Martins', contato: 'Diego Martins' });
    await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 'y2'));
    r = await stats.buscarPorId('y2');
    assert.equal(r.rdSituacao, 'Não achei este lead no RD. Informe o e-mail ou o telefone dele.');
    assert.ok(r.rdConferidoEm);
  } finally {
    crm.consultarLead = antes;
  }
});

test('vínculo: nome com mais de um contato no RD só vale se exatamente um deles tem card do próprio pré-vendedor', async () => {
  const antes = crm.consultarLead;
  const ficha = (id, responsavel, sdr) => ({ contatoId: id, nome: 'Diego Martins', telefones: [], emails: [], campos: sdr ? [{ rotulo: 'SDR', valor: sdr }] : [], negociacoes: [{ id: 'n' + id, etapa: 'Reunião Realizada', funil: 'CLOSERS', responsavel }] });
  let fichas = { a: ficha('a', 'Outro Vendedor'), b: ficha('b', 'Giovane Ribeiro', 'Cauã'), c: ficha('c', 'Samuel Filipe') };
  crm.consultarLead = async (b) => (b.contatoId ? { configurado: true, encontrado: true, ficha: fichas[b.contatoId] }
    : { configurado: true, encontrado: false, candidatos: Object.keys(fichas).map((id) => ({ id, nome: 'Diego Martins' })) });
  try {
    await stats.registrar({ id: 'z1', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Diego Martins', contato: 'Diego Martins' });
    await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 'z1'));
    let r = await stats.buscarPorId('z1');
    assert.deepEqual([r.rdContatoId, r.rdSituacao], ['b', 'Reunião Realizada · CLOSERS · Giovane Ribeiro — este closer não está cadastrado em Closers (ou o nome não bate)'], 'o campo SDR do card diz de quem é o lead; e a linha avisa que o closer do RD não está no cadastro');
    assert.equal(r.closerId, '', 'closer fora do cadastro não é preenchido');

    // dois candidatos com card do mesmo pré-vendedor: continua sem escolher, e diz por quê
    fichas = { a: ficha('a', 'Cauã Lima'), b: ficha('b', 'Giovane Ribeiro', 'Cauã') };
    await stats.registrar({ id: 'z2', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Diego Martins', contato: 'Diego Martins' });
    await vendasRd.sincronizar((await stats.listar({})).filter((x) => x.id === 'z2'));
    r = await stats.buscarPorId('z2');
    assert.deepEqual([r.rdContatoId || '', r.rdSituacao], ['', 'Não achei no RD: 2 contatos com esse nome. Informe o e-mail ou o telefone do lead.']);
  } finally {
    crm.consultarLead = antes;
  }
});

test('closer do lead: vale o card que já está com um closer, mesmo que a ficha abra no card do pré-vendedor', async () => {
  const closerAuto = require('../src/closerAuto');
  const ficha = { negociacao: { etapa: 'Respondeu', funil: 'SMQLs automáticas', responsavel: 'Cauã Lima' },
    negociacoes: [{ id: 'a', etapa: 'Respondeu', funil: 'SMQLs automáticas', responsavel: 'Cauã Lima', escolhida: true }, { id: 'b', etapa: 'FUP Agendado', funil: 'CLOSERS', responsavel: 'Zayra Beatriz' }] };
  assert.equal(closerAuto.closerDoRd(ficha), 'Zayra Beatriz');
  assert.equal(closerAuto.closerDoRd({ negociacao: ficha.negociacao, negociacoes: [ficha.negociacoes[0]] }), '');
  assert.equal(vendasRd.situacaoNoRd(ficha), 'FUP Agendado · CLOSERS · Zayra Beatriz', 'a linha mostra o card que está com o closer');
  assert.equal(vendasRd.situacaoNoRd({ negociacoes: [] }), 'Achei o contato no RD, mas ele não tem negociação.');
});

test('ao abrir a conversa: o vínculo do card vai para os reports daquele lead, mesmo sem desfecho', async () => {
  await stats.registrar({ id: 'o1', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Marcio PRONIX Henrique', contato: 'Marcio PRONIX Henrique' });
  const conversa = { telefone: '', nome: 'Marcio PRONIX Henrique' };
  const ficha = { contatoId: 'm7', nome: 'Marcio Henrique', telefones: ['+55 (11) 98888-7777'], emails: ['marcio@exemplo.com'], negociacoes: [{ id: 'a', ganha: false, etapa: 'Respondeu' }] };
  assert.equal(await vendasRd.anotarPelaFicha({ usuario: { id: 'u1', nome: 'Cauã Lima' }, conversa, ficha }), 0);
  const r = await stats.buscarPorId('o1');
  assert.deepEqual([r.rdContatoId, r.telefone, r.leadEmail, r.resultado], ['m7', '5511988887777', 'marcio@exemplo.com', '']);
});

// ---------------------------------------------------------------- a rodada automática
test('rodada automática: recentes primeiro, um terço para os antigos, e quem foi conferido há pouco fica para a próxima', () => {
  const agora = Date.parse('2026-10-12T15:00:00Z');
  const ha = (h) => new Date(agora - h * 3600000).toISOString();
  const r = (id, idadeH, conferidoH, extra = {}) => ({ id, contato: 'Contato ' + id, quando: ha(idadeH), dia: ha(idadeH).slice(0, 10), rdConferidoEm: conferidoH == null ? '' : ha(conferidoH), ...extra });
  const reports = [
    r('q1', 5, 0.2), r('q2', 30, 2), r('q3', 60, null), r('q4', 100, 5), // recentes (até 7 dias)
    r('f1', 24 * 20, 30), r('f2', 24 * 40, 3), r('f3', 24 * 30, 100), // antigos
    r('v1', 24 * 30, 0.1, { resultado: 'venda_call' }), r('n1', 24 * 3, null, { resultado: 'no_show' }), r('s1', 24 * 2, null, { contato: '', lead: '' }), // fora
    r('velho', 24 * 120, null), // mais de 90 dias
    r('c1', 24 * 15, 2, { vendidoNoRd: ha(10), rdVendaLida: ha(10), resultado: 'venda_call' }), // venda recente sem produto: conta como quente
  ];
  const ids = (o) => vendasRd.escolherFila(reports, { agora, ...o }).escolhidos.map((x) => x.id);
  assert.deepEqual(ids({ porVez: 3, minutosQuente: 50, horasFrio: 20 }), ['q3', 'q4', 'f3'], 'dois terços recentes (os conferidos há mais tempo), um terço antigo');
  assert.deepEqual(ids({ porVez: 12, minutosQuente: 50, horasFrio: 20 }), ['q3', 'q4', 'q2', 'c1', 'f3', 'f1'], 'q1 (há 12 min) e f2 (há 3 h) esperam');
  assert.deepEqual(ids({ porVez: 12 }), ['q3', 'q4', 'q2', 'c1', 'q1', 'f3', 'f1', 'f2'], 'sem intervalo (botão), entra tudo que está em aberto');
  assert.equal(vendasRd.escolherFila(reports, { agora, porVez: 2, minutosQuente: 50, horasFrio: 20 }).total, 6);
});
