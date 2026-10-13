'use strict';
// Transcrições novas das calls lidas do Google Drive: cada documento vira um caso do closer. Drive, Google
// e IA SIMULADOS (nenhuma chamada de rede), banco em pasta temporária, documentos inventados. O que importa
// provar: só lê documento novo; reunião sem conversa não vira caso; duas reuniões do mesmo lead viram um
// caso; nome de lead não vai para a IA nem fica guardado; erro de conexão diz o que fazer.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-transcricoes-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', GROQ_API_KEY: 'gsk_teste',
  GOOGLE_CLIENT_ID: 'cliente', GOOGLE_CLIENT_SECRET: 'segredo', GOOGLE_REFRESH_TOKEN: 'rt-de-teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.RDSTATION_CRM_TOKEN;

const app = require('../server');
const db = require('../src/db');
const closers = require('../src/closers');
const casos = require('../src/casos');
const stats = require('../src/stats');
const transcricoes = require('../src/transcricoes');
const drive = require('../src/driveGoogle');

// ---------------------------------------------------------------- documentos inventados
const PASTA = 'pasta_das_calls_0001';
const SUB = 'subpasta_gravacoes_01';
const DOC = 'application/vnd.google-apps.document';
function documento({ quando, resumo, decisoes = '', proximas = '', detalhes = '', falas = [], duracao = '01:30:00' }) {
  const transcricao = falas.map(([quem, fala]) => `${quem}: ${fala}`).join('\n\n');
  return [
    '📝 Observações', 'out. 9, 2026', `Reunião em ${quando} GMT-03:00`, 'Registros da reunião Transcrição', '',
    'Resumo', resumo, '', ...(decisoes ? ['Decisões', decisoes, ''] : []), ...(proximas ? ['Próximas etapas', proximas, ''] : []), 'Detalhes', detalhes, '',
    'Revise as anotações do Gemini para checar se estão corretas.', '📖 Transcrição', 'out. 9, 2026', `Reunião em ${quando} GMT-03:00 - Transcrição`, '00:00:00', '',
    transcricao, '', `A transcrição foi encerrada após ${duracao}`,
  ].join('\n');
}
const longa = (quem, base) => Array.from({ length: 40 }, (_, i) => [i % 2 ? quem : 'Closer Fictício Santos Lima', `${base} parte ${i} — conversa sobre a operação, o estoque e o investimento do projeto.`]);
const ARQUIVOS = {
  antigo: { pai: PASTA, tipo: DOC, criado: '2026-10-01T15:00:00Z', nome: 'Reunião antiga - Anotações do Gemini', texto: documento({ quando: '1 de out. de 2026 às 12:00', resumo: 'Reunião antiga.', detalhes: 'x'.repeat(2000), falas: longa('Lead Antigo', 'antiga') }) },
  casal: {
    pai: PASTA, tipo: DOC, criado: '2026-10-09T18:00:00Z', nome: 'Marina e Ricardo - Anotações do Gemini',
    texto: documento({
      quando: '9 de out. de 2026 às 14:30',
      resumo: 'O casal decidiu contratar a consultoria. Marina Souza e Ricardo Souza são donos de loja física há 8 anos.',
      decisoes: 'Alinhada\nContratação do projeto Marina Souza e Ricardo Souza decidiram contratar o programa.',
      proximas: '[Marina Souza, Ricardo Souza] Enviar comprovante: Enviar o comprovante do Pix no grupo.\n[Carlos Onboarding] Dar boas-vindas: Recepcionar o cliente e marcar o onboarding.\n[Closer Fictício Santos Lima] Criar projeto: Definir o mix de produtos.',
      detalhes: 'Contexto: Marina Souza contou que a loja caiu 40%. O e-mail dela é marina.souza@exemplo.com e o telefone (71) 99999-8888. Closer Fictício Santos Lima apresentou o método no Mercado Livre.',
      falas: longa('Marina Souza', 'loja').concat([['Ricardo Souza', 'A gente decide junto.']]), duracao: '02:10:00',
    }),
  },
  bruno1: {
    pai: PASTA, tipo: DOC, criado: '2026-10-10T18:00:00Z', nome: 'Bruno Teixeira - 1ª',
    texto: documento({ quando: '10 de out. de 2026 às 09:30', resumo: 'Bruno Teixeira já vende no Mercado Livre e ficou de falar com o sócio.', proximas: '[Bruno Teixeira] Consultar sócio: Conversar com o sócio sobre o investimento.', detalhes: 'Bruno Teixeira tem margem espremida. ' + 'd'.repeat(1600), falas: longa('Bruno Teixeira', 'margem'), duracao: '01:20:00' }),
  },
  video: { pai: PASTA, tipo: 'video/mp4', criado: '2026-10-10T18:05:00Z', nome: 'gravação.mp4', texto: 'binário' },
  semConversa: { pai: PASTA, tipo: DOC, criado: '2026-10-11T12:00:00Z', nome: 'Não compareceu', texto: documento({ quando: '11 de out. de 2026 às 14:41', resumo: 'O resumo desta reunião não foi gerado porque não havia conversas suficientes em um idioma aceito.', detalhes: 'Os detalhes desta reunião não foram gerados.', falas: [['Closer Fictício Santos Lima', 'Alô?']], duracao: '00:00:22' }) },
  bruno2: {
    pai: SUB, tipo: DOC, criado: '2026-10-12T20:00:00Z', nome: 'Bruno Teixeira e Sócio - 2ª',
    texto: documento({ quando: '12 de out. de 2026 às 17:00', resumo: 'Bruno Teixeira voltou com o sócio e fecharam.', proximas: '[Bruno Teixeira, Paulo Mendes] Efetuar pagamento: Pagar a entrada no cartão.', detalhes: 'Os sócios aprovaram. ' + 'e'.repeat(1600), falas: longa('Bruno Teixeira', 'fechamento'), duracao: '00:50:00' }),
  },
};
const PASTAS = { [SUB]: { pai: PASTA, criado: '2026-10-01T10:00:00Z', nome: 'Gravações' } };

