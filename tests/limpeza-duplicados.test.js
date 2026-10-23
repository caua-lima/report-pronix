'use strict';
// Cadastros duplicados na Limpeza do RD: o mesmo lead (e-mail ou telefone igual) com mais de um card em
// aberto no funil, no nome de quem pediu. Um fica; os outros saem como "Duplicado". RD SIMULADO, banco
// em pasta temporária. O que importa provar: a busca não altera nada; nunca se fecha o último card vivo
// de um lead; lead perdido que voltou não é duplicado; dá para desfazer; o relatório conta.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-duplicados-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'tok-rd',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_MOVER_ETAPA;

const app = require('../server');
const db = require('../src/db');
const crm = require('../src/crm');
const limpeza = require('../src/limpezaRd');

// ---------------------------------------------------------------- RD simulado
const DIA = 86400000;
const ha = (dias) => new Date(Date.now() - dias * DIA).toISOString();
const CAUA = { _id: 'u1', name: 'Cauã Lima' };
const SAMUEL = { _id: 'u2', name: 'Samuel Filipe' };
const etapa = {
  e1: { _id: 'e1', name: 'Contato iniciado' }, e2: { _id: 'e2', name: 'Respondeu' }, e3: { _id: 'e3', name: 'Qualificado' }, e9: { _id: 'e9', name: 'Desqualificados' },
  z1: { _id: 'z1', name: 'Reunião realizada' }, // etapa de OUTRO funil
};
let deals = {};
let escritas = [];
let motivos;
let pedidosDeLista = [];
function reiniciar() {
  const contato = (email, fone) => [{ name: 'x', emails: email ? [{ email }] : [], phones: fone ? [{ phone: fone }] : [] }];
  const d = (id, nome, et, criado, parado, email, fone, extra = {}) => ({
    _id: id, name: nome, deal_stage: etapa[et], user: CAUA, win: null, closed_at: null, created_at: ha(criado), updated_at: ha(parado), last_activity_at: null,
    deal_custom_fields: [], contacts: contato(email, fone), ...extra,
  });
  deals = Object.fromEntries([
    // Ana: o card em "Respondeu" fica; o cadastro novo (30 dias) sai. E-mail igual sem diferenciar maiúscula.
    d('a1', 'Ana', 'e1', 30, 20, 'ana@exemplo.com', '(71) 99999-1111'),
    d('a2', 'Ana Souza', 'e2', 60, 25, ' ANA@Exemplo.com ', ''),
    // Bruno: mesma etapa, telefone igual escrito de dois jeitos; fica o de movimento mais recente.
    d('b1', 'Bruno', 'e1', 10, 2, '', '+55 71 98888-2222'),
    d('b2', 'Bruno antigo', 'e1', 40, 30, '', '(71) 8888-2222'),
    // Carla: três cards ligados em corrente (c1-c2 pelo e-mail, c2-c3 pelo telefone).
    d('c1', 'Carla', 'e3', 90, 5, 'carla@exemplo.com', ''),
    d('c2', 'Carla 2', 'e1', 20, 18, 'carla@exemplo.com', '71977773333'),
    d('c3', 'Carla 3', 'e1', 15, 15, '', '(71) 97777-3333'),
    // Daniel: o outro card dele já foi perdido — lead de volta, não duplicado.
    d('d1', 'Daniel', 'e1', 3, 3, 'daniel@exemplo.com', ''),
    d('d2', 'Daniel perdido', 'e1', 80, 40, 'daniel@exemplo.com', '', { win: false, closed_at: ha(40) }),
    // Edu: o outro card é de outro responsável.
    d('e1x', 'Edu', 'e1', 9, 9, 'edu@exemplo.com', ''),
    d('e2x', 'Edu do Samuel', 'e1', 8, 8, 'edu@exemplo.com', '', { user: SAMUEL }),
    // Gil: o outro card está em aberto, mas já na etapa de desqualificados.
    d('g1', 'Gil', 'e1', 7, 7, 'gil@exemplo.com', ''),
    d('g2', 'Gil na desqualificados', 'e9', 50, 50, 'gil@exemplo.com', ''),
    // telefone de preenchimento não identifica ninguém
    d('h1', 'Hugo', 'e1', 6, 6, '', '(11) 99999-9999'),
    d('h2', 'Helena', 'e1', 5, 5, '', '11 99999-9999'),
    // card de outro funil com o e-mail da Ana: não entra
    d('x1', 'Ana no funil dos closers', 'z1', 4, 4, 'ana@exemplo.com', ''),
    // e-mail genérico em sete cards: fica de fora
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => d('t' + n, 'Teste ' + n, 'e1', 12, 12, 'teste@teste.com', '')),
  ].map((x) => [x._id, x]));
  escritas = [];
  pedidosDeLista = [];
  motivos = [{ _id: 'm1', name: 'Nunca Respondeu (SDR)' }, { _id: 'm2', name: 'Parou de Responder (SDR/Closer)' }, { _id: 'm7', name: 'Lead Duplicado' }];
}
crm.configurado = () => true;
crm.funis = async () => [{ id: 'f1', nome: 'SMQLs automáticas', etapas: ['e1', 'e2', 'e3', 'e9'].map((k, ordem) => ({ id: k, nome: etapa[k].name, ordem })) }];
crm.usuariosRd = async () => [{ id: 'u1', nome: 'Cauã Lima' }, { id: 'u2', nome: 'Samuel Filipe' }];
crm.rd = async (caminho, params = {}, { metodo = 'GET', corpo } = {}) => {
  if (caminho === '/deal_lost_reasons') return { deal_lost_reasons: motivos };
  if (caminho === '/custom_fields') return { custom_fields: [{ _id: 'cfSdr', label: 'SDR', opts: ['Samuel Filipe', 'Cauã'] }] };
  if (caminho === '/deals') {
    pedidosDeLista.push({ ...params });
    // De propósito o RD simulado ignora o filtro de funil: o código tem de conferir a etapa por conta própria.
    const lista = Object.values(deals).filter((x) => (!params.user_id || x.user._id === params.user_id) && (params.win !== 'null' || x.win === null));
    return { deals: JSON.parse(JSON.stringify(lista)), has_more: false };
  }
  const m = /^\/deals\/(.+)$/.exec(caminho);
  if (m) {
    const x = deals[decodeURIComponent(m[1])];
    if (!x) return null;
    if (metodo === 'GET') return JSON.parse(JSON.stringify(x));
    escritas.push({ id: x._id, corpo: JSON.parse(JSON.stringify(corpo)) });
    if (corpo.deal_stage_id) x.deal_stage = Object.values(etapa).find((e) => e._id === corpo.deal_stage_id);
    if (corpo.deal && 'win' in corpo.deal) { x.win = corpo.deal.win; x.closed_at = corpo.deal.win === null ? null : new Date().toISOString(); }
    if (corpo.deal && corpo.deal.deal_custom_fields) x.deal_custom_fields = corpo.deal.deal_custom_fields;
    return JSON.parse(JSON.stringify(x));
  }
  throw new Error('chamada ao RD não prevista no teste: ' + caminho);
};
const limparCache = async () => { await db.cacheDel('crm:motivos-perda2'); await db.cacheDel('crm:campos-negociacao'); };
test.beforeEach(async () => { reiniciar(); await limparCache(); });
test.after(() => fs.rmSync(DADOS, { recursive: true, force: true }));
const EU = { id: 'meu-id', nome: 'Cauã Lima' };
// c3 só se liga ao c1 por meio do c2 (telefone): o par leva a ponte.
const PARES = [{ id: 'c2', fica: 'c1' }, { id: 'c3', fica: 'c1', via: 'c2' }, { id: 'a1', fica: 'a2' }, { id: 'b2', fica: 'b1' }];

