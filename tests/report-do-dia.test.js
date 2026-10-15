'use strict';
// Report automático do dia: a contagem das conversas (novos, respostas, recontatos), as desqualificações
// por motivo (RD + registro do sistema, sem contar duas vezes), o que é digitado e o texto pronto.
// RD SIMULADO, banco em pasta temporária, leads inventados.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-report-dia-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'tok-rd',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;

const app = require('../server');
const db = require('../src/db');
const crm = require('../src/crm');
const stats = require('../src/stats');
const usuarios = require('../src/usuarios');
const rel = require('../src/reportDoDia');

const HOJE = stats.hojeStr();
let rdPerdidas = [];
let rdFora = false;
crm.configurado = () => true;
crm.usuariosRd = async () => [{ id: 'rd1', nome: 'Cauã Lima' }, { id: 'rd2', nome: 'Samuel Filipe' }];
crm.rd = async (caminho, params = {}) => {
  if (caminho !== '/deals') throw new Error('chamada ao RD não prevista no teste: ' + caminho);
  if (rdFora) throw new Error('O RD Station CRM limitou as consultas. Tente de novo em 1 minuto.');
  assert.equal(params.user_id, 'rd1', 'só os cards do próprio usuário');
  assert.equal(params.win, 'false');
  return { deals: JSON.parse(JSON.stringify(rdPerdidas)), has_more: false };
};

