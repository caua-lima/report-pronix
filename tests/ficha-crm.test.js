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
const MAPA_FALSO = [
  { id: 'financeiro', nome: 'Investimento / capacidade financeira', perguntou: 'sim', respondeu: 'parcial', resumo: 'Disse que vai ver com a esposa.', evidencia: 'Vou ver com ela', quando: '21/09 10:05' },
  { id: 'decisor', nome: 'Decisor', perguntou: 'sim', respondeu: 'sim', resumo: 'Decide com a esposa.', evidencia: '', quando: '' },
  { id: 'prazo', nome: 'Prazo / urgência', perguntou: 'nao', respondeu: 'nao', resumo: 'ainda não perguntado', evidencia: '', quando: '' },
  { id: 'pagamento', nome: 'Forma de pagamento', perguntou: 'sim', respondeu: 'nao', resumo: '', evidencia: '', quando: '' },
];
const RESUMO_FALSO = {
  cenario: 'Marcos tem loja de moto peças e quer vender no Mercado Livre.',
  peQueParou: 'Você perguntou se ele consegue investir R$3 mil e ele ainda não respondeu.',
  ultimaPergunta: 'Você: Consegue investir a partir de R$3 mil?',
  proximoPasso: 'Retomar confirmando o investimento.',
  aguardando: 'lead',
  ultimaMensagem: '21/09 10:05',
};

function crmFalso(responder, opcoes = {}) {
  const consultas = [];
  const resumosPedidos = [];
  const acoes = [];
  const aoEnviar = async (original) => {
    const msg = JSON.parse(JSON.stringify(original));
    acoes.push(msg.action);
    if (msg.action === 'crmLead') {
      consultas.push({ telefone: msg.telefone || '', nome: msg.nome || '', contatoId: msg.contatoId || '', ...(msg.dealId ? { dealId: msg.dealId, lembrar: msg.lembrar === true } : {}) });
      return responder(msg);
    }
    if (msg.action === 'reportFetch') return { ok: true, dados: {}, arquivo: 'r.pdf', arquivoBase64: 'AAAA', mensagensRecebidas: msg.mensagens };
    if (msg.action === 'conversaMapa') {
      (opcoes.mapasPedidos || (opcoes.mapasPedidos = [])).push(msg);
      return opcoes.mapa ? opcoes.mapa(msg) : { ok: true, qualificadoFinanceiramente: 'parcial', mapa: MAPA_FALSO };
    }
    if (msg.action === 'conversaPergunta') {
      (opcoes.perguntasPedidas || (opcoes.perguntasPedidas = [])).push(msg);
      return opcoes.pergunta ? opcoes.pergunta(msg) : { ok: true, veredito: 'parcial', resposta: 'Em parte: ele disse que vai ver com a esposa.', evidencias: [{ quem: 'lead', trecho: 'Tudo sim', quando: '21/09 10:05' }] };
    }
    if (msg.action === 'resumoRapido') {
      resumosPedidos.push(msg);
      return opcoes.resumo ? opcoes.resumo(msg) : { ok: true, resumo: RESUMO_FALSO, cache: false };
    }
    return { ok: true };
  };
  return { aoEnviar, consultas, resumosPedidos, acoes, opcoes };
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
    'Outras anotações (1)', 'Abrir no RD Station']) {
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

// ---------------------------------------------------------------- aberto pelo botão de WhatsApp do card no RD
test('aberto pelo link do RD (send?phone=): contato salvo com nome também é buscado pelo número do link', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrirPagina({
    arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/send?phone=5511967636300&text=',
    aoEnviar: srv.aoEnviar, intervaloRapido: true,
  });
  montarWhatsApp(p, CONVERSA, { contato: 'Rodrigo Melo', idsSimples: true });
  await esperar(() => srv.consultas.length === 1, { motivo: '1ª consulta' });
  assert.deepEqual(srv.consultas[0], { telefone: '5511967636300', nome: 'Rodrigo Melo', contatoId: '' });

  // Trocou para outra conversa: o número do link NÃO vale para ela.
  trocarConversa(p, 'Outra Pessoa');
  await esperar(() => srv.consultas.length === 2, { motivo: '2ª consulta' });
  assert.deepEqual(srv.consultas[1], { telefone: '', nome: 'Outra Pessoa', contatoId: '' });

  // Voltou para a conversa do link: vale de novo.
  trocarConversa(p, 'Rodrigo Melo');
  await esperar(() => srv.consultas.length === 3, { motivo: '3ª consulta' });
  assert.equal(srv.consultas[2].telefone, '5511967636300');
  p.fechar();
});

