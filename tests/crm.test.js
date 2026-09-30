'use strict';
// Ficha do lead no RD Station CRM: API do RD simulada (formato da documentação oficial v1),
// banco em pasta temporária, sem rede e sem token real.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-crm-'));
const TOKEN = 'tok-teste-SECRETO-123';
Object.assign(process.env, {
  CR_DATA_DIR: DADOS,
  ADMIN_PASSWORD: 'senha-de-teste',
  RDSTATION_CRM_TOKEN: TOKEN,
  KV_REST_API_URL: '',
  KV_REST_API_TOKEN: '',
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  TZ_RELATORIO: 'America/Sao_Paulo',
});
delete process.env.VERCEL;

const app = require('../server');
const crm = require('../src/crm');

// ---------------------------------------------------------------- RD Station simulado
const MARCOS = {
  id: 'c1', name: 'Marcos Pereira',
  phones: [{ phone: '(71) 99999-8888', whatsapp_full_internacional: '+5571999998888' }],
  emails: [{ email: 'marcos@exemplo.com' }],
  deals: [{ id: 'd0', name: 'Marcos (2025)', closed_at: '2025-12-01T10:00:00Z', win: false }, { id: 'd1', name: 'Marcos Pereira', closed_at: null, win: null }],
  contact_custom_fields: [{ custom_field_id: 'cf1', value: 'Salvador' }],
};
const OUTRO = { id: 'c9', name: 'Outra Pessoa', phones: [{ phone: '(11) 91234-5678' }], deals: [] };
const ARMANDO = { id: 'c8', name: 'Armando Moretti Filho', phones: [{ phone: '(15) 99767-1347' }], deals: [{ id: 'd9', closed_at: null, win: null }], contact_custom_fields: [] };
const ANA1 = { id: 'c2', name: 'Ana Souza', phones: [{ phone: '(21) 98888-1111' }], deals: [] };
const ANA2 = { id: 'c3', name: 'Ana Lima', phones: [{ phone: '(31) 97777-2222' }], deals: [] };

