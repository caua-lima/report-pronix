'use strict';
// O vínculo do report com o lead no RD e a atualização de hora em hora. API do RD simulada (formato da
// documentação v1), banco em pasta temporária, sem rede e sem token real. O que importa provar: o lead é
// achado pelo e-mail e pelo id do contato (não pelo nome do WhatsApp); cadastro repetido não trava a
// busca; a venda chega com produto e ticket; a batida da extensão é barata e não acumula.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-vinculo-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'tok-vinculo', CRM_CACHE_TTL_SEG: '0',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;

const app = require('../server');
const db = require('../src/db');
const crm = require('../src/crm');
const stats = require('../src/stats');

// ---------------------------------------------------------------- RD simulado
const amanha = new Date(Date.now() + 86400000).toISOString();
const CONTATOS = [
  { id: 'k1', name: 'Bruno Mello', phones: [{ phone: '(71) 98888-2222' }], emails: [{ email: 'Bruno.Mello@exemplo.com' }], deals: [{ id: 'sdr1' }] },
  // o mesmo Bruno, cadastrado de novo com o mesmo e-mail: é dele o card que foi para os closers
  { id: 'k2', name: 'Bruno Mello', phones: [], emails: [{ email: 'bruno.mello@exemplo.com' }], deals: [{ id: 'cl1' }] },
  { id: 'k3', name: 'Diego Martins', phones: [{ phone: '(11) 97777-0001' }], emails: [{ email: 'diego1@exemplo.com' }], deals: [{ id: 'dg1' }] },
  { id: 'k4', name: 'Diego Martins', phones: [{ phone: '(21) 96666-0002' }], emails: [{ email: 'diego2@exemplo.com' }], deals: [{ id: 'dg2' }] },
  { id: 'k5', name: 'Outra Pessoa', phones: [], emails: [{ email: 'parecido.bruno.mello@exemplo.com' }], deals: [] },
];
const CAUA = { id: 'u1', name: 'Cauã Lima' };
const PH = { id: 'u2', name: 'Paulo Henrique Pagoti' };
const DEALS = {
  sdr1: { id: 'sdr1', name: 'PRXC | Bruno Mello', deal_stage: { id: 'e2', name: 'Respondeu' }, deal_pipeline: { id: 'f1', name: 'SMQLs automáticas' }, user: CAUA, win: null, closed_at: null, created_at: '2026-10-09T10:00:00Z', updated_at: '2026-10-10T10:00:00Z' },
  cl1: {
    id: 'cl1', name: 'PRXC | Bruno Mello', deal_stage: { id: 'c7', name: 'Vendido' }, deal_pipeline: { id: 'f2', name: 'CLOSERS' }, user: PH, win: true, closed_at: amanha,
    created_at: '2026-10-12T03:19:00Z', updated_at: amanha, amount_total: 18624, deal_products: [{ id: 'p1', name: 'Pronix Performance', price: 18624, total: 18624 }],
  },
  dg1: { id: 'dg1', name: 'Diego', deal_stage: { id: 'e1', name: 'Contato iniciado' }, deal_pipeline: { id: 'f1', name: 'SMQLs automáticas' }, user: { id: 'u9', name: 'Outro SDR' }, win: null, closed_at: null, updated_at: '2026-10-10T10:00:00Z' },
  dg2: { id: 'dg2', name: 'Diego', deal_stage: { id: 'c1', name: 'Reunião Realizada' }, deal_pipeline: { id: 'f2', name: 'CLOSERS' }, user: PH, win: null, closed_at: null, updated_at: '2026-10-11T10:00:00Z' },
};
const chamadasRd = [];
let emailFiltra = true; // o RD aceita o filtro ?email= (quando não aceita, devolve qualquer coisa e o código confere)
const fetchReal = global.fetch;
global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchReal(url, opts);
  if (u.hostname !== 'crm.rdstation.com') throw new Error('chamada externa inesperada: ' + u.hostname);
  const p = u.pathname.replace('/api/v1', '');
  chamadasRd.push(p + '?' + [...u.searchParams].filter(([k]) => k !== 'token').map(([k, v]) => `${k}=${v}`).join('&'));
  const json = (corpo) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(corpo)) });
  if (p === '/contacts') {
    const email = u.searchParams.get('email');
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const phone = (u.searchParams.get('phone') || '').replace(/\D/g, '');
    let lista = [];
    if (email) lista = emailFiltra ? CONTATOS.filter((c) => c.emails.some((e) => e.email.toLowerCase().includes(email))) : [CONTATOS[4]];
    else if (q) lista = CONTATOS.filter((c) => c.name.toLowerCase().includes(q) || c.emails.some((e) => e.email.toLowerCase().includes(q)));
    else if (phone) lista = CONTATOS.filter((c) => c.phones.some((f) => f.phone.replace(/\D/g, '').slice(-8) === phone.slice(-8)));
    return json({ contacts: lista, total: lista.length });
  }
  let m = /^\/contacts\/(.+)$/.exec(p);
  if (m) return json(CONTATOS.find((c) => c.id === m[1]) || {});
  m = /^\/deals\/([^/]+)\/deal_products$/.exec(p);
  if (m) return json({ deal_products: [{ name: 'PRONIX Acelera' }] });
  m = /^\/deals\/(.+)$/.exec(p);
  if (m) return json(DEALS[m[1]] || {});
  if (p === '/activities') return json({ activities: [] });
  if (p === '/users') return json({ users: [CAUA, PH] });
  if (p === '/custom_fields') return json({ custom_fields: [] });
  if (p === '/deal_pipelines') return json({ deal_pipelines: [] });
  return json({});
};
test.after(() => { global.fetch = fetchReal; fs.rmSync(DADOS, { recursive: true, force: true }); });

