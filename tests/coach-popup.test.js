'use strict';
// Popup do Coach no WhatsApp Web (content.js REAL em DOM simulado): ele acompanha a conversa e pede a
// dica sozinho quando o lead responde, lendo só o que já está na tela. Sem rede e sem IA.
const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, montarWhatsApp, esperar, dormir } = require('./helpers/dom');

const FICHA = {
  nome: 'Marcos Pereira', telefones: ['(71) 99999-8888'], emails: [],
  negociacao: { nome: 'Marcos Pereira', etapa: 'Respondeu', funil: 'Funil SDR', responsavel: 'Cauã Lima', fonte: '', campanha: '', criadaEm: '', url: 'https://crm.rdstation.com/app/deals/d1' },
  totalNegociacoes: 1, negociacoes: [{ id: 'd1', nome: 'Marcos Pereira', etapa: 'Respondeu', funil: 'Funil SDR', aberta: true, escolhida: true }],
  formulario: null, campos: [], anotacoes: [],
};
const DICA = {
  perfil: { tipo: 'Analítico', chave: 'analitico', evidencia: 'Pediu números antes de avançar.' },
  agora: 'Ele começa do zero: confirme a reserva para o estoque antes de falar do método.',
  comoAbordar: 'Seja objetivo e traga dados.',
  faltaLevantar: ['Quem decide junto', 'Por que agora'],
  objecoes: [{ objecao: 'Achou o investimento alto', resposta: 'Posso te mostrar quanto os clientes recuperam?' }],
  perguntas: ['Quanto você tem disponível hoje?', 'Quem mais participa da decisão?'],
  proximaMensagem: 'Legal, Marcos! Você já tem uma reserva de pelo menos R$3 mil para o primeiro estoque?',
};

/** Service worker falso. `dica(msg, n)` responde o n-ésimo pedido de coach; `crm` responde a ficha. */
function servidorFalso({ coach = true, crm, dica } = {}) {
  const pedidos = { coach: [], feedback: [], ficha: [], audio: [] };
  const aoEnviar = async (original) => {
    const msg = JSON.parse(JSON.stringify(original));
    if (msg.action === 'crmLead') {
      pedidos.ficha.push(msg);
      return { ...(crm ? crm(msg) : { ok: true, configurado: true, encontrado: true, ficha: FICHA }), coach };
    }
    if (msg.action === 'permissoes') return { ok: true, coach, papel: 'master' };
    if (msg.action === 'coach') {
      pedidos.coach.push(msg);
      return dica ? dica(msg, pedidos.coach.length) : { ok: true, coach: DICA, cache: false };
    }
    if (msg.action === 'coachFeedback') {
      pedidos.feedback.push(msg);
      return { ok: true };
    }
    if (msg.action === 'transcreverAudio') {
      pedidos.audio.push(msg);
      return { ok: true, texto: 'tenho cinco mil guardados pra começar' };
    }
    return { ok: true };
  };
  return { aoEnviar, pedidos };
}

const LEAD_POR_ULTIMO = [{ from: 'eu', texto: 'Oi Marcos! Você já vende no Mercado Livre ou está começando do zero?' }, { from: 'eles', texto: 'Estou começando do zero' }];
const EU_POR_ULTIMO = [{ from: 'eu', texto: 'Oi Marcos, tudo bem?' }, { from: 'eu', texto: 'Consegue falar agora?' }];

// Teste que falha no meio não pode deixar janela aberta (o vigia seguraria o processo para sempre).
const abertas = [];
test.afterEach(() => abertas.splice(0).forEach((p) => p.fechar()));