test('link do RD aberto num contato não salvo: depois, outra conversa não herda o número do link', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrirPagina({
    arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/send?phone=5511967636300',
    aoEnviar: srv.aoEnviar, intervaloRapido: true,
  });
  montarWhatsApp(p, CONVERSA, { contato: '+55 11 96763-6300', idsSimples: true });
  await esperar(() => srv.consultas.length === 1, { motivo: '1ª consulta' });
  trocarConversa(p, 'Contato Salvo');
  await esperar(() => srv.consultas.length === 2, { motivo: '2ª consulta' });
  assert.deepEqual(srv.consultas[1], { telefone: '', nome: 'Contato Salvo', contatoId: '' });
  p.fechar();
});

test('o cartão encosta na borda da conversa (ao lado do painel do RD, não por cima)', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  // Janela de 1380px; a conversa (#main) vai até 1030px — o resto é o painel do RD Station.
  Object.defineProperty(p.w, 'innerWidth', { value: 1380, configurable: true });
  const main = p.document.querySelector('#main');
  main.getBoundingClientRect = () => ({ left: 0, right: 1030, top: 0, bottom: 900, width: 1030, height: 900 });
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha' });
  await esperar(() => cartao(p).style.right === '366px', { motivo: 'posição ao lado do painel' });
  assert.equal(cartao(p).style.top, '70px');
  assert.equal(cartao(p).style.width, '290px');
  p.fechar();
});

// ---------------------------------------------------------------- resumo rápido da conversa
const botao = (p, texto) => (cartao(p) ? [...cartao(p).querySelectorAll('button')].find((b) => b.textContent === texto) : undefined);

test('resumo rápido: o botão lê a conversa e mostra cenário, onde parou, última pergunta e próximo passo', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha' });
  assert.ok(botao(p, 'Resumo rápido da conversa'), 'botão no cartão');
  botao(p, 'Resumo rápido da conversa').click();
  await esperar(() => /Onde parou/.test(textoCartao(p)), { motivo: 'resumo na tela' });
  assert.deepEqual(srv.resumosPedidos[0].mensagens.map((m) => m.content), ['Oi, tudo bem?', 'Tudo sim'], 'mandou a conversa lida');
  const t = textoCartao(p);
  for (const x of ['RESUMO RÁPIDO', 'Marcos tem loja de moto peças', 'Você perguntou se ele consegue investir R$3 mil',
    'Última pergunta', 'Você: Consegue investir a partir de R$3 mil?', 'Próximo passo', 'Aguardando o lead · última mensagem 21/09 10:05']) {
    assert.ok(t.includes(x), 'faltou no cartão: ' + x);
  }
  assert.ok(t.indexOf('RESUMO RÁPIDO') < t.indexOf('Profissão'), 'o resumo vem antes do formulário');
  assert.equal(p.document.getElementById('closer-report-badge'), null, 'o aviso de andamento some ao terminar');

  // Minimizar e abrir de novo não perde o resumo.
  botao(p, '–').click();
  botao(p, '+').click();
  assert.match(textoCartao(p), /Onde parou/);
  p.fechar();
});

