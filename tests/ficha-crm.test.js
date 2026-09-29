'use strict';
// Cartão "ficha do lead" (RD Station CRM) no WhatsApp Web: o content.js REAL em DOM simulado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, montarWhatsApp, esperar, dormir } = require('./helpers/dom');

const FICHA_MARCOS = {
  nome: 'Marcos Pereira',
  telefones: ['(71) 99999-8888'],
  emails: [],
  negociacao: { nome: 'Marcos Pereira', etapa: 'MQL', funil: 'Funil MQL', responsavel: 'Cauã Lima', fonte: '', campanha: '', criadaEm: '', url: 'https://crm.rdstation.com/app/deals/d1' },
  totalNegociacoes: 2,
  formulario: {
    campos: [
      { rotulo: 'Profissão', valor: 'Lojista/Comerciante' },
      { rotulo: 'Estado', valor: 'Bahia' },
      { rotulo: 'Vende online', valor: 'Quero começar a vender no Mercado Livre' },
      { rotulo: 'Investimento', valor: '+ de R$5.000' },
    ],
    autor: 'Gustavo Dias',
    quando: '28/09/2026 23:38',
  },
  campos: [{ rotulo: 'Observação', valor: '<img src=x onerror=alert(1)>' }],
  anotacoes: [{ autor: 'Cauã Lima', quando: '29/09/2026 10:00', texto: 'Liguei, não atendeu' }],
};

/** "Service worker" falso: responde a ficha conforme a função passada; guarda cada consulta. */
function crmFalso(responder) {
  const consultas = [];
  const aoEnviar = async (original) => {
    const msg = JSON.parse(JSON.stringify(original));
    if (msg.action === 'crmLead') {
      consultas.push({ telefone: msg.telefone || '', nome: msg.nome || '', contatoId: msg.contatoId || '' });
      return responder(msg);
    }
    if (msg.action === 'reportFetch') return { ok: true, dados: {}, arquivo: 'r.pdf', arquivoBase64: 'AAAA', mensagensRecebidas: msg.mensagens };
    return { ok: true };
  };
  return { aoEnviar, consultas };
}

const CONVERSA = [
  { from: 'eu', texto: 'Oi, tudo bem?' },
  { from: 'eles', texto: 'Tudo sim' },
];

function abrir(servidor, { contato = '+55 71 99999-8888', storage = {} } = {}) {
  const pagina = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar: servidor.aoEnviar, intervaloRapido: true, storage });
  montarWhatsApp(pagina, CONVERSA, { contato, idsSimples: true });
  return pagina;
}
const cartao = (p) => p.document.getElementById('cr-ficha-crm');
const textoCartao = (p) => (cartao(p) ? cartao(p).textContent : '');
const trocarConversa = (p, contato) => {
  const s = p.document.querySelector('#main header span');
  s.setAttribute('title', contato);
  s.textContent = contato;
};

test('abre a conversa: o cartão mostra etapa, responsável e as respostas do formulário', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'cartão com a ficha' });
  assert.deepEqual(srv.consultas[0], { telefone: '5571999998888', nome: '', contatoId: '' }, 'telefone do cabeçalho, sem repetir como nome');
  const t = textoCartao(p);
  for (const esperado of ['Marcos Pereira', 'MQL · Funil MQL', 'Responsável: Cauã Lima', 'Lojista/Comerciante', 'Bahia',
    'Quero começar a vender no Mercado Livre', '+ de R$5.000', 'Anotado por Gustavo Dias · 28/09/2026 23:38',
    'Outras anotações (1)', 'Este contato tem 2 negociações', 'Abrir no RD Station']) {
    assert.ok(t.includes(esperado), 'faltou no cartão: ' + esperado);
  }
  const link = cartao(p).querySelector('a');
  assert.equal(link.href, 'https://crm.rdstation.com/app/deals/d1');
  assert.equal(link.target, '_blank');
  assert.match(link.rel, /noopener/);
  assert.equal(cartao(p).querySelector('img'), null, 'dado do CRM nunca vira HTML');
  assert.ok(t.includes('<img src=x onerror=alert(1)>'));
  assert.equal(p.document.querySelector('#main').contains(cartao(p)), false, 'fora do #main: o report nunca lê o cartão como mensagem');
  await dormir(80);
  assert.equal(srv.consultas.length, 1, 'mesma conversa: não consulta de novo');
  p.fechar();
});

test('trocou de conversa: busca a ficha do novo lead', async () => {
  const srv = crmFalso((m) => ({ ok: true, configurado: true, encontrado: true, ficha: { ...FICHA_MARCOS, nome: m.telefone === '5511988887777' ? 'Júlia Ramos' : 'Marcos Pereira' } }));
  const p = abrir(srv);
  await esperar(() => /Marcos Pereira/.test(textoCartao(p)), { motivo: '1ª ficha' });
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => /Júlia Ramos/.test(textoCartao(p)), { motivo: 'ficha da 2ª conversa' });
  assert.deepEqual(srv.consultas.map((c) => c.telefone), ['5571999998888', '5511988887777']);
  p.fechar();
});

