'use strict';
// Reunião do lead no Google Agenda: Google e RD simulados, banco em pasta temporária, sem rede.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-google-'));
const SEGREDO = 'segredo-do-cliente-GOOGLE';
const REFRESH = 'refresh-token-SECRETO';
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'tok-rd',
  GOOGLE_CLIENT_ID: 'cliente.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: SEGREDO,
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
  TZ_RELATORIO: 'America/Sao_Paulo',
});
delete process.env.VERCEL;
delete process.env.GOOGLE_REFRESH_TOKEN;

const app = require('../server');
const db = require('../src/db');
const agendaGoogle = require('../src/agendaGoogle');

// ---------------------------------------------------------------- Google e RD simulados
const AGORA = new Date('2026-10-06T15:00:00Z'); // 12:00 em São Paulo
const AGENDAS = [
  { id: 'caua@pronix.com', summary: 'Cauã Lima', primary: true, accessRole: 'owner' },
  { id: 'vitor@pronix.com', summary: 'Vitor Augusto', accessRole: 'reader' },
  { id: 'paulo@pronix.com', summary: 'paulo@pronix.com', summaryOverride: 'Paulo Henrique', accessRole: 'reader' },
  { id: 'pt.brazilian#holiday@group.v.calendar.google.com', summary: 'Feriados', accessRole: 'reader' },
];
let nEv = 0;
const ev = (summary, inicio, convidados = [], extra = {}) => ({ id: 'ev' + ++nEv, summary, start: { dateTime: inicio }, attendees: convidados.map((email) => ({ email })), ...extra });
const pinturas = [];
let podePintar = true;
const ESCOPO_COMPLETO = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
let escopoDoToken = ESCOPO_COMPLETO;
let erro403 = { error: 'forbidden' };
const EVENTOS = {
  'vitor@pronix.com': [
    ev('Diagnóstico Pronix — Giumar Pedroso', '2026-10-06T14:00:00-03:00', ['giumar@exemplo.com', 'vitor@pronix.com']),
    ev('Diagnóstico Pronix — Lead Antigo', '2026-10-05T10:00:00-03:00', ['antigo@exemplo.com']),
    ev('Diagnóstico Pronix — Cancelado', '2026-10-07T10:00:00-03:00', ['cancelado@exemplo.com'], { status: 'cancelled' }),
    ev('Daily Geral', '2026-10-06T08:00:00-03:00', ['giumar.outro@exemplo.com']),
  ],
  'paulo@pronix.com': [
    ev('Diagnóstico Pronix — Remarcou', '2026-10-05T09:00:00-03:00', ['remarcou@exemplo.com']),
    ev('Diagnóstico Pronix — Remarcou', '2026-10-08T16:30:00-03:00', ['Remarcou@Exemplo.com']),
    ev('Diagnóstico Pronix — Marcos Pereira Lima', '2026-10-09T11:00:00-03:00', []),
  ],
  'caua@pronix.com': [],
};
const chamadas = [];
let refreshValido = true;
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchReal(url, opts);
  const json = (corpo, status = 200) => ({ ok: status < 400, status, json: async () => corpo });
  if (u.hostname === 'crm.rdstation.com') {
    const p = u.pathname.replace('/api/v1', '');
    if (p === '/contacts') return json({ contacts: [{ id: 'c1', name: 'Giumar Pedroso', phones: [{ phone: '(11) 91111-0001' }], emails: [{ email: 'Giumar@Exemplo.com' }], deals: [] }] });
    if (p === '/users') return json({ users: [] });
    if (p === '/custom_fields') return json([]);
    return json({}, 404);
  }
  chamadas.push({ url: u.origin + u.pathname, q: u.searchParams.get('q'), auth: (opts.headers || {}).Authorization || '', corpo: String(opts.body || '') });
  if (u.hostname === 'oauth2.googleapis.com') {
    const b = new URLSearchParams(String(opts.body));
    if (u.pathname === '/tokeninfo') return json({ scope: escopoDoToken });
    assert.equal(b.get('client_secret'), SEGREDO);
    if (b.get('grant_type') === 'authorization_code') return b.get('code') === 'codigo-bom' ? json({ refresh_token: REFRESH, access_token: 'acesso-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    return refreshValido && b.get('refresh_token') === REFRESH ? json({ access_token: 'acesso-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
  }
  if (u.hostname === 'www.googleapis.com') {
    assert.equal(opts.headers.Authorization, 'Bearer acesso-1');
    if (u.pathname.endsWith('/users/me/calendarList')) return json({ items: AGENDAS });
    const pm = /\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(u.pathname);
    if (pm && opts.method === 'PATCH') {
      if (!podePintar) return json(erro403, 403);
      const corpo = JSON.parse(opts.body);
      pinturas.push({ agenda: decodeURIComponent(pm[1]), evento: pm[2], corpo });
      const alvo = (EVENTOS[decodeURIComponent(pm[1])] || []).find((e) => e.id === pm[2]);
      if (alvo) alvo.colorId = corpo.colorId;
      return json(alvo || {});
    }
    const m = /\/calendars\/([^/]+)\/events$/.exec(u.pathname);
    if (m) {
      assert.equal(u.searchParams.get('singleEvents'), 'true');
      const q = String(u.searchParams.get('q')).toLowerCase();
      const itens = (EVENTOS[decodeURIComponent(m[1])] || []).filter((e) =>
        (e.attendees || []).some((a) => a.email.toLowerCase().includes(q)) || e.summary.toLowerCase().includes(q));
      return json({ items: itens });
    }
  }
  throw new Error('chamada externa inesperada: ' + u.href);
};

let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const criar = async (nome, papel) => (await (await fetchReal(base + '/api/admin/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ nome, papel }),
  })).json()).usuario.chave;
  E.master = await criar('Cauã Lima', 'master');
  E.sdr = await criar('Bia SDR', 'sdr');
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});
async function chamar(metodo, rota, corpo, chave) {
  const r = await fetchReal(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', ...(chave ? { 'x-cr-key': chave } : {}) }, body: corpo === undefined ? undefined : JSON.stringify(corpo), redirect: 'manual' });
  const texto = await r.text();
  assert.ok(!texto.includes(SEGREDO) && !texto.includes(REFRESH), 'segredo do Google nunca aparece numa resposta');
  let json = null;
  try { json = JSON.parse(texto); } catch (_) { /* página html */ }
  return { status: r.status, json, texto };
}

// ---------------------------------------------------------------- conectar
test('sem conectar: nada é consultado no Google e a ficha vem como sempre', async () => {
  assert.equal(await agendaGoogle.reuniaoDoLead({ emails: ['giumar@exemplo.com'] }, AGORA), null);
  assert.equal(chamadas.length, 0);
  const s = await chamar('GET', '/api/master/google', undefined, E.master);
  assert.deepEqual([s.json.configurado, s.json.conectado, s.json.agendas], [true, false, []]);
  assert.match(s.json.retorno, /\/api\/google\/retorno$/);
  assert.equal((await chamar('GET', '/api/master/google', undefined, E.sdr)).status, 403, 'só o master');
  assert.equal((await chamar('POST', '/api/master/google/conectar', {}, E.sdr)).status, 403);
});

test('conectar: o master abre a tela do Google e a volta guarda a autorização', async () => {
  const c = await chamar('POST', '/api/master/google/conectar', {}, E.master);
  const u = new URL(c.json.url);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events', 'ler as agendas e alterar eventos (só a cor)');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.match(u.searchParams.get('redirect_uri'), /\/api\/google\/retorno$/);
  const state = u.searchParams.get('state');

  // volta com state inventado ou repetido: recusada
  assert.match((await chamar('GET', '/api/google/retorno?code=codigo-bom&state=' + 'a'.repeat(36))).texto, /Pedido expirado/);
  assert.match((await chamar('GET', '/api/google/retorno?code=codigo-bom&state=' + state)).texto, /Google Agenda conectado/);
  assert.match((await chamar('GET', '/api/google/retorno?code=codigo-bom&state=' + state)).texto, /Pedido expirado/, 'o state vale uma vez só');

  const s = await chamar('GET', '/api/master/google', undefined, E.master);
  assert.equal(s.json.conectado, true);
  assert.deepEqual(s.json.agendas, ['Cauã Lima', 'Vitor Augusto', 'Paulo Henrique'], 'as agendas compartilhadas, sem a de feriados');
});

const visto = (r) => (r ? { quando: r.quando, closer: r.closer, titulo: r.titulo } : null);

// ---------------------------------------------------------------- achar a reunião
test('acha a reunião pelo e-mail do lead entre os convidados: dia e hora no fuso do time e o closer dono da agenda', async () => {
  chamadas.length = 0;
  const r = await agendaGoogle.reuniaoDoLead({ emails: ['Giumar@Exemplo.com'], nome: 'Giumar Pedroso' }, AGORA);
  assert.deepEqual(visto(r), { quando: '2026-10-06T14:00', closer: 'Vitor Augusto', titulo: 'Diagnóstico Pronix — Giumar Pedroso' });
  const eventos = chamadas.filter((c) => /\/events$/.test(c.url));
  assert.equal(eventos.length, 3, 'uma consulta por agenda (sem a de feriados)');
  assert.ok(eventos.every((c) => c.q === 'giumar@exemplo.com'));
  // de novo: vem do cache
  chamadas.length = 0;
  assert.deepEqual(await agendaGoogle.reuniaoDoLead({ emails: ['giumar@exemplo.com'] }, AGORA), r);
  assert.equal(chamadas.length, 0);
});

test('remarcou: vale a próxima reunião; só passada: a mais recente; cancelada e de outro convidado não contam', async () => {
  assert.equal((await agendaGoogle.reuniaoDoLead({ emails: ['remarcou@exemplo.com'] }, AGORA)).quando, '2026-10-08T16:30');
  assert.deepEqual(visto(await agendaGoogle.reuniaoDoLead({ emails: ['antigo@exemplo.com'] }, AGORA)), { quando: '2026-10-05T10:00', closer: 'Vitor Augusto', titulo: 'Diagnóstico Pronix — Lead Antigo' });
  assert.equal(await agendaGoogle.reuniaoDoLead({ emails: ['cancelado@exemplo.com'] }, AGORA), null);
  assert.equal(await agendaGoogle.reuniaoDoLead({ emails: ['giumar.outro@exemplo.com.br'] }, AGORA), null, 'e-mail parecido não é o mesmo convidado');
  assert.equal(await agendaGoogle.reuniaoDoLead({ emails: ['ninguem@exemplo.com'] }, AGORA), null);
});

test('lead sem e-mail no RD: procura pelo nome inteiro no título; só o primeiro nome não basta', async () => {
  assert.equal((await agendaGoogle.reuniaoDoLead({ emails: [], nome: 'Marcos Pereira' }, AGORA)).quando, '2026-10-09T11:00');
  chamadas.length = 0;
  assert.equal(await agendaGoogle.reuniaoDoLead({ emails: [], nome: 'Marcos' }, AGORA), null);
  assert.equal(await agendaGoogle.reuniaoDoLead({ emails: ['não é e-mail'], nome: '' }, AGORA), null);
  assert.equal(chamadas.length, 0, 'sem dado suficiente, nem consulta');
});

test('a ficha do lead traz a reunião para quem tem a automação; para os outros, não', async () => {
  const m = await chamar('POST', '/api/crm/lead', { telefone: '5511911110001' }, E.master);
  assert.deepEqual(m.json.reuniao, { quando: '2026-10-06T14:00', closer: 'Vitor Augusto', titulo: 'Diagnóstico Pronix — Giumar Pedroso' });
  const s = await chamar('POST', '/api/crm/lead', { telefone: '5511911110001' }, E.sdr);
  assert.equal(s.json.encontrado, true);
  assert.ok(!('reuniao' in s.json));
});

// ---------------------------------------------------------------- cor do pré-vendedor na agenda
test('pintar: a reunião futura do lead ganha a cor do pré-vendedor; evento que já tem cor, ou que já passou, não é mexido', async () => {
  const giumar = await agendaGoogle.reuniaoDoLead({ emails: ['giumar@exemplo.com'] }, AGORA);
  assert.equal(await agendaGoogle.pintarReuniao(giumar, '5'), 'pintado');
  assert.deepEqual(pinturas, [{ agenda: 'vitor@pronix.com', evento: giumar.eventoId, corpo: { colorId: '5' } }], 'a única alteração é a cor');
  assert.equal(await agendaGoogle.pintarReuniao(giumar, '5'), 'ja-tem-cor', 'não repete');
  assert.equal(await agendaGoogle.pintarReuniao({ ...giumar, eventoId: 'outro', cor: '11' }, '5'), 'ja-tem-cor', 'lead já marcado por outro pré-vendedor: não troca');
  const antigo = await agendaGoogle.reuniaoDoLead({ emails: ['antigo@exemplo.com'] }, AGORA);
  assert.equal(await agendaGoogle.pintarReuniao(antigo, '5'), 'passada');
  assert.equal(await agendaGoogle.pintarReuniao(giumar, '99'), 'sem-evento', 'cor inválida');
  assert.equal(await agendaGoogle.pintarReuniao(null, '5'), 'sem-evento');
  assert.equal(pinturas.length, 1);

  // conta que só pode VER a agenda (ou conexão antiga, só de leitura): não quebra nada
  podePintar = false;
  const remarcou = await agendaGoogle.reuniaoDoLead({ emails: ['remarcou@exemplo.com'] }, AGORA);
  assert.equal(await agendaGoogle.pintarReuniao(remarcou, '5'), 'sem-permissao');
  podePintar = true;
});

test('painel explica por que a cor não mudou: conexão só de leitura, agenda só para ver, cor não escolhida e a última tentativa', async () => {
  let s = (await chamar('GET', '/api/master/google', undefined, E.master)).json;
  assert.equal(s.alteraEventos, true);
  assert.deepEqual(s.soLeitura, ['Vitor Augusto', 'Paulo Henrique'], 'agendas compartilhadas só para ver');
  assert.equal(s.suaCor, '', 'o master ainda não escolheu a cor');
  assert.deepEqual([s.ultimaPintura.resultado, s.ultimaPintura.motivo, s.ultimaPintura.agenda], ['sem-permissao', 'agenda', 'Paulo Henrique']);
  assert.ok(!JSON.stringify(s.ultimaPintura).includes('Remarcou'), 'nada do lead fica guardado');

  // conexão antiga, feita só com leitura: o Google recusa por falta de escopo
  escopoDoToken = 'https://www.googleapis.com/auth/calendar.readonly';
  erro403 = { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } };
  podePintar = false;
  const lead = await agendaGoogle.reuniaoDoLead({ nome: 'Marcos Pereira Lima' }, AGORA);
  assert.equal(await agendaGoogle.pintarReuniao(lead, '5'), 'sem-permissao');
  podePintar = true;
  s = (await chamar('GET', '/api/master/google', undefined, E.master)).json;
  assert.equal(s.alteraEventos, false);
  assert.equal(s.ultimaPintura.motivo, 'conexao');
  escopoDoToken = ESCOPO_COMPLETO;
  erro403 = { error: 'forbidden' };
});