// ---------------------------------------------------------------- peças
test('telefone: DDD + 8 últimos dígitos, com ou sem 55 e o nono dígito; número curto ou de preenchimento não vale', () => {
  const k = limpeza.chaveDoTelefone;
  assert.deepEqual(['+55 (71) 99999-8888', '71 9999-8888', '5571999998888', '071999998888'].map(k), ['7199998888', '7199998888', '7199998888', '7199998888']);
  assert.notEqual(k('(11) 99999-8888'), k('(71) 99999-8888'), 'outro DDD é outra pessoa');
  assert.deepEqual(['99999-8888', '', '(11) 99999-9999', '11 0000-0000', '+1 415 555 2671 99'].map(k), ['', '', '', '', '']);
  assert.deepEqual(limpeza.chavesDoCard({ contacts: [{ emails: [{ email: ' A@B.com ' }, { email: 'invalido' }], phones: [{ phone: '71 99999-8888' }] }, { emails: ['c@d.com'], phones: [] }] }), ['e:a@b.com', 'e:c@d.com', 't:7199998888']);
  assert.deepEqual(limpeza.chavesDoCard({}), []);
});

// ---------------------------------------------------------------- a busca
test('busca: acha os leads com mais de um card em aberto, diz qual fica e quais saem — e não altera nada', async () => {
  const p = await limpeza.previaDuplicados({ usuario: EU });
  assert.deepEqual(p.grupos.map((g) => [g.fica.id, g.saem.map((s) => s.id), g.por]), [
    ['c1', ['c3', 'c2'], 'e-mail'], // a etapa mais adiantada fica; c3 entrou pelo telefone em comum com c2
    ['a2', ['a1'], 'e-mail'],
    ['b1', ['b2'], 'telefone'], // mesma etapa: fica o de movimento mais recente
  ]);
  assert.deepEqual(p.pares, [{ id: 'c3', fica: 'c1', via: 'c2' }, { id: 'c2', fica: 'c1' }, { id: 'a1', fica: 'a2' }, { id: 'b2', fica: 'b1' }]);
  assert.deepEqual([p.totalGrupos, p.total, p.funilId], [3, 4, 'f1']);
  assert.deepEqual(p.contexto, { funil: 'SMQLs automáticas', destino: 'Desqualificados', motivo: 'Lead Duplicado', sdr: 'Cauã', responsavel: 'Cauã Lima', avisos: [] });
  // só os meus, em aberto, no funil, fora da etapa de destino
  assert.equal(p.analisados, 19);
  assert.deepEqual(pedidosDeLista[0], { deal_pipeline_id: 'f1', win: 'null', limit: 200, page: 1, user_id: 'u1' });
  const todosOsIds = JSON.stringify(p.grupos);
  for (const fora of ['d1', 'd2', 'e1x', 'e2x', 'g1', 'g2', 'h1', 'h2', 'x1', 't1']) assert.ok(!todosOsIds.includes(`"id":"${fora}"`), fora + ' não é duplicado');
  // o que a tela mostra de cada card
  const ana = p.grupos[1];
  assert.deepEqual([ana.fica.nome, ana.fica.etapa, ana.fica.email, ana.fica.dias, ana.fica.link], ['Ana Souza', 'Respondeu', 'ana@exemplo.com', 25, 'https://crm.rdstation.com/app/deals/a2']);
  assert.deepEqual([ana.saem[0].etapa, ana.saem[0].telefone, ana.saem[0].dias], ['Contato iniciado', '(71) 99999-1111', 20]);
  assert.equal(ana.reinscritoHaDias, 30, 'o card que sai é mais novo que o que fica: o lead se inscreveu de novo');
  assert.equal(p.grupos[2].reinscritoHaDias, null, 'o que sai é o mais antigo: não é reinscrição');
  // dado genérico: avisado e fora da conta
  assert.deepEqual(p.suspeitos, [{ dado: 'teste@teste.com', tipo: 'e-mail', cards: 7 }]);
  assert.equal(escritas.length, 0, 'a busca só lê');
});

