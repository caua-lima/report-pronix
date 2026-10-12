'use strict';
// Diagnóstico das automações ("Respondeu" no RD e cor na agenda): só confere, nunca altera.
// RD e Google simulados; banco em pasta temporária.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-diag-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'tok-rd',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_MOVER_ETAPA;
delete process.env.CRM_ETAPA_RESPONDEU;

const app = require('../server');
const db = require('../src/db');
const crm = require('../src/crm');
const agendaGoogle = require('../src/agendaGoogle');
const diagnostico = require('../src/diagnostico');
test.after(() => fs.rmSync(DADOS, { recursive: true, force: true }));

// ---------------------------------------------------------------- o que o RD e o Google "respondem"
let rd;
let google;
function tudoCerto() {
  rd = { configurado: true, usuarios: [{ id: 'u1', nome: 'Cauã Lima' }], funis: [{ id: 'f1', nome: 'SMQLs automáticas', etapas: [{ id: 'e1', nome: 'Contato iniciado', ordem: 0 }, { id: 'e2', nome: 'Respondeu', ordem: 1 }] }], erro: null };
  google = { configurado: true, conectado: true, conectadoEm: '2026-10-12T12:00:00.000Z', agendas: ['Cauã Lima', 'Closer Um'], alteraEventos: true, soLeitura: [], ultimaPintura: null };
}
let escritas = 0;
crm.configurado = () => rd.configurado;
crm.usuariosRd = async () => { if (rd.erro) throw new Error(rd.erro); return rd.usuarios; };
crm.funis = async () => rd.funis;
crm.rd = async () => { escritas++; throw new Error('o diagnóstico não pode chamar o RD direto'); };
agendaGoogle.status = async () => google;
const EU = { id: 'meu', nome: 'Cauã Lima', automacao: true, fichaCrm: true, corAgenda: '5' };
const item = (d, grupo, nome) => d.itens.find((i) => i.grupo === grupo && i.nome === nome);
test.beforeEach(() => { tudoCerto(); escritas = 0; });

test('tudo no lugar, mas ainda sem nenhuma vez de verdade: "pronto", não "comprovado"', async () => {
  const d = await diagnostico.rodar(EU);
  assert.deepEqual(d.respondeu, { pronto: true, comprovado: false, falhas: 0 });
  assert.deepEqual(d.cor, { pronto: true, comprovado: false, falhas: 0 });
  assert.equal(item(d, 'respondeu', 'Etapa "Respondeu" no funil').detalhe, 'Funis com a etapa: SMQLs automáticas.');
  assert.equal(item(d, 'cor', 'Sua cor na agenda').detalhe, 'Banana (cor 5).');
  // a prova ainda não existe: vira aviso (nem ok, nem falta), com o que fazer para acontecer
  const semProva = item(d, 'respondeu', 'Último card movido de verdade');
  assert.deepEqual([semProva.ok, semProva.detalhe], [null, 'Este sistema ainda não moveu nenhum card.']);
  assert.match(semProva.resolver, /abra no WhatsApp/);
  assert.equal(item(d, 'cor', 'Última reunião pintada de verdade').ok, null);
  assert.ok(d.itens.filter((i) => i.ok === true).every((i) => i.resolver === ''), 'item ok não traz "como resolver"');
  assert.equal(escritas, 0, 'o diagnóstico só confere');
});

test('quando já aconteceu de verdade: mostra o último card movido e a última reunião pintada', async () => {
  await db.push('crm_movimentos', { quando: '2026-10-12T15:30:00.000Z', card: 'd1', de: 'Contato iniciado', para: 'Respondeu', por: 'Cauã Lima' }, 500);
  google.ultimaPintura = { em: '2026-10-12T16:00:00.000Z', resultado: 'pintado', motivo: '', agenda: 'Closer Um' };
  const d = await diagnostico.rodar(EU);
  assert.deepEqual([d.respondeu.comprovado, d.cor.comprovado], [true, true]);
  assert.match(item(d, 'respondeu', 'Último card movido de verdade').detalhe, /^12\/10\/2026,? 12:30: de "Contato iniciado" para "Respondeu", por Cauã Lima\. \(1 no registro\.\)$/);
  assert.match(item(d, 'cor', 'Última reunião pintada de verdade').detalhe, /pintou uma reunião na agenda Closer Um\.$/);
});

