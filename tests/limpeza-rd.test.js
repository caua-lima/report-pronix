'use strict';
// Limpeza do funil no RD: card parado vira perda em Desqualificados. RD SIMULADO (nenhuma chamada de
// rede), banco em pasta temporária. O que importa provar: a prévia não altera nada; a execução só mexe
// no que continua parado; nenhum campo do card é apagado; dá para desfazer; o relatório bate.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-limpeza-'));
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
const etapa = { e1: { _id: 'e1', name: 'Contato iniciado' }, e2: { _id: 'e2', name: 'Respondeu' }, e3: { _id: 'e3', name: 'Qualificado' }, e9: { _id: 'e9', name: 'Desqualificados' } };
let deals = {};
let escritas = [];
let motivos;
let campos;
let erroNoPut = null;
function reiniciar() {
  const d = (id, nome, et, parado, extra = {}) => ({ _id: id, name: nome, deal_stage: etapa[et], user: CAUA, win: null, closed_at: null, created_at: ha(200), updated_at: ha(parado), last_activity_at: null, deal_custom_fields: [], ...extra });
  deals = Object.fromEntries([
    d('d1', 'PRXC | Lead Um', 'e1', 111),
    d('d2', 'PRXC | Lead Dois', 'e1', 40, { deal_custom_fields: [{ custom_field_id: 'cfOrigem', value: 'Instagram', custom_field: { _id: 'cfOrigem', label: 'Origem' } }, { custom_field: { _id: 'cfSdr', label: 'SDR' }, value: 'Samuel Filipe' }] }),
    d('d3', 'PRXC | Recente', 'e1', 3),
    d('d4', 'PRXC | No limite', 'e1', 15), // "há mais de 15 dias": 15 ainda não entra
    d('d5', 'PRXC | Parou', 'e2', 60),
    d('d6', 'PRXC | Atividade ontem', 'e2', 90, { last_activity_at: ha(1) }),
    d('d7', 'PRXC | Do Samuel', 'e1', 80, { user: SAMUEL }),
    d('d8', 'PRXC | Qualificado parado', 'e3', 99), // outra etapa: nunca entra
    d('d9', 'PRXC | Já perdido', 'e2', 70, { win: false, closed_at: ha(70) }),
  ].map((x) => [x._id, x]));
  escritas = [];
  erroNoPut = null;
  motivos = [{ _id: 'm1', name: 'Nunca Respondeu (SDR)' }, { _id: 'm2', name: 'Parou de Responder (SDR/Closer)' }, { _id: 'm3', name: 'Outros' }];
  campos = [{ _id: 'cfSdr', label: 'SDR', opts: ['Reinaldo Ramos Rocha Junior', 'Samuel Filipe', 'Closer', 'Cauã', 'Juliana'] }, { _id: 'cfOrigem', label: 'Origem', opts: [] }];
}
crm.configurado = () => true;
crm.funis = async () => [{ id: 'f1', nome: 'Funil SDR', etapas: Object.values(etapa).map((e, ordem) => ({ id: e._id, nome: e.name, ordem })) }];
crm.usuariosRd = async () => [{ id: 'u1', nome: 'Cauã Lima' }, { id: 'u2', nome: 'Samuel Filipe' }];
crm.rd = async (caminho, params = {}, { metodo = 'GET', corpo } = {}) => {
  if (caminho === '/deal_lost_reasons') return { deal_lost_reasons: motivos };
  if (caminho === '/custom_fields') return { custom_fields: campos };
  if (caminho === '/deals') {
    const lista = Object.values(deals).filter((d) => d.deal_stage._id === params.deal_stage_id && (!params.user_id || d.user._id === params.user_id));
    return { deals: JSON.parse(JSON.stringify(lista)), has_more: false };
  }
  const m = /^\/deals\/(.+)$/.exec(caminho);
  if (m) {
    const d = deals[decodeURIComponent(m[1])];
    if (!d) return null;
    if (metodo === 'GET') return JSON.parse(JSON.stringify(d));
    if (erroNoPut) throw new Error(erroNoPut);
    escritas.push({ id: d._id, corpo: JSON.parse(JSON.stringify(corpo)) });
    if (corpo.deal_stage_id) d.deal_stage = Object.values(etapa).find((e) => e._id === corpo.deal_stage_id);
    if (corpo.deal && 'win' in corpo.deal) { d.win = corpo.deal.win; d.closed_at = corpo.deal.win === null ? null : new Date().toISOString(); }
    if (corpo.deal && corpo.deal.deal_custom_fields) d.deal_custom_fields = corpo.deal.deal_custom_fields;
    d.updated_at = new Date().toISOString();
    return JSON.parse(JSON.stringify(d));
  }
  throw new Error('chamada ao RD não prevista no teste: ' + caminho);
};
const limparCache = async () => { await db.cacheDel('crm:motivos-perda'); await db.cacheDel('crm:campos-negociacao'); };
test.beforeEach(async () => { reiniciar(); await limparCache(); });
test.after(() => fs.rmSync(DADOS, { recursive: true, force: true }));
const EU = { id: 'meu-id', nome: 'Cauã Lima' };