test('resumo rápido: também aparece quando o lead não está no RD', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: false }));
  const p = abrir(srv);
  await esperar(() => /Não achei este lead/.test(textoCartao(p)), { motivo: 'não encontrado' });
  botao(p, 'Resumo rápido da conversa').click();
  await esperar(() => /Onde parou/.test(textoCartao(p)), { motivo: 'resumo' });
  p.fechar();
});

test('resumo rápido: erro mostra a mensagem e "Tentar de novo" pede outra vez', async () => {
  let vez = 0;
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }), {
    resumo: () => (++vez === 1 ? { ok: false, erro: 'A IA demorou demais para responder.' } : { ok: true, resumo: RESUMO_FALSO }),
  });
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha' });
  botao(p, 'Resumo rápido da conversa').click();
  await esperar(() => /demorou demais/.test(textoCartao(p)), { motivo: 'erro' });
  botao(p, 'Tentar de novo').click();
  await esperar(() => /Onde parou/.test(textoCartao(p)), { motivo: 'resumo na 2ª' });
  assert.equal(srv.resumosPedidos.length, 2);
  p.fechar();
});

test('resumo rápido: cada conversa tem o seu (trocar de conversa não mostra o resumo da anterior)', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha' });
  botao(p, 'Resumo rápido da conversa').click();
  await esperar(() => /Onde parou/.test(textoCartao(p)), { motivo: 'resumo' });
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => srv.consultas.length === 2 && /Investimento/.test(textoCartao(p)), { motivo: 'ficha da 2ª conversa' });
  assert.doesNotMatch(textoCartao(p), /Onde parou/);
  assert.ok(botao(p, 'Resumo rápido da conversa'));
  p.fechar();
});

// ---------------------------------------------------------------- número pelo painel "Dados do contato"
function abrirPainelDoContato(p, telefones) {
  const d = p.document.createElement('div');
  d.id = 'drawer-contato';
  d.innerHTML = '<span dir="auto">Armando PRONIX Moretti</span>' + telefones.map((t) => `<span dir="auto">${t}</span>`).join('');
  p.document.body.appendChild(d);
  return d;
}

test('contato salvo com nome: abriu "Dados do contato", a ficha passa a buscar pelo número de lá', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv, { contato: 'Armando PRONIX Moretti' });
  await esperar(() => srv.consultas.length === 1, { motivo: '1ª consulta (nome)' });
  assert.deepEqual(srv.consultas[0], { telefone: '', nome: 'Armando PRONIX Moretti', contatoId: '' });

  const painel = abrirPainelDoContato(p, ['+55 15 99767-1347']);
  await esperar(() => srv.consultas.length === 2, { motivo: 'consulta pelo número do painel' });
  assert.deepEqual(srv.consultas[1], { telefone: '5515997671347', nome: 'Armando PRONIX Moretti', contatoId: '' });

  // Fechou o painel, foi para outra conversa e voltou: o número dessa conversa ficou guardado.
  painel.remove();
  trocarConversa(p, 'Outra Pessoa');
  await esperar(() => srv.consultas.length === 3, { motivo: 'outra conversa' });
  trocarConversa(p, 'Armando PRONIX Moretti');
  await esperar(() => srv.consultas.length === 4, { motivo: 'volta' });
  assert.equal(srv.consultas[3].telefone, '5515997671347');
  p.fechar();
});

test('painel com vários números (grupo) ou número na lista de conversas: não usa', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: false }));
  const p = abrir(srv, { contato: 'Grupo da Loja' });
  await esperar(() => srv.consultas.length === 1, { motivo: '1ª consulta' });
  abrirPainelDoContato(p, ['+55 11 90000-1111', '+55 21 98888-2222']);
  const lista = p.document.createElement('div');
  lista.id = 'pane-side';
  lista.innerHTML = '<span dir="auto">+55 31 97777-3333</span>';
  p.document.body.appendChild(lista);
  await dormir(150);
  assert.equal(srv.consultas.length, 1, 'nenhuma consulta nova por número');
  p.fechar();
});