function abrir(srv, conversa = LEAD_POR_ULTIMO, { contato = '+55 71 99999-8888', storage = {} } = {}) {
  const p = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar: srv.aoEnviar, intervaloRapido: true, storage });
  montarWhatsApp(p, conversa, { contato, idsSimples: true });
  abertas.push(p);
  return p;
}
const popup = (p) => p.document.getElementById('cr-coach');
const texto = (p) => (popup(p) ? popup(p).textContent : '');
const cartao = (p) => p.document.getElementById('cr-ficha-crm');
const botao = (p, rotulo) => (popup(p) ? [...popup(p).querySelectorAll('button')].find((b) => b.textContent === rotulo) : undefined);
const dicaNaTela = (p) => esperar(() => /Próxima mensagem/.test(texto(p)), { motivo: 'dica no popup' });

let seq = 0;
function chegarMensagem(p, textoMsg, de = 'eles') {
  const el = p.document.createElement('div');
  el.className = de === 'eu' ? 'message-out' : 'message-in';
  el.setAttribute('data-id', 'A5NOVA' + String(++seq).padStart(6, '0'));
  el.innerHTML = `<div class="copyable-text" data-pre-plain-text="[10:05, 01/09/2026] ${de === 'eu' ? 'Você' : 'Marcos'}: "><span class="selectable-text"></span></div>`;
  el.querySelector('.selectable-text').textContent = textoMsg;
  p.document.getElementById('rolagem').appendChild(el);
}
const trocarConversa = (p, contato) => {
  const s = p.document.querySelector('#main header span');
  s.setAttribute('title', contato);
  s.textContent = contato;
};

// ---------------------------------------------------------------- quem vê
test('sem o coach liberado: nenhum popup, nenhum pedido — e o cartão da ficha não tem mais botão de coach', async () => {
  const sem = servidorFalso({ coach: false });
  const p = abrir(sem);
  await esperar(() => cartao(p) && /Funil SDR/.test(cartao(p).textContent), { motivo: 'ficha' });
  await dormir(200);
  assert.equal(popup(p), null);
  assert.equal(sem.pedidos.coach.length, 0);

  const com = servidorFalso();
  const q = abrir(com);
  await dicaNaTela(q);
  assert.ok(![...cartao(q).querySelectorAll('button')].some((b) => /coach/i.test(b.textContent)), 'o coach saiu de dentro do cartão');
  assert.equal(q.document.querySelector('#main').contains(popup(q)), false, 'fora do #main: o report nunca lê o popup como mensagem');
});

// ---------------------------------------------------------------- acompanhar a conversa
test('lead falou por último: a dica chega sozinha, lendo só o que está na tela (sem rolar nem tocar áudio)', async () => {
  const srv = servidorFalso();
  const p = abrir(srv);
  await dicaNaTela(p);
  assert.equal(srv.pedidos.coach.length, 1);
  assert.deepEqual(srv.pedidos.coach[0].mensagens.map((m) => [m.from, m.type, m.content]), [
    ['eu', 'texto', 'Oi Marcos! Você já vende no Mercado Livre ou está começando do zero?'],
    ['eles', 'texto', 'Estou começando do zero'],
  ]);
  const t = texto(p);
  for (const x of ['COACH', 'acompanhando a conversa', 'AGORA', DICA.agora, 'Próxima mensagem', DICA.proximaMensagem, 'Perfil do lead: Analítico',
    'Análise completa', 'Pediu números antes de avançar.', 'Como abordar', 'Ainda falta levantar', '• Quem decide junto',
    'Objeção: Achou o investimento alto', 'Perguntas para aprofundar', '• Quanto você tem disponível hoje?']) {
    assert.ok(t.includes(x), 'faltou no popup: ' + x);
  }
  assert.ok(t.indexOf('AGORA') < t.indexOf('Próxima mensagem') && t.indexOf('Próxima mensagem') < t.indexOf('Análise completa'), 'a dica do momento vem primeiro');
  assert.equal(popup(p).querySelector('details').open, false, 'a análise completa fica recolhida');
  assert.equal(p.document.getElementById('closer-report-badge'), null, 'leitura leve: sem o aviso de "lendo a conversa"');
  assert.equal(srv.pedidos.audio.length, 0);
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 1, 'sem mensagem nova, não pede de novo');
});