test('o que falta aparece como "falta", com o que fazer', async () => {
  rd.funis = [{ id: 'f1', nome: 'Funil', etapas: [{ id: 'e1', nome: 'Entrada', ordem: 0 }] }];
  rd.erro = 'O RD Station CRM recusou o token (confira RDSTATION_CRM_TOKEN na Vercel).';
  process.env.CRM_MOVER_ETAPA = '0';
  Object.assign(google, { alteraEventos: false, soLeitura: ['Cauã Lima', 'Closer Um'], ultimaPintura: { em: '2026-10-12T16:00:00.000Z', resultado: 'sem-permissao', motivo: 'conexao', agenda: 'Closer Um' } });
  const d = await diagnostico.rodar({ ...EU, automacao: false, fichaCrm: false, corAgenda: '' });
  delete process.env.CRM_MOVER_ETAPA;
  const faltas = (grupo) => d.itens.filter((i) => i.grupo === grupo && i.ok === false).map((i) => i.nome);
  assert.deepEqual(faltas('respondeu'), ['O RD aceita o token', 'Etapa "Respondeu" no funil', 'Escrita no RD ligada', 'Sua Automação RD', 'Seu Popup do lead']);
  assert.deepEqual(faltas('cor'), ['A conexão pode alterar eventos', 'Agendas que você pode editar', 'Sua cor na agenda', 'Sua Automação RD', 'Última reunião pintada de verdade']);
  assert.deepEqual([d.respondeu.pronto, d.respondeu.falhas, d.cor.pronto, d.cor.falhas], [false, 5, false, 5]);
  assert.match(item(d, 'respondeu', 'Sua Automação RD').resolver, /Acessos → clique no seu nome/);
  assert.match(item(d, 'cor', 'A conexão pode alterar eventos').resolver, /Conectar de novo/);
  assert.match(item(d, 'cor', 'Última reunião pintada de verdade').detalhe, /o Google recusou \(agenda Closer Um\): a conexão não pode alterar eventos\./);

  // sem token do RD: nem tenta falar com o RD
  tudoCerto();
  rd.configurado = false;
  const semToken = await diagnostico.rodar(EU);
  assert.equal(item(semToken, 'respondeu', 'Token do RD no servidor').ok, false);
  assert.equal(item(semToken, 'respondeu', 'O RD aceita o token'), undefined);
  // Google sem conexão: os itens que dependem dela não aparecem
  google = { configurado: true, conectado: false, agendas: [] };
  const semGoogle = await diagnostico.rodar(EU);
  assert.equal(item(semGoogle, 'cor', 'Conta do Google conectada').ok, false);
  assert.equal(item(semGoogle, 'cor', 'A conexão pode alterar eventos'), undefined);
});

test('agenda só para ver em parte das agendas é aviso; quem entrou só com a senha não tem permissões para conferir', async () => {
  google.soLeitura = ['Closer Um'];
  const d = await diagnostico.rodar(null);
  const ag = item(d, 'cor', 'Agendas que você pode editar');
  assert.deepEqual([ag.ok, ag.detalhe], [null, '2 agenda(s) à vista; só para VER (a cor não muda nelas): Closer Um.']);
  assert.equal(item(d, 'respondeu', 'Suas permissões').ok, null);
  assert.equal(item(d, 'cor', 'Sua cor e permissões').ok, null);
  assert.equal(item(d, 'cor', 'Sua cor na agenda'), undefined);
  assert.equal(d.cor.pronto, true, 'aviso não conta como falha');
});

test('rota: só o master', async () => {
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const admin = { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' };
    const criar = async (nome, papel) => (await (await fetch(base + '/api/admin/usuarios', { method: 'POST', headers: admin, body: JSON.stringify({ nome, papel }) })).json()).usuario;
    const master = await criar('Cauã Lima', 'master');
    const sdr = await criar('Bia SDR', 'sdr');
    const ver = async (u) => { const r = await fetch(base + '/api/master/diagnostico', { headers: { 'x-cr-key': u.chave } }); return { status: r.status, json: await r.json() }; };
    assert.equal((await ver(sdr)).status, 403);
    const r = await ver(master);
    assert.equal(r.status, 200);
    // o master novo já vem com automação, popup do lead e a cor Banana: nada falta do lado dele
    assert.deepEqual(['Sua Automação RD', 'Seu Popup do lead'].map((n) => r.json.itens.find((i) => i.grupo === 'respondeu' && i.nome === n).ok), [true, true]);
    assert.equal(r.json.itens.find((i) => i.nome === 'Sua cor na agenda').detalhe, 'Banana (cor 5).');
  } finally {
    await new Promise((r) => servidor.close(r));
  }
});