// ---------------------------------------------------------------- lead com mais de um card
test('lead com vários cards: o cartão mostra o seletor e trocar manda o card escolhido para o servidor lembrar', async () => {
  const f = { ...FICHA_MARCOS, negociacoes: [
    { id: 'e2', nome: 'atual', etapa: 'Reunião Realizada', funil: 'Closers', responsavel: 'Vitor', criadaEm: '20/09/2026', aberta: true, escolhida: true },
    { id: 'e1', nome: 'antigo', etapa: 'MQL', funil: 'Funil MQL', responsavel: 'Cauã', criadaEm: '01/08/2026', aberta: true, escolhida: false },
  ] };
  const srv = crmFalso((m) => ({ ok: true, configurado: true, encontrado: true, ficha: { ...f, negociacoes: f.negociacoes.map((c) => ({ ...c, escolhida: c.id === (m.dealId || 'e2') })) } }));
  const p = abrir(srv);
  await esperar(() => /Este lead tem 2 cards/.test(textoCartao(p)), { motivo: 'seletor' });
  const sel = cartao(p).querySelector('select');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['Reunião Realizada · Closers · 20/09/2026', 'MQL · Funil MQL · 01/08/2026']);
  assert.equal(sel.value, 'e2');
  sel.value = 'e1';
  sel.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await esperar(() => srv.consultas.length === 2, { motivo: 'consulta do card escolhido' });
  assert.equal(srv.consultas[1].dealId, 'e1');
  assert.equal(srv.consultas[1].lembrar, true);
  await esperar(() => cartao(p).querySelector('select') && cartao(p).querySelector('select').value === 'e1', { motivo: 'seletor no card novo' });
  p.fechar();
});

// ---------------------------------------------------------------- mapa da conversa e perguntas
const resumoPronto = async (srv) => {
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha' });
  botao(p, 'Resumo rápido da conversa').click();
  await esperar(() => /Onde parou/.test(textoCartao(p)), { motivo: 'resumo na tela' });
  return p;
};

test('depois do resumo rápido: "Mapear a conversa" mostra o que já foi perguntado e respondido, com a evidência', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = await resumoPronto(srv);
  assert.ok(botao(p, 'Mapear a conversa'), 'o botão aparece depois do resumo');
  botao(p, 'Mapear a conversa').click();
  await esperar(() => /Qualificado financeiramente: Em parte/.test(textoCartao(p)), { motivo: 'mapa na tela' });
  // a conversa já lida (com os áudios) vai junto, sem reler
  assert.deepEqual(srv.opcoes.mapasPedidos[0].mensagens.map((m) => m.content), ['Oi, tudo bem?', 'Tudo sim']);
  const t = textoCartao(p);
  for (const x of ['Investimento / capacidade financeira', 'respondeu em parte', '“Vou ver com ela” · 21/09 10:05', 'Decisor', 'ainda não perguntado', 'perguntou, sem resposta']) assert.ok(t.includes(x), 'faltou: ' + x);
  const simbolos = [...p.document.querySelectorAll('#cr-mapa span')].map((s) => s.textContent).filter((s) => ['✓', '◐', '?', '–'].includes(s));
  assert.deepEqual(simbolos, ['◐', '✓', '–', '?']);
  assert.equal(p.document.querySelector('#cr-mapa i'), null);
  p.fechar();
});

