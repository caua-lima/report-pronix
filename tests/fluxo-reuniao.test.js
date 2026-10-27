'use strict';
// "Reunião realizada" e "Perder como duplicado" no Pronix CRM SIMULADO (leads inventados, banco em pasta temporária).
// Três funis: o MQL vai até a reunião realizada; o Aplicação Direta não tem essa etapa — os cards dele passam para o
// funil Closers, e é o histórico dos cards que já fizeram isso que ensina o caminho.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-fluxo-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;
delete process.env.CRM_MOVER_ETAPA;

const db = require('../src/db');
const closers = require('../src/closers');
const fluxo = require('../src/fluxoReuniao');

const etapa = (id, name, order, categoria, extra = {}) => ({ id, _id: id, name, order, categoria, eh_perdido: categoria === 'perda', eh_ganho: categoria === 'venda', exige_closer: false, ...extra });
const FUNIS = [
  {
    id: 'f-mql', _id: 'f-mql', name: 'Funil MQL',
    deal_stages: [
      etapa('e-contato', 'Contato iniciado', 1, 'contato'), etapa('e-resp', 'Respondeu', 2, 'resposta'), etapa('e-qual', 'Qualificado', 3, null),
      etapa('e-trab', 'Tentando agendar', 4, null), etapa('e-agend', 'Reunião Agendada', 5, 'reuniao_agendada', { exige_closer: true }),
      etapa('e-real', 'Reunião Realizada', 6, 'reuniao_realizada'), etapa('e-fup', 'FUP', 7, 'fup'), etapa('e-venda', 'Vendido', 8, 'venda'), etapa('e-perda', 'Perdido', 9, 'perda'),
    ],
  },
  {
    id: 'f-smql', _id: 'f-smql', name: 'SMQLs Automaticos',
    deal_stages: [
      etapa('s-contato', 'Contato iniciado', 1, 'contato'), etapa('s-resp', 'Respondeu', 2, 'resposta'), etapa('s-emq', 'Em qualificação', 3, null),
      etapa('s-agendou', 'Agendou', 4, 'reuniao_agendada'), etapa('s-real', 'Reunião Realizada', 5, 'reuniao_realizada'), etapa('s-desq', 'Desqualificado', 6, 'perda'),
    ],
  },
  {
    id: 'f-ad', _id: 'f-ad', name: 'Aplicação Direta',
    deal_stages: [etapa('a-novo', 'Novo', 1, 'contato'), etapa('a-resp', 'Respondeu', 2, 'resposta'), etapa('a-apl', 'Aplicou', 3, null), etapa('a-perda', 'Perdido', 4, 'perda')],
  },
  {
    id: 'f-clo', _id: 'f-clo', name: 'Closers',
    deal_stages: [
      etapa('c-agend', 'Reunião Agendada', 1, 'reuniao_agendada', { exige_closer: true }), etapa('c-real', 'Reunião Realizada', 2, 'reuniao_realizada'),
      etapa('c-fup', 'FUP', 3, 'fup'), etapa('c-venda', 'Vendido', 4, 'venda'), etapa('c-perda', 'Perdido', 5, 'perda'),
    ],
  },
];
const funilDe = (stageId) => FUNIS.find((f) => f.deal_stages.some((e) => e.id === stageId));
const nomeDe = (stageId) => funilDe(stageId).deal_stages.find((e) => e.id === stageId).name;
const hist = (...ids) => ids.map((id, i) => ({ deal_stage_id: id, deal_stage_name: nomeDe(id), deal_pipeline_id: funilDe(id).id, deal_pipeline_name: funilDe(id).name, start_date: `2026-09-0${i + 1}T12:00:00.000Z`, end_date: null }));
// cards que já chegaram na reunião: os do Aplicação Direta saem de "Aplicou" e entram no Closers em "Reunião Agendada"
const HISTORICOS = {
  h1: hist('a-novo', 'a-resp', 'a-apl', 'c-agend', 'c-real', 'c-fup'),
  h2: hist('a-novo', 'a-resp', 'a-apl', 'c-agend', 'c-real'),
  h3: hist('a-resp', 'a-apl', 'c-agend', 'c-real'),
  m1: hist('e-contato', 'e-resp', 'e-qual', 'e-agend', 'e-real'),
};