test('eu falei por último: espera o lead; quando ele responde, pede; várias mensagens seguidas viram um pedido só', async () => {
  const srv = servidorFalso();
  const p = abrir(srv, EU_POR_ULTIMO);
  await esperar(() => /Você falou por último/.test(texto(p)), { motivo: 'aguardando o lead' });
  await dormir(250);
  assert.equal(srv.pedidos.coach.length, 0);

  chegarMensagem(p, 'Oi, pode falar');
  await dicaNaTela(p);
  assert.equal(srv.pedidos.coach.length, 1);
  assert.equal(srv.pedidos.coach[0].mensagens.at(-1).content, 'Oi, pode falar');

  // o lead manda três mensagens em sequência: um pedido só, já com as três
  chegarMensagem(p, 'Eu trabalho com moto peças');
  await dormir(15);
  chegarMensagem(p, 'Tenho loja física');
  await dormir(15);
  chegarMensagem(p, 'Mas quero vender online');
  await esperar(() => srv.pedidos.coach.length === 2, { motivo: 'pedido da rajada' });
  assert.deepEqual(srv.pedidos.coach[1].mensagens.slice(-3).map((m) => m.content), ['Eu trabalho com moto peças', 'Tenho loja física', 'Mas quero vender online']);
  await dormir(400);
  assert.equal(srv.pedidos.coach.length, 2);

  // eu respondo: a dica fica, com o aviso de que agora é a vez do lead — e nada é pedido
  chegarMensagem(p, 'Legal! E você já tem uma reserva para o estoque?', 'eu');
  await esperar(() => /aguardando o lead responder/.test(texto(p)), { motivo: 'vez do lead' });
  assert.match(texto(p), /Próxima mensagem/);
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 2);
});

test('pausar: para de pedir sozinho (fica guardado) e "Pedir dica agora" continua funcionando', async () => {
  const srv = servidorFalso();
  const p = abrir(srv, LEAD_POR_ULTIMO, { storage: { coachAcompanhar: false } });
  await esperar(() => /acompanhamento pausado/.test(texto(p)), { motivo: 'popup pausado' });
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 0);
  botao(p, 'Pedir dica agora').click();
  await dicaNaTela(p);
  assert.equal(srv.pedidos.coach.length, 1);
  chegarMensagem(p, 'Tenho uns 5 mil');
  await dormir(400);
  assert.equal(srv.pedidos.coach.length, 1, 'pausado: mensagem nova não pede dica');

  botao(p, 'Acompanhar').click();
  assert.equal(p.storage.coachAcompanhar, true);
  await esperar(() => srv.pedidos.coach.length === 2, { motivo: 'religado: olha de novo o ponto da conversa' });
  botao(p, 'Pausar').click();
  assert.equal(p.storage.coachAcompanhar, false);
});

test('limite gratuito atingido: mostra a mensagem e não fica insistindo; com dica na tela, o erro não a apaga', async () => {
  let falhar = true;
  const srv = servidorFalso({ dica: () => (falhar ? { ok: false, erro: 'O limite gratuito da IA foi atingido por agora.' } : { ok: true, coach: DICA }) });
  const p = abrir(srv);
  await esperar(() => /limite gratuito/.test(texto(p)), { motivo: 'erro no popup' });
  chegarMensagem(p, 'Oi?');
  await dormir(250);
  assert.equal(srv.pedidos.coach.length, 1, 'depois de um erro, dá um tempo antes de pedir de novo');

  falhar = false;
  botao(p, 'Tentar de novo').click();
  await dicaNaTela(p);
  assert.equal(srv.pedidos.coach.length, 2);

  falhar = true;
  botao(p, 'Atualizar').click();
  await esperar(() => /limite gratuito/.test(texto(p)), { motivo: 'erro com a dica na tela' });
  assert.match(texto(p), /Próxima mensagem/, 'a última dica continua na tela');
  assert.ok(texto(p).includes(DICA.agora));
});

