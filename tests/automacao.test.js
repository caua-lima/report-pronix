'use strict';
// Automação do cartão: mover o card para "Respondeu" no RD (a única escrita no CRM), etiqueta
// "Qualificado" e agendamento lembrados por lead. RD simulado, banco em pasta temporária, sem rede.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-auto-'));
const TOKEN = 'tok-teste-SECRETO-456';
Object.assign(process.env, {
  CR_DATA_DIR: DADOS,
  ADMIN_PASSWORD: 'senha-de-teste',
  RDSTATION_CRM_TOKEN: TOKEN,
  KV_REST_API_URL: '',
  KV_REST_API_TOKEN: '',
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_MOVER_ETAPA;
delete process.env.CRM_ETAPA_RESPONDEU;
delete process.env.CRM_ETAPA_QUALIFICADO;

const app = require('../server');
const db = require('../src/db');
const leads = require('../src/leads');

// ---------------------------------------------------------------- RD Station simulado
// O funil do time, na ordem da tela do RD.
const FUNIL = {
  id: 'p1', name: 'Funil SDR', order: 1,
  deal_stages: [
    { _id: 's4', id: 's4', name: 'Qualificado', order: 4 },
    { _id: 's1', id: 's1', name: 'SMQLs Automaticos', order: 1 },
    { _id: 's2', id: 's2', name: 'Contato iniciado', order: 2 },
    { _id: 's3', id: 's3', name: 'Respondeu', order: 3 },
    { _id: 's5', id: 's5', name: 'Ultima tentativa', order: 5 },
    { _id: 's6', id: 's6', name: 'Reunião Realizada', order: 6 },
    { _id: 's7', id: 's7', name: 'Desqualificados', order: 7 },
  ],
};
const FUNIL_CLOSERS = { id: 'p2', name: 'Closers', order: 2, deal_stages: [{ id: 'k1', name: 'Reunião agendada', order: 1 }] };
const ETAPAS = Object.fromEntries([...FUNIL.deal_stages, ...FUNIL_CLOSERS.deal_stages].map((e) => [e.id, e]));

// telefone (8 últimos dígitos) -> contato; card -> etapa atual
const LEADS = {
  '11110001': { id: 'a1', name: 'Lead Contato Iniciado', card: 'd1' },
  '11110002': { id: 'a2', name: 'Lead Qualificado', card: 'd2' },
  '11110003': { id: 'a3', name: 'Lead Card Fechado', card: 'd3' },
  '11110004': { id: 'a4', name: 'Lead No Funil Dos Closers', card: 'd4' },
  '11110005': { id: 'a5', name: 'Lead De Outro Responsavel', card: 'd5' },
  '11110006': { id: 'a6', name: 'Lead Com Automacao Desligada', card: 'd6' },
  '11110007': { id: 'a7', name: 'Lead Novo', card: 'd7' },
};
const etapaDoCard = { d1: 's2', d2: 's4', d3: 's2', d4: 'k1', d5: 's1', d6: 's2', d7: 's1' };
const FECHADOS = new Set(['d3']);

const chamadasRd = [];
const escritas = [];
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchReal(url, opts);
  if (u.hostname !== 'crm.rdstation.com') throw new Error('chamada externa inesperada: ' + u.hostname);
  assert.equal(u.searchParams.get('token'), TOKEN, 'toda chamada ao RD leva o token');
  const metodo = opts.method || 'GET';
  const p = u.pathname.replace('/api/v1', '');
  chamadasRd.push(metodo + ' ' + p);
  const json = (corpo, status = 200) => ({ ok: status < 400, status, json: async () => corpo });
  const deal = (id) => {
    const e = ETAPAS[etapaDoCard[id]];
    const funil = FUNIL.deal_stages.includes(e) ? FUNIL : FUNIL_CLOSERS;
    return {
      id, name: 'PRXC | ' + id, created_at: '2026-09-28T20:00:00-03:00', updated_at: '2026-09-29T10:00:00-03:00',
      closed_at: FECHADOS.has(id) ? '2026-09-30T10:00:00-03:00' : null, win: FECHADOS.has(id) ? false : null,
      deal_stage: { _id: e.id, id: e.id, name: e.name }, deal_pipeline: { id: funil.id, name: funil.name }, user: { name: 'Cauã Lima' },
    };
  };
  if (p === '/contacts') {
    const digitos = String(u.searchParams.get('phone') || '').replace(/\D/g, '');
    const l = LEADS[digitos.slice(-8)];
    if (!l) return json({ contacts: [], total: 0 });
    return json({ contacts: [{ id: l.id, name: l.name, phones: [{ phone: '(11) 9' + digitos.slice(-8, -4) + '-' + digitos.slice(-4) }], deals: [{ id: l.card }] }], total: 1 });
  }
  if (p === '/deal_pipelines') return json([FUNIL, FUNIL_CLOSERS]);
  const m = /^\/deals\/(\w+)$/.exec(p);
  if (m && metodo === 'PUT') {
    escritas.push({ card: m[1], corpo: JSON.parse(opts.body), tipo: opts.headers['Content-Type'] });
    if (m[1] === 'd5') return json({ error: 'forbidden' }, 403);
    etapaDoCard[m[1]] = JSON.parse(opts.body).deal_stage_id;
    return json(deal(m[1]));
  }
  if (m && etapaDoCard[m[1]]) return json(deal(m[1]));
  if (p === '/activities') return json({ activities: [] });
  if (p === '/users') return json({ users: [] });
  if (p === '/custom_fields') return json([]);
  return json({}, 404);
};

// ---------------------------------------------------------------- servidor
let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const criar = async (nome, papel) => {
    const r = await fetchReal(base + '/api/admin/usuarios', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' },
      body: JSON.stringify({ nome, papel }),
    });
    const u = (await r.json()).usuario;
    return u;
  };
  const master = await criar('Cauã Lima', 'master');
  const sdr = await criar('Bia SDR', 'sdr');
  Object.assign(E, { master: master.chave, sdr: sdr.chave, idSdr: sdr.id });
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});