// ---------------------------------------------------------------- achar o lead
test('pelo e-mail: acha o lead certo (confere o e-mail do contato) e junta os cadastros repetidos dele', async () => {
  const r = await crm.consultarLead({ email: ' BRUNO.mello@exemplo.com ' });
  assert.deepEqual([r.encontrado, r.buscaPor, r.ficha.contatoId, r.ficha.nome], [true, 'email', 'k1', 'Bruno Mello']);
  assert.deepEqual(r.ficha.negociacoes.map((c) => c.id).sort(), ['cl1', 'sdr1'], 'os cards dos dois cadastros entram');
  const vendido = r.ficha.negociacoes.find((c) => c.id === 'cl1');
  assert.deepEqual([vendido.ganha, vendido.valor, vendido.produtos, vendido.funil, vendido.responsavel], [true, 18624, ['Pronix Performance'], 'CLOSERS', 'Paulo Henrique Pagoti']);
  assert.ok(!r.ficha.negociacoes.some((c) => c.id === 'dg1'), 'contato com e-mail só parecido não entra');

  // RD que ignora o filtro de e-mail: cai na busca livre e continua conferindo o e-mail
  emailFiltra = false;
  chamadasRd.length = 0;
  const r2 = await crm.consultarLead({ email: 'bruno.mello@exemplo.com' });
  emailFiltra = true;
  assert.deepEqual([r2.encontrado, r2.ficha.contatoId], [true, 'k1']);
  assert.ok(chamadasRd.some((c) => c.startsWith('/contacts?q=bruno.mello')));
  assert.equal((await crm.consultarLead({ email: 'ninguem@exemplo.com' })).encontrado, false);
  assert.equal((await crm.consultarLead({ email: 'isto não é e-mail' })).encontrado, false);
});

test('pelo nome: cadastro repetido da mesma pessoa vira um lead só; pessoas diferentes com o mesmo nome continuam em dúvida', async () => {
  const bruno = await crm.consultarLead({ nome: 'Bruno PRONIX Mello' });
  assert.deepEqual([bruno.encontrado, bruno.buscaPor], [true, 'nome'], 'antes isso ficava como "mais de um contato" e nada era puxado');
  assert.deepEqual(bruno.ficha.negociacoes.map((c) => c.id).sort(), ['cl1', 'sdr1']);
  const diego = await crm.consultarLead({ nome: 'Diego Martins' });
  assert.equal(diego.encontrado, false);
  assert.deepEqual(diego.candidatos.map((c) => c.id), ['k3', 'k4']);

  assert.equal(crm.saoAMesmaPessoa([CONTATOS[0], CONTATOS[1]]), true);
  assert.equal(crm.saoAMesmaPessoa([CONTATOS[2], CONTATOS[3]]), false);
  assert.equal(crm.saoAMesmaPessoa([{ name: 'x', phones: [], emails: [] }, { name: 'x', phones: [], emails: [] }]), false, 'sem telefone nem e-mail não dá para afirmar');
  // ligados em corrente: a-b pelo telefone, b-c pelo e-mail
  assert.equal(crm.saoAMesmaPessoa([{ phones: [{ phone: '71 99999-0000' }], emails: [] }, { phones: [{ phone: '+55 71 9999-0000' }], emails: [{ email: 'a@b.com' }] }, { phones: [], emails: [{ email: 'A@B.com' }] }]), true);
});