const chamadasRd = [];
let rdStatus = 200;
const fetchReal = global.fetch;
global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return fetchReal(url, opts);
  if (u.hostname !== 'crm.rdstation.com') throw new Error('chamada externa inesperada: ' + u.hostname);
  assert.equal(u.searchParams.get('token'), TOKEN, 'toda chamada ao RD leva o token');
  chamadasRd.push(u.pathname + '?' + [...u.searchParams].filter(([k]) => k !== 'token').map(([k, v]) => `${k}=${v}`).join('&'));
  const json = (corpo, status = rdStatus) => ({ ok: status < 400, status, json: async () => corpo });
  if (rdStatus !== 200) return json({ error: 'x' });
  const p = u.pathname.replace('/api/v1', '');
  if (p === '/contacts') {
    const phone = u.searchParams.get('phone');
    const q = u.searchParams.get('q');
    // O RD simulado devolve OUTRA pessoa pelo número formatado e só acha o Marcos pelos dígitos
    // (o servidor tem que conferir o telefone e não pegar a errada).
    if (phone === '(71) 99999-8888') return json({ contacts: [OUTRO], total: 1 });
    if (phone === '71999998888') return json({ contacts: [MARCOS], total: 1 });
    if (q === 'Ana') return json({ contacts: [ANA1, ANA2], total: 2 });
    if (q === 'Marcos Pereira') return json({ contacts: [MARCOS], total: 1 });
    if (q === 'Armando Moretti') return json({ contacts: [ARMANDO], total: 1 });
    if (q === 'Carlos') return json({ contacts: [{ id: 'c7', name: 'Carlos Silva', phones: [{ phone: '(11) 90000-7777' }], deals: [] }], total: 1 });
    if (q === 'João') return json({ contacts: [{ id: 'c5', name: 'João Pedro Lima', phones: [], deals: [] }, { id: 'c6', name: 'João Souza', phones: [], deals: [] }], total: 2 });
    return json({ contacts: [], total: 0 });
  }
  if (p === '/contacts/c2') return json(ANA1);
  if (p === '/deals/d9') {
    return json({
      id: 'd9', name: 'PRXC | Armando Moretti Filho', deal_stage: { name: 'Reunião Realizada' }, deal_pipeline: { name: 'Closers' }, user: { name: 'Vitor Santos' },
      deal_custom_fields: [
        { custom_field: { label: 'Vende online?' }, value: 'Já vendo e quero aumentar meus resultados no Mercado Livre' },
        { custom_field: { label: '[AD]CAMPANHA' }, value: '[SMQL] [CAP] [META]' },
        { custom_field: { label: 'LP' }, value: 'diagnostico-v2' },
        { custom_field: { label: 'Motivo' }, value: 'JÁ VENDE' },
      ],
    });
  }
  if (p === '/deals/d1') {
    return json({
      id: 'd1', name: 'Marcos Pereira', created_at: '2026-09-28T20:00:00-03:00',
      deal_stage: { name: 'MQL' }, deal_pipeline: { name: 'Funil MQL' }, user: { name: 'Cauã Lima' },
      deal_source: { name: 'Instagram' },
      deal_custom_fields: [
        { custom_field: { label: 'Faturamento' }, value: 'R$ 50 mil' },
        { custom_field: { label: 'Vazio' }, value: '' },
        { custom_field: { label: 'Canais' }, value: ['Loja física', 'Instagram'] },
      ],
    });
  }
  if (p === '/activities' && u.searchParams.get('deal_id') === 'd9') {
    return json({ activities: [{ id: 'a9', date: '2026-09-27T09:58:00-03:00', user_id: 'u1', deal_id: 'd9',
      text: 'ProfissÃ£o: EmpresÃ¡rio\nEstado: SÃ£o Paulo\nVende online: JÃ¡ vendo e quero aumentar meus resultados no Mercado Livre\nInvestimento: R$3.000 a R$5.000' }] });
  }
  if (p === '/activities') {
    assert.equal(u.searchParams.get('deal_id'), 'd1');
    return json({
      activities: [
        { id: 'a1', date: '2026-09-28T23:38:00-03:00', user_id: 'u1', deal_id: 'd1',
          text: '<p>Profissão: Lojista/Comerciante</p><p>Estado: Bahia</p><p>Vende online: Quero começar a vender no Mercado Livre</p><p>Investimento: + de R$5.000</p>' },
        { id: 'a2', date: '2026-09-29T10:00:00-03:00', user_id: 'u2', deal_id: 'd1', text: 'Liguei &amp; não atendeu' },
      ],
    });
  }
  if (p === '/users') return json({ users: [{ id: 'u1', name: 'Gustavo Dias' }, { id: 'u2', name: 'Cauã Lima' }] });
  if (p === '/custom_fields') return json([{ id: 'cf1', label: 'Cidade', for: 'contact' }]);
  return json({}, 404);
};

// ---------------------------------------------------------------- servidor
let servidor;
let base;
const E = {};
test.before(async () => {
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  const criar = async (nome, papel) => {
    const r = await fetchReal(base + '/api/admin/usuarios', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' },
      body: JSON.stringify({ nome, papel }),
    });
    return (await r.json()).usuario.chave;
  };
  E.sdr = await criar('SDR Teste', 'sdr');
  E.sdr2 = await criar('SDR Sem Ficha', 'sdr');
  E.admin = await criar('Admin Teste', 'admin');
});
test.after(async () => {
  await new Promise((r) => servidor.close(r));
  global.fetch = fetchReal;
  fs.rmSync(DADOS, { recursive: true, force: true });
});