test('quem fica: etapa mais adiantada; empate, movimento mais recente; empate, o mais antigo', () => {
  const etapas = new Map([['e1', { ordem: 0 }], ['e2', { ordem: 1 }]]);
  const c = (id, et, mov, criado) => ({ _id: id, deal_stage: { _id: et }, updated_at: mov, created_at: criado });
  const fica = (...cards) => limpeza.escolherQuemFica(cards, etapas)._id;
  assert.equal(fica(c('n', 'e1', '2026-10-10', '2026-10-01'), c('v', 'e2', '2026-08-01', '2026-07-01')), 'v', 'etapa manda');
  assert.equal(fica(c('v', 'e1', '2026-08-01', '2026-07-01'), c('n', 'e1', '2026-10-10', '2026-10-01')), 'n', 'depois o movimento');
  assert.equal(fica(c('b', 'e1', '2026-10-10', '2026-09-01'), c('a', 'e1', '2026-10-10', '2026-08-01')), 'a', 'depois o mais antigo');
});

test('sem o motivo "Duplicado" no RD, ou sem usuário no RD com o meu nome: erro que diz o que falta', async () => {
  motivos = motivos.filter((m) => m._id !== 'm7');
  await limparCache();
  await assert.rejects(() => limpeza.previaDuplicados({ usuario: EU }), /Não achei no RD o motivo de perda "Duplicado"\. Motivos que existem: Nunca Respondeu \(SDR\), Parou de Responder \(SDR\/Closer\)\./);
  await assert.rejects(() => limpeza.fecharDuplicados({ usuario: EU, pares: PARES }), /motivo de perda "Duplicado"/);
  assert.equal(escritas.length, 0);
});