test('produtos do card pela rota própria do RD; id estranho não vira chamada', async () => {
  assert.deepEqual(await crm.produtosDoCard('cl1'), ['PRONIX Acelera']);
  chamadasRd.length = 0;
  assert.deepEqual(await crm.produtosDoCard('../x'), []);
  assert.equal(chamadasRd.length, 0);
});

// ---------------------------------------------------------------- o report nasce vinculado
test('o report guarda o vínculo que veio do card (só o que é válido)', async () => {
  await stats.registrar({ id: 'b1', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'Bruno PRONIX Mello', contato: 'Bruno PRONIX Mello', vinculo: { telefone: '+55 (71) 98888-2222', email: ' Bruno.Mello@Exemplo.com ', contatoId: 'k1', dealId: 'sdr1' } });
  const r = await stats.buscarPorId('b1');
  assert.deepEqual([r.telefone, r.leadEmail, r.rdContatoId, r.rdDealId], ['5571988882222', 'bruno.mello@exemplo.com', 'k1', 'sdr1']);
  await stats.registrar({ id: 'b0', usuarioId: 'u1', usuarioNome: 'Cauã Lima', lead: 'x', contato: 'x', vinculo: { telefone: '123', email: 'ruim', contatoId: '../../etc', dealId: { a: 1 } } });
  const ruim = await stats.buscarPorId('b0');
  assert.deepEqual([ruim.telefone, ruim.leadEmail, ruim.rdContatoId, ruim.rdDealId], ['', '', '', '']);
  await stats.remover('b0').catch(() => {});
});