async function post(rota, corpo, { chave, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (chave) headers['x-cr-key'] = chave;
  if (admin) headers['x-admin-pass'] = 'senha-de-teste';
  const r = await fetchReal(base + rota, { method: 'POST', headers, body: JSON.stringify(corpo) });
  const texto = await r.text();
  assert.ok(!texto.includes(TOKEN), 'o token do CRM nunca pode aparecer numa resposta');
  return { status: r.status, json: JSON.parse(texto) };
}

// ---------------------------------------------------------------- testes
test('sem chave da extensão: 401', async () => {
  assert.equal((await post('/api/crm/lead', { telefone: '5571999998888' })).status, 401);
});

test('pelo telefone do WhatsApp: acha o lead certo (mesmo com o RD devolvendo outra pessoa num formato)', async () => {
  chamadasRd.length = 0;
  const r = await post('/api/crm/lead', { telefone: '5571999998888' }, { chave: E.sdr });
  assert.equal(r.status, 200);
  assert.equal(r.json.configurado, true);
  assert.equal(r.json.encontrado, true);
  assert.equal(r.json.buscaPor, 'telefone');
  const f = r.json.ficha;
  assert.equal(f.nome, 'Marcos Pereira', 'não pegou a "Outra Pessoa" que o RD devolveu pelo número formatado');
  assert.deepEqual(f.negociacao, {
    nome: 'Marcos Pereira', etapa: 'MQL', funil: 'Funil MQL', responsavel: 'Cauã Lima', fonte: 'Instagram', campanha: '',
    criadaEm: '28/09/2026 20:00', url: 'https://crm.rdstation.com/app/deals/d1',
  });
  assert.equal(f.totalNegociacoes, 2);
  assert.deepEqual(f.formulario, {
    campos: [
      { rotulo: 'Profissão', valor: 'Lojista/Comerciante' },
      { rotulo: 'Estado', valor: 'Bahia' },
      { rotulo: 'Vende online', valor: 'Quero começar a vender no Mercado Livre' },
      { rotulo: 'Investimento', valor: '+ de R$5.000' },
    ],
    autor: 'Gustavo Dias',
    quando: '28/09/2026 23:38',
  });
  assert.deepEqual(f.campos, [
    { rotulo: 'Faturamento', valor: 'R$ 50 mil' },
    { rotulo: 'Canais', valor: 'Loja física, Instagram' },
    { rotulo: 'Cidade', valor: 'Salvador' },
  ]);
  assert.deepEqual(f.anotacoes, [{ autor: 'Cauã Lima', quando: '29/09/2026 10:00', texto: 'Liguei & não atendeu' }]);
  assert.ok(chamadasRd.some((c) => c.startsWith('/api/v1/deals/d1')), 'usa a negociação EM ABERTO (d1), não a perdida (d0)');
  assert.ok(!chamadasRd.some((c) => c.includes('d0')));
});

test('mesma conversa de novo: vem do cache, sem consultar o RD (inclusive o número sem o 9)', async () => {
  chamadasRd.length = 0;
  const r = await post('/api/crm/lead', { telefone: '557199998888' }, { chave: E.sdr });
  assert.equal(r.json.ficha.nome, 'Marcos Pereira');
  assert.equal(r.json.cache, true);
  assert.equal(chamadasRd.length, 0);
});

test('contato salvo só com o nome: vários resultados viram uma lista para escolher; escolher traz a ficha', async () => {
  const r = await post('/api/crm/lead', { nome: 'Ana' }, { chave: E.sdr });
  assert.equal(r.json.encontrado, false);
  assert.deepEqual(r.json.candidatos, [
    { id: 'c2', nome: 'Ana Souza', telefone: '(21) 98888-1111' },
    { id: 'c3', nome: 'Ana Lima', telefone: '(31) 97777-2222' },
  ]);
  const escolhido = await post('/api/crm/lead', { contatoId: 'c2' }, { chave: E.sdr });
  assert.equal(escolhido.json.encontrado, true);
  assert.equal(escolhido.json.ficha.nome, 'Ana Souza');
  assert.equal(escolhido.json.ficha.negociacao, null, 'contato sem negociação');
});

test('um único resultado pelo nome já vira a ficha', async () => {
  const r = await post('/api/crm/lead', { nome: 'Marcos Pereira' }, { chave: E.sdr });
  assert.equal(r.json.encontrado, true);
  assert.equal(r.json.buscaPor, 'nome');
});

test('telefone que não está no RD: encontrado false (e tenta pelo nome se veio nome)', async () => {
  chamadasRd.length = 0;
  const r = await post('/api/crm/lead', { telefone: '5511900001111', nome: 'Desconhecido' }, { chave: E.sdr });
  assert.deepEqual(r.json, { configurado: true, encontrado: false });
  assert.ok(chamadasRd.some((c) => c.includes('q=Desconhecido')));
});

test('nome que é na verdade um telefone não vira busca por nome', async () => {
  chamadasRd.length = 0;
  await post('/api/crm/lead', { nome: '+55 11 90000-2222' }, { chave: E.sdr });
  assert.equal(chamadasRd.length, 0);
});

test('token recusado pelo RD: erro claro e o token não aparece', async () => {
  rdStatus = 401;
  const r = await post('/api/crm/lead', { telefone: '5561988887777' }, { chave: E.sdr });
  rdStatus = 200;
  assert.equal(r.status, 502);
  assert.match(r.json.erro, /recusou o token/);
});

test('sem RDSTATION_CRM_TOKEN: configurado false (a extensão não mostra nada)', async () => {
  delete process.env.RDSTATION_CRM_TOKEN;
  const r = await post('/api/crm/lead', { telefone: '5571999998888' }, { chave: E.sdr });
  process.env.RDSTATION_CRM_TOKEN = TOKEN;
  assert.deepEqual(r.json, { configurado: false });
});

test('teste do admin: sem cache e com o passo a passo de quais formatos de telefone foram tentados', async () => {
  assert.equal((await post('/api/admin/crm/teste', { telefone: '5571999998888' }, { chave: E.sdr })).status, 401, 'SDR não usa');
  const r = await post('/api/admin/crm/teste', { telefone: '5571999998888' }, { admin: true });
  assert.equal(r.json.encontrado, true);
  const t = r.json.diagnostico.tentativas;
  assert.deepEqual(t, [
    { variante: '(71) 99999-8888', resultados: 1, bateu: false },
    { variante: '71999998888', resultados: 1, bateu: true },
  ], 'começa pelo formato do card do RD; resultado com telefone diferente é descartado');
  assert.equal(r.json.diagnostico.encontradaCom, '71999998888');
});

// ---------------------------------------------------------------- funções puras
test('variantes de telefone: formato do card do RD primeiro, depois dígitos, com/sem 55 e com/sem o 9', () => {
  assert.deepEqual(crm.variantesTelefone('5511967636300'), ['(11) 96763-6300', '11967636300', '5511967636300', '(11) 6763-6300', '1167636300', '551167636300']);
  assert.deepEqual(crm.variantesTelefone('557199998888'), ['(71) 9999-8888', '7199998888', '557199998888', '(71) 99999-8888', '71999998888', '5571999998888']);
  assert.deepEqual(crm.variantesTelefone('123'), []);
});

test('confere o telefone pelos 8 últimos dígitos, em qualquer formato', () => {
  assert.equal(crm.contatoTemTelefone(MARCOS, '557199998888'), true, 'sem o 9 (como o WhatsApp às vezes entrega) os 8 últimos são os mesmos');
  assert.equal(crm.contatoTemTelefone(MARCOS, '5571999998888'), true);
  assert.equal(crm.contatoTemTelefone({ phones: [{ whatsapp_full_internacional: '+55 71 99999-8888' }] }, '71999998888'), true);
  assert.equal(crm.contatoTemTelefone(OUTRO, '5571999998888'), false);
  assert.equal(crm.contatoTemTelefone({}, '5571999998888'), false);
});

test('anotação em HTML vira texto e os campos saem linha a linha', () => {
  assert.equal(crm.limparTexto('<p>A: 1</p><p>B:&nbsp;2 &amp; 3</p><br>'), 'A: 1\nB: 2 & 3');
  assert.deepEqual(crm.extrairCampos('Profissão: Lojista\nsem dois pontos\nhttps://x.com\nLink: https://y.com'), [
    { rotulo: 'Profissão', valor: 'Lojista' },
    { rotulo: 'Link', valor: 'https://y.com' },
  ]);
});

test('escolhe a negociação em aberto; se todas fecharam, a última', () => {
  assert.equal(crm.escolherNegociacao(MARCOS.deals).id, 'd1');
  assert.equal(crm.escolherNegociacao([{ id: 'x', win: true, closed_at: '1' }, { id: 'y', win: false, closed_at: '2' }]).id, 'y');
  assert.equal(crm.escolherNegociacao([]), null);
});

// ---------------------------------------------------------------- disponível para todos
test('ficha disponível para todo usuário com chave (SDR ou admin), sem liberação', async () => {
  assert.equal((await post('/api/crm/lead', { telefone: '5571999998888' }, { chave: E.sdr2 })).json.encontrado, true);
  assert.equal((await post('/api/crm/lead', { telefone: '5571999998888' }, { chave: E.admin })).json.encontrado, true);
  const patch = await fetchReal(base + '/api/admin/usuarios/qualquer', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'senha-de-teste' }, body: JSON.stringify({ fichaCrm: false }),
  });
  assert.equal(patch.status, 404, 'não existe mais liberação por usuário');
});