test('depois do resumo rápido: perguntas prontas e livres; a resposta traz Sim/Não/Em parte e a evidência; o texto digitado não se perde', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = await resumoPronto(srv);
  botao(p, 'Já está qualificado financeiramente?').click();
  await esperar(() => /Em parte\. Em parte: ele disse/.test(textoCartao(p)), { motivo: 'resposta' });
  assert.deepEqual(srv.opcoes.perguntasPedidas.map((m) => m.pergunta), ['Já está qualificado financeiramente?']);
  assert.match(textoCartao(p), /Lead \(21\/09 10:05\): “Tudo sim”/);

  // digitar e apertar Enter; o cartão se redesenha e o que está sendo digitado continua lá
  const input = () => p.document.getElementById('cr-pergunta-texto');
  input().value = 'ele falou do prazo?';
  input().dispatchEvent(new p.w.Event('input', { bubbles: true }));
  botao(p, 'Mapear a conversa').click(); // redesenha o cartão no meio da digitação
  await esperar(() => /Qualificado financeiramente/.test(textoCartao(p)), { motivo: 'mapa' });
  assert.equal(input().value, 'ele falou do prazo?', 'o texto digitado sobrevive ao redesenho');
  input().dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await esperar(() => srv.opcoes.perguntasPedidas.length === 2, { motivo: 'segunda pergunta' });
  assert.equal(srv.opcoes.perguntasPedidas[1].pergunta, 'ele falou do prazo?');
  assert.equal(input().value, '', 'a caixa limpa depois de perguntar');
  // a mais nova vem primeiro
  const perguntasNaTela = [...cartao(p).querySelectorAll('#cr-perguntas div')].filter((d) => !d.children.length).map((d) => d.textContent).filter((x) => x.startsWith('Você: '));
  assert.deepEqual(perguntasNaTela, ['Você: ele falou do prazo?', 'Você: Já está qualificado financeiramente?']);
  p.fechar();
});

test('mapa e perguntas: erro do servidor aparece e dá para tentar de novo; sem o resumo, nada disso aparece', async () => {
  let vez = 0;
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }), {
    mapa: () => (++vez === 1 ? { ok: false, erro: 'O limite gratuito da IA foi atingido por agora. Tente de novo em 1 minuto.' } : { ok: true, qualificadoFinanceiramente: 'nao', mapa: MAPA_FALSO }),
    pergunta: () => ({ ok: false, erro: 'A IA não respondeu. Tente de novo.' }),
  });
  const sem = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(sem)), { motivo: 'ficha' });
  assert.equal(botao(sem, 'Mapear a conversa'), undefined, 'sem o resumo (a conversa lida) não há mapa nem pergunta');
  assert.equal(sem.document.getElementById('cr-perguntas'), null);
  sem.fechar();

  const p = await resumoPronto(srv);
  botao(p, 'Mapear a conversa').click();
  await esperar(() => /limite gratuito da IA/.test(textoCartao(p)), { motivo: 'erro do mapa' });
  botao(p, 'Tentar de novo').click();
  await esperar(() => /Qualificado financeiramente: Não/.test(textoCartao(p)), { motivo: 'mapa na segunda' });
  botao(p, 'Já perguntei do decisor?').click();
  await esperar(() => /A IA não respondeu/.test(textoCartao(p)), { motivo: 'erro da pergunta' });
  p.fechar();
});


// ---------------------------------------------------------------- painel lateral do CRM
const FICHA_PAINEL = {
  ...FICHA_MARCOS,
  crmNome: 'Pronix CRM',
  emails: ['marcos@exemplo.com'],
  negociacao: { ...FICHA_MARCOS.negociacao, url: 'https://crm.pronixhub.com.br/#/deals/d1' },
  negociacoes: [
    { id: 'd1', nome: 'PRXC | Marcos <b>Pereira</b>', etapa: 'Respondeu', funil: 'Funil MQL', responsavel: 'Cauã Lima', aberta: true, ganha: false, perdida: false, valor: 0, escolhida: true, url: 'https://crm.pronixhub.com.br/#/deals/d1' },
    { id: 'd0', nome: 'PRXC | Marcos (antigo)', etapa: 'Desqualificado', funil: 'Funil MQL', responsavel: 'Cauã Lima', aberta: false, ganha: false, perdida: true, motivoPerda: 'Nunca Respondeu (SDR)', valor: 0, escolhida: false, url: 'javascript:alert(1)' },
  ],
};
const painel = (p) => p.document.getElementById('pronix-painel-lateral');