// ---------------------------------------------------------------- Google, Drive e IA simulados
const chamadas = { lista: [], export: [], ia: [], token: 0 };
let erroDoDrive = null; // { status, corpo } para todas as chamadas ao Drive
let respostasIa = {}; // trecho do pedido -> resposta; '' -> padrão
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchReal(url, opts);
  const json = (corpo, status = 200) => ({ ok: status < 400, status, json: async () => corpo, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) });
  if (u.hostname === 'oauth2.googleapis.com') { chamadas.token++; return json({ access_token: 'acesso-de-teste', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.readonly' }); }
  if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/drive/v3/files')) {
    assert.equal(opts.headers.Authorization, 'Bearer acesso-de-teste');
    assert.equal(opts.method || 'GET', 'GET', 'no Drive, só leitura');
    if (erroDoDrive) return json(erroDoDrive.corpo, erroDoDrive.status);
    const m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(u.pathname);
    if (m) { chamadas.export.push(m[1]); return json(ARQUIVOS[m[1]].texto); }
    const q = u.searchParams.get('q');
    chamadas.lista.push(q);
    const pai = /^'([^']+)' in parents/.exec(q)[1];
    const desde = (/createdTime >= '([^']+)'/.exec(q) || [])[1];
    if (/mimeType = 'application\/vnd\.google-apps\.folder'/.test(q)) return json({ files: Object.entries(PASTAS).filter(([, p]) => p.pai === pai).map(([id, p]) => ({ id, name: p.nome, mimeType: 'application/vnd.google-apps.folder', createdTime: p.criado })) });
    const files = Object.entries(ARQUIVOS)
      .filter(([, a]) => a.pai === pai && q.includes(`mimeType = '${a.tipo}'`) && (!desde || a.criado >= desde))
      .map(([id, a]) => ({ id, name: a.nome, mimeType: a.tipo, createdTime: a.criado }));
    return json({ files });
  }
  if (u.hostname === 'api.groq.com') {
    const corpo = JSON.parse(opts.body);
    const user = corpo.messages[1].content;
    chamadas.ia.push(user);
    const chave = Object.keys(respostasIa).find((k) => k && user.includes(k));
    const r = chave ? respostasIa[chave] : respostasIa[''];
    if (r === 'falha') return json({ error: 'caiu' }, 500);
    return json({ choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] });
  }
  throw new Error('chamada externa inesperada: ' + u.href);
};
test.after(() => { global.fetch = fetchReal; fs.rmSync(DADOS, { recursive: true, force: true }); });