// ---------------------------------------------------------------- rotas: a batida de hora em hora e o vínculo à mão
test('batida da extensão: põe os reports em dia com o RD (venda em call, produto, ticket e closer) e não acumula', async () => {
  const closers = require('../src/closers');
  const ph = await closers.criar('Paulo Henrique');
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const admin = { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' };
    const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', { method: 'POST', headers: admin, body: JSON.stringify({ nome, papel }) })).json()).usuario;
    const master = await criar('Cauã Lima', 'master');
    const chamar = async (metodo, rota, corpo, u) => {
      const r = await fetch(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', ...(u ? { 'x-cr-key': u.chave } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    assert.equal((await chamar('POST', '/api/rd/atualizar', {})).status, 401, 'sem chave não roda');

    // b1 (o Bruno, vinculado pelo id do contato) e um Diego sem vínculo, com o nome em dúvida no RD
    await stats.registrar({ id: 'dg', usuarioId: master.id, usuarioNome: 'Cauã Lima', lead: 'Diego Martins', contato: 'Diego Martins' });
    await db.destravar('rd-desfechos');
    const r = await chamar('POST', '/api/rd/atualizar', {}, master);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.ok, r.json.conferidos, r.json.vendidos], [true, 2, 1]);

    const b1 = await stats.buscarPorId('b1');
    assert.deepEqual([b1.resultado, b1.produto, b1.ticket, b1.closerNome, b1.closerId, b1.dataFechamento], ['venda_call', 'performance', 18624, 'Paulo Henrique', ph.id, stats.emDiaLocal(amanha)]);
    assert.equal(b1.rdSituacao, 'Vendido (vendido) · CLOSERS · Paulo Henrique Pagoti');
    const dg = await stats.buscarPorId('dg');
    assert.equal(dg.rdSituacao, 'Não achei no RD: 2 contatos com esse nome. Informe o e-mail ou o telefone do lead.');
    assert.equal(dg.closerId, '');

    // de novo logo em seguida: a trava de 30 min segura, sem nenhuma chamada ao RD
    chamadasRd.length = 0;
    const de_novo = await chamar('POST', '/api/rd/atualizar', {}, master);
    assert.deepEqual(de_novo.json, { ok: true, emDia: true });
    assert.equal(chamadasRd.length, 0);

    // a tela de Resultados mostra o que o RD disse de cada lead
    const tela = await chamar('GET', '/api/master/resultados?escopo=todos', undefined, master);
    const linha = (id) => tela.json.reports.find((x) => x.id === id);
    assert.deepEqual([linha('b1').rdSituacao, linha('b1').vinculado, linha('b1').produto, linha('b1').ticket], ['Vendido (vendido) · CLOSERS · Paulo Henrique Pagoti', true, 'performance', 18624]);
    assert.deepEqual([linha('dg').vinculado, /^Não achei/.test(linha('dg').rdSituacao), Boolean(linha('dg').rdConferidoEm)], [false, true, true]);

    // informar o e-mail do lead na linha: vincula e confere na hora
    const v = await chamar('PATCH', '/api/admin/reports/dg/resultado', { leadEmail: 'Diego2@exemplo.com', versao: linha('dg').versao }, master);
    assert.equal(v.status, 200);
    assert.deepEqual([v.json.recarregar, v.json.rdSituacao], [true, 'Reunião Realizada · CLOSERS · Paulo Henrique Pagoti']);
    const depois = await stats.buscarPorId('dg');
    assert.deepEqual([depois.leadEmail, depois.rdContatoId, depois.telefone, depois.closerNome], ['diego2@exemplo.com', 'k4', '21966660002', 'Paulo Henrique']);
    // telefone também serve; dado que não acha ninguém deixa a linha pedindo de novo
    const t = await chamar('PATCH', '/api/admin/reports/dg/resultado', { telefone: '(11) 97777-0001' }, master);
    assert.equal(t.json.rdSituacao, 'Contato iniciado · SMQLs automáticas · Outro SDR');
    assert.equal((await stats.buscarPorId('dg')).rdContatoId, 'k3', 'o vínculo antigo sai quando o dado é trocado');
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});

// ---------------------------------------------------------------- a extensão
test('extensão: cria o alarme de hora em hora uma vez só e, quando ele toca, bate no servidor com a chave salva', async () => {
  const ler = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const manifesto = JSON.parse(ler('extension/manifest.json'));
  assert.ok(manifesto.permissions.includes('alarms'));
  const carregar = ({ existe, chave = 'pnx_abc' }) => {
    const chamadas = [];
    const criados = [];
    let aoTocar = null;
    const chrome = {
      storage: { local: { get: (padrao, cb) => cb(Object.assign({}, padrao, { chave, server: 'https://report-pronix.vercel.app' })) } },
      runtime: { onMessage: { addListener: () => {} } },
      alarms: {
        get: (nome, cb) => cb(existe ? { name: nome } : undefined),
        create: (nome, o) => criados.push([nome, JSON.parse(JSON.stringify(o))]),
        onAlarm: { addListener: (fn) => { aoTocar = fn; } },
      },
    };
    const fetch = async (url, opts) => { chamadas.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
    vm.runInNewContext(ler('extension/background.js'), { chrome, fetch, URL, JSON, Promise, console, AbortSignal });
    return { chamadas, criados, tocar: (nome) => aoTocar({ name: nome }) };
  };
  const novo = carregar({ existe: false });
  assert.deepEqual(novo.criados, [['rd-atualizar', { delayInMinutes: 3, periodInMinutes: 60 }]]);
  assert.deepEqual(carregar({ existe: true }).criados, [], 'o service worker acorda toda hora: recriar zeraria a contagem');

  novo.tocar('outro-alarme');
  novo.tocar('rd-atualizar');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(novo.chamadas.length, 1);
  assert.equal(novo.chamadas[0].url, 'https://report-pronix.vercel.app/api/rd/atualizar');
  assert.deepEqual([novo.chamadas[0].opts.method, novo.chamadas[0].opts.headers['x-cr-key']], ['POST', 'pnx_abc']);
  // sem chave salva, o alarme não chama nada
  const semChave = carregar({ existe: false, chave: '' });
  semChave.tocar('rd-atualizar');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(semChave.chamadas.length, 0);
});