// ---------------------------------------------------------------- execução
test('fechar: vai para Desqualificados com a perda "Duplicado" e o SDR; o card que fica não é tocado; relatório e desfazer', async () => {
  const r = await limpeza.fecharDuplicados({ usuario: EU, pares: PARES, execucao: 'rodada-dup-1' });
  assert.deepEqual(r.feitos.map((f) => [f.id, f.motivo, f.fica.id, f.fica.etapa]), [['c2', 'Duplicado', 'c1', 'Qualificado'], ['c3', 'Duplicado', 'c1', 'Qualificado'], ['a1', 'Duplicado', 'a2', 'Respondeu'], ['b2', 'Duplicado', 'b1', 'Contato iniciado']]);
  assert.deepEqual([r.pulados.length, r.erros.length], [0, 0]);
  assert.deepEqual(escritas[0], { id: 'c2', corpo: { deal_stage_id: 'e9', deal: { win: false, deal_lost_reason_id: 'm7', deal_custom_fields: [{ custom_field_id: 'cfSdr', value: 'Cauã' }] } } });
  assert.deepEqual(escritas.map((e) => e.id), ['c2', 'c3', 'a1', 'b2'], 'só os duplicados são escritos');
  assert.deepEqual([deals.c1.win, deals.a2.win, deals.b1.win, deals.a2.deal_stage.name], [null, null, null, 'Respondeu']);
  assert.deepEqual([deals.a1.win, deals.a1.deal_stage.name], [false, 'Desqualificados']);
  assert.equal(r.feitos[2].email, 'ana@exemplo.com');

  // depois de fechar, a busca não acha mais nada desses leads
  assert.equal((await limpeza.previaDuplicados({ usuario: EU })).total, 0);

  // relatório: a linha de duplicados aparece, e rodada só de duplicados não mostra os outros motivos zerados
  const rel = await limpeza.relatorio({});
  assert.deepEqual(rel.porMotivo, [{ rotulo: 'Duplicado', total: 4 }, { rotulo: 'Nunca respondeu', total: 0 }, { rotulo: 'Parou de responder', total: 0 }]);
  assert.equal(rel.texto, '• Duplicado - 4\nTotal: 4');
  const salvo = (await limpeza.relatoriosSalvos()).find((x) => x.id === 'rodada-dup-1');
  assert.deepEqual([salvo.total, salvo.funil], [4, 'SMQLs automáticas']);
  assert.deepEqual(salvo.porMotivo, [{ rotulo: 'Nunca respondeu', total: 0 }, { rotulo: 'Parou de responder', total: 0 }, { rotulo: 'Duplicado', total: 4 }]);
  assert.match(salvo.texto, /— SMQLs automáticas\n• Duplicado - 4\nTotal: 4$/);
  assert.ok(!fs.readFileSync(path.join(DADOS, 'rd_limpeza_relatorios.json'), 'utf8').includes('@'), 'nada de e-mail de lead no que fica guardado');
  assert.ok(!fs.readFileSync(path.join(DADOS, 'rd_limpeza_log.json'), 'utf8').includes('@'));

  // desfazer: o card volta para a etapa de onde saiu, em aberto, e sai da conta
  const d = await limpeza.desfazer({ usuario: EU, ids: ['a1'] });
  assert.deepEqual(d.desfeitos, [{ id: 'a1', nome: 'Ana', etapa: 'Contato iniciado' }]);
  assert.deepEqual([deals.a1.win, deals.a1.deal_stage.name], [null, 'Contato iniciado']);
  assert.equal((await limpeza.relatorio({})).texto, '• Duplicado - 3\nTotal: 3');
  assert.deepEqual((await limpeza.previaDuplicados({ usuario: EU })).pares, [{ id: 'a1', fica: 'a2' }], 'reaberto, volta a ser duplicado');
});