const IA_PADRAO = {
  '': { quem: 'sozinho', todos_na_call: 'sim', momento: 'online', resultado: 'nao', motivo: 'ficou de pensar', perfil: 'vendedor com margem espremida', travas: [] },
  'O casal decidiu contratar': { quem: 'casal', todos_na_call: 'sim', momento: 'loja física', resultado: 'acordo', motivo: 'vai mandar o Pix', perfil: 'Marina Souza e o marido, donos de loja física há 8 anos, em queda de 40%', travas: [] },
  'ficou de falar com o sócio': { quem: 'socios', todos_na_call: 'nao', momento: 'online', resultado: 'nao', motivo: 'foi consultar o sócio', perfil: 'vendedor de margem espremida com sócio fora da call', travas: ['sócio ausente'] },
  'voltou com o sócio e fecharam': { quem: 'socios', todos_na_call: 'sim', momento: 'online', resultado: 'acordo', motivo: 'vão pagar a entrada no cartão', perfil: 'sócios com e-commerce; fecharam na segunda reunião', travas: [] },
};
let closer;
test.before(async () => {
  closer = await closers.criar('Closer Fictício');
  await closers.definirInteligencia(closer.id, { apelido: 'CF', inteligencia: 'Fecha com casal.' });
});
test.beforeEach(() => { erroDoDrive = null; respostasIa = { ...IA_PADRAO }; chamadas.lista.length = 0; chamadas.export.length = 0; chamadas.ia.length = 0; });
const comPasta = async (desde = '2026-10-09') => closers.definirDrive(closer.id, { pasta: PASTA, desde });

// ---------------------------------------------------------------- ler o documento
test('documento do Meet: seções, data, duração, quantos falaram, onboarding da casa e reunião sem conversa', () => {
  const e = transcricoes.estruturar(ARQUIVOS.casal.texto, { closerNome: 'Closer Fictício' });
  assert.match(e.resumo, /^O casal decidiu contratar/);
  assert.match(e.decisoes, /^Alinhada\nContratação/);
  assert.match(e.proximas, /^\[Marina Souza, Ricardo Souza\] Enviar comprovante/);
  assert.match(e.detalhes, /^Contexto: Marina Souza/);
  assert.ok(!e.detalhes.includes('A transcrição foi encerrada') && e.transcricao.includes('A gente decide junto.'));
  assert.deepEqual([e.quando, e.minutos, e.falantes, e.onboarding, e.curta], ['2026-10-09 14:30', 130, 2, true, false]);
  assert.deepEqual(e.leadPrimeiros, [casos.impressaoDoNome('Marina'), casos.impressaoDoNome('Ricardo')], 'o closer e a casa não são o lead');
  assert.match(e.leadPrimeiros[0], /^[a-f0-9]{12}$/);

  const vazio = transcricoes.estruturar(ARQUIVOS.semConversa.texto, { closerNome: 'Closer Fictício' });
  assert.deepEqual([vazio.curta, vazio.resumo, vazio.minutos, vazio.quando], [true, '', 0, '2026-10-11 14:41']);
  // documento só com a transcrição (sem anotações): vale o texto todo
  const soFala = transcricoes.estruturar('Fulano de Tal: oi\n\nCloser Fictício: olá', { closerNome: 'Closer Fictício' });
  assert.deepEqual([soFala.resumo, soFala.falantes, soFala.curta, soFala.quando], ['', 1, true, '']);
});

test('antes de ir para a IA os nomes somem: responsável vira [lead], [casa] ou [closer]; nome, e-mail e telefone são mascarados', () => {
  const e = transcricoes.estruturar(ARQUIVOS.casal.texto, { closerNome: 'Closer Fictício' });
  const t = transcricoes.anotacoesParaIa(e, 'Closer Fictício');
  for (const nome of ['Marina', 'Ricardo', 'Souza', 'Carlos', 'Santos Lima', 'marina.souza@', '99999-8888']) assert.ok(!t.includes(nome), 'vazou: ' + nome);
  assert.match(t, /\[lead\] Enviar comprovante/);
  assert.match(t, /\[casa\] Dar boas-vindas/);
  assert.match(t, /\[closer\] Criar projeto/);
  assert.match(t, /\[pessoa\] contou que a loja caiu 40%\. O e-mail dela é \[e-mail\] e o telefone \[telefone\]\. o closer apresentou o método no Mercado Livre\./, 'o que não é nome de gente fica como está');
  assert.ok(!t.includes('A gente decide junto'), 'com anotações, a transcrição crua não vai');
  assert.equal(transcricoes.mascarar('[Time, Closer Fictício Santos] Tarefa', { closerNome: 'Closer Fictício' }), '[lead e closer] Tarefa');
});