let cards = {};
let semHistorico = false;
let recusar = null; // { caminho, mensagem }
const escritas = [];
const novoCard = (id, stageId, extra = {}) => ({
  id, _id: id, name: `PRXC | Lead ${id}`, win: null, closed_at: null, versao: 3, created_at: '2026-10-01T12:00:00.000Z', updated_at: '2026-10-20T12:00:00.000Z',
  deal_stage: { id: stageId, name: nomeDe(stageId) }, deal_pipeline: { id: funilDe(stageId).id, name: funilDe(stageId).name },
  user: { id: 'u-caua', name: 'Cauã Lima' }, contacts: [{ id: 'c1', _id: 'c1', name: 'Lead Teste' }], handoff: null, ...extra,
});
function reiniciar() {
  cards = {
    'd-mql': novoCard('d-mql', 'e-resp'),
    'd-ad': novoCard('d-ad', 'a-resp', { contacts: [{ id: 'c2', _id: 'c2', name: 'Outro Lead' }] }),
    'd-real': novoCard('d-real', 'e-real'),
    'd-smql': novoCard('d-smql', 's-resp', { contacts: [{ id: 'c3', _id: 'c3', name: 'Lead SMQL' }] }),
    'd-qual': novoCard('d-qual', 'e-qual', { contacts: [{ id: 'c4', _id: 'c4', name: 'Lead Qualificado' }] }),
    'd-velho': novoCard('d-velho', 'e-contato', { user: { id: 'u-isa', name: 'Isamara' }, created_at: '2026-08-11T12:00:00.000Z' }),
  };
  escritas.length = 0;
  recusar = null;
}
reiniciar();