// ---------------------------------------------------------------- contato salvo com nome no WhatsApp
test('nome salvo "Armando PRONIX Moretti" acha "Armando Moretti Filho" sozinho (sem digitar número)', async () => {
  chamadasRd.length = 0;
  const r = await post('/api/crm/lead', { nome: 'Armando PRONIX Moretti' }, { chave: E.sdr });
  assert.equal(r.json.encontrado, true);
  assert.equal(r.json.ficha.nome, 'Armando Moretti Filho');
  assert.ok(chamadasRd.some((c) => c.includes('q=Armando PRONIX Moretti')));
  assert.ok(chamadasRd.some((c) => c.includes('q=Armando Moretti')), 'tenta de novo sem o "PRONIX"');
  const f = r.json.ficha;
  assert.deepEqual(f.formulario.campos, [
    { rotulo: 'Profissão', valor: 'Empresário' },
    { rotulo: 'Estado', valor: 'São Paulo' },
    { rotulo: 'Vende online', valor: 'Já vendo e quero aumentar meus resultados no Mercado Livre' },
    { rotulo: 'Investimento', valor: 'R$3.000 a R$5.000' },
  ], 'acentos quebrados da anotação consertados');
  assert.deepEqual(f.campos, [{ rotulo: 'Motivo', valor: 'JÁ VENDE' }], '"Vende online?" não repete o do formulário');
  assert.equal(f.campanha, undefined);
  assert.ok(!JSON.stringify(f).includes('diagnostico-v2') && !JSON.stringify(f).includes('[AD]'), 'campos de anúncio/origem ficam fora da ficha');
});