test('contato salvo com nome: busca pelo nome; vários resultados viram lista e escolher traz a ficha', async () => {
  const srv = crmFalso((m) => {
    if (m.contatoId === 'c3') return { ok: true, configurado: true, encontrado: true, ficha: { ...FICHA_MARCOS, nome: 'Ana Lima' } };
    return { ok: true, configurado: true, encontrado: false, candidatos: [{ id: 'c2', nome: 'Ana Souza', telefone: '(21) 98888-1111' }, { id: 'c3', nome: 'Ana Lima', telefone: '(31) 97777-2222' }] };
  });
  const p = abrir(srv, { contato: 'Ana' });
  await esperar(() => /Mais de um contato/.test(textoCartao(p)), { motivo: 'lista de candidatos' });
  assert.deepEqual(srv.consultas[0], { telefone: '', nome: 'Ana', contatoId: '' });
  const botao = [...cartao(p).querySelectorAll('button')].find((b) => /Ana Lima/.test(b.textContent));
  botao.click();
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha do escolhido' });
  assert.equal(srv.consultas.at(-1).contatoId, 'c3');
  p.fechar();
});

test('não achou: o SDR busca pelo telefone ou nome no próprio cartão', async () => {
  const srv = crmFalso((m) => (m.telefone === '71988887777'
    ? { ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }
    : { ok: true, configurado: true, encontrado: false }));
  const p = abrir(srv);
  await esperar(() => /Não achei este lead/.test(textoCartao(p)), { motivo: 'não encontrado' });
  const input = cartao(p).querySelector('input');
  input.value = '(71) 98888-7777';
  input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter' }));
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha pela busca manual' });
  assert.deepEqual(srv.consultas.at(-1), { telefone: '71988887777', nome: '', contatoId: '' });

  // Busca por nome digitado.
  srv.consultas.length = 0;
  trocarConversa(p, '+55 11 90000-0000');
  await esperar(() => /Não achei este lead/.test(textoCartao(p)), { motivo: 'não encontrado de novo' });
  const input2 = cartao(p).querySelector('input');
  input2.value = 'Marcos Pereira';
  [...cartao(p).querySelectorAll('button')].find((b) => b.textContent === 'Buscar').click();
  await esperar(() => srv.consultas.some((c) => c.nome === 'Marcos Pereira'), { motivo: 'busca por nome' });
  p.fechar();
});

test('CRM não configurado no servidor: não aparece cartão nenhum', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: false }));
  const p = abrir(srv);
  await esperar(() => srv.consultas.length === 1, { motivo: 'consulta' });
  await dormir(80);
  assert.equal(cartao(p), null);
  p.fechar();
});

test('erro do servidor: mostra a mensagem e "Tentar de novo" consulta outra vez', async () => {
  let vez = 0;
  const srv = crmFalso(() => (++vez === 1 ? { ok: false, erro: 'O RD Station CRM demorou para responder.' } : { ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => /demorou para responder/.test(textoCartao(p)), { motivo: 'erro' });
  [...cartao(p).querySelectorAll('button')].find((b) => /Tentar de novo/.test(b.textContent)).click();
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha após tentar de novo' });
  p.fechar();
});

test('desligado no popup: não consulta nada; religar busca a conversa aberta', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv, { storage: { fichaCrm: false } });
  await dormir(120);
  assert.equal(srv.consultas.length, 0);
  assert.equal(cartao(p), null);
  p.w.chrome.storage.local.set({ fichaCrm: true });
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'religado' });
  p.w.chrome.storage.local.set({ fichaCrm: false });
  assert.equal(cartao(p), null, 'desligar esconde na hora');
  p.fechar();
});

test('× fecha só nesta conversa; minimizar fica guardado', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha' });

  const minimizar = [...cartao(p).querySelectorAll('button')].find((b) => b.textContent === '–');
  minimizar.click();
  assert.doesNotMatch(textoCartao(p), /Investimento/, 'minimizado mostra só o topo');
  assert.equal(p.storage.fichaCrmMinimizada, true);
  [...cartao(p).querySelectorAll('button')].find((b) => b.textContent === '+').click();
  assert.match(textoCartao(p), /Investimento/);

  [...cartao(p).querySelectorAll('button')].find((b) => b.textContent === '×').click();
  assert.equal(cartao(p), null);
  await dormir(80);
  assert.equal(cartao(p), null, 'continua fechado nesta conversa');
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => cartao(p) !== null, { motivo: 'reabre em outra conversa' });
  p.fechar();
});

test('sem conversa aberta: o cartão some', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => cartao(p) !== null, { motivo: 'cartão' });
  p.document.querySelector('#main').remove();
  await esperar(() => cartao(p) === null, { motivo: 'cartão escondido' });
  p.fechar();
});

test('com o cartão aberto, o report continua lendo só as mensagens da conversa', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  let enviadas = null;
  const aoEnviarOriginal = srv.aoEnviar;
  srv.aoEnviar = async (m) => {
    if (m.action === 'reportFetch') enviadas = JSON.parse(JSON.stringify(m.mensagens));
    return aoEnviarOriginal(m);
  };
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha' });
  p.iniciar();
  await esperar(() => enviadas !== null, { motivo: 'report' });
  assert.deepEqual(enviadas.map((m) => m.content), ['Oi, tudo bem?', 'Tudo sim']);
  p.fechar();
});