test('fechar confere de novo: nunca fecha o último card vivo do lead, nem o que passou a ser o mais adiantado', async () => {
  deals.a2.win = false; // o card que ficaria foi perdido depois da busca
  deals.b2.deal_stage = etapa.e2; // o "duplicado" do Bruno andou e passou o que ficaria
  deals.c2.contacts = [{ emails: [{ email: 'outra.pessoa@exemplo.com' }], phones: [] }]; // contato corrigido no RD
  deals.t1.user = SAMUEL; // o duplicado mudou de responsável
  deals.t4.user = SAMUEL; // o que ficaria mudou de responsável
  const antes = (await limpeza.relatoriosSalvos()).length;
  const r = await limpeza.fecharDuplicados({ usuario: EU, pares: PARES.concat([{ id: 'naoexiste', fica: 'c1' }, { id: 'g1', fica: 'g2' }, { id: 'd1', fica: 'd2' }, { id: 't1', fica: 't2' }, { id: 't3', fica: 't4' }]) });
  assert.deepEqual(r.feitos, []);
  assert.deepEqual(Object.fromEntries(r.pulados.map((x) => [x.id, x.porque])), {
    c2: 'os dois cards não têm mais e-mail ou telefone em comum',
    c3: 'os dois cards não têm mais e-mail ou telefone em comum', // a ponte (c2) deixou de ter o contato do lead
    a1: 'o card que ficaria não está mais em aberto neste funil',
    b2: 'passou a ser o card mais adiantado do lead',
    naoexiste: 'o card não existe mais',
    g1: 'o card que ficaria não está mais em aberto neste funil', // o outro está na etapa de desqualificados
    d1: 'o card que ficaria não está mais em aberto neste funil', // o outro já foi perdido
    t1: 'é de outro responsável',
    t3: 'o card que ficaria mudou de responsável',
  });
  assert.equal(escritas.length, 0);
  assert.equal((await limpeza.relatoriosSalvos()).length, antes, 'rodada que não fechou nada não vira relatório');

  // pedido sem par válido: erro; par repetido ou com o mesmo card dos dois lados é descartado; o lote tem teto
  await assert.rejects(() => limpeza.fecharDuplicados({ usuario: EU, pares: [{ id: 'a1', fica: 'a1' }, { id: '../x', fica: 'a2' }, null] }), /Nenhum card duplicado para fechar/);
  reiniciar();
  const muitos = await limpeza.fecharDuplicados({ usuario: EU, pares: [{ id: 'b2', fica: 'b1' }, { id: 'b2', fica: 'b1' }].concat(Array.from({ length: 30 }, (_, i) => ({ id: 'q' + i, fica: 'b1' }))) });
  assert.deepEqual([muitos.feitos.map((f) => f.id), muitos.feitos.length + muitos.pulados.length], [['b2'], limpeza.LOTE_DUPLICADOS]);
});

