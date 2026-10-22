'use strict';
// O servidor falando com o PronixCRM (crm.pronixhub.com.br), a cópia da API v1 do RD. CRM SIMULADO, banco
// em pasta temporária, leads inventados. Prova o que difere do RD: token no cabeçalho, negociações do contato
// em /deals?contact_id, etapa por POST /stage com a versão e perda por POST /lost.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pronixcrm-'));
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;
delete process.env.CRM_MOVER_ETAPA;

const crm = require('../src/crm');
const limpeza = require('../src/limpezaRd');

const FUNIL = {
  _id: 'f-mql', id: 'f-mql', name: 'Funil MQL',
  deal_stages: [
    { id: 'e-contato', name: 'Contato iniciado', order: 1, eh_perdido: false },
    { id: 'e-respondeu', name: 'Respondeu', order: 2, eh_perdido: false },
    { id: 'e-desq', name: 'Desqualificado', order: 3, eh_perdido: true },
  ],
};
const CONTATO = { id: 'c1', _id: 'c1', name: 'Marcos Teste', emails: [], phones: [{ phone: '(71) 99999-8888' }] };
const DEAL = (extra = {}) => ({
  id: 'd1', _id: 'd1', name: 'PRXC | Marcos Teste', win: null, closed_at: null, versao: 7, created_at: '2026-10-01T12:00:00.000Z', updated_at: '2026-10-20T12:00:00.000Z',
  deal_stage: { id: 'e-contato', name: 'Contato iniciado' }, deal_pipeline: { id: 'f-mql', name: 'Funil MQL' }, user: { id: 'u-caua', name: 'Cauã Lima' },
  contacts: [CONTATO], deal_custom_fields: [{ custom_field_id: 'cf1', label: 'Profissão', value: 'Empresário', custom_field: { id: 'cf1', label: 'Profissão' } }], ...extra,
});