const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== 'crm.pronixhub.com.br') throw new Error('chamada externa inesperada: ' + u.href);
  const metodo = opts.method || 'GET';
  const corpo = opts.body ? JSON.parse(opts.body) : null;
  const p = u.pathname.replace('/api/v1', '');
  const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (metodo !== 'GET') escritas.push({ metodo, caminho: p, corpo });
  if (recusar && p === recusar.caminho) return ok({ codigo: 'X', mensagem: recusar.mensagem }, 422);
  if (p === '/deal_pipelines') return ok(FUNIS);
  if (p === '/me') return ok({ user: { id: 'u-caua', name: 'Cauã Lima' }, permissions: ['trocar_responsavel', 'mover_de_funil'] });
  if (p === '/users') {
    // como o CRM de verdade: em páginas (o Pedro e a Zoe só vêm na 2ª)
    const todos = [{ id: 'u-caua', name: 'Cauã Lima', email: 'caua@x.test' }, { id: 'u-ph', name: 'Paulo Henrique Pagoti', email: 'ph@x.test' }, { id: 'u-isa', name: 'Isamara', email: 'isa@x.test' }, { id: 'u-pedro', name: 'Pedro Henrique Melo Palermo', email: '' }, { id: 'u-zoe', name: 'Zoe Closer', email: '' }];
    return u.searchParams.get('cursor') === 'pag2' ? ok({ users: todos.slice(3) }) : ok({ users: todos.slice(0, 3), proximo_cursor: 'pag2' });
  }
  if (p === '/deal_lost_reasons') return ok({ deal_lost_reasons: [{ id: 'm-sumiu', name: 'Nunca respondeu' }, { id: 'm-dup', name: 'Duplicidade de card' }] });
  if (p === '/deals' && metodo === 'GET') {
    if (semHistorico) return ok({ deals: [] });
    const f = u.searchParams.get('deal_pipeline_id');
    const ids = f === 'f-clo' ? ['h1', 'h2', 'h3'] : f === 'f-mql' ? ['m1'] : [];
    return ok({ deals: ids.map((id) => ({ id, _id: id, updated_at: '2026-09-10T12:00:00.000Z' })) });
  }
  const m = p.match(/^\/deals\/([^/]+)(\/[a-z_]+)?$/);
  // donos dos cards que chegaram na reunião realizada: os closers que o histórico ensina
  if (m && HISTORICOS[m[1]]) return ok({ id: m[1], _id: m[1], updated_at: '2026-09-10T12:00:00.000Z', deal_stage_histories: HISTORICOS[m[1]], user: m[1] === 'm1' ? { id: 'u-zoe', name: 'Zoe Closer' } : { id: 'u-ph', name: 'Paulo Henrique Pagoti' } });
  if (m && cards[m[1]]) {
    const c = cards[m[1]];
    const rota = m[2] || '';
    if (metodo === 'GET' && !rota) return ok(c);
    if (rota === '/notes') return ok({ ok: true }); // anotação não pede versão
    if (corpo && (corpo.versao ?? (corpo.deal && corpo.deal.versao)) !== c.versao) return ok({ codigo: 'CONFLITO_VERSAO', mensagem: 'A versão enviada não é a atual.' }, 409);
    const sobe = (mud) => { cards[m[1]] = { ...c, ...mud, versao: c.versao + 1 }; return ok(cards[m[1]]); };
    if (rota === '/stage') {
      const destino = funilDe(corpo.deal_stage_id).deal_stages.find((e) => e.id === corpo.deal_stage_id);
      if (destino.exige_closer && !c.closerDefinido && !corpo.user_id) return ok({ codigo: 'CLOSER_OBRIGATORIO', mensagem: 'Diga quem é o closer.' }, 422);
      if (corpo.user_id && !c.handoff && !corpo.handoff) return ok({ codigo: 'HANDOFF_OBRIGATORIO', mensagem: 'Falta o handoff.' }, 422);
      return sobe({ deal_stage: { id: destino.id, name: destino.name }, ...(corpo.user_id ? { user: { id: corpo.user_id, name: 'closer' }, closerDefinido: true } : {}), ...(corpo.handoff ? { handoff: { text: corpo.handoff } } : {}) });
    }
    if (rota === '/pipeline') {
      const f = FUNIS.find((x) => x.id === corpo.deal_pipeline_id);
      const destino = f.deal_stages.find((e) => e.id === corpo.deal_stage_id);
      if (destino.exige_closer && !corpo.user_id) return ok({ codigo: 'CLOSER_OBRIGATORIO', mensagem: 'Diga quem é o closer.' }, 422);
      if (corpo.user_id && !c.handoff && !corpo.handoff) return ok({ codigo: 'HANDOFF_OBRIGATORIO', mensagem: 'Falta o handoff.' }, 422);
      return sobe({ deal_pipeline: { id: f.id, name: f.name }, deal_stage: { id: destino.id, name: destino.name }, user: { id: corpo.user_id, name: 'closer' }, closerDefinido: true, ...(corpo.handoff ? { handoff: { text: corpo.handoff } } : {}) });
    }
    if (rota === '/handoff') return sobe({ handoff: { text: corpo.handoff } });
    if (rota === '/lost') { cards[m[1]] = { ...c, win: false, versao: c.versao + 1 }; return ok({ ok: [m[1]], falhas: [] }); }
    if (metodo === 'PUT' && !rota) return sobe({ user: { id: corpo.deal.user_id, name: 'closer' } });
  }
  return ok({ codigo: 'NAO_ENCONTRADO', mensagem: 'não existe' }, 404);
};
test.after(() => { global.fetch = fetchReal; });