test('ao abrir a conversa: quem tem cor escolhida em Acessos pinta a reunião do lead; quem não tem, não', async () => {
  pinturas.length = 0;
  const usuarios = (await chamar('GET', '/api/admin/usuarios', undefined, E.master)).json.usuarios;
  const idMaster = usuarios.find((u) => u.papel === 'master').id;
  await db.cacheDel('google:pintado:' + (await agendaGoogle.reuniaoDoLead({ emails: ['giumar@exemplo.com'] }, new Date())).eventoId);

  await chamar('POST', '/api/crm/lead', { telefone: '5511911110001' }, E.master);
  assert.equal(pinturas.length, 0, 'sem cor escolhida: não mexe na agenda');

  assert.equal((await chamar('PATCH', '/api/admin/usuarios/' + idMaster, { corAgenda: '12' }, E.master)).status, 400, 'cor fora da tabela');
  assert.equal((await chamar('PATCH', '/api/admin/usuarios/' + idMaster, { corAgenda: '5' }, E.master)).status, 200);
  const r = await chamar('POST', '/api/crm/lead', { telefone: '5511911110001' }, E.master);
  assert.deepEqual(Object.keys(r.json.reuniao).sort(), ['closer', 'quando', 'titulo'], 'para a extensão vai só o que o cartão mostra');
  await chamar('PATCH', '/api/admin/usuarios/' + idMaster, { corAgenda: '' }, E.master);
});

test('Google recusou a conexão (autorização revogada): a ficha continua vindo, só sem a reunião', async () => {
  refreshValido = false;
  await db.cacheDel('google:token');
  await assert.rejects(agendaGoogle.reuniaoDoLead({ emails: ['novo@exemplo.com'] }, AGORA), /Conecte de novo/);
  await db.cacheDel('crm:tel:11110001');
  const m = await chamar('POST', '/api/crm/lead', { telefone: '5511911110001', nome: 'x' }, E.master);
  assert.equal(m.status, 200);
  assert.equal(m.json.encontrado, true);
  refreshValido = true;
});

test('desconectar apaga a autorização guardada', async () => {
  assert.equal((await chamar('DELETE', '/api/master/google', undefined, E.sdr)).status, 403);
  assert.equal((await chamar('DELETE', '/api/master/google', undefined, E.master)).status, 200);
  assert.equal((await chamar('GET', '/api/master/google', undefined, E.master)).json.conectado, false);
  assert.ok(!JSON.stringify(await db.getJson('google_agenda', {})).includes(REFRESH));
  assert.equal(await agendaGoogle.reuniaoDoLead({ emails: ['outro@exemplo.com'] }, AGORA), null);
});
