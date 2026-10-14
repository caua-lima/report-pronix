'use strict';
// Trazer do Report Closer: os reports exportados de lá entram aqui com o closer, o resultado, a venda e o
// PDF — só os do próprio usuário, sem duplicar. Banco em pasta temporária, leads inventados.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-importar-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.RDSTATION_CRM_TOKEN;

const app = require('../server');
const stats = require('../src/stats');
const closers = require('../src/closers');
const { mesmoLead } = require('../src/importarReports');

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
  E.master = await criar('Cauã Lima', 'master');
  E.sdr = await criar('Bia SDR', 'sdr');
  E.ph = await closers.criar('Paulo Henrique');
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  fs.rmSync(DADOS, { recursive: true, force: true });
});
const chamar = async (metodo, rota, corpo, u = E.master) => {
  const r = await fetch(base + rota, { method: metodo, headers: { 'Content-Type': 'application/json', 'x-cr-key': u.chave }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const pdf = (texto) => ({ arquivo: 'Report_Lead.pdf', base64: Buffer.from('%PDF-1.3 ' + texto).toString('base64') });

test('importar do Report Closer: a venda do PH entra com closer, ticket, data e PDF; de outro SDR, repetida ou inválida fica de fora', async () => {
  // já existe aqui um report do mesmo lead, gerado nos dois sistemas
  await stats.registrar({ id: 'aqui1', usuarioId: E.master.id, usuarioNome: E.master.nome, lead: 'Lead Duplicado Fictício', contato: 'Lead Duplicado Fictício', origem: 'extensao' });
  const ontem = new Date(Date.now() - 86400000).toISOString();
  const reports = [
    {
      id: 'a1b2c3', lead: 'Lead Vendido Fictício', contato: '+55 11 98888-0001', usuarioNome: 'Cauã Lima', quando: '2026-10-07T14:00:00.000Z', dia: '2026-10-07',
      perfil: 'analitico', consciencia: 'pronto', closerNome: 'Paulo Henrique Pagoti', resultado: 'venda_call', ticket: 18624, produto: 'performance',
      pagamento: 'Cartão 12x', dataFechamento: '2026-10-07', vendidoNoRd: '2026-10-07T20:00:00.000Z', leadEmail: 'lead.vendido@exemplo.com', pdf: pdf('vendido'),
    },
    { id: 'outro1', lead: 'Lead da Bia', contato: 'Lead da Bia', usuarioNome: 'Bia SDR', quando: ontem, resultado: 'venda_call', closerNome: 'Paulo Henrique', pdf: pdf('bia') },
    { id: 'dup001', lead: 'Lead Duplicado Fictício', contato: 'Lead Duplicado Fictício', usuarioNome: 'Cauã', quando: ontem, resultado: 'venda_fup', closerNome: 'Paulo Henrique' },
    { id: 'x', lead: 'Sem id válido', usuarioNome: 'Cauã Lima', quando: ontem },
    { id: 'semPdf1', lead: 'Lead Sem PDF', contato: 'Lead Sem PDF', usuarioNome: 'Cauã Lima', quando: ontem, resultado: 'venda_fup', closerNome: 'Closer Que Não Existe', pdf: { arquivo: 'x.pdf', base64: Buffer.from('nao e pdf').toString('base64') } },
  ];
  let r = await chamar('POST', '/api/master/importar-reports', { formato: 'report-closer/1', reports });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.importados, r.json.jaEstavam, r.json.deOutroSdr, r.json.invalidos, r.json.comPdf], [2, 1, 1, 1, 1]);

  const novo = await stats.buscarPorId('rca1b2c3');
  assert.deepEqual(
    [novo.usuarioId, novo.usuarioNome, novo.quando, novo.dia, novo.closerId, novo.closerNome, novo.resultado, novo.ticket, novo.produto, novo.pagamento, novo.origem, novo.leadEmail, novo.custo],
    [E.master.id, 'Cauã Lima', '2026-10-07T14:00:00.000Z', '2026-10-07', E.ph.id, 'Paulo Henrique', 'venda_call', 18624, 'performance', 'Cartão 12x', 'report-closer', 'lead.vendido@exemplo.com', 0],
  );
  assert.equal((await stats.buscarPorId('rcsemPdf1')).closerId, '', 'closer que não está no cadastro daqui fica em branco (o RD preenche depois)');

  // aparece em Resultados no dia dele, e o PDF abre
  const res = await chamar('GET', '/api/master/resultados?de=2026-10-07&ate=2026-10-07&escopo=meus');
  assert.ok(res.json.reports.some((x) => x.id === 'rca1b2c3' && x.closerId === E.ph.id && x.resultado === 'venda_call'));
  const p = await chamar('GET', '/api/reports/rca1b2c3/pdf');
  assert.equal(Buffer.from(p.json.arquivoBase64, 'base64').toString(), '%PDF-1.3 vendido');
  assert.equal((await chamar('GET', '/api/reports/rcsemPdf1/pdf')).status, 404, 'o que não era PDF não foi guardado');

  // importar de novo não duplica
  r = await chamar('POST', '/api/master/importar-reports', { formato: 'report-closer/1', reports: [reports[0]] });
  assert.deepEqual([r.json.importados, r.json.jaEstavam], [0, 1]);
  // arquivo errado, lote grande demais e quem não é master
  assert.equal((await chamar('POST', '/api/master/importar-reports', { formato: 'outro', reports: [] })).status, 400);
  assert.equal((await chamar('POST', '/api/master/importar-reports', { formato: 'report-closer/1', reports: Array(11).fill(reports[0]) })).status, 400);
  assert.equal((await chamar('POST', '/api/master/importar-reports', { formato: 'report-closer/1', reports }, E.sdr)).status, 403);
});

test('o mesmo lead: mesmo nome ou o mesmo telefone, com até 3 dias de diferença', () => {
  const r = (lead, contato, quando) => ({ lead, contato, quando });
  assert.equal(mesmoLead(r('Ana Souza', '', '2026-10-01T10:00:00Z'), r('ana souza', '', '2026-10-03T10:00:00Z')), true);
  assert.equal(mesmoLead(r('Ana Souza', '', '2026-10-01T10:00:00Z'), r('Ana Souza', '', '2026-10-09T10:00:00Z')), false, 'longe demais: outra negociação');
  assert.equal(mesmoLead(r('Ana', '+55 11 97777-1234', '2026-10-01T10:00:00Z'), r('Outro nome', '11977771234', '2026-10-02T10:00:00Z')), true);
  assert.equal(mesmoLead(r('Ana', '', '2026-10-01T10:00:00Z'), r('Bruno', '', '2026-10-01T10:00:00Z')), false);
});
