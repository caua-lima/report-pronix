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
const RESUMO_FALSO = {
  cenario: 'Marcos tem loja de moto peças e quer vender no Mercado Livre.',
  peQueParou: 'Você perguntou se ele consegue investir R$3 mil e ele ainda não respondeu.',
  ultimaPergunta: 'Você: Consegue investir a partir de R$3 mil?',
  proximoPasso: 'Retomar confirmando o investimento.',
  aguardando: 'lead',
  ultimaMensagem: '21/09 10:05',
};

const COACH_FALSO = {
  perfil: { tipo: 'analítico', evidencia: 'Pediu números e prova de resultado.' },
  comoAbordar: 'Seja objetivo e traga dados antes de falar de preço.',
  objecoes: [{ objecao: 'Achou o investimento alto', resposta: 'Posso te mostrar quanto os clientes recuperam nos primeiros meses?' }],
  perguntas: ['Quanto você fatura hoje por mês?', 'Quem mais participa da decisão?'],
};

function crmFalso(responder, opcoes = {}) {
  const consultas = [];
  const resumosPedidos = [];
  const coachPedidos = [];
  const feedbacks = [];
  const aoEnviar = async (original) => {
    const msg = JSON.parse(JSON.stringify(original));
    if (msg.action === 'crmLead') {
      consultas.push({ telefone: msg.telefone || '', nome: msg.nome || '', contatoId: msg.contatoId || '', ...(msg.dealId ? { dealId: msg.dealId, lembrar: msg.lembrar === true } : {}) });
      return responder(msg);
    }
    if (msg.action === 'reportFetch') return { ok: true, dados: {}, arquivo: 'r.pdf', arquivoBase64: 'AAAA', mensagensRecebidas: msg.mensagens };
    if (msg.action === 'coach') {
      coachPedidos.push(msg);
      return opcoes.coach ? opcoes.coach(msg) : { ok: true, coach: COACH_FALSO, cache: false };
    }
    if (msg.action === 'coachFeedback') {
      feedbacks.push(msg);
      return { ok: true };
    }
    if (msg.action === 'resumoRapido') {
      resumosPedidos.push(msg);
      return opcoes.resumo ? opcoes.resumo(msg) : { ok: true, resumo: RESUMO_FALSO, cache: false };
    }
    return { ok: true };
  };
  return { aoEnviar, consultas, resumosPedidos, coachPedidos, feedbacks };
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

// ---------------------------------------------------------------- Coach da conversa
const comCoach = (r) => ({ ...r, coach: true });

test('coach: só aparece o botão se o servidor liberou para este usuário', async () => {
  const sem = crmFalso(() => ({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS, coach: false }));
  const p1 = abrir(sem);
  await esperar(() => /Investimento/.test(textoCartao(p1)), { motivo: 'ficha' });
  assert.ok(botao(p1, 'Resumo rápido da conversa'));
  assert.equal(botao(p1, 'Coach da conversa'), undefined);
  p1.fechar();

  const com = crmFalso(() => comCoach({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p2 = abrir(com);
  await esperar(() => /Investimento/.test(textoCartao(p2)), { motivo: 'ficha' });
  assert.ok(botao(p2, 'Coach da conversa'));
  p2.fechar();
});

test('coach: o botão mostra perfil, como abordar, objeção com resposta e perguntas', async () => {
  const srv = crmFalso(() => comCoach({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => !!botao(p, 'Coach da conversa'), { motivo: 'botão do coach' });
  botao(p, 'Coach da conversa').click();
  await esperar(() => /Perguntas para aprofundar/.test(textoCartao(p)), { motivo: 'coach na tela' });
  assert.deepEqual(srv.coachPedidos[0].mensagens.map((m) => m.content), ['Oi, tudo bem?', 'Tudo sim']);
  const t = textoCartao(p);
  for (const x of ['COACH', 'Perfil do lead', 'analítico', 'Pediu números e prova de resultado.', 'Como abordar', 'traga dados antes de falar de preço',
    'Objeção: Achou o investimento alto', 'Posso te mostrar quanto os clientes recuperam', '• Quanto você fatura hoje por mês?', '• Quem mais participa da decisão?']) {
    assert.ok(t.includes(x), 'faltou no cartão: ' + x);
  }
  assert.equal(p.document.getElementById('closer-report-badge'), null, 'o aviso de andamento some');
  p.fechar();
});

test('coach aprende: "Funcionou" manda a sugestão ao servidor uma vez só', async () => {
  const srv = crmFalso(() => comCoach({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }));
  const p = abrir(srv);
  await esperar(() => !!botao(p, 'Coach da conversa'), { motivo: 'botão' });
  botao(p, 'Coach da conversa').click();
  await esperar(() => /Perguntas para aprofundar/.test(textoCartao(p)), { motivo: 'coach' });
  const funcionou = [...cartao(p).querySelectorAll('button')].filter((b) => b.textContent === 'Funcionou');
  assert.equal(funcionou.length, 4, 'abordagem + 1 objeção + 2 perguntas');
  funcionou[1].click(); // a objeção
  funcionou[1].click(); // clique repetido não duplica
  await esperar(() => srv.feedbacks.length === 1, { motivo: 'feedback' });
  assert.deepEqual({ tipo: srv.feedbacks[0].tipo, texto: srv.feedbacks[0].texto, contexto: srv.feedbacks[0].contexto, util: srv.feedbacks[0].util },
    { tipo: 'objecao', texto: 'Posso te mostrar quanto os clientes recuperam nos primeiros meses?', contexto: 'Achou o investimento alto', util: true });
  assert.equal(funcionou[1].disabled, true);
  await dormir(60);
  assert.equal(srv.feedbacks.length, 1);
  p.fechar();
});

test('coach: erro (ex.: limite gratuito) mostra a mensagem e "Tentar de novo" pede outra vez', async () => {
  let vez = 0;
  const srv = crmFalso(() => comCoach({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }), {
    coach: () => (++vez === 1 ? { ok: false, erro: 'O limite gratuito do coach foi atingido por agora.' } : { ok: true, coach: COACH_FALSO }),
  });
  const p = abrir(srv);
  await esperar(() => !!botao(p, 'Coach da conversa'), { motivo: 'botão' });
  botao(p, 'Coach da conversa').click();
  await esperar(() => /limite gratuito/.test(textoCartao(p)), { motivo: 'erro' });
  [...cartao(p).querySelectorAll('button')].filter((b) => b.textContent === 'Tentar de novo').pop().click();
  await esperar(() => /Perguntas para aprofundar/.test(textoCartao(p)), { motivo: 'coach na 2ª' });
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

// ---------------------------------------------------------------- Coach não depende mais da ficha do RD
test('coach sem RD: CRM desligado no servidor (ou popup do lead desligado) ainda mostra o cartão com resumo e coach', async () => {
  const srv = crmFalso(() => ({ ok: true, configurado: false, coach: true }));
  const p = abrir(srv);
  await esperar(() => !!botao(p, 'Coach da conversa'), { motivo: 'cartão só com o coach' });
  const t = textoCartao(p);
  assert.ok(t.includes('PRONIX') && !t.includes('RD STATION'));
  assert.ok(!t.includes('Não achei este lead'), 'sem busca de RD neste cartão');
  assert.ok(botao(p, 'Resumo rápido da conversa'));
  p.fechar();

  // sem o coach liberado, CRM desligado continua sem cartão nenhum
  const sem = crmFalso(() => ({ ok: true, configurado: false, coach: false }));
  const q = abrir(sem);
  await esperar(() => sem.consultas.length === 1, { motivo: 'consulta' });
  await dormir(60);
  assert.equal(cartao(q), null);
  q.fechar();
});

test('coach: a permissão vem da chave — aparece mesmo quando a consulta ao RD dá erro', async () => {
  const srv = crmFalso(() => ({ ok: false, erro: 'RD Station fora do ar' }));
  const aoEnviar = async (msg) => (msg.action === 'permissoes' ? { ok: true, coach: true, papel: 'master' } : srv.aoEnviar(msg));
  const p = abrir({ aoEnviar });
  await esperar(() => /RD Station fora do ar/.test(textoCartao(p)), { motivo: 'erro do RD na tela' });
  await esperar(() => !!botao(p, 'Coach da conversa'), { motivo: 'coach apesar do erro' });
  p.fechar();
});

test('coach: mostra o que falta levantar e a próxima mensagem pronta (copiar e marcar "Funcionou")', async () => {
  const completo = {
    ...COACH_FALSO,
    perfil: { tipo: 'Dominante', chave: 'dominante', evidencia: 'Respondeu só "quanto custa?".' },
    faltaLevantar: ['Quem decide junto', 'Por que agora'],
    proximaMensagem: 'Te passo já. Antes: você decide isso sozinho?',
  };
  const srv = crmFalso(() => comCoach({ ok: true, configurado: true, encontrado: true, ficha: FICHA_MARCOS }), { coach: () => ({ ok: true, coach: completo }) });
  const p = abrir(srv);
  let copiado = null;
  Object.defineProperty(p.w.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { copiado = t; } } });
  await esperar(() => !!botao(p, 'Coach da conversa'), { motivo: 'botão' });
  botao(p, 'Coach da conversa').click();
  await esperar(() => /Próxima mensagem/.test(textoCartao(p)), { motivo: 'coach completo' });
  const t = textoCartao(p);
  for (const x of ['Dominante', 'Respondeu só "quanto custa?".', 'Ainda falta levantar', '• Quem decide junto', '• Por que agora', 'Te passo já. Antes: você decide isso sozinho?']) {
    assert.ok(t.includes(x), 'faltou no cartão: ' + x);
  }
  botao(p, 'Copiar').click();
  await esperar(() => copiado !== null, { motivo: 'copiou' });
  assert.equal(copiado, 'Te passo já. Antes: você decide isso sozinho?');
  const funcionou = [...cartao(p).querySelectorAll('button')].filter((b) => b.textContent === 'Funcionou');
  funcionou[funcionou.length - 1].click();
  await esperar(() => srv.feedbacks.length === 1, { motivo: 'feedback da mensagem' });
  assert.equal(srv.feedbacks[0].tipo, 'mensagem');
  assert.equal(srv.feedbacks[0].contexto, 'Dominante');
  p.fechar();
});
