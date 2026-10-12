'use strict';
// Casos do closer: o pacote (cadastro + inteligência + negociações das transcrições), o padrão que
// sai deles e como cada reunião com resultado marcado entra na conta. Dados fictícios, banco em
// pasta temporária, IA simulada.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-casos-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', GROQ_API_KEY: 'gsk_teste', PDF_SEM_COMPRESSAO: '1',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;

const app = require('../server');
const stats = require('../src/stats');
const closers = require('../src/closers');
const casos = require('../src/casos');

const pedidosIa = [];
const RESPOSTA_IA = {
  nota: 9, veredito: 'Casal decidido, os dois na call.', composicao: 'casal', momento: 'loja física', decisores_na_call: 'sim',
  motivos: ['Casal junto na call é onde este closer mais fecha.'], atencao: [], como_conduzir: ['Confirmar a presença dos dois.'], falta_saber: [],
};
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchReal(url, opts);
  if (u.hostname === 'api.groq.com') {
    pedidosIa.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(RESPOSTA_IA) } }] }) };
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
  })).json()).usuario;
  E.master = await criar('Master Teste', 'master');
  E.sdr = await criar('Bia SDR', 'sdr');
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});
async function chamar(metodo, rota, corpo, usuario) {
  const r = await fetchReal(base + rota, {
    method: metodo, headers: { 'Content-Type': 'application/json', ...(usuario ? { 'x-cr-key': usuario.chave } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
/** Texto de um PDF do pdfkit sem compressão. */
function textoDoPdf(buf) {
  const s = buf.toString('latin1');
  return [...s.matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .map((m) => Buffer.from([...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]).join(''), 'hex').toString('latin1'))
    .join('\n');
}

// 10 negociações inventadas: casal junto fecha, família não fecha.
const caso = (quem, todosNaCall, momento, resultado, extra = {}) => ({ quem, todosNaCall, momento, resultado, reunioes: 1, minutos: 130, data: '2026-09-10', ...extra });
const CASOS = [
  caso('casal', true, 'loja', 'venda'), caso('casal', true, 'zero', 'venda'), caso('casal', true, 'zero', 'venda', { reunioes: 2, minutos: 260 }),
  caso('casal', false, 'loja', 'nao', { motivo: 'foi consultar alguém', travas: ['consultar esposa'] }),
  caso('sozinho', true, 'online', 'venda'), caso('sozinho', true, 'zero', 'acordo'), caso('sozinho', true, 'loja', 'nao', { minutos: 45 }),
  caso('socios', false, 'online', 'nao', { perfil: 'dois sócios, um fora da call' }),
  caso('familia', false, 'loja', 'nao'), caso('familia', false, 'loja', 'nao'),
];
const PACOTE = { pacote: 'closer', versao: 1, nome: 'Closer Fictício da Silva', apelido: 'CF', inteligencia: 'Fecha mais com casal na call. Trava quando o pai paga.', casos: CASOS };

test('peças: chaves de quem decide e de momento, sim/não e caso inválido', () => {
  assert.deepEqual(['sozinho', 'Casal', 'com sócio', 'família', 'Sozinho, a esposa apoia', 'não ficou claro', ''].map(casos.chaveDeQuem), ['sozinho', 'casal', 'socios', 'familia', 'sozinho', '', '']);
  assert.deepEqual(['loja física', 'já vende online', 'do zero', 'não ficou claro'].map(casos.chaveDoMomento), ['loja', 'online', 'zero', '']);
  assert.deepEqual([true, false, 'sim', 'Não', 'não ficou claro', undefined].map(casos.simNao), [true, false, true, false, null, null]);
  assert.equal(casos.normalizarCaso({ quem: 'casal' }, 'transcricao'), null, 'sem resultado não é caso');
  assert.equal(casos.normalizarCaso({ resultado: 'talvez' }, 'transcricao'), null);
  const c = casos.normalizarCaso({ resultado: 'venda', quem: 'x', momento: 'y', minutos: -3, reunioes: 'duas', data: 'ontem', perfil: 'a'.repeat(400), travas: 'nenhuma' }, 'transcricao');
  assert.deepEqual([c.quem, c.momento, c.minutos, c.reunioes, c.data, c.perfil.length, c.travas, c.todosNaCall], ['', '', null, null, '', 160, [], null]);
});

test('padrão: vendas por quem decide, presença, momento, reuniões e tempo; texto enxuto para a IA', () => {
  const p = casos.padrao(CASOS.map((c) => casos.normalizarCaso(c, 'transcricao')));
  assert.deepEqual(p.geral, { total: 10, vendas: 4, acordos: 1 });
  assert.deepEqual(p.quem.casal, { total: 4, vendas: 3, acordos: 0 });
  assert.deepEqual(p.quem.familia, { total: 2, vendas: 0, acordos: 0 });
  assert.deepEqual(p.presenca, { todos: { total: 6, vendas: 4, acordos: 1 }, faltou: { total: 4, vendas: 0, acordos: 0 } });
  assert.deepEqual(p.quemPresenca['casal:todos'], { total: 3, vendas: 3, acordos: 0 });
  assert.deepEqual(p.reunioes, { uma: { total: 9, vendas: 3, acordos: 1 }, duas: { total: 1, vendas: 1, acordos: 0 } });
  assert.deepEqual(p.tempo.a, { total: 1, vendas: 0, acordos: 0 });
  const t = casos.textoDoPadrao(p);
  assert.match(t, /Casos das calls dele: 10 \(10 de transcrições, 0 de reuniões com resultado marcado\)\. Vendas: 4 de 10 \(40%\); mais 1 acordo/);
  assert.match(t, /casal: 3 de 4;/, 'menos de 5 casos: sem porcentagem');
  assert.match(t, /todos os decisores na call: 4 de 6 \(67%\); faltou alguém: 0 de 4/);
  assert.match(t, /casal com os dois na call: 3 de 3; casal com um só na call: 0 de 1/);
  assert.ok(t.length < 1200, 'cabe no limite de tokens do plano gratuito');
  assert.equal(casos.textoDoPadrao(casos.padrao([])), '');
});

test('pacote: só o master importa; cria o closer com apelido, inteligência e casos; importar de novo não duplica', async () => {
  assert.equal((await chamar('POST', '/api/admin/closers/importar', PACOTE, E.sdr)).status, 403);
  assert.equal((await chamar('POST', '/api/admin/closers/importar', { casos: [] }, E.master)).status, 400, 'sem nome');
  assert.equal((await chamar('POST', '/api/admin/closers/importar', { nome: 'X', casos: 'muitos' }, E.master)).status, 400, 'casos tem de ser lista');
  assert.deepEqual(await closers.listar(), [], 'pacote recusado não cria nada');

  const r = await chamar('POST', '/api/admin/closers/importar', PACOTE, E.master);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.criado, r.json.casos, r.json.inteligencia, r.json.closer.nome, r.json.closer.apelido], [true, 10, true, 'Closer Fictício da Silva', 'CF']);
  E.closer = r.json.closer.id;
  const salvo = await closers.porId(E.closer);
  assert.equal(salvo.inteligencia, PACOTE.inteligencia);
  assert.ok(salvo.inteligenciaEm);
  // o botão já aparece na extensão de todo mundo, sem a inteligência ir junto
  assert.deepEqual((await chamar('GET', '/api/eu', undefined, E.sdr)).json.analises, [{ id: E.closer, nome: 'Closer Fictício da Silva', apelido: 'CF' }]);

  // de novo, agora achando pelo apelido e com um caso a menos: atualiza, não cria outro nem soma
  const de_novo = await chamar('POST', '/api/admin/closers/importar', { nome: 'Closer F. Silva', apelido: 'cf', casos: CASOS.slice(0, 9) }, E.master);
  assert.deepEqual([de_novo.json.criado, de_novo.json.casos, de_novo.json.inteligencia, de_novo.json.closer.id], [false, 9, false, E.closer]);
  assert.equal((await closers.listar()).length, 1);
  assert.equal((await closers.porId(E.closer)).inteligencia, PACOTE.inteligencia, 'pacote sem inteligência mantém a que estava');
  // e pelo nome cadastrado dentro de um nome mais comprido (como vem do RD)
  const pelo_nome = await chamar('POST', '/api/admin/closers/importar', { nome: 'Closer Fictício da Silva Junior', casos: CASOS }, E.master);
  assert.deepEqual([pelo_nome.json.criado, pelo_nome.json.casos], [false, 10]);
  assert.equal((await casos.importados(E.closer)).every((c) => c.origem === 'transcricao' && c.id), true);
});

test('padrão no painel: só o master vê; closer inexistente dá 404', async () => {
  assert.equal((await chamar('GET', `/api/admin/closers/${E.closer}/padrao`, undefined, E.sdr)).status, 403);
  assert.equal((await chamar('GET', '/api/admin/closers/nada/padrao', undefined, E.master)).status, 404);
  const r = await chamar('GET', `/api/admin/closers/${E.closer}/padrao`, undefined, E.master);
  assert.deepEqual(r.json.padrao.geral, { total: 10, vendas: 4, acordos: 1 });
  assert.deepEqual(r.json.padrao.origem, { transcricao: 10, resultado: 0 });
});

test('a análise recebe o padrão dos casos; o lead analisado vira caso quando o resultado é marcado', async () => {
  await stats.registrar({ id: 'lead1', usuarioId: E.sdr.id, usuarioNome: 'Bia SDR', lead: 'Lead Um', contato: 'Lead Um', origem: 'extensao' });
  await stats.registrar({ id: 'lead2', usuarioId: E.sdr.id, usuarioNome: 'Bia SDR', lead: 'Lead Dois', contato: 'Lead Dois', origem: 'extensao' });
  const dados = { lead: 'Lead Um', resumo: [{ rotulo: 'Decisor(es)', valor: 'Decide com a esposa, que vai à call' }] };
  const r = await chamar('POST', '/api/afinidade', { closerId: E.closer, reportId: 'lead1', dados }, E.sdr);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.afinidade.momento, r.json.afinidade.decisoresNaCall, r.json.afinidade.base.casos, r.json.afinidade.base.casosVendas], ['loja', true, 10, 4]);
  const user = pedidosIa[0].messages[1].content;
  assert.match(user, /<historico>\nAinda sem reuniões com resultado marcado para este closer\.\nCasos das calls dele: 10 \(10 de transcrições/);
  assert.match(user, /casal com os dois na call: 3 de 3/);
  assert.match(pedidosIa[0].messages[0].content, /"momento":"loja física \| já vende online \| do zero \| não ficou claro","decisores_na_call"/);
  assert.ok(textoDoPdf(Buffer.from(r.json.arquivoBase64, 'base64')).replace(/\s+/g, ' ').includes('10 caso(s) das calls dele, com 4 venda(s)'), 'o PDF diz em quantos casos a nota se apoia');
  // o que a análise leu do lead fica no report
  const rep = await stats.buscarPorId('lead1');
  assert.deepEqual([rep.afinidade.composicao, rep.afinidade.momento, rep.afinidade.decisoresNaCall], ['casal', 'loja', true]);
  await chamar('POST', '/api/afinidade', { closerId: E.closer, reportId: 'lead2', dados: { ...dados, lead: 'Lead Dois' } }, E.sdr);

  // ainda sem resultado: não é caso
  const padrao = async () => (await chamar('GET', `/api/admin/closers/${E.closer}/padrao`, undefined, E.master)).json.padrao;
  assert.deepEqual((await padrao()).origem, { transcricao: 10, resultado: 0 });
  // venda marcada: entra; "em follow-up" e no-show: não entram; "não comprou": entra como não
  await stats.atualizarResultado('lead1', { closerId: E.closer, closerNome: 'Closer Fictício da Silva', resultado: 'venda_call', dataReuniao: '2026-10-13' });
  await stats.atualizarResultado('lead2', { resultado: 'em_followup' });
  let p = await padrao();
  assert.deepEqual([p.origem.resultado, p.geral.total, p.geral.vendas, p.quemPresenca['casal:todos'].vendas], [1, 11, 5, 4]);
  await stats.atualizarResultado('lead2', { resultado: 'sem_venda' });
  p = await padrao();
  assert.deepEqual([p.origem.resultado, p.geral.total, p.geral.vendas, p.quem.casal.total], [2, 12, 5, 6], 'report sem closer marcado conta para o closer da análise');
  await stats.atualizarResultado('lead2', { resultado: 'no_show' });
  assert.equal((await padrao()).origem.resultado, 1);

  // reunião marcada com outro closer não conta para este
  const outro = await closers.criar('Outro Closer');
  await stats.atualizarResultado('lead1', { closerId: outro.id, closerNome: 'Outro Closer' });
  assert.equal((await padrao()).origem.resultado, 0);
  // a próxima análise já usa os números novos (o cache não segura o padrão antigo)
  await stats.atualizarResultado('lead1', { closerId: E.closer, closerNome: 'Closer Fictício da Silva' });
  pedidosIa.length = 0;
  await chamar('POST', '/api/afinidade', { closerId: E.closer, dados }, E.sdr);
  assert.equal(pedidosIa.length, 1);
  assert.match(pedidosIa[0].messages[1].content, /Casos das calls dele: 11 \(10 de transcrições, 1 de reuniões com resultado marcado\)/);
});

test('remover o closer leva os casos dele junto', async () => {
  assert.equal((await casos.importados(E.closer)).length, 10);
  assert.equal((await chamar('DELETE', '/api/admin/closers/' + E.closer, undefined, E.master)).status, 200);
  assert.deepEqual(await casos.importados(E.closer), []);
});