test('só o primeiro nome bateu e o sobrenome é outro: não escolhe sozinho, mostra para o SDR escolher', async () => {
  const r = await post('/api/crm/lead', { nome: 'Carlos PRONIX Tavares' }, { chave: E.sdr });
  assert.equal(r.json.encontrado, false);
  assert.deepEqual(r.json.candidatos, [{ id: 'c7', nome: 'Carlos Silva', telefone: '(11) 90000-7777' }]);
});

test('vários com o primeiro nome: lista para escolher', async () => {
  const r = await post('/api/crm/lead', { nome: 'João PRONIX Ferreira' }, { chave: E.sdr });
  assert.equal(r.json.encontrado, false);
  assert.deepEqual(r.json.candidatos.map((c) => c.nome), ['João Pedro Lima', 'João Souza']);
});

test('acentos quebrados: conserta só o que está quebrado', () => {
  assert.equal(crm.consertarAcentos('EmpresÃ¡rio de SÃ£o Paulo'), 'Empresário de São Paulo');
  assert.equal(crm.consertarAcentos('AÃ‡ÃƒO Ã‰ JÃ¡'), 'AÇÃO É Já');
  assert.equal(crm.consertarAcentos('SÃO PAULO e ÂNGELA'), 'SÃO PAULO e ÂNGELA', 'texto certo não muda');
  assert.equal(crm.consertarAcentos(null), '');
});

test('nome salvo: tira etiquetas do time, números e emojis, mantendo os acentos para a busca', () => {
  assert.deepEqual(crm.consultasPorNome('Armando PRONIX Moretti').consultas, ['Armando PRONIX Moretti', 'Armando Moretti', 'Armando']);
  assert.deepEqual(crm.consultasPorNome('Lead João Paulo Souza 22 🚀').consultas, ['Lead João Paulo Souza 22 🚀', 'João Paulo Souza', 'João Souza', 'João']);
  assert.deepEqual(crm.consultasPorNome('PRXC | Márcia Gonçalves').palavras, ['marcia', 'goncalves']);
  assert.deepEqual(crm.consultasPorNome('Ana').consultas, ['Ana']);
});