test('a limpeza de parados continua igual: o relatório dela não ganha linha de duplicados sem duplicado', async () => {
  deals.p1 = { _id: 'p1', name: 'Parado', deal_stage: etapa.e1, user: CAUA, win: null, closed_at: null, created_at: ha(200), updated_at: ha(60), last_activity_at: null, deal_custom_fields: [], contacts: [] };
  const lista = crm.rd;
  crm.rd = async (caminho, params = {}, o = {}) => (caminho === '/deals' && params.deal_stage_id
    ? { deals: JSON.parse(JSON.stringify(Object.values(deals).filter((x) => x.deal_stage._id === params.deal_stage_id && x.win === null && x.user._id === params.user_id))), has_more: false }
    : lista(caminho, params, o));
  try {
    const r = await limpeza.executar({ usuario: EU, ids: ['p1'], dias: 15, escopo: 'meus', execucao: 'rodada-parados' });
    assert.deepEqual(r.feitos.map((f) => f.motivo), ['Nunca respondeu']);
    const salvo = (await limpeza.relatoriosSalvos()).find((x) => x.id === 'rodada-parados');
    assert.deepEqual(salvo.porMotivo, [{ rotulo: 'Nunca respondeu', total: 1 }, { rotulo: 'Parou de responder', total: 0 }]);
    assert.match(salvo.texto, /• Nunca respondeu - 1\n• Parou de responder - 0\nTotal: 1$/);
  } finally {
    crm.rd = lista;
  }
});

// ---------------------------------------------------------------- rotas
test('rotas: só o master busca e fecha duplicados', async () => {
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const admin = { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' };
    const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', { method: 'POST', headers: admin, body: JSON.stringify({ nome, papel }) })).json()).usuario;
    const master = await criar('Cauã Lima', 'master');
    const sdr = await criar('Bia SDR', 'sdr');
    const chamar = async (metodo, rota, corpo, u) => {
      const r = await fetch(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', 'x-cr-key': u.chave }, body: corpo ? JSON.stringify(corpo) : undefined });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    assert.equal((await chamar('GET', '/api/master/limpeza-rd/duplicados?funil=f1', undefined, sdr)).status, 403);
    assert.equal((await chamar('POST', '/api/master/limpeza-rd/duplicados', { pares: PARES }, sdr)).status, 403);
    const p = await chamar('GET', '/api/master/limpeza-rd/duplicados?funil=f1', undefined, master);
    assert.equal(p.status, 200);
    assert.deepEqual([p.json.totalGrupos, p.json.total], [3, 4]);
    const f = await chamar('POST', '/api/master/limpeza-rd/duplicados', { pares: p.json.pares.slice(0, 2), funil: 'f1', execucao: 'rodada-rota' }, master);
    assert.deepEqual(f.json.feitos.map((x) => x.id), ['c3', 'c2']);
    assert.equal((await chamar('POST', '/api/master/limpeza-rd/duplicados', { pares: [] }, master)).status, 400);
    assert.equal((await chamar('GET', '/api/master/limpeza-rd/duplicados?funil=outro', undefined, master)).status, 400, 'funil que não existe');
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});