test('"Funcionou" ensina o coach uma vez só; "Copiar" copia a próxima mensagem', async () => {
  const srv = servidorFalso();
  const p = abrir(srv);
  let copiado = null;
  Object.defineProperty(p.w.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { copiado = t; } } });
  await dicaNaTela(p);
  botao(p, 'Copiar').click();
  await esperar(() => copiado !== null, { motivo: 'copiou' });
  assert.equal(copiado, DICA.proximaMensagem);

  const funcionou = [...popup(p).querySelectorAll('button')].filter((b) => b.textContent === 'Funcionou');
  assert.equal(funcionou.length, 5, 'próxima mensagem + abordagem + 1 objeção + 2 perguntas');
  funcionou[0].click();
  funcionou[0].click(); // clique repetido não duplica
  await esperar(() => srv.pedidos.feedback.length === 1, { motivo: 'feedback' });
  assert.deepEqual(
    { tipo: srv.pedidos.feedback[0].tipo, texto: srv.pedidos.feedback[0].texto, contexto: srv.pedidos.feedback[0].contexto, util: srv.pedidos.feedback[0].util },
    { tipo: 'mensagem', texto: DICA.proximaMensagem, contexto: 'Analítico', util: true }
  );
  assert.equal(funcionou[0].disabled, true);
  await dormir(60);
  assert.equal(srv.pedidos.feedback.length, 1);
});

// ---------------------------------------------------------------- áudios
test('"Ler conversa inteira" transcreve os áudios, e as dicas seguintes já vêm com a transcrição', async () => {
  const srv = servidorFalso();
  const p = abrir(srv, [
    { from: 'eu', texto: 'Quanto você tem para começar?' },
    { from: 'eles', tipo: 'audio' },
    { from: 'eles', texto: 'te mandei em áudio' },
  ]);
  await dicaNaTela(p);
  assert.deepEqual(srv.pedidos.coach[0].mensagens.map((m) => [m.type, m.content]), [
    ['texto', 'Quanto você tem para começar?'], ['audio', '[áudio]'], ['texto', 'te mandei em áudio'],
  ], 'na leitura leve o áudio vai como [áudio]: nada é tocado');
  assert.match(texto(p), /1 áudio\(s\) do lead ainda sem leitura/);
  assert.equal(srv.pedidos.audio.length, 0);

  botao(p, 'Ler conversa inteira').click();
  await esperar(() => srv.pedidos.coach.length === 2 && /Próxima mensagem/.test(texto(p)), { motivo: 'leitura completa' });
  assert.equal(srv.pedidos.audio.length, 1, 'transcreveu o áudio');
  assert.equal(srv.pedidos.coach[1].mensagens[1].content, 'tenho cinco mil guardados pra começar');
  assert.doesNotMatch(texto(p), /sem leitura/);
  assert.equal(p.document.getElementById('closer-report-badge'), null, 'o aviso de andamento some ao terminar');
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 2, 'o que foi lido não é pedido de novo');

  // mensagem nova do lead: a dica automática já leva o áudio transcrito, sem tocar de novo
  chegarMensagem(p, 'consegue me ajudar?');
  await esperar(() => srv.pedidos.coach.length === 3, { motivo: 'dica automática depois da leitura completa' });
  assert.deepEqual(srv.pedidos.coach[2].mensagens.map((m) => m.content), [
    'Quanto você tem para começar?', 'tenho cinco mil guardados pra começar', 'te mandei em áudio', 'consegue me ajudar?',
  ]);
  assert.equal(srv.pedidos.audio.length, 1);
});