// ---------------------------------------------------------------- a leitura
test('ler a pasta: só documento novo (a partir da data), poucos por vez; cada call vira um caso sem nome de lead', async () => {
  await comPasta();
  let c = await closers.porId(closer.id);
  let r = await transcricoes.sincronizar(c, { porVez: 2 });
  assert.deepEqual(r, { lidos: 2, casos: 2, semConversa: 0, erros: [], restantes: 2, total: 4 });
  assert.deepEqual(chamadas.export, ['casal', 'bruno1'], 'do mais antigo para o mais novo; o vídeo e o documento de antes da data nem aparecem');
  assert.match(chamadas.lista[0], /^'pasta_das_calls_0001' in parents and trashed = false and \(mimeType = 'application\/vnd\.google-apps\.document' or mimeType = 'text\/plain'\) and createdTime >= '2026-10-09T00:00:00'$/);
  for (const pedido of chamadas.ia) for (const nome of ['Marina', 'Ricardo', 'Bruno', 'Teixeira']) assert.ok(!pedido.includes(nome), 'nome de lead foi para a IA: ' + nome);

  let lista = await casos.doDrive(closer.id);
  const casal = lista.find((x) => x.arquivos.includes('casal'));
  // a tarefa para a casa (onboarding) prova a venda, mesmo com a IA dizendo "acordo"; o perfil não leva nome
  assert.deepEqual([casal.resultado, casal.motivo, casal.quem, casal.todosNaCall, casal.momento, casal.data, casal.minutos, casal.reunioes, casal.origem],
    ['venda', 'onboarding iniciado pela casa', 'casal', true, 'loja', '2026-10-09', 130, 1, 'drive']);
  assert.equal(casal.perfil, 'o lead e o marido, donos de loja física há 8 anos, em queda de 40%');

  // segunda rodada: a reunião sem conversa não vira caso; a 2ª call do Bruno (na subpasta) soma no caso dele
  r = await transcricoes.sincronizar(c, { porVez: 5 });
  assert.deepEqual(r, { lidos: 2, casos: 1, semConversa: 1, erros: [], restantes: 0, total: 4 });
  lista = await casos.doDrive(closer.id);
  assert.equal(lista.length, 2, 'duas reuniões do mesmo lead são UMA negociação');
  const bruno = lista.find((x) => x.arquivos.includes('bruno1'));
  assert.deepEqual([bruno.arquivos, bruno.reunioes, bruno.minutos, bruno.resultado, bruno.todosNaCall, bruno.quem, bruno.travas, bruno.data],
    [['bruno1', 'bruno2'], 2, 130, 'acordo', true, 'socios', ['sócio ausente'], '2026-10-10'], 'vale o melhor desfecho e a presença da reunião que fechou');
  assert.equal(bruno.perfil, 'sócios com e-commerce; fecharam na segunda reunião');

  // terceira: nada novo, nenhuma chamada à IA nem download
  chamadas.export.length = 0; chamadas.ia.length = 0;
  r = await transcricoes.sincronizar(c, { porVez: 5 });
  assert.deepEqual([r.lidos, r.casos, r.restantes, chamadas.export.length, chamadas.ia.length], [0, 0, 0, 0, 0]);

  // nada de nome guardado: nem nos casos, nem na lista do que foi lido
  const guardado = fs.readFileSync(path.join(DADOS, 'closers_casos.json'), 'utf8') + fs.readFileSync(path.join(DADOS, 'drive_lidos.json'), 'utf8');
  for (const nome of ['Marina', 'Ricardo', 'Souza', 'Bruno', 'Teixeira', 'Anotações do Gemini']) assert.ok(!guardado.includes(nome), 'ficou guardado: ' + nome);
  c = await closers.porId(closer.id);
  assert.deepEqual([c.driveUltima.lidos, c.driveUltima.casos, c.driveUltima.erro], [0, 0, '']);

  // os casos do Drive entram no padrão e nos casos parecidos
  const todos = await casos.doCloser(closer.id, []);
  assert.deepEqual(casos.padrao(todos).geral, { total: 2, vendas: 1, acordos: 1 });
  assert.equal(casos.padrao(todos).origem.transcricao, 2);
  assert.equal(casos.parecidos(todos, { quem: 'casal', momento: 'loja', todosNaCall: true }).exemplos[0].perfil, casal.perfil);
});