// ---------------------------------------------------------------- "parado há"
test('parado há: conta do movimento mais recente (atividade, atualização ou criação); sem data, não afirma nada', () => {
  const agora = Date.parse('2026-10-12T12:00:00Z');
  const d = (x) => limpeza.diasParado(x, agora);
  assert.equal(d({ updated_at: '2026-09-01T12:00:00Z', created_at: '2026-01-01T00:00:00Z' }), 41);
  assert.equal(d({ updated_at: '2026-06-01T12:00:00Z', last_activity_at: '2026-10-11T12:00:00Z' }), 1, 'atividade recente manda');
  assert.equal(d({ created_at: '2026-10-12T00:00:00Z' }), 0);
  assert.equal(d({}), null);
});

// ---------------------------------------------------------------- prévia
test('prévia: lista só o que está em aberto, nas duas etapas e parado há MAIS de 15 dias — e não altera nada', async () => {
  const p = await limpeza.previa({ usuario: EU, dias: 15, escopo: 'meus' });
  assert.deepEqual(p.cards.map((c) => [c.id, c.motivo, c.dias]), [['d1', 'Nunca respondeu', 111], ['d5', 'Parou de responder', 60], ['d2', 'Nunca respondeu', 40]]);
  assert.deepEqual(p.ids, ['d1', 'd5', 'd2']);
  assert.deepEqual(p.porMotivo, [
    { rotulo: 'Nunca respondeu', etapa: 'Contato iniciado', total: 2, naEtapa: 4 },
    { rotulo: 'Parou de responder', etapa: 'Respondeu', total: 1, naEtapa: 3 },
  ]);
  assert.deepEqual(p.contexto, {
    funil: 'Funil SDR', destino: 'Desqualificados', sdr: 'Cauã', responsavel: 'Cauã Lima',
    motivos: [{ etapa: 'Contato iniciado', motivo: 'Nunca Respondeu (SDR)' }, { etapa: 'Respondeu', motivo: 'Parou de Responder (SDR/Closer)' }], avisos: [],
  });
  assert.equal(escritas.length, 0, 'a prévia só lê');

  // todos da etapa: entra o card do outro responsável
  const todos = await limpeza.previa({ usuario: EU, dias: 15, escopo: 'todos' });
  assert.deepEqual(todos.ids, ['d1', 'd7', 'd5', 'd2']);
  // outro limite de dias
  assert.deepEqual((await limpeza.previa({ usuario: EU, dias: 50, escopo: 'meus' })).ids, ['d1', 'd5']);
  assert.equal((await limpeza.previa({ usuario: EU, dias: 'abc', escopo: 'meus' })).dias, 15, 'limite inválido vira o padrão');
});