test('painel lateral: o lead da conversa, cada negociação é um link para o card no CRM, e o WhatsApp abre espaço', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_PAINEL }));
  const p = abrir(srv);
  await esperar(() => painel(p) && /Marcos Pereira/.test(painel(p).textContent), { motivo: 'painel com o lead' });
  const t = painel(p).textContent;
  for (const x of ['PRONIX CRM', 'Marcos Pereira', 'marcos@exemplo.com', 'Negociações (2)', 'Funil MQL › Respondeu', 'Em andamento', 'Perdida', 'Motivo: Nunca Respondeu (SDR)', 'O que respondeu', 'Profissão', 'Lojista/Comerciante', 'Últimas anotações', 'Liguei, não atendeu']) {
    assert.ok(t.includes(x), 'faltou no painel: ' + x);
  }
  const d1 = painel(p).querySelector('[data-pnx-deal="d1"]');
  assert.equal(d1.tagName, 'A');
  assert.equal(d1.getAttribute('href'), 'https://crm.pronixhub.com.br/#/deals/d1');
  assert.equal(d1.getAttribute('target'), '_blank');
  assert.equal(painel(p).querySelector('[data-pnx-abrir]').getAttribute('href'), 'https://crm.pronixhub.com.br/#/deals/d1', 'botão principal abre o card escolhido');
  // link que não é do CRM nunca vira link; texto do CRM nunca vira HTML
  assert.equal(painel(p).querySelector('[data-pnx-deal="d0"]').tagName, 'DIV');
  assert.equal(painel(p).querySelector('b'), null);
  assert.equal(painel(p).querySelector('img'), null);
  // o WhatsApp fica mais estreito para o painel caber
  assert.match(p.document.getElementById('pronix-painel-encaixe').textContent, /#app\{[^}]*right:320px/);

  // recolher: vira uma aba e o WhatsApp volta à largura toda; a escolha fica guardada
  [...painel(p).querySelectorAll('button')].find((b) => b.textContent === '»').click();
  assert.equal(painel(p), null);
  assert.equal(p.document.getElementById('pronix-painel-encaixe'), null);
  assert.equal(p.storage.painelLateralAberto, false);
  p.document.getElementById('pronix-painel-aba').click();
  assert.ok(painel(p), 'a aba abre o painel de novo');
  p.fechar();
});

test('painel lateral: não aparece para quem não tem a ficha do CRM', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: false }));
  const p = abrir(srv);
  await esperar(() => srv.consultas.length >= 1, { motivo: 'consulta feita' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(painel(p), null);
  assert.equal(p.document.getElementById('pronix-painel-encaixe'), null);
  p.fechar();
});

test('ficha guardada nesta aba: voltar a uma conversa mostra o lead na hora, antes da resposta nova', async () => {
  let atrasar = false;
  const srv = crmFalso(async (msg) => {
    if (atrasar) await new Promise((r) => setTimeout(r, 600));
    return msg.nome === 'Outra Pessoa' ? { ok: true, configurado: true, encontrado: false } : { ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS };
  });
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha da 1ª conversa' });
  trocarConversa(p, 'Outra Pessoa');
  await esperar(() => /Não achei este lead/.test(textoCartao(p)), { motivo: 'outra conversa' });
  atrasar = true;
  const t0 = Date.now();
  trocarConversa(p, '+55 71 99999-8888');
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'volta com a ficha guardada' });
  assert.ok(Date.now() - t0 < 600, 'apareceu antes da resposta nova (que demora 600 ms)');
  await esperar(() => srv.consultas.length === 3, { motivo: 'a busca nova também foi feita' });
  p.fechar();
});

test('sem coach: a extensão nunca pede dica nem feedback do coach ao servidor', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => /Investimento/.test(textoCartao(p)), { motivo: 'ficha na tela' });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(srv.acoes.filter((a) => /coach|permiss/i.test(a)), []);
  assert.doesNotMatch(textoCartao(p), /coach|como abordar/i);
  p.fechar();
});