test('a mesma reunião chega pelo Drive e por um report com resultado: conta uma vez só (vale a do Drive)', async () => {
  const rep = (id, lead, dia) => ({ id, lead, dia, closerId: closer.id, resultado: 'venda_call', afinidade: { closerId: closer.id, composicao: 'casal', momento: 'loja', decisoresNaCall: true } });
  const todos = await casos.doCloser(closer.id, [rep('r1', 'Marina PRONIX Souza', '2026-10-09'), rep('r2', 'Marina de Outro Mês', '2026-11-20'), rep('r3', 'Outra Pessoa', '2026-10-09')]);
  assert.deepEqual(todos.map((c) => c.id).sort(), ['d_bruno1', 'd_casal', 'r_r2', 'r_r3'], 'a Marina de outubro já está no caso do Drive');
});

test('a IA não respondeu: o documento é tentado de novo depois, no máximo 3 vezes; os outros seguem', async () => {
  await closers.definirDrive(closer.id, { pasta: PASTA, desde: '2026-10-01' }); // agora o "antigo" entra
  respostasIa[''] = 'falha';
  const c = await closers.porId(closer.id);
  let r = await transcricoes.sincronizar(c, { porVez: 3 });
  assert.deepEqual([r.lidos, r.casos, r.erros.length, r.restantes], [1, 0, 1, 0]);
  await transcricoes.sincronizar(c, { porVez: 3 });
  r = await transcricoes.sincronizar(c, { porVez: 3 });
  assert.equal(r.erros.length, 1);
  chamadas.export.length = 0;
  r = await transcricoes.sincronizar(c, { porVez: 3 });
  assert.deepEqual([r.lidos, chamadas.export.length], [0, 0], 'depois de 3 tentativas, desiste do documento');
  assert.equal((await casos.doDrive(closer.id)).length, 2);
});