// ---------------------------------------------------------------- execução
test('executar: move para Desqualificados, marca perda com o motivo certo e preenche SDR sem apagar os outros campos', async () => {
  const r = await limpeza.executar({ usuario: EU, ids: ['d1', 'd2', 'd5'], dias: 15, escopo: 'meus' });
  assert.deepEqual(r.feitos.map((f) => [f.id, f.motivo]), [['d1', 'Nunca respondeu'], ['d2', 'Nunca respondeu'], ['d5', 'Parou de responder']]);
  assert.deepEqual([r.pulados.length, r.erros.length, r.limite], [0, 0, false]);

  assert.deepEqual(escritas[0], { id: 'd1', corpo: { deal_stage_id: 'e9', deal: { win: false, deal_lost_reason_id: 'm1', deal_custom_fields: [{ custom_field_id: 'cfSdr', value: 'Cauã' }] } } });
  // d2 já tinha "Origem" e um SDR antigo: a origem fica, o SDR é trocado (sem duplicar)
  assert.deepEqual(escritas[1].corpo.deal.deal_custom_fields, [{ custom_field_id: 'cfOrigem', value: 'Instagram' }, { custom_field_id: 'cfSdr', value: 'Cauã' }]);
  assert.deepEqual([escritas[2].id, escritas[2].corpo.deal.deal_lost_reason_id], ['d5', 'm2']);
  assert.deepEqual([deals.d1.deal_stage.name, deals.d1.win], ['Desqualificados', false]);

  // relatório por motivo, do jeito pedido
  const rel = await limpeza.relatorio({});
  assert.deepEqual(rel.porMotivo, [{ rotulo: 'Nunca respondeu', total: 2 }, { rotulo: 'Parou de responder', total: 1 }]);
  assert.equal(rel.texto, '• Nunca respondeu - 2\n• Parou de responder - 1\nTotal: 3');
  const hoje = require('../src/stats').emDiaLocal(new Date().toISOString());
  assert.equal((await limpeza.relatorio({ de: hoje, ate: hoje })).total, 3);
  assert.equal((await limpeza.relatorio({ de: '2999-01-01' })).total, 0);

  // rodar de novo: os mesmos cards já estão fechados — nada é escrito outra vez
  const de_novo = await limpeza.executar({ usuario: EU, ids: ['d1', 'd2', 'd5'], dias: 15, escopo: 'meus' });
  assert.deepEqual([de_novo.feitos.length, de_novo.pulados.length], [0, 3]);
  assert.equal(escritas.length, 3);
});

test('executar: cada card é lido de novo — o que mudou desde a prévia é pulado, com o motivo', async () => {
  const r = await limpeza.executar({ usuario: EU, ids: ['d3', 'd4', 'd6', 'd7', 'd8', 'd9', 'naoexiste', 'id inválido!'], dias: 15, escopo: 'meus' });
  assert.equal(r.feitos.length, 0);
  assert.deepEqual(Object.fromEntries(r.pulados.map((p) => [p.id, p.porque])), {
    d3: 'teve movimento recente', d4: 'teve movimento recente', d6: 'teve movimento recente',
    d7: 'é de outro responsável', d8: 'mudou de etapa', d9: 'já foi fechado', naoexiste: 'o card não existe mais',
  });
  assert.equal(escritas.length, 0);
  // em "todos da etapa", o card do Samuel entra (e o SDR preenchido é o de quem pediu)
  const todos = await limpeza.executar({ usuario: EU, ids: ['d7'], dias: 15, escopo: 'todos' });
  assert.equal(todos.feitos.length, 1);
});

test('executar: no máximo 20 por chamada; RD que recusa ou limita não derruba o resto', async () => {
  await assert.rejects(() => limpeza.executar({ usuario: EU, ids: [], dias: 15 }), /Nenhum card/);
  for (let i = 0; i < 30; i++) deals['x' + i] = { ...JSON.parse(JSON.stringify(deals.d1)), _id: 'x' + i };
  const muitos = await limpeza.executar({ usuario: EU, ids: Array.from({ length: 30 }, (_, i) => 'x' + i), dias: 15, escopo: 'meus' });
  assert.equal(muitos.feitos.length, limpeza.LOTE_MAX);

  erroNoPut = 'O RD Station recusou a mudança de etapa (422).';
  const recusa = await limpeza.executar({ usuario: EU, ids: ['d1', 'd2'], dias: 15, escopo: 'meus' });
  assert.deepEqual([recusa.feitos.length, recusa.erros.length, recusa.limite], [0, 2, false]);
  assert.equal(deals.d1.deal_stage.name, 'Contato iniciado', 'card com erro fica onde estava');

  erroNoPut = 'O RD Station CRM limitou as consultas. Tente de novo em 1 minuto.';
  const limite = await limpeza.executar({ usuario: EU, ids: ['d1', 'd2', 'd5'], dias: 15, escopo: 'meus' });
  assert.deepEqual([limite.erros.length, limite.limite], [1, true], 'para no primeiro limite, sem insistir');

  erroNoPut = null;
  process.env.CRM_MOVER_ETAPA = '0';
  await assert.rejects(() => limpeza.executar({ usuario: EU, ids: ['d1'], dias: 15 }), /escrita no RD está desligada/);
  delete process.env.CRM_MOVER_ETAPA;
});