// ---------------------------------------------------------------- o popup em si
test('minimizado mostra só a dica do momento; arrastar guarda o lugar; × fecha só nesta conversa', async () => {
  const srv = servidorFalso();
  const p = abrir(srv);
  await dicaNaTela(p);

  botao(p, '–').click();
  assert.equal(p.storage.coachMinimizado, true);
  assert.ok(texto(p).includes(DICA.agora), 'minimizado: a dica do momento continua à vista');
  assert.doesNotMatch(texto(p), /Próxima mensagem/);
  botao(p, '+').click();
  assert.match(texto(p), /Próxima mensagem/);

  // arrastar pelo topo
  const alca = [...popup(p).querySelectorAll('div')].find((d) => /^Arraste/.test(d.title));
  alca.dispatchEvent(new p.w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  p.document.dispatchEvent(new p.w.MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }));
  p.document.dispatchEvent(new p.w.MouseEvent('mouseup', { bubbles: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(p.storage.coachPos)), { left: 390, top: 290 }); // (o objeto vem da janela simulada)
  assert.equal(popup(p).style.left, '390px');
  assert.equal(popup(p).style.top, '290px');
  await dormir(60);
  assert.equal(popup(p).style.left, '390px', 'o vigia não puxa o popup de volta');
  const alca2 = [...popup(p).querySelectorAll('div')].find((d) => /^Arraste/.test(d.title));
  alca2.dispatchEvent(new p.w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(p.storage.coachPos, null, 'duplo clique volta ao lugar padrão');
  assert.equal(popup(p).style.left, '16px');

  botao(p, '×').click();
  assert.equal(popup(p), null);
  chegarMensagem(p, 'mensagem com o popup fechado');
  await dormir(300);
  assert.equal(popup(p), null, 'continua fechado nesta conversa');
  assert.equal(srv.pedidos.coach.length, 1, 'fechado: não pede dica');
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => popup(p) !== null, { motivo: 'volta na próxima conversa' });
});

test('cada conversa tem a sua dica: trocar e voltar não pede de novo', async () => {
  const srv = servidorFalso({ dica: (msg, n) => ({ ok: true, coach: { ...DICA, agora: 'Dica número ' + n } }) });
  const p = abrir(srv);
  await esperar(() => /Dica número 1/.test(texto(p)), { motivo: 'dica da 1ª conversa' });
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => /Dica número 2/.test(texto(p)), { motivo: 'dica da 2ª conversa' });
  assert.doesNotMatch(texto(p), /Dica número 1/);
  trocarConversa(p, '+55 71 99999-8888');
  await esperar(() => /Dica número 1/.test(texto(p)), { motivo: 'de volta à 1ª: a dica dela' });
  await dormir(400);
  assert.equal(srv.pedidos.coach.length, 2);
});

test('o coach não depende do RD: CRM desligado ou com erro, o popup acompanha do mesmo jeito', async () => {
  const semCrm = servidorFalso({ crm: () => ({ ok: true, configurado: false }) });
  const p = abrir(semCrm);
  await dicaNaTela(p);
  assert.equal(semCrm.pedidos.coach.length, 1);

  const comErro = servidorFalso({ crm: () => ({ ok: false, erro: 'RD Station fora do ar' }) });
  const q = abrir(comErro);
  await dicaNaTela(q);
  await esperar(() => cartao(q) && /RD Station fora do ar/.test(cartao(q).textContent), { motivo: 'o cartão mostra o erro do RD' });
});

test('enquanto um report é gerado, o coach não lê nem pede nada por conta própria', async () => {
  let soltar;
  const srv = servidorFalso();
  const original = srv.aoEnviar;
  srv.aoEnviar = async (msg) => {
    if (msg.action === 'reportFetch') {
      await new Promise((r) => { soltar = r; });
      return { ok: true, dados: {}, arquivo: 'r.pdf', arquivoBase64: 'AAAA' };
    }
    return original(msg);
  };
  const p = abrir(srv, EU_POR_ULTIMO);
  await esperar(() => /Você falou por último/.test(texto(p)), { motivo: 'popup' });
  p.iniciar();
  await esperar(() => typeof soltar === 'function', { motivo: 'report em andamento' });
  chegarMensagem(p, 'oi, cheguei');
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 0, 'report em andamento: o coach espera');
  soltar();
  await esperar(() => srv.pedidos.coach.length === 1, { motivo: 'depois do report, a dica vem' });
});