const DADOS_REPORT = {
  lead: 'Lead Teste',
  resumo: [{ rotulo: 'Investimento', valor: 'R$ 3 a 5 mil' }, { rotulo: 'Decisor', valor: 'Ele mesmo' }],
  dores: [{ dor: 'Estoque parado', intensidade: 4, porque: 'Disse que tem R$ 50 mil parados' }],
  secoes: [{ titulo: 'O que o closer deve bater', numerada: true, itens: ['Mostrar casos de loja física', 'Fechar na call'] }],
  sinais_compra: ['Perguntou como paga'],
  abertura: 'Oi, o Cauã me passou o seu contexto.',
};

test('o report vira o texto do handoff, nos tópicos que o closer lê', () => {
  const t = fluxo.textoDoHandoff(DADOS_REPORT, { sdr: 'Cauã Lima', quando: '23/10/2026' });
  for (const x of ['Nome: Lead Teste', 'Investimento: R$ 3 a 5 mil', 'Dor / momento do lead: Estoque parado', 'O QUE O CLOSER DEVE BATER', '1. Mostrar casos de loja física', 'SINAIS DE COMPRA', 'ABERTURA SUGERIDA', 'Report PRONIX de Cauã Lima em 23/10/2026.']) {
    assert.ok(t.includes(x), 'faltou: ' + x);
  }
});

test('funil que vai até a reunião: Qualificado → Reunião Agendada (closer + handoff do report) → Reunião Realizada', async () => {
  reiniciar();
  await closers.criar('Paulo Henrique Pagoti', 'ph@x.test');
  await closers.criar('Pedro Palermo', ''); // no CRM: Pedro Henrique Melo Palermo — na 2ª página dos usuários
  await closers.criar('Giovane Romano', 'giovane@x.test'); // cadastrado aqui, mas sem usuário no CRM
  await fluxo.guardarHandoff({ dados: DADOS_REPORT, sdr: 'Cauã Lima', reportId: 'r1', vinculo: { dealId: 'd-mql', contatoId: 'c1' } });
  const plano = await fluxo.planejar({ dealId: 'd-mql', closerNome: 'Paulo Henrique' });
  assert.deepEqual(plano.passos.map((p) => [p.tipo, p.etapaNome, p.exigeCloser]), [['etapa', 'Qualificado', false], ['etapa', 'Reunião Agendada', true], ['etapa', 'Reunião Realizada', false]]);
  assert.equal(plano.closerSugerido, 'u-ph', 'o closer da agenda vem escolhido');
  assert.deepEqual(plano.closers, [{ id: 'u-ph', nome: 'Paulo Henrique Pagoti' }, { id: 'u-pedro', nome: 'Pedro Henrique Melo Palermo' }, { id: 'u-zoe', nome: 'Zoe Closer' }],
    'os cadastrados (pelas palavras do nome) e os donos das reuniões realizadas — nunca um SDR');
  assert.deepEqual(plano.closersSemCrm, ['Giovane Romano'], 'quem não está no CRM é avisado, não some calado');
  assert.ok(plano.handoff.doReport, 'o report deste card vai como handoff');
  assert.deepEqual(plano.faltando, []);

  const r = await fluxo.executar({ usuario: { nome: 'Cauã Lima' }, dealId: 'd-mql', assinatura: plano.assinatura, closerId: 'u-ph' });
  assert.deepEqual(r.feitos, ['Qualificado', 'Reunião Agendada', 'Reunião Realizada', 'Closer: Paulo Henrique Pagoti']);
  assert.deepEqual(escritas.map((e) => [e.caminho, e.corpo.deal_stage_id, e.corpo.user_id || '']), [
    ['/deals/d-mql/stage', 'e-qual', ''], ['/deals/d-mql/stage', 'e-agend', 'u-ph'], ['/deals/d-mql/stage', 'e-real', ''],
  ]);
  assert.match(escritas[1].corpo.handoff, /^Nome: Lead Teste/);
  assert.equal(cards['d-mql'].deal_stage.id, 'e-real');
});

