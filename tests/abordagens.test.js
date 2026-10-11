'use strict';
// Teste das abordagens de primeiro contato: reconhecer qual foi usada, contar enviadas / respostas /
// reports / vendas por abordagem. Banco em pasta temporária, extensão em DOM simulado, sem rede.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-abordagens-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;

const app = require('../server');
const stats = require('../src/stats');
const abordagens = require('../src/abordagens');
const agenda = require('../extension/agenda.js');
const { abrirPagina, montarWhatsApp, esperar, dormir } = require('./helpers/dom');

const RAIZ = path.join(__dirname, '..');
const eu = (content) => ({ from: 'eu', type: 'texto', content });
const lead = (content) => ({ from: 'eles', type: 'texto', content });
const preencher = (m) => m.replace(/\[NOME\]/g, 'Robson').replace(/\[DIA\]/g, 'terça-feira').replace(/\[HORA\]/g, '11h');
const ASSINATURAS = abordagens.paraExtensao(abordagens.PADRAO);

let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const admin = { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' };
  const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', { method: 'POST', headers: admin, body: JSON.stringify({ nome, papel }) })).json()).usuario;
  E.master = await criar('Cauã Lima', 'master');
  E.sdr = await criar('Bia SDR', 'sdr');
  E.sem = await criar('Sem Automacao', 'sdr');
  for (const u of [E.master, E.sdr]) await fetch(base + '/api/admin/usuarios/' + u.id, { method: 'PATCH', headers: admin, body: JSON.stringify({ automacao: true }) });
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  fs.rmSync(DADOS, { recursive: true, force: true });
});
async function chamar(metodo, rota, corpo, usuario) {
  const r = await fetch(base + rota, {
    method: metodo, headers: { 'Content-Type': 'application/json', ...(usuario ? { 'x-cr-key': usuario.chave } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ---------------------------------------------------------------- as cinco de partida
test('as 5 abordagens de partida: letras únicas, assinatura dentro do próprio texto e o agendamento continua sendo lido', () => {
  assert.deepEqual(abordagens.PADRAO.map((a) => a.id), ['A', 'B', 'C', 'D', 'E']);
  const agora = new Date('2026-10-12T12:00:00');
  for (const a of abordagens.PADRAO) {
    const textos = a.mensagens.map(abordagens.normalizar);
    a.assinaturas.forEach((s) => assert.ok(textos.some((t) => t.includes(abordagens.normalizar(s))), `${a.id}: assinatura fora do texto`));
    // Cada abordagem só é reconhecida como ela mesma
    assert.equal(agenda.detectarAbordagem(a.mensagens.map((m) => eu(preencher(m))), ASSINATURAS), a.id);
    // "Você agendou sua reunião para terça-feira às 11h" continua virando a etiqueta de agendamento do cartão
    const achado = agenda.detectarAgendamento(a.mensagens.map((m, i) => ({ ...eu(preencher(m)), timestamp: 1000 + i })), agora);
    assert.ok(achado && /T11:00$/.test(achado.quando), `${a.id}: agendamento não lido`);
  }
});

// ---------------------------------------------------------------- reconhecer a abordagem na conversa
test('reconhece a abordagem pelas MINHAS primeiras mensagens; vale a assinatura mais longa', () => {
  const det = (msgs) => agenda.detectarAbordagem(msgs, ASSINATURAS);
  // as variações de hoje (prints): todas são o controle
  for (const fim of ['Posso confirmar, Robson?', 'Posso confirmar?', 'posso  CONFIRMAR, Danilo']) {
    assert.equal(det([eu('Boa tarde, Robson!'), eu('Prazer em falar com você meu caro, sou o Cauã Lima.'), eu('Você agendou sua reunião para terça-feira às 11h.'), eu(fim)]), 'A');
  }
  // C e D também têm "posso confirmar": ganha a assinatura mais longa
  assert.equal(det([eu('Quero deixar tudo preparado para o seu caso. Posso confirmar a sua presença, Ana?')]), 'C');
  assert.equal(det([eu('Boa tarde, Ana! Aqui é o Cauã Lima, especialista em Mercado Livre do time do Hugo Vasconcelos.'), eu('Você agendou sua reunião para terça às 17h. Posso confirmar?')]), 'D');
  // sem acento, com pontuação diferente: ainda é a B
  assert.equal(det([eu('Antes da reuniao me conta, voce ja vende no mercado livre... ou vai comecar do zero??')]), 'B');
  // fala do LEAD não conta; áudio não conta; conversa sem nada parecido: ''
  assert.equal(det([lead('posso confirmar sim'), eu('Oi!')]), '');
  assert.equal(det([{ from: 'eu', type: 'audio', content: 'posso confirmar' }]), '');
  assert.equal(det([eu('Oi, tudo bem?'), lead('tudo')]), '');
  // assinatura não casa atravessando duas mensagens
  assert.equal(det([eu('Você confirma a sua presença? Seu horário já está'), eu('reservado na nossa agenda')]), '');
  // só o começo da conversa é primeiro contato
  const longa = Array.from({ length: 12 }, (_, i) => (i % 2 ? lead('ok ' + i) : eu('mensagem ' + i))).concat([eu('Posso confirmar, Robson?')]);
  assert.equal(det(longa), '');
  assert.equal(agenda.detectarAbordagem([eu('Posso confirmar?')], []), '');
  assert.equal(agenda.detectarAbordagem(null, ASSINATURAS), '');
});

// ---------------------------------------------------------------- anotar
test('anotar: precisa da automação; a primeira abordagem reconhecida fica; "respondeu" só para quem tem abordagem', async () => {
  assert.equal((await chamar('POST', '/api/lead/abordagem', { telefone: '5511911110001', abordagem: 'A' }, E.sem)).status, 403);
  assert.equal((await chamar('POST', '/api/lead/abordagem', { abordagem: 'A' }, E.sdr)).status, 400, 'sem telefone nem nome');

  // "respondeu" de lead que nunca recebeu abordagem não cria nada
  assert.deepEqual((await chamar('POST', '/api/lead/abordagem', { telefone: '5511911110001', respondeu: true }, E.sdr)).json.contato, { abordagem: '', respondeu: false });
  // letra que não existe é ignorada
  assert.deepEqual((await chamar('POST', '/api/lead/abordagem', { telefone: '5511911110001', abordagem: 'Z' }, E.sdr)).json.contato, { abordagem: '', respondeu: false });

  const r = await chamar('POST', '/api/lead/abordagem', { telefone: '+55 (11) 91111-0001', nome: '+55 11 91111-0001', abordagem: 'b' }, E.sdr);
  assert.deepEqual(r.json.contato, { abordagem: 'B', respondeu: false });
  // outra abordagem depois (ele mandou mais mensagens) não troca a do primeiro contato
  assert.deepEqual((await chamar('POST', '/api/lead/abordagem', { telefone: '5511911110001', abordagem: 'C' }, E.sdr)).json.contato, { abordagem: 'B', respondeu: false });
  assert.deepEqual((await chamar('POST', '/api/lead/abordagem', { telefone: '5511911110001', respondeu: true }, E.sdr)).json.contato, { abordagem: 'B', respondeu: true });

  // o mesmo lead é de cada usuário: para a master ele ainda não tem abordagem
  assert.deepEqual(await abordagens.doLead(E.master.id, { telefone: '5511911110001' }), { abordagem: '', respondeu: false });
  assert.deepEqual(await abordagens.doLead(E.sdr.id, { telefone: '11 91111-0001' }), { abordagem: 'B', respondeu: true });

  // nenhum texto de conversa fica guardado: só letra, datas e a identificação do lead
  const guardado = JSON.parse(fs.readFileSync(path.join(DADOS, 'abordagem_contatos.json'), 'utf8'));
  const reg = Object.values(guardado)[0];
  assert.deepEqual(Object.keys(reg).sort(), ['abordagem', 'em', 'nome', 'respondeu', 'respondeuEm', 'tel', 'usuarioId']);
  assert.equal(reg.tel, '11110001');
});

// ---------------------------------------------------------------- o placar
test('placar: enviadas, respostas, reports e VENDAS por abordagem; só compara quem tem 10 envios', async () => {
  const tel = (n) => '55119' + String(20000000 + n);
  // A: 10 envios, 8 respostas, 1 venda.   C: 10 envios, 6 respostas, 2 vendas.   E: 3 envios (amostra pequena), 1 venda.
  const plano = [['A', 10, 8, 1, 100], ['C', 10, 6, 2, 200], ['E', 3, 3, 1, 300]];
  for (const [letra, enviados, respostas, vendas, baseTel] of plano) {
    for (let i = 0; i < enviados; i++) {
      const telefone = tel(baseTel + i);
      await abordagens.anotar({ usuarioId: E.master.id, conversa: { telefone }, abordagem: letra, respondeu: i < respostas });
      if (i < vendas + 1) {
        // quem virou report: os primeiros; venda só nos "vendas" primeiros (o seguinte tem report sem venda)
        const id = `r${letra}${i}`;
        await stats.registrar({ id, usuarioId: E.master.id, usuarioNome: 'Cauã Lima', lead: 'Lead ' + id, contato: '+' + telefone, origem: 'extensao' });
        if (i < vendas) await stats.atualizarResultado(id, { resultado: 'venda_call' });
        else await stats.atualizarResultado(id, { resultado: 'sem_venda' });
      }
    }
  }
  // report de outro usuário com o mesmo telefone não conta para a master
  await stats.registrar({ id: 'alheio', usuarioId: E.sdr.id, usuarioNome: 'Bia SDR', lead: 'x', contato: '+' + tel(105), origem: 'extensao' });
  await stats.atualizarResultado('alheio', { resultado: 'venda_call' });

  const r = await chamar('GET', '/api/master/abordagens', undefined, E.master);
  assert.equal(r.status, 200);
  assert.equal(r.json.lista.length, 5);
  const linha = (id) => r.json.placar.linhas.find((l) => l.id === id);
  assert.deepEqual([linha('A').enviadas, linha('A').respostas, linha('A').comReport, linha('A').vendas], [10, 8, 2, 1]);
  assert.deepEqual([linha('C').enviadas, linha('C').respostas, linha('C').comReport, linha('C').vendas], [10, 6, 3, 2]);
  assert.equal(linha('A').taxaResposta, 0.8);
  assert.equal(linha('C').taxaVenda, 0.2);
  assert.deepEqual([linha('E').enviadas, linha('E').vendas, linha('E').amostraPequena], [3, 1, true]);
  assert.deepEqual([linha('B').enviadas, linha('D').enviadas], [0, 0], 'a B da Bia não entra no placar da master');
  assert.equal(r.json.placar.melhorEmResposta, 'A');
  assert.equal(r.json.placar.melhorEmVenda, 'C', 'a E tem taxa maior, mas ainda não tem amostra');
  assert.equal(r.json.placar.total, 23);

  // a equipe toda (master): entra também o contato da Bia
  const todos = await chamar('GET', '/api/master/abordagens?escopo=todos', undefined, E.master);
  assert.equal(todos.json.placar.total, 24);
  assert.equal(todos.json.placar.linhas.find((l) => l.id === 'B').respostas, 1);
  // venda marcada só no RD também conta
  await stats.atualizarResultado('rA1', { resultado: '', vendidoNoRd: '2026-10-11' });
  assert.equal((await abordagens.placar({ usuarioId: E.master.id, reports: await stats.listar({}) })).linhas[0].vendas, 2);
  // período: contato feito antes do corte não entra
  assert.equal((await abordagens.placar({ usuarioId: E.master.id, reports: [], desde: '2999-01-01' })).total, 0);
  // quem não tem a aba Resultados não vê
  assert.equal((await chamar('GET', '/api/master/abordagens', undefined, E.sdr)).status, 403);
});

// ---------------------------------------------------------------- editar as abordagens
test('salvar: só o master; recusa letra repetida, assinatura em duas abordagens ou fora do texto', async () => {
  const boa = (id, extra = {}) => ({ id, nome: 'Abordagem ' + id, hipotese: 'h', mensagens: ['Oi, [NOME]!', `Frase única da ${id} aqui.`], assinaturas: [`frase única da ${id} aqui`], ...extra });
  assert.equal((await chamar('PUT', '/api/master/abordagens', { lista: [boa('A')] }, E.sdr)).status, 403);
  const erro = async (lista) => (await chamar('PUT', '/api/master/abordagens', { lista }, E.master)).json.erro;
  assert.match(await erro([boa('A'), boa('A')]), /mesma letra/);
  assert.match(await erro([boa('A'), boa('B', { mensagens: ['Frase única da A aqui.'], assinaturas: ['frase única da A aqui'] })]), /está em duas abordagens/);
  assert.match(await erro([boa('A', { assinaturas: ['trecho que não existe'] })]), /não aparece inteira/);
  assert.match(await erro([boa('A', { assinaturas: ['oi'] })]), /precisa de nome/);

  const ok = await chamar('PUT', '/api/master/abordagens', { lista: [boa('A'), boa('B')] }, E.master);
  assert.equal(ok.status, 200);
  assert.deepEqual((await abordagens.ler()).map((a) => a.id), ['A', 'B']);
  // o que já foi contado para letras que saíram aparece no total, fora das linhas
  const p = await abordagens.placar({ usuarioId: E.master.id, reports: [] });
  assert.equal(p.linhas.length, 2);
  assert.equal(p.semAbordagemAtual, 13);
  await abordagens.salvar(abordagens.PADRAO); // volta às de partida para os testes seguintes
});

// ---------------------------------------------------------------- na extensão
const FICHA = {
  nome: 'Lead de Teste', telefones: ['(71) 99999-8888'], emails: [],
  negociacao: { nome: 'Lead de Teste', etapa: 'MQL', funil: 'Funil SDR', responsavel: 'Cauã Lima', fonte: '', campanha: '', criadaEm: '', url: 'https://crm.rdstation.com/app/deals/d1' },
  totalNegociacoes: 1, negociacoes: [{ id: 'd1', nome: 'Lead de Teste', etapa: 'MQL', funil: 'Funil SDR', aberta: true, escolhida: true }],
  formulario: null, campos: [], anotacoes: [],
};
const SEM_MARCA = { qualificado: false, origem: '', agendadoPara: '', agendaFonteTs: -1 };
function extensao(conversa, contato) {
  const pedidos = [];
  const aoEnviar = async (original) => {
    const msg = JSON.parse(JSON.stringify(original));
    if (msg.action === 'crmLead') return { ok: true, configurado: true, encontrado: true, ficha: FICHA, coach: false, automacao: true, podeResponder: false, marca: SEM_MARCA, abordagens: ASSINATURAS, contato };
    if (msg.action === 'abordagem') {
      pedidos.push(msg);
      return { ok: true, contato: { abordagem: msg.abordagem || (contato && contato.abordagem) || '', respondeu: msg.respondeu === true } };
    }
    return { ok: true };
  };
  const p = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar, intervaloRapido: true });
  montarWhatsApp(p, conversa, { contato: '+55 71 99999-8888', idsSimples: true });
  return { p, pedidos, etiquetas: () => { const el = p.document.getElementById('cr-etiquetas'); return el ? el.textContent : ''; } };
}
const abertas = [];
test.afterEach(() => abertas.splice(0).forEach((p) => p.fechar()));
const PRIMEIRO_CONTATO_B = abordagens.PADRAO[1].mensagens.map((m) => ({ from: 'eu', texto: preencher(m) }));

test('extensão: reconhece a abordagem ao abrir a conversa, mostra a etiqueta e avisa só a letra', async () => {
  const x = extensao(PRIMEIRO_CONTATO_B, { abordagem: '', respondeu: false });
  abertas.push(x.p);
  await esperar(() => x.pedidos.length === 1, { motivo: 'abordagem enviada' });
  assert.deepEqual(x.pedidos[0], { action: 'abordagem', telefone: '5571999998888', nome: '+55 71 99999-8888', abordagem: 'B' });
  await esperar(() => /ABORDAGEM B/.test(x.etiquetas()), { motivo: 'etiqueta no cartão' });
  await dormir(120);
  assert.equal(x.pedidos.length, 1, 'não reenvia a cada tique');
});

test('extensão: o lead respondeu — avisa "respondeu" junto; lead que já tinha abordagem não é reenviado', async () => {
  const respondida = PRIMEIRO_CONTATO_B.concat([{ from: 'eles', texto: 'Vou começar do zero' }]);
  const x = extensao(respondida, { abordagem: '', respondeu: false });
  abertas.push(x.p);
  await esperar(() => x.pedidos.length === 1, { motivo: 'abordagem + resposta' });
  assert.deepEqual([x.pedidos[0].abordagem, x.pedidos[0].respondeu], ['B', true]);

  // já anotada (aberta de novo depois): só o "respondeu" que faltava
  const y = extensao(respondida, { abordagem: 'B', respondeu: false });
  abertas.push(y.p);
  await esperar(() => y.pedidos.length === 1, { motivo: 'só a resposta' });
  assert.deepEqual(y.pedidos[0], { action: 'abordagem', telefone: '5571999998888', nome: '+55 71 99999-8888', respondeu: true });

  // tudo já anotado: nada é enviado
  const z = extensao(respondida, { abordagem: 'B', respondeu: true });
  abertas.push(z.p);
  await esperar(() => /ABORDAGEM B/.test(z.etiquetas()), { motivo: 'etiqueta' });
  await dormir(150);
  assert.equal(z.pedidos.length, 0);
});

test('extensão: conversa que não usa nenhuma abordagem não é contada', async () => {
  const x = extensao([{ from: 'eu', texto: 'Oi, tudo bem?' }, { from: 'eles', texto: 'Tudo' }], { abordagem: '', respondeu: false });
  abertas.push(x.p);
  await esperar(() => !!x.p.document.getElementById('cr-ficha-crm'), { motivo: 'cartão' });
  await dormir(200);
  assert.equal(x.pedidos.length, 0);
  assert.doesNotMatch(x.etiquetas(), /ABORDAGEM/);
});

test('background: a anotação vai para /api/lead/abordagem só com a letra e o "respondeu"', async () => {
  const chamadas = [];
  let listener = null;
  const chrome = {
    storage: { local: { get: (padrao, cb) => cb(Object.assign({}, padrao, { chave: 'pnx_abc', server: 'https://report-pronix.vercel.app' })) } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
  };
  const fetchFalso = async (url, opts) => { chamadas.push({ url, corpo: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, contato: { abordagem: 'B', respondeu: true } }) }; };
  vm.runInNewContext(fs.readFileSync(path.join(RAIZ, 'extension/background.js'), 'utf8'), { chrome, fetch: fetchFalso, URL, JSON, Promise, console, AbortSignal });
  const r = await new Promise((resolve) => listener({ action: 'abordagem', telefone: '5571999998888', nome: 'Lead', abordagem: 'B', respondeu: true, mensagens: ['não deve ir'] }, {}, (x) => resolve(JSON.parse(JSON.stringify(x)))));
  assert.deepEqual(r, { ok: true, contato: { abordagem: 'B', respondeu: true } });
  assert.equal(chamadas[0].url, 'https://report-pronix.vercel.app/api/lead/abordagem');
  assert.deepEqual(chamadas[0].corpo, { telefone: '5571999998888', nome: 'Lead', abordagem: 'B', respondeu: true });
});

test('o script do painel não tem erro de sintaxe (um erro ali deixa a tela inteira sem funcionar)', () => {
  const html = fs.readFileSync(path.join(RAIZ, 'public/dashboard.html'), 'utf8');
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocos.length >= 2);
  blocos.forEach((codigo) => assert.doesNotThrow(() => new vm.Script(codigo)));
});