const pedidos = [];
let estado = DEAL();
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== 'crm.pronixhub.com.br') throw new Error('chamada externa inesperada: ' + u.href);
  const corpo = opts.body ? JSON.parse(opts.body) : null;
  pedidos.push({ metodo: opts.method || 'GET', caminho: u.pathname.replace('/api/v1', ''), query: Object.fromEntries(u.searchParams), auth: (opts.headers || {}).Authorization, corpo });
  const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
  const p = u.pathname.replace('/api/v1', '');
  // a lista do PronixCRM acha pelo telefone, mas vem sem "deals", sem telefones e sem e-mails: o detalhe completa
  if (p === '/contacts' && u.searchParams.get('phone')) return ok({ contacts: [{ ...CONTATO, phones: [], emails: [] }] });
  if (p === '/contacts/c1') return ok({ contact: { ...CONTATO, contact_custom_fields: [{ custom_field_id: 'cc1', value: 'Bahia' }] } });
  if (p === '/deals' && u.searchParams.get('contact_id') === 'c1') return ok({ deals: [DEAL({ id: 'd1', _id: 'd1' }), DEAL({ id: 'd0', _id: 'd0', win: false, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' })] });
  if (p === '/deals/d1' && (opts.method || 'GET') === 'GET') return ok(estado);
  if (p === '/deals/d0') return ok(DEAL({ id: 'd0', _id: 'd0', win: false }));
  if (p === '/deals/d1/stage') {
    if (corpo.versao !== estado.versao) return ok({ codigo: 'CONFLITO_VERSAO', mensagem: 'A versão enviada não é a atual: releia e refaça.' }, 409);
    estado = { ...estado, versao: estado.versao + 1, deal_stage: { id: corpo.deal_stage_id, name: 'Respondeu' } };
    return ok(estado);
  }
  if (p === '/deals/d1/lost') {
    estado = { ...estado, win: false, versao: estado.versao + 1, ...(corpo.deal_stage_id ? { deal_stage: { id: corpo.deal_stage_id, name: 'Desqualificado' } } : {}) };
    return ok({ ok: ['d1'], falhas: [] });
  }
  // /activities do PronixCRM ignora o deal_id: devolve as de TODAS as negociações (aqui, o formulário de outro lead)
  if (p === '/activities') return ok({ activities: [{ deal_id: 'outro', text: 'Faturamento: Acima de R$200 mil\nERP: Bling\nDificuldades: estoque', date: '2026-09-01T12:00:00.000Z' }] });
  if (p === '/deals/d1/activities') return ok({ activities: [{ deal_id: 'd1', text: 'Profissão: Empresário\nInvestimento: + de R$5.000', date: '2026-10-01T12:00:00.000Z' }] });
  if (p === '/users') return ok({ users: [{ id: 'u-caua', name: 'Cauã Lima' }] });
  if (p === '/custom_fields') return ok({ custom_fields: [{ id: 'cc1', label: 'Estado' }] });
  if (p === '/deal_pipelines') return ok([FUNIL]);
  if (p === '/deal_lost_reasons') return ok({ deal_lost_reasons: [{ id: 'm1', name: 'Nunca Respondeu (SDR)', type: 'perda' }] });
  return ok({ codigo: 'NAO_ENCONTRADO', mensagem: 'não existe' }, 404);
};
test.after(() => { global.fetch = fetchReal; fs.rmSync(DADOS, { recursive: true, force: true }); });

test('token "pcrm_": o servidor fala com o PronixCRM, com o token no cabeçalho e nunca na URL', async () => {
  assert.equal(crm.ehPronix(), true);
  assert.equal(crm.linkDoCard('d1'), 'https://crm.pronixhub.com.br/#/deals/d1');
  pedidos.length = 0;
  await crm.rd('/users');
  assert.equal(pedidos[0].auth, 'Bearer pcrm_token_de_teste');
  assert.equal(pedidos[0].query.token, undefined, 'o token não vai na query string');
});

test('ficha do lead pelo telefone: as negociações vêm de /deals?contact_id e o card aberto é o escolhido', async () => {
  pedidos.length = 0;
  const r = await crm.consultarLead({ telefone: '5571999998888' }, { semCache: true });
  assert.equal(r.encontrado, true, JSON.stringify(r));
  assert.equal(r.ficha.negociacao.etapa, 'Contato iniciado');
  assert.equal(r.ficha.negociacao.url, 'https://crm.pronixhub.com.br/#/deals/d1');
  assert.deepEqual(r.ficha.negociacoes.map((c) => [c.id, c.escolhida]), [['d1', true], ['d0', false]]);
  assert.ok(r.ficha.formulario.campos.some((c) => c.rotulo === 'Profissão' && c.valor === 'Empresário'));
  assert.ok(!r.ficha.formulario.campos.some((c) => c.rotulo === 'Faturamento'), 'o formulário de outro lead não entra (era o "Fat. R$ 200k+" errado)');
  assert.ok(pedidos.some((x) => x.caminho === '/deals/d1/activities') && !pedidos.some((x) => x.caminho === '/activities'), 'atividades pela rota da negociação');
  assert.equal(r.ficha.crmNome, 'Pronix CRM');
  assert.ok(r.ficha.campos.some((c) => c.rotulo === 'Estado' && c.valor === 'Bahia'), 'campos do contato vêm do detalhe { contact }');
  assert.ok(pedidos.some((x) => x.caminho === '/deals' && x.query.contact_id === 'c1'));
});

test('"Respondeu" automático: POST /deals/:id/stage com a versão lida', async () => {
  estado = DEAL();
  pedidos.length = 0;
  const r = await crm.moverParaRespondeu({ telefone: '5571999998888' });
  assert.deepEqual(r, { movido: true, de: 'Contato iniciado', para: 'Respondeu' });
  const escrita = pedidos.find((x) => x.metodo === 'POST');
  assert.deepEqual([escrita.caminho, escrita.corpo], ['/deals/d1/stage', { deal_stage_id: 'e-respondeu', versao: 7 }]);
  assert.equal(pedidos.some((x) => x.metodo === 'PUT'), false, 'nada de PUT com deal_stage_id (o PronixCRM recusa)');
});

test('Desqualificar: POST /deals/:id/lost com a versão, o motivo e a etapa de perda; SDR não se grava; desfazer explica', async () => {
  estado = DEAL();
  pedidos.length = 0;
  const r = await limpeza.desqualificarCard({ usuario: { id: 'u1', nome: 'Cauã Lima' }, dealId: 'd1', motivoId: 'm1' });
  assert.deepEqual(r, { motivo: 'Nunca Respondeu (SDR)', etapa: 'Desqualificado', dealId: 'd1' });
  const escrita = pedidos.find((x) => x.metodo === 'POST');
  assert.deepEqual([escrita.caminho, escrita.corpo], ['/deals/d1/lost', { versao: 7, deal_lost_reason_id: 'm1', deal_stage_id: 'e-desq' }]);
  await assert.rejects(limpeza.desfazer({ usuario: { id: 'u1', nome: 'Cauã Lima' }, ids: ['d1'] }), /reabrir uma negociação perdida é pela tela do CRM/);
});

test('o CRM recusou: a mensagem dele chega a quem usa', async () => {
  estado = DEAL({ versao: 9 });
  await assert.rejects(crm.mudarEtapa({ id: 'd1', versao: 3 }, 'e-respondeu'), /O CRM não aceitou: A versão enviada não é a atual/);
});

test('listas no PronixCRM: percorre pelo cursor e guarda o detalhe por id + updated_at (só relê o que mudou)', async () => {
  const antes = global.fetch;
  const leituras = [];
  global.fetch = async (url) => {
    const u = new URL(String(url));
    const p = u.pathname.replace('/api/v1', '');
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (p === '/deals') {
      const cursor = u.searchParams.get('cursor');
      const pagina = (n, desde) => Array.from({ length: n }, (_, i) => ({ id: 'x' + (desde + i), updated_at: '2026-10-20T10:00:00.000Z' }));
      return ok(cursor ? { deals: pagina(5, 200), proximo_cursor: null } : { deals: pagina(200, 0), proximo_cursor: 'c2' });
    }
    leituras.push(p);
    return ok({ id: p.split('/').pop(), versao: 1 });
  };
  try {
    const lista = await crm.listarNegociacoes({ sdr_id: 'u1' });
    assert.equal(lista.length, 205, 'as duas páginas');
    const primeira = await crm.detalhesDe(lista.slice(0, 3));
    assert.deepEqual([primeira.length, leituras.length], [3, 3]);
    await crm.detalhesDe(lista.slice(0, 3));
    assert.equal(leituras.length, 3, 'a 2ª vez vem do guardado');
    await crm.detalhesDe([{ id: 'x0', updated_at: '2026-10-21T09:00:00.000Z' }]);
    assert.equal(leituras.length, 4, 'mudou (updated_at novo): relê');
  } finally {
    global.fetch = antes;
  }
});