test('Aplicação Direta: sai de "Aplicou", vai para o funil Closers em "Reunião Agendada" (como os cards que já foram) e chega na realizada', async () => {
  reiniciar();
  const plano = await fluxo.planejar({ dealId: 'd-ad' });
  assert.deepEqual(plano.passos.map((p) => [p.tipo, p.funilNome, p.etapaNome]), [['etapa', 'Aplicação Direta', 'Aplicou'], ['funil', 'Closers', 'Reunião Agendada'], ['etapa', 'Closers', 'Reunião Realizada']]);
  assert.equal(plano.passos[1].vistos, 3, '3 de 3 cards do Aplicação Direta foram para o Closers');
  assert.equal(plano.handoff.doReport, null);
  await assert.rejects(fluxo.executar({ dealId: 'd-ad', assinatura: plano.assinatura, closerId: 'u-ph' }), /Falta o handoff/);
  const r = await fluxo.executar({ dealId: 'd-ad', assinatura: plano.assinatura, closerId: 'u-ph', handoff: 'Lead quer começar no Mercado Livre, tem R$ 5 mil e decide sozinho.' });
  assert.deepEqual(r.feitos, ['Aplicou', 'Closers › Reunião Agendada', 'Reunião Realizada', 'Closer: Paulo Henrique Pagoti']);
  assert.deepEqual(escritas.map((e) => e.caminho), ['/deals/d-ad/stage', '/deals/d-ad/pipeline', '/deals/d-ad/stage']);
  assert.equal(escritas[1].corpo.deal_pipeline_id, 'f-clo');
  assert.equal(escritas[1].corpo.user_id, 'u-ph');
  assert.match(escritas[1].corpo.handoff, /Mercado Livre/);
});

test('nada muda sem conferir: card que mudou depois do plano, card já na realizada, closer fora da lista', async () => {
  reiniciar();
  const plano = await fluxo.planejar({ dealId: 'd-mql' });
  cards['d-mql'] = { ...cards['d-mql'], deal_stage: { id: 'e-qual', name: 'Qualificado' } };
  await assert.rejects(fluxo.executar({ dealId: 'd-mql', assinatura: plano.assinatura, closerId: 'u-ph', handoff: 'x'.repeat(60) }), /O card mudou/);
  await assert.rejects(fluxo.planejar({ dealId: 'd-real' }), /já está em "Reunião Realizada"/);
  reiniciar();
  const p2 = await fluxo.planejar({ dealId: 'd-mql' });
  await assert.rejects(fluxo.executar({ dealId: 'd-mql', assinatura: p2.assinatura, closerId: 'u-isa', handoff: 'x'.repeat(60) }), /Escolha um closer da lista/);
  assert.deepEqual(escritas, [], 'nada foi escrito no CRM');
});

test('o CRM recusou no meio: para ali e diz o que já foi feito', async () => {
  reiniciar();
  const plano = await fluxo.planejar({ dealId: 'd-mql' });
  recusar = { caminho: '/deals/d-mql/stage', mensagem: 'Campo obrigatório da etapa: Data da reunião' };
  await assert.rejects(fluxo.executar({ dealId: 'd-mql', assinatura: plano.assinatura, closerId: 'u-ph' }), /Campo obrigatório da etapa: Data da reunião/);
});

test('funil sem caminho conhecido (nenhum card dele chegou na reunião e há dois funis com a etapa): não adivinha', async () => {
  reiniciar();
  semHistorico = true;
  await db.cacheDel('crm:fluxos2');
  try {
    await assert.rejects(fluxo.planejar({ dealId: 'd-ad' }), /Não sei para qual funil os cards de "Aplicação Direta" vão/);
  } finally {
    semHistorico = false;
    await db.cacheDel('crm:fluxos2');
  }
});