let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ nome, papel }),
  })).json()).usuario;
  E.caua = await criar('Cauã Lima', 'sdr');
  E.sem = await criar('Sem Automacao', 'sdr');
  await usuarios.definirAutomacao(E.caua.id, true);
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  fs.rmSync(DADOS, { recursive: true, force: true });
});
const chamar = async (metodo, rota, corpo, u = E.caua) => {
  const r = await fetch(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', 'x-cr-key': u.chave }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const aviso = (telefone, eu, antes, eles, nome = '', elesAntes = false) => chamar('POST', '/api/atividade', { telefone, nome, eu, antes, eles, elesAntes });
const perdida = (id, motivo, closedAt = new Date().toISOString()) => ({ _id: id, win: false, closed_at: closedAt, deal_lost_reason: { name: motivo } });

test('contagem: novo = escrevi hoje sem histórico; recontato = escrevi hoje com histórico; resposta = o lead escreveu hoje; cada contato conta uma vez', async () => {
  // Ana: lead novo que respondeu. Bruno: lead novo que não respondeu. Carla: recontato. Diego: recontato que respondeu.
  assert.equal((await aviso('+55 71 99999-0001', true, false, false)).json.registrado, true);
  assert.equal((await aviso('(71) 99999-0001', true, false, true)).status, 200, 'o mesmo número escrito de outro jeito é o mesmo contato');
  await aviso('71999990002', true, false, false);
  await aviso('71999990003', true, true, false);
  await aviso('71999990004', true, true, false);
  await aviso('71999990004', false, false, true);
  // Eva: viu primeiro só o que havia hoje (histórico cortado) e depois o antigo: vira recontato, não novo
  await aviso('71999990005', true, false, false);
  await aviso('71999990005', true, true, false);
  // Gil: recontato em que o lead JÁ tinha escrito em outro dia e escreve de novo hoje: não é a primeira resposta
  await aviso('71999990011', true, true, true, '', true);
  // Hugo: recontato de lead que nunca tinha respondido e responde hoje pela primeira vez: conta
  await aviso('71999990012', true, true, true, '', false);
  // Fábio: sem telefone, pelo nome; conversa que só tem mensagem antiga não gera nada
  assert.equal((await aviso('', true, false, false, 'Fábio Souza')).json.registrado, true);
  assert.equal((await aviso('71999990009', false, true, false)).json.registrado, false);

  const c = await rel.contagemDoDia(E.caua.id, HOJE);
  assert.deepEqual([c.novos, c.recontatos, c.respostas, c.conversas], [3, 5, 3, 8], 'resposta = só a primeira vez que o lead responde (Ana, Diego e Hugo; Gil já tinha escrito antes)');
  // nada de telefone nem nome guardado
  const guardado = fs.readdirSync(DADOS).map((f) => fs.readFileSync(path.join(DADOS, f), 'utf8')).join('');
  for (const dado of ['99999-0001', '71999990001', '999990002', 'Fábio', 'Souza']) assert.ok(!guardado.includes(dado), 'ficou guardado: ' + dado);
  // sem a automação do cartão a extensão nem conta
  assert.equal((await aviso('71999990010', true, false, false)).status, 200);
  assert.equal((await chamar('POST', '/api/atividade', { telefone: '71999990010', eu: true }, E.sem)).status, 403);
  // e a contagem é de cada pessoa
  assert.equal((await rel.contagemDoDia(E.sem.id, HOJE)).conversas, 0);
});

test('desqualificados: perdas de hoje no RD por motivo, juntas com as do sistema sem repetir; as desfeitas não contam', async () => {
  rdPerdidas = [
    perdida('a1', 'Nunca Respondeu (SDR)'), perdida('a2', 'Nunca Respondeu (SDR)'), perdida('a3', 'Desistiu de vender no Mercado Livre'),
    perdida('a4', 'Parou de Responder (SDR/Closer)'),
    perdida('velha', 'Nunca Respondeu (SDR)', new Date(Date.now() - 3 * 86400000).toISOString()), // fechada em outro dia
    { _id: 'aberta', win: null, closed_at: null },
  ];
  // do sistema: a1 (também está no RD), s1 pelo botão, s2 desfeita, s3 de outra pessoa
  const em = new Date().toISOString();
  await db.push('rd_limpeza_log', { dealId: 'a1', motivo: 'Nunca respondeu', em, por: 'Cauã Lima', usuarioId: E.caua.id });
  await db.push('rd_limpeza_log', { dealId: 's1', motivo: 'Nicho com pouca demanda', em, por: 'Cauã Lima', usuarioId: E.caua.id });
  await db.push('rd_limpeza_log', { dealId: 's2', motivo: 'Número inválido', em, por: 'Cauã Lima', usuarioId: E.caua.id });
  await db.push('rd_limpeza_log', { dealId: 's2', desfeito: true, motivo: 'Número inválido', em, por: 'Cauã Lima', usuarioId: E.caua.id });
  await db.push('rd_limpeza_log', { dealId: 's3', motivo: 'Número inválido', em, por: 'Samuel Filipe', usuarioId: 'outro' });

  const d = await rel.desqualificadosDoDia(E.caua, HOJE);
  assert.deepEqual(d.motivos, [
    { motivo: 'Nunca Respondeu', qtd: 2 }, { motivo: 'Desistiu de vender no Mercado Livre', qtd: 1 }, { motivo: 'Nicho com pouca demanda', qtd: 1 }, { motivo: 'Parou de Responder', qtd: 1 },
  ].sort((a, b) => b.qtd - a.qtd || a.motivo.localeCompare(b.motivo)));
  assert.equal(d.total, 5);
  assert.equal(d.aviso, '');

  // RD fora do ar: vale o registro do sistema, e o aviso diz isso
  rdFora = true;
  try {
    const so = await rel.desqualificadosDoDia(E.caua, HOJE);
    assert.deepEqual(so.motivos, [{ motivo: 'Nicho com pouca demanda', qtd: 1 }, { motivo: 'Nunca respondeu', qtd: 1 }]);
    assert.match(so.aviso, /Não consegui ler as perdas no RD[\s\S]*só o que o sistema desqualificou/);
  } finally {
    rdFora = false;
  }
});

test('o texto sai no formato do fechamento, e só entra a seção que tem o que dizer', async () => {
  const contagem = { novos: 28, respostas: 16, recontatos: 53 };
  const completo = rel.montarTexto({
    nome: 'Cauã Lima', dia: '2026-10-14', contagem,
    manual: rel.manualLimpo({ automaticas: 11, realizadas: 4, agendasCaidas: 'Vivian às 9h30 - pediu pra remarcar\nLuiz às 9h30 - desistiu', noShow: 'Nelson às 15h30 confirmou e sumiu', extras: '- Oi Cauã, meu marido pediu para cancelar' }),
    desqualificados: { motivos: [{ motivo: 'Desistiu de vender no Mercado Livre', qtd: 7 }, { motivo: 'Número inválido', qtd: 2 }] },
  });
  assert.equal(completo, [
    'REPORT Cauã Lima | 14/10', '', '', '---------------------------------- ',
    'Automáticas: 11', 'Leads novos contatados: 28', 'Respostas: 16', 'Recontatos: 53', 'Realizadas: 4',
    '', 'Agendas que caíram:', '', 'Vivian às 9h30 - pediu pra remarcar', 'Luiz às 9h30 - desistiu',
    '', 'NO SHOW: ', '', 'Nelson às 15h30 confirmou e sumiu',
    '', 'Desqualificados:', '7x Desistiu de vender no Mercado Livre', '2x Número inválido', '- Oi Cauã, meu marido pediu para cancelar',
  ].join('\n'));
  const enxuto = rel.montarTexto({ nome: 'Cauã Lima', dia: '2026-10-14', contagem, manual: rel.manualLimpo(null), desqualificados: { motivos: [] } });
  assert.equal(enxuto, 'REPORT Cauã Lima | 14/10\n\n\n---------------------------------- \nLeads novos contatados: 28\nRespostas: 16\nRecontatos: 53');
  assert.deepEqual(rel.manualLimpo({ automaticas: '  ', realizadas: '-3', agendasCaidas: '  a  \r\n b ' }), { automaticas: null, realizadas: null, agendasCaidas: 'a\n b', noShow: '', extras: '' });
});

test('rotas: o dia vem com contagem, desqualificados e texto; o que se digita fica salvo por dia e por pessoa', async () => {
  rdPerdidas = [perdida('r1', 'Número inválido')];
  let r = await chamar('GET', '/api/report-dia');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.dia, r.json.contagem.novos, r.json.desqualificados.total], [HOJE, 4, 3]); // o RD (r1) e o registro do sistema (a1 e s1)
  assert.match(r.json.texto, /^REPORT Cauã Lima \| \d{2}\/\d{2}\n\n\n-{34} \nLeads novos contatados: 4\nRespostas: 3\nRecontatos: 5\n\nDesqualificados:\n/);

  r = await chamar('PUT', '/api/report-dia', { dia: HOJE, manual: { automaticas: 11, noShow: 'Nelson às 15h30' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.manual.automaticas, r.json.manual.noShow], [11, 'Nelson às 15h30']);
  assert.match(r.json.texto, /Automáticas: 11\nLeads novos contatados: 4[\s\S]*NO SHOW: \n\nNelson às 15h30/);
  r = await chamar('GET', '/api/report-dia?dia=' + HOJE);
  assert.equal(r.json.manual.automaticas, 11, 'ficou salvo');
  // outro dia e outra pessoa começam em branco
  r = await chamar('GET', '/api/report-dia?dia=2026-01-05');
  assert.deepEqual([r.json.manual.automaticas, r.json.contagem.conversas], [null, 0]);
  r = await chamar('GET', '/api/report-dia', undefined, E.sem);
  assert.deepEqual([r.json.manual.automaticas, r.json.contagem.conversas], [null, 0]);
  assert.equal((await fetch(base + '/api/report-dia')).status, 401);
});