// ---------------------------------------------------------------- desfazer
test('desfazer: o card volta para a etapa de onde saiu, em aberto, e sai do relatório', async () => {
  await limpeza.executar({ usuario: EU, ids: ['d1', 'd5'], dias: 15, escopo: 'meus' });
  const r = await limpeza.desfazer({ usuario: EU, ids: ['d5', 'd3'] });
  assert.deepEqual(r.desfeitos, [{ id: 'd5', nome: 'PRXC | Parou', etapa: 'Respondeu' }]);
  assert.match(r.erros[0].erro, /não está no registro/);
  assert.deepEqual(escritas[escritas.length - 1], { id: 'd5', corpo: { deal_stage_id: 'e2', deal: { win: null, deal_lost_reason_id: null } } });
  assert.deepEqual([deals.d5.deal_stage.name, deals.d5.win], ['Respondeu', null]);
  // só o que não foi desfeito conta — olhando só para os dois cards deste teste
  const rel = await limpeza.relatorio({});
  assert.equal(rel.porMotivo.find((m) => m.rotulo === 'Parou de responder').total < rel.porMotivo.find((m) => m.rotulo === 'Nunca respondeu').total, true);
  assert.match((await limpeza.desfazer({ usuario: EU, ids: ['d5'] })).erros[0].erro, /já foi desfeito/);
});

// ---------------------------------------------------------------- quando falta algo no RD
test('faltou algo no RD: o erro diz o quê (motivo de perda, opção do SDR, etapa, usuário)', async () => {
  motivos = [{ _id: 'm3', name: 'Outros' }];
  await assert.rejects(() => limpeza.previa({ usuario: EU }), /Não achei no RD o motivo de perda "Nunca respondeu"\. Motivos que existem: Outros\./);
  reiniciar(); await limparCache();
  campos = [{ _id: 'cfSdr', label: 'SDR', opts: ['Samuel Filipe', 'Juliana'] }];
  await assert.rejects(() => limpeza.previa({ usuario: EU }), /não tem uma opção com o seu nome \("Cauã Lima"\)\. Opções: Samuel Filipe, Juliana\./);
  reiniciar(); await limparCache();
  campos = [];
  const semCampo = await limpeza.previa({ usuario: EU });
  assert.match(semCampo.contexto.avisos[0], /Não achei o campo "SDR"/);
  assert.equal(semCampo.contexto.sdr, '');
  // usuário que não existe no RD: "só os meus" não tem como filtrar
  await assert.rejects(() => limpeza.previa({ usuario: { id: 'x', nome: 'Fulano de Tal' }, escopo: 'meus' }), /Não achei no RD um usuário com o seu nome/);
  const funisOk = crm.funis;
  crm.funis = async () => [{ id: 'f2', nome: 'Outro funil', etapas: [{ id: 'z1', nome: 'Entrada', ordem: 0 }] }];
  await assert.rejects(() => limpeza.previa({ usuario: EU }), /Não achei no RD um funil/);
  crm.funis = funisOk;
});

// ---------------------------------------------------------------- rotas
test('rotas: só o master usa; a prévia e o relatório respondem pelo painel', async () => {
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
    for (const [m, rota] of [['GET', '/api/master/limpeza-rd/previa'], ['POST', '/api/master/limpeza-rd/executar'], ['POST', '/api/master/limpeza-rd/desfazer'], ['GET', '/api/master/limpeza-rd/relatorio']]) {
      assert.equal((await chamar(m, rota, m === 'POST' ? { ids: ['d1'] } : undefined, sdr)).status, 403, rota);
    }
    const p = await chamar('GET', '/api/master/limpeza-rd/previa?dias=15&escopo=meus', undefined, master);
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.ids, ['d1', 'd5', 'd2']);
    const e = await chamar('POST', '/api/master/limpeza-rd/executar', { ids: ['d1'], dias: 15, escopo: 'meus' }, master);
    assert.equal(e.json.feitos.length, 1);
    const rel = await chamar('GET', '/api/master/limpeza-rd/relatorio', undefined, master);
    assert.match(rel.json.texto, /• Nunca respondeu - \d+\n• Parou de responder - \d+\nTotal: \d+|• Parou de responder - \d+\n• Nunca respondeu - \d+\nTotal: \d+/);
    const erro = await chamar('POST', '/api/master/limpeza-rd/executar', { ids: [] }, master);
    assert.equal(erro.status, 400);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});