test('perder como duplicado: o card mais antigo vira perda com o motivo de duplicidade e a nota diz onde o lead segue', async () => {
  reiniciar();
  const r = await fluxo.perderDuplicado({ usuario: { nome: 'Cauã Lima' }, dealId: 'd-velho', manterId: 'd-mql' });
  assert.equal(r.motivo, 'Duplicidade de card');
  assert.equal(escritas.length, 1);
  assert.equal(escritas[0].caminho, '/deals/d-velho/lost');
  assert.equal(escritas[0].corpo.deal_lost_reason_id, 'm-dup');
  assert.match(escritas[0].corpo.deal_lost_note, /segue no card "PRXC \| Lead d-mql" \(Funil MQL › Respondeu\), id d-mql/);
  await assert.rejects(fluxo.perderDuplicado({ dealId: 'd-velho', manterId: 'd-velho' }), /Não sei qual card/);
});

// ---------------------------------------------------------------- botão "Qualificado"
test('Qualificado: vai para a etapa "Qualificado" do funil, sem closer e sem handoff', async () => {
  reiniciar();
  const plano = await fluxo.planejar({ dealId: 'd-mql', alvo: 'qualificado' });
  assert.deepEqual(plano.passos.map((p) => p.etapaNome), ['Qualificado']);
  assert.equal(plano.precisaCloser, false);
  const r = await fluxo.executar({ dealId: 'd-mql', assinatura: plano.assinatura, alvo: 'qualificado' });
  assert.deepEqual(r.feitos, ['Qualificado']);
  assert.deepEqual(escritas.map((e) => [e.caminho, e.corpo.deal_stage_id, e.corpo.user_id || '', e.corpo.handoff || '']), [['/deals/d-mql/stage', 'e-qual', '', '']]);
  assert.equal(cards['d-mql'].user.id, 'u-caua', 'o responsável não muda');
});

test('Qualificado: funil sem "Qualificado" vai para a etapa de reunião agendada ("Agendou"), e "Em qualificação" não é confundida', async () => {
  reiniciar();
  const plano = await fluxo.planejar({ dealId: 'd-smql', alvo: 'qualificado' });
  assert.deepEqual(plano.passos.map((p) => p.etapaNome), ['Agendou']);
  const r = await fluxo.executar({ dealId: 'd-smql', assinatura: plano.assinatura, alvo: 'qualificado' });
  assert.deepEqual(r.feitos, ['Agendou']);
  assert.equal(cards['d-smql'].deal_stage.id, 's-agendou');
});

test('Qualificado: Aplicação Direta segue para o funil Closers, e lá a etapa pede o closer e o handoff', async () => {
  reiniciar();
  const plano = await fluxo.planejar({ dealId: 'd-ad', alvo: 'qualificado' });
  assert.deepEqual(plano.passos.map((p) => [p.tipo, p.etapaNome, p.exigeCloser]), [['etapa', 'Aplicou', false], ['funil', 'Reunião Agendada', true]]);
  assert.equal(plano.precisaCloser, true);
  await assert.rejects(fluxo.executar({ dealId: 'd-ad', assinatura: plano.assinatura, alvo: 'qualificado', handoff: 'x'.repeat(60) }), /Escolha o closer/);
  const r = await fluxo.executar({ dealId: 'd-ad', assinatura: plano.assinatura, alvo: 'qualificado', closerId: 'u-ph', handoff: 'Lead quer começar no Mercado Livre, tem R$ 5 mil e decide sozinho.' });
  assert.deepEqual(r.feitos, ['Aplicou', 'Closers › Reunião Agendada', 'Closer: Paulo Henrique Pagoti']);
});

test('Qualificado: card que já está qualificado (ou adiante) não é mexido; o plano de um destino não vale para o outro', async () => {
  reiniciar();
  await assert.rejects(fluxo.planejar({ dealId: 'd-qual', alvo: 'qualificado' }), /já está em "Qualificado": qualificado ou adiante/);
  const plano = await fluxo.planejar({ dealId: 'd-mql', alvo: 'qualificado' });
  await assert.rejects(fluxo.executar({ dealId: 'd-mql', assinatura: plano.assinatura, alvo: 'realizada', closerId: 'u-ph', handoff: 'x'.repeat(60) }), /O card mudou/);
  assert.deepEqual(escritas, []);
});

