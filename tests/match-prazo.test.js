'use strict';
// Match com o closer com o CRM LENTO (dados inventados): o pedido tem de responder dentro do orçamento (a Vercel corta
// em 60 s e a tela só mostrava "Falha na requisição."), dizer o que faltou e continuar de onde parou na rodada seguinte.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-match-prazo-'));
const TIME = ['Ana Teste', 'Bruno Teste', 'Carla Teste', 'Davi Teste', 'Eva Teste', 'Fabio Teste', 'Gil Teste', 'Hugo Teste'];
Object.assign(process.env, {
  CR_DATA_DIR: DADOS, ADMIN_PASSWORD: 'senha-de-teste', RDSTATION_CRM_TOKEN: 'pcrm_token_de_teste',
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
  MATCH_SDRS_TIME: TIME.join(', '),
  // orçamento em escala de teste: 2 s no total, 0,8 s reservados para o detalhe, 0,3 s de folga
  MATCH_ORCAMENTO_MS: '2000', MATCH_RESERVA_DETALHE_MS: '800', MATCH_FOLGA_MS: '300',
});
delete process.env.VERCEL;
delete process.env.CRM_API_URL;
delete process.env.CRM_API_TOKEN;
delete process.env.MATCH_DESDE;

const match = require('../src/matchCloser');

const etapa = (id, name, order, categoria) => ({ id, _id: id, name, order, categoria, eh_perdido: categoria === 'perda', eh_ganho: categoria === 'venda', exige_closer: false });
const FUNIS = [
  { id: 'f-clo', _id: 'f-clo', name: 'Closers', deal_stages: [etapa('c-agend', 'Reunião Agendada', 1, 'reuniao_agendada'), etapa('c-real', 'Reunião Realizada', 2, 'reuniao_realizada'), etapa('c-vend', 'Vendido', 3, 'venda')] },
  { id: 'f-smql', _id: 'f-smql', name: 'SMQLs', deal_stages: [etapa('s-agendou', 'Agendou', 1, 'reuniao_agendada'), etapa('s-call', 'Call feita', 2, 'reuniao_realizada')] },
];
const PH = { id: 'u-ph', name: 'Paulo Henrique Pagoti' };
const USUARIOS = [{ id: 'u-caua', name: 'Cauã Lima' }, PH].concat(TIME.map((n, i) => ({ id: 'u-' + i, name: n })));
// cada SDR tem uma venda com o PH no funil Closers
const CARDS = Object.fromEntries(USUARIOS.filter((u) => u.id !== 'u-ph').map((u) => [`v-${u.id}`, {
  id: `v-${u.id}`, _id: `v-${u.id}`, name: `Lead de ${u.name}`, win: true, closed_at: '2026-07-10T18:00:00.000Z', created_at: '2026-07-01T12:00:00.000Z', updated_at: '2026-07-10T18:00:00.000Z',
  deal_pipeline: { id: 'f-clo', name: 'Closers' }, deal_stage: { id: 'c-vend', name: 'Vendido' }, user: PH, sdr: { id: u.id, name: u.name },
  deal_custom_fields: [], deal_products: [], amount_total: 1000,
  deal_stage_histories: [{ deal_stage_id: 'c-real', deal_stage_name: 'Reunião Realizada', start_date: '2026-07-05T15:00:00.000Z' }],
}]));
let listagens = 0;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchReal = global.fetch;
global.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'crm.pronixhub.com.br') throw new Error('chamada externa inesperada: ' + u.href);
  const p = u.pathname.replace('/api/v1', '');
  const ok = (j, status = 200) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
  if (p === '/deal_pipelines') return ok(FUNIS);
  if (p === '/users') return ok({ users: USUARIOS });
  if (p === '/deals') {
    listagens++;
    await espera(450); // CRM lento: 9 SDRs x 2 funis = 18 listas não cabem no tempo das listas de uma rodada só
    const sdr = u.searchParams.get('sdr_id'), f = u.searchParams.get('deal_pipeline_id');
    return ok({ deals: Object.values(CARDS).filter((c) => c.sdr.id === sdr && c.deal_pipeline.id === f).map(({ deal_stage_histories, ...l }) => l) });
  }
  const m = p.match(/^\/deals\/([^/]+)(\/activities)?$/);
  if (m && m[2]) return ok({ activities: [] });
  if (m && CARDS[m[1]]) return ok(CARDS[m[1]]);
  return ok({ codigo: 'NAO_ENCONTRADO', mensagem: 'não existe' }, 404);
};
test.after(() => { global.fetch = fetchReal; fs.rmSync(DADOS, { recursive: true, force: true }); });

test('CRM lento: responde dentro do orçamento, diz o que faltou e completa nas rodadas seguintes', async () => {
  const pedido = { usuario: { id: 'eu', nome: 'Cauã Lima' }, closer: 'Paulo Henrique', atualizar: true };
  const t0 = Date.now();
  const primeira = await match.levantar(pedido);
  const levou = Date.now() - t0;
  assert.ok(levou < 2600, `a 1ª rodada respeita o orçamento de 2 s (levou ${levou} ms)`);
  assert.ok(primeira.diagnostico.pendentesDoCrm > 0, 'avisa que ainda falta ler (a tela continua sozinha)');
  assert.ok(primeira.reunioes.length < 9, 'a 1ª rodada não leu tudo');

  let r = primeira;
  for (let rodada = 0; rodada < 6 && r.diagnostico.pendentesDoCrm; rodada++) r = await match.levantar(pedido);
  assert.equal(r.diagnostico.pendentesDoCrm, 0, 'termina de ler');
  assert.equal(r.reunioes.filter((x) => x.venda).length, 9, 'as 9 vendas do time com o PH');
  assert.ok(listagens <= 18 + 4, `as listas prontas ficam guardadas entre as rodadas (${listagens} listagens)`);
});