async function chamar(metodo, rota, corpo, chave) {
  const r = await fetchReal(base + rota, {
    method: metodo, headers: { 'Content-Type': 'application/json', ...(chave ? { 'x-cr-key': chave } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await r.text();
  assert.ok(!texto.includes(TOKEN), 'o token do CRM nunca pode aparecer numa resposta');
  return { status: r.status, json: JSON.parse(texto) };
}
const post = (rota, corpo, chave) => chamar('POST', rota, corpo, chave);
const tel = (final) => '55119' + final;
const ficha = (final, chave = E.master) => post('/api/crm/lead', { telefone: tel(final) }, chave);
const mover = (final, extra = {}, chave = E.master) => post('/api/crm/respondeu', { telefone: tel(final), ...extra }, chave);
const marca = (corpo, chave = E.master) => post('/api/lead/marca', corpo, chave);
const SEM_MARCA = { qualificado: false, agendadoPara: '', agendaFonteTs: -1 };

// ---------------------------------------------------------------- quem tem a automação
test('a automação começa só com o master; ele liga e desliga para os outros na aba Acessos', async () => {
  assert.equal((await chamar('GET', '/api/eu', undefined, E.master)).json.automacao, true);
  assert.equal((await chamar('GET', '/api/eu', undefined, E.sdr)).json.automacao, false);

  // sem a automação: a ficha vem como sempre, sem etiquetas, e as rotas novas recusam
  const f = await ficha('11110001', E.sdr);
  assert.equal(f.json.encontrado, true);
  assert.ok(!('automacao' in f.json) && !('marca' in f.json) && !('podeResponder' in f.json));
  assert.equal((await mover('11110001', {}, E.sdr)).status, 403);
  assert.equal((await marca({ telefone: tel('11110001'), qualificado: true, manual: true }, E.sdr)).status, 403);
  assert.equal((await mover('11110001', {}, null)).status, 401, 'sem chave'); // null: undefined cairia na chave padrão do master
  assert.equal(escritas.length, 0);

  const patch = (corpo, chave) => chamar('PATCH', '/api/admin/usuarios/' + E.idSdr, corpo, chave);
  assert.equal((await patch({ automacao: true }, E.sdr)).status, 403, 'só o master muda');
  assert.equal((await patch({ automacao: true }, E.master)).status, 200);
  assert.equal((await chamar('GET', '/api/eu', undefined, E.sdr)).json.automacao, true);
  assert.equal((await ficha('11110001', E.sdr)).json.automacao, true);
  assert.equal((await patch({ automacao: false }, E.master)).status, 200);
  assert.equal((await chamar('GET', '/api/eu', undefined, E.sdr)).json.automacao, false);
});

// ---------------------------------------------------------------- mover para "Respondeu"
test('a ficha diz se vale tentar mover: só card em aberto e ANTES de "Respondeu" no mesmo funil', async () => {
  const a = await ficha('11110001');
  assert.equal(a.json.ficha.negociacao.etapa, 'Contato iniciado');
  assert.equal(a.json.automacao, true);
  assert.equal(a.json.podeResponder, true);
  assert.deepEqual(a.json.marca, SEM_MARCA);
  assert.equal((await ficha('11110007')).json.podeResponder, true, '"SMQLs Automaticos" também está antes');
  assert.equal((await ficha('11110002')).json.podeResponder, false, 'já em "Qualificado"');
  assert.equal((await ficha('11110003')).json.podeResponder, false, 'card fechado');
  assert.equal((await ficha('11110004')).json.podeResponder, false, 'funil sem a etapa "Respondeu"');
  assert.equal(chamadasRd.filter((c) => c === 'GET /deal_pipelines').length, 1, 'os funis ficam em cache: uma consulta só desde o começo');
  assert.equal(escritas.length, 0, 'consultar a ficha nunca escreve no RD');
});

test('lead respondeu: o card sai de "Contato iniciado" e vai para "Respondeu" — uma vez só', async () => {
  const r = await mover('11110001', { dealId: 'd1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { movido: true, de: 'Contato iniciado', para: 'Respondeu' });
  assert.deepEqual(escritas, [{ card: 'd1', corpo: { deal_stage_id: 's3' }, tipo: 'application/json' }], 'a escrita é só a troca de etapa');

  // a ficha em cache foi descartada: a próxima consulta já mostra a etapa nova e não manda mover de novo
  const depois = await ficha('11110001');
  assert.equal(depois.json.ficha.negociacao.etapa, 'Respondeu');
  assert.equal(depois.json.podeResponder, false);
  assert.ok(!depois.json.cache);

  assert.deepEqual((await mover('11110001', { dealId: 'd1' })).json, { movido: false, motivo: 'ja-adiante', etapa: 'Respondeu' });
  assert.equal(escritas.length, 1);

  const log = await db.range('crm_movimentos');
  assert.deepEqual(log.map((l) => [l.card, l.de, l.para, l.por]), [['d1', 'Contato iniciado', 'Respondeu', 'Cauã Lima']]);
});

test('sem dizer o card, move o que a ficha escolheu (de "SMQLs Automaticos" também)', async () => {
  escritas.length = 0;
  assert.deepEqual((await mover('11110007')).json, { movido: true, de: 'SMQLs Automaticos', para: 'Respondeu' });
  assert.deepEqual(escritas.map((e) => [e.card, e.corpo.deal_stage_id]), [['d7', 's3']]);
});

test('nunca volta um card, nem mexe em card fechado, de outro lead ou de funil sem a etapa', async () => {
  escritas.length = 0;
  assert.deepEqual((await mover('11110002')).json, { movido: false, motivo: 'ja-adiante', etapa: 'Qualificado' });
  assert.deepEqual((await mover('11110003')).json, { movido: false, motivo: 'card-fechado' });
  assert.deepEqual((await mover('11110004')).json, { movido: false, motivo: 'sem-etapa' });
  assert.deepEqual((await mover('11110006', { dealId: 'd2' })).json, { movido: false, motivo: 'card-nao-e-do-lead' }, 'card de outro lead');
  assert.deepEqual((await mover('11119999')).json, { movido: false, motivo: 'card-nao-e-do-lead' }, 'lead que não está no RD');
  assert.equal(escritas.length, 0, 'nenhuma escrita no RD');
  assert.equal(etapaDoCard.d2, 's4');
});

test('o RD recusa a escrita (card de outro responsável): erro claro, sem token, e a ficha segue igual', async () => {
  const r = await mover('11110005');
  assert.equal(r.status, 502);
  assert.match(r.json.erro, /não deixou alterar este card/);
  assert.equal(etapaDoCard.d5, 's1');
  assert.equal((await ficha('11110005')).json.ficha.negociacao.etapa, 'SMQLs Automaticos');
});

test('CRM_MOVER_ETAPA=0 desliga a escrita no RD sem desligar as etiquetas', async () => {
  process.env.CRM_MOVER_ETAPA = '0';
  try {
    escritas.length = 0;
    const f = await ficha('11110006');
    assert.equal(f.json.podeResponder, false);
    assert.deepEqual(f.json.marca, SEM_MARCA);
    assert.deepEqual((await mover('11110006')).json, { movido: false, motivo: 'desligado' });
    assert.equal(escritas.length, 0);
  } finally {
    delete process.env.CRM_MOVER_ETAPA;
  }
  assert.equal((await ficha('11110006')).json.podeResponder, true);
});

// ---------------------------------------------------------------- etiqueta "Qualificado"
test('card em "Qualificado": a etiqueta entra sozinha e fica lembrada depois que o card muda de etapa', async () => {
  assert.equal((await ficha('11110002')).json.marca.qualificado, true);
  // o lead sumiu e o card foi para "Ultima tentativa"; passado o cache, a etiqueta continua
  etapaDoCard.d2 = 's5';
  await db.cacheDel('crm:tel:11110002');
  const f = await ficha('11110002');
  assert.equal(f.json.ficha.negociacao.etapa, 'Ultima tentativa');
  assert.equal(f.json.marca.qualificado, true);
});

test('marcar e tirar à mão: a escolha do usuário vale sobre qualquer leitura automática', async () => {
  const conversa = { telefone: tel('11110001') };
  assert.deepEqual((await marca({ ...conversa, qualificado: true, manual: true })).json, { ok: true, marca: { ...SEM_MARCA, qualificado: true } });
  assert.equal((await ficha('11110001')).json.marca.qualificado, true, 'aparece ao reabrir a conversa');
  assert.equal((await marca({ ...conversa, qualificado: false, manual: true })).json.marca.qualificado, false);
  // leitura automática (report gerado, agendamento) não recoloca o que o usuário tirou
  assert.equal((await marca({ ...conversa, qualificado: true, origem: 'report' })).json.marca.qualificado, false);
  assert.equal((await marca({ ...conversa, agendadoPara: '2026-10-08T15:00', fonteTs: 1000 })).json.marca.qualificado, false);
  // e, para quem nunca foi mexido à mão, report gerado marca
  assert.equal((await marca({ telefone: tel('11110007'), qualificado: true, origem: 'report' })).json.marca.qualificado, true);
  assert.equal((await marca({ telefone: '', nome: '' , qualificado: true, manual: true })).status, 400, 'sem telefone nem nome');
});

// ---------------------------------------------------------------- agendamento
test('agendamento: guarda o dia e a hora, só troca por mensagem mais nova, e apagar não volta', async () => {
  const conversa = { telefone: tel('11110003') };
  const r = await marca({ ...conversa, agendadoPara: '2026-10-08T15:00', fonteTs: 5000 });
  assert.deepEqual(r.json.marca, { qualificado: true, agendadoPara: '2026-10-08T15:00', agendaFonteTs: 5000 }, 'quem tem reunião marcada é qualificado');
  assert.deepEqual((await ficha('11110003')).json.marca, r.json.marca);

  // mensagem mais antiga (ou a mesma) não sobrescreve; a remarcação (mais nova) sim
  assert.equal((await marca({ ...conversa, agendadoPara: '2026-10-01T10:00', fonteTs: 4000 })).json.marca.agendadoPara, '2026-10-08T15:00');
  assert.equal((await marca({ ...conversa, agendadoPara: '2026-10-01T10:00', fonteTs: 5000 })).json.marca.agendadoPara, '2026-10-08T15:00');
  assert.equal((await marca({ ...conversa, agendadoPara: '2026-10-12T10:00', fonteTs: 9000 })).json.marca.agendadoPara, '2026-10-12T10:00');

  // apagar: some, e a mesma mensagem não traz de volta — só uma mais nova
  assert.deepEqual((await marca({ ...conversa, limparAgenda: true })).json.marca, { qualificado: true, agendadoPara: '', agendaFonteTs: 9000 });
  assert.equal((await marca({ ...conversa, agendadoPara: '2026-10-12T10:00', fonteTs: 9000 })).json.marca.agendadoPara, '');
  assert.equal((await marca({ ...conversa, agendadoPara: '2026-10-20T09:30', fonteTs: 9500 })).json.marca.agendadoPara, '2026-10-20T09:30');

  for (const ruim of ['amanhã às 15h', '2026-10-08', '2026-10-08T15:00:00Z', 123]) {
    assert.equal((await marca({ ...conversa, agendadoPara: ruim, fonteTs: 99999 })).status, 400, 'data inválida: ' + ruim);
  }
});

test('a marca é da conversa do WhatsApp: contato salvo só com nome acha a marca; com telefone, vale o telefone', async () => {
  await marca({ nome: 'João PRONIX Souza', qualificado: true, manual: true });
  assert.equal((await leads.ler({ nome: 'joão pronix souza' })).qualificado, true, 'nome sem diferença de maiúscula/acento');
  assert.equal(await leads.ler({ nome: 'Outro Nome' }), null);
  // depois o número ficou conhecido: a consulta manda telefone e nome e continua achando pelo nome
  const r = await post('/api/crm/lead', { telefone: tel('11110099'), conversa: { telefone: tel('11110099'), nome: 'João PRONIX Souza' } }, E.master);
  assert.equal(r.json.marca.qualificado, true);
  // número que apareceu como "nome" (contato não salvo) não vira chave por nome
  assert.deepEqual(leads.chaves({ telefone: '', nome: '+55 11 91111-0001' }), { tel: '', nome: '' });
  assert.deepEqual(leads.chaves({ telefone: '5511911110001', nome: 'Ana' }), { tel: 'tel:11110001', nome: 'nome:ana' });
  // nada de conversa guardado: só a etiqueta e a data
  const guardado = JSON.stringify(await db.getJson('lead_marcas', {}));
  assert.ok(!/content|mensag/i.test(guardado));
});