// ---------------------------------------------------------------- handoff complementado com a ligação
test('Reunião realizada: o handoff do report (editado) e as informações da ligação vão juntos na passagem', async () => {
  reiniciar();
  await fluxo.guardarHandoff({ dados: DADOS_REPORT, sdr: 'Cauã Lima', reportId: 'r1', vinculo: { dealId: 'd-mql' } });
  const plano = await fluxo.planejar({ dealId: 'd-mql' });
  assert.ok(plano.handoff.doReport.texto.startsWith('Nome: Lead Teste'), 'o texto do report vem no plano para editar');
  await fluxo.executar({ dealId: 'd-mql', assinatura: plano.assinatura, closerId: 'u-ph', handoff: 'Nome: Lead Teste (editado)', complemento: 'Na ligação disse que a esposa decide junto.' });
  const passagem = escritas.find((e) => e.corpo.user_id);
  assert.equal(passagem.corpo.handoff, 'Nome: Lead Teste (editado)\n\nINFORMAÇÕES DA LIGAÇÃO\nNa ligação disse que a esposa decide junto.');
});

test('Reunião realizada: card que já tinha handoff — o complemento da ligação vai como anotação no card', async () => {
  reiniciar();
  cards['d-mql'] = { ...cards['d-mql'], handoff: { text: 'Handoff já gravado no CRM.' } };
  const plano = await fluxo.planejar({ dealId: 'd-mql' });
  const r = await fluxo.executar({ dealId: 'd-mql', assinatura: plano.assinatura, closerId: 'u-ph', complemento: 'Na ligação confirmou o investimento.' });
  assert.ok(r.feitos.includes('Complemento anotado'));
  const nota = escritas.find((e) => e.caminho === '/deals/d-mql/notes');
  assert.equal(nota.corpo.text, 'Complemento do handoff (ligação):\nNa ligação confirmou o investimento.');
  assert.equal(escritas.some((e) => e.corpo && e.corpo.handoff), false, 'o handoff que já existe não é reescrito');
});

test('o texto do report fica guardado também pelo id do report (para complementar com a ligação depois)', async () => {
  await fluxo.guardarHandoff({ dados: DADOS_REPORT, sdr: 'Cauã Lima', reportId: 'rep123', vinculo: {} });
  assert.match(await fluxo.textoDoReport('rep123'), /^Nome: Lead Teste/);
  assert.equal(await fluxo.textoDoReport('nao-existe'), '');
  assert.equal(await fluxo.textoDoReport('../x'), '');
});

test('PDF do report anexado: vira o texto do handoff (sem o rodapé); arquivo que não é PDF não passa', async () => {
  const { gerarPdfBuffer } = require('../src/generatePdf');
  const { textoDoReportPdf } = require('../src/pdfTexto');
  const buf = await gerarPdfBuffer({ lead: 'Lead Teste', sdr: 'SDR Teste', resumo: [{ rotulo: 'Investimento', valor: 'R$ 5 mil' }], secoes: [{ titulo: 'O que o closer deve bater', numerada: true, itens: ['Mostrar casos de loja física'] }], abertura: 'Oi, o SDR me passou o contexto.', citacoes: [], dores: [], sinais_compra: [], frase_impacto: '' });
  const texto = textoDoReportPdf(buf.toString('base64'));
  assert.match(texto, /Lead: Lead Teste/);
  assert.match(texto, /Investimento: R\$ 5 mil/);
  assert.match(texto, /Mostrar casos de loja física/);
  assert.doesNotMatch(texto, /Handoff de pré-vendas · SDR/, 'sem o rodapé da página');
  assert.throws(() => textoDoReportPdf(Buffer.from('não sou pdf').toString('base64')), /não é um PDF/);
  assert.throws(() => textoDoReportPdf(''), /Anexe o PDF/);
});