test('erro do Google diz o que fazer, e não gasta tentativa do documento', async () => {
  assert.equal(drive.idDaPasta('https://drive.google.com/drive/u/0/folders/1PastaDeExemplo_ABCdef-0123456789xyz?usp=sharing'), '1PastaDeExemplo_ABCdef-0123456789xyz');
  assert.equal(drive.idDaPasta('https://exemplo.com/qualquer'), '');
  const c = await closers.porId(closer.id);
  erroDoDrive = { status: 403, corpo: { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } };
  await assert.rejects(() => transcricoes.sincronizar(c), /ainda não tem permissão para ler o Drive[\s\S]*"Conectar de novo"/);
  erroDoDrive = { status: 403, corpo: { error: { code: 403, message: 'Google Drive API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } } };
  await assert.rejects(() => transcricoes.sincronizar(c), /A API do Google Drive não está ativada no projeto do Google Cloud/);
  erroDoDrive = { status: 404, corpo: { error: { code: 404, message: 'File not found' } } };
  await assert.rejects(() => transcricoes.sincronizar(c), /Não achei a pasta no Drive/);
  await assert.rejects(() => transcricoes.sincronizar({ id: closer.id, nome: 'Closer Fictício' }), /Informe a pasta do Drive/);
  // a rodada automática não quebra: anota o erro no closer, para a tela mostrar
  const r = await transcricoes.sincronizarTodos({ porVez: 2 });
  assert.match(r.erros[0], /Não achei a pasta/);
  assert.match((await closers.porId(closer.id)).driveUltima.erro, /Não achei a pasta/);
});

// ---------------------------------------------------------------- rotas e painel
test('rotas: só o master configura a pasta, lê, corrige e apaga caso; a batida de hora em hora também lê o Drive', async () => {
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const admin = { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' };
    const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', { method: 'POST', headers: admin, body: JSON.stringify({ nome, papel }) })).json()).usuario;
    const master = await criar('Master Teste', 'master');
    const sdr = await criar('Bia SDR', 'sdr');
    const chamar = async (metodo, rota, corpo, u) => {
      const r = await fetch(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', 'x-cr-key': u.chave }, body: corpo ? JSON.stringify(corpo) : undefined });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const novo = await closers.criar('Outro Closer Ficticio');
    for (const [m, rota] of [['POST', `/api/admin/closers/${novo.id}/drive/ler`], ['GET', `/api/admin/closers/${novo.id}/drive`], ['PATCH', `/api/admin/closers/${novo.id}/casos/x`], ['DELETE', `/api/admin/closers/${novo.id}/casos/x`]]) {
      assert.equal((await chamar(m, rota, m === 'GET' || m === 'DELETE' ? undefined : {}, sdr)).status, 403, rota);
    }
    // a pasta entra pelo link; link que não é pasta é recusado; vazio desliga
    assert.equal((await chamar('PATCH', '/api/admin/closers/' + novo.id, { drivePasta: 'https://exemplo.com/x' }, master)).status, 400);
    let r = await chamar('PATCH', '/api/admin/closers/' + novo.id, { drivePasta: `https://drive.google.com/drive/u/0/folders/${PASTA}`, driveDesde: '2026-10-09' }, master);
    assert.deepEqual([r.status, r.json.closer.drivePasta, r.json.closer.driveDesde], [200, PASTA, '2026-10-09']);
    assert.equal((await chamar('POST', `/api/admin/closers/${novo.id}/drive/ler`, {}, sdr)).status, 403);

    r = await chamar('POST', `/api/admin/closers/${novo.id}/drive/ler`, {}, master);
    assert.deepEqual([r.status, r.json.lidos, r.json.casos, r.json.restantes], [200, 3, 2, 1], 'três documentos por clique');
    r = await chamar('GET', `/api/admin/closers/${novo.id}/drive`, undefined, master);
    assert.deepEqual([r.json.pasta, r.json.total, r.json.ultima.casos], [PASTA, 2, 2]);
    assert.deepEqual(r.json.casos.map((c) => [c.id, c.resultado, c.revisado]), [['d_bruno1', 'nao', false], ['d_casal', 'venda', false]]);
    assert.ok(!JSON.stringify(r.json).includes('Marina'));

    // corrigir: vira "revisado" e a leitura não mexe mais nele (a 2ª call do Bruno vira outro caso)
    r = await chamar('PATCH', `/api/admin/closers/${novo.id}/casos/d_bruno1`, { resultado: 'acordo', quem: 'casal' }, master);
    assert.deepEqual([r.json.caso.resultado, r.json.caso.quem, r.json.caso.revisado], ['acordo', 'casal', true]);
    assert.equal((await chamar('PATCH', `/api/admin/closers/${novo.id}/casos/naoexiste`, { resultado: 'venda' }, master)).status, 404);
    await chamar('POST', `/api/admin/closers/${novo.id}/drive/ler`, {}, master);
    const depois = await casos.doDrive(novo.id);
    assert.deepEqual(depois.find((c) => c.id === 'd_bruno1').resultado, 'acordo');
    assert.equal(depois.length, 3);
    // apagar
    assert.equal((await chamar('DELETE', `/api/admin/closers/${novo.id}/casos/d_casal`, undefined, master)).status, 200);
    assert.equal((await casos.doDrive(novo.id)).some((c) => c.id === 'd_casal'), false);
    chamadas.export.length = 0;
    await chamar('POST', `/api/admin/closers/${novo.id}/drive/ler`, {}, master);
    assert.equal(chamadas.export.length, 0, 'documento de caso apagado não é lido de novo');

    // batida de hora em hora: lê o Drive junto (no máximo uma vez a cada 45 min)
    await closers.definirDrive(closer.id, { pasta: PASTA, desde: '2026-10-09' });
    const terceiro = await closers.criar('Terceiro Closer Ficticio');
    await closers.definirDrive(terceiro.id, { pasta: PASTA, desde: '2026-10-09' });
    await db.destravar('drive-transcricoes');
    r = await chamar('POST', '/api/rd/atualizar', {}, sdr);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.transcricoes, { lidos: 2, casos: 2 }, 'dois documentos por closer na rodada automática');
    r = await chamar('POST', '/api/rd/atualizar', {}, sdr);
    assert.equal(r.json.transcricoes, undefined, 'a trava segura a segunda batida');
    // remover o closer leva os casos do Drive junto
    await chamar('DELETE', '/api/admin/closers/' + terceiro.id, undefined, master);
    assert.deepEqual(await casos.doDrive(terceiro.id), []);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});
