'use strict';
// Popup do Coach no WhatsApp Web (content.js REAL em DOM simulado): um popup separado do cartão da
// ficha, que só pede a dica quando o usuário clica. Sem rede e sem IA.
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

const CONVERSA = [{ from: 'eu', texto: 'Oi Marcos! Você já vende no Mercado Livre ou está começando do zero?' }, { from: 'eles', texto: 'Estou começando do zero' }];

// Teste que falha no meio não pode deixar janela aberta (o vigia seguraria o processo para sempre).
const abertas = [];
test.afterEach(() => abertas.splice(0).forEach((p) => p.fechar()));

function abrir(srv, conversa = CONVERSA, { contato = '+55 71 99999-8888', storage = {} } = {}) {
  const p = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar: srv.aoEnviar, intervaloRapido: true, storage });
  montarWhatsApp(p, conversa, { contato, idsSimples: true });
  abertas.push(p);
  return p;
}
const popup = (p) => p.document.getElementById('cr-coach');
const texto = (p) => (popup(p) ? popup(p).textContent : '');
const cartao = (p) => p.document.getElementById('cr-ficha-crm');
const botao = (p, rotulo) => (popup(p) ? [...popup(p).querySelectorAll('button')].find((b) => b.textContent === rotulo) : undefined);
const popupPronto = (p) => esperar(() => !!botao(p, 'Pedir dica'), { motivo: 'popup do coach com o botão' });
const dicaNaTela = (p) => esperar(() => /Próxima mensagem/.test(texto(p)), { motivo: 'dica no popup' });
/** Abre o popup e pede a primeira dica. */
async function comDica(p) {
  await popupPronto(p);
  botao(p, 'Pedir dica').click();
  await dicaNaTela(p);
}

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
test('sem o coach liberado: nenhum popup, nenhum pedido — e o cartão da ficha não tem botão de coach', async () => {
  const sem = servidorFalso({ coach: false });
  const p = abrir(sem);
  await esperar(() => cartao(p) && /Funil SDR/.test(cartao(p).textContent), { motivo: 'ficha' });
  await dormir(200);
  assert.equal(popup(p), null);
  assert.equal(sem.pedidos.coach.length, 0);

  const com = servidorFalso();
  const q = abrir(com);
  await popupPronto(q);
  await esperar(() => cartao(q) && /Funil SDR/.test(cartao(q).textContent), { motivo: 'ficha' });
  assert.ok(![...cartao(q).querySelectorAll('button')].some((b) => /coach/i.test(b.textContent)), 'o coach é um popup separado do cartão');
  assert.equal(q.document.querySelector('#main').contains(popup(q)), false, 'fora do #main: o report nunca lê o popup como mensagem');
  assert.notEqual(popup(q), cartao(q));
});

// ---------------------------------------------------------------- só no clique
test('o coach só trabalha no clique: abrir a conversa ou chegar mensagem do lead não pede nada sozinho', async () => {
  const srv = servidorFalso();
  const p = abrir(srv);
  await popupPronto(p);
  assert.match(texto(p), /COACH/);
  assert.match(texto(p), /Peça a dica de como seguir/);
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 0, 'conversa aberta com o lead falando por último: nenhum pedido');
  chegarMensagem(p, 'Tenho uma loja de moto peças');
  chegarMensagem(p, 'E uns 5 mil guardados');
  await dormir(400);
  assert.equal(srv.pedidos.coach.length, 0, 'mensagens novas do lead: nenhum pedido');
  assert.equal(srv.pedidos.audio.length, 0);
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => srv.pedidos.ficha.length === 2, { motivo: 'outra conversa' });
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 0, 'trocar de conversa: nenhum pedido');
});

test('"Pedir dica": lê só o que está na tela (sem rolar nem tocar áudio) e mostra o que fazer agora', async () => {
  const srv = servidorFalso();
  const p = abrir(srv);
  await comDica(p);
  assert.equal(srv.pedidos.coach.length, 1);
  assert.deepEqual(srv.pedidos.coach[0].mensagens.map((m) => [m.from, m.type, m.content]), [
    ['eu', 'texto', 'Oi Marcos! Você já vende no Mercado Livre ou está começando do zero?'],
    ['eles', 'texto', 'Estou começando do zero'],
  ]);
  const t = texto(p);
  for (const x of ['COACH', 'AGORA', DICA.agora, 'Próxima mensagem', DICA.proximaMensagem, 'Perfil do lead: Analítico',
    'Análise completa', 'Pediu números antes de avançar.', 'Como abordar', 'Ainda falta levantar', '• Quem decide junto',
    'Objeção: Achou o investimento alto', 'Perguntas para aprofundar', '• Quanto você tem disponível hoje?']) {
    assert.ok(t.includes(x), 'faltou no popup: ' + x);
  }
  assert.ok(t.indexOf('AGORA') < t.indexOf('Próxima mensagem') && t.indexOf('Próxima mensagem') < t.indexOf('Análise completa'), 'a dica do momento vem primeiro');
  assert.equal(popup(p).querySelector('details').open, false, 'a análise completa fica recolhida');
  assert.equal(p.document.getElementById('closer-report-badge'), null, 'leitura leve: sem o aviso de "lendo a conversa"');
  assert.equal(srv.pedidos.audio.length, 0);
});

test('chegou mensagem depois da dica: o popup avisa, e só o clique em "Atualizar" pede a nova', async () => {
  const srv = servidorFalso({ dica: (msg, n) => ({ ok: true, coach: { ...DICA, agora: 'Dica número ' + n } }) });
  const p = abrir(srv);
  await comDica(p);
  assert.match(texto(p), /Dica número 1/);
  assert.doesNotMatch(texto(p), /Chegaram mensagens/);

  chegarMensagem(p, 'Tenho uns 5 mil guardados');
  await esperar(() => /Chegaram mensagens depois desta dica/.test(texto(p)), { motivo: 'aviso de mensagens novas' });
  assert.match(texto(p), /Dica número 1/, 'a dica anterior continua na tela');
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 1, 'avisa, mas não pede sozinho');

  botao(p, 'Atualizar').click();
  await esperar(() => /Dica número 2/.test(texto(p)), { motivo: 'dica nova' });
  assert.equal(srv.pedidos.coach.length, 2);
  assert.equal(srv.pedidos.coach[1].mensagens.at(-1).content, 'Tenho uns 5 mil guardados');
  assert.doesNotMatch(texto(p), /Chegaram mensagens/);
});

test('erro (limite gratuito): mostra a mensagem; "Tentar de novo" pede outra vez; com dica na tela, o erro não a apaga', async () => {
  let falhar = true;
  const srv = servidorFalso({ dica: () => (falhar ? { ok: false, erro: 'O limite gratuito da IA foi atingido por agora.' } : { ok: true, coach: DICA }) });
  const p = abrir(srv);
  await popupPronto(p);
  botao(p, 'Pedir dica').click();
  await esperar(() => /limite gratuito/.test(texto(p)), { motivo: 'erro no popup' });
  await dormir(200);
  assert.equal(srv.pedidos.coach.length, 1, 'não tenta de novo sozinho');

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
  await comDica(p);
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
  await comDica(p);
  assert.deepEqual(srv.pedidos.coach[0].mensagens.map((m) => [m.type, m.content]), [
    ['texto', 'Quanto você tem para começar?'], ['audio', '[áudio]'], ['texto', 'te mandei em áudio'],
  ], '"Pedir dica" manda o áudio como [áudio]: nada é tocado');
  assert.match(texto(p), /1 áudio\(s\) do lead ainda sem leitura/);
  assert.equal(srv.pedidos.audio.length, 0);

  botao(p, 'Ler conversa inteira').click();
  await esperar(() => srv.pedidos.coach.length === 2 && /Próxima mensagem/.test(texto(p)), { motivo: 'leitura completa' });
  assert.equal(srv.pedidos.audio.length, 1, 'transcreveu o áudio');
  assert.equal(srv.pedidos.coach[1].mensagens[1].content, 'tenho cinco mil guardados pra começar');
  assert.doesNotMatch(texto(p), /sem leitura/);
  assert.equal(p.document.getElementById('closer-report-badge'), null, 'o aviso de andamento some ao terminar');

  // mensagem nova do lead + "Atualizar": a leitura leve já leva o áudio transcrito, sem tocar de novo
  chegarMensagem(p, 'consegue me ajudar?');
  await esperar(() => /Chegaram mensagens depois desta dica/.test(texto(p)), { motivo: 'aviso' });
  botao(p, 'Atualizar').click();
  await esperar(() => srv.pedidos.coach.length === 3, { motivo: 'dica atualizada' });
  assert.deepEqual(srv.pedidos.coach[2].mensagens.map((m) => m.content), [
    'Quanto você tem para começar?', 'tenho cinco mil guardados pra começar', 'te mandei em áudio', 'consegue me ajudar?',
  ]);
  assert.equal(srv.pedidos.audio.length, 1);
});

// ---------------------------------------------------------------- o popup em si
test('minimizado mostra só a dica do momento; arrastar guarda o lugar; × fecha só nesta conversa', async () => {
  const srv = servidorFalso();
  const p = abrir(srv);
  await comDica(p);

  botao(p, '–').click();
  assert.equal(p.storage.coachMinimizado, true);
  assert.ok(texto(p).includes(DICA.agora), 'minimizado: a dica do momento continua à vista');
  assert.doesNotMatch(texto(p), /Próxima mensagem/);
  botao(p, '+').click();
  assert.match(texto(p), /Próxima mensagem/);

  // arrastar pelo topo
  const alca = () => [...popup(p).querySelectorAll('div')].find((d) => /^Arraste/.test(d.title));
  alca().dispatchEvent(new p.w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  p.document.dispatchEvent(new p.w.MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }));
  p.document.dispatchEvent(new p.w.MouseEvent('mouseup', { bubbles: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(p.storage.coachPos)), { left: 390, top: 290 }); // (o objeto vem da janela simulada)
  assert.equal(popup(p).style.left, '390px');
  assert.equal(popup(p).style.top, '290px');
  await dormir(60);
  assert.equal(popup(p).style.left, '390px', 'o vigia não puxa o popup de volta');
  alca().dispatchEvent(new p.w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(p.storage.coachPos, null, 'duplo clique volta ao lugar padrão');
  assert.equal(popup(p).style.left, '16px');

  botao(p, '×').click();
  assert.equal(popup(p), null);
  await dormir(200);
  assert.equal(popup(p), null, 'continua fechado nesta conversa');
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => popup(p) !== null, { motivo: 'volta na próxima conversa' });
});

test('popup minimizado e posição ficam guardados para a próxima vez', async () => {
  const srv = servidorFalso();
  const p = abrir(srv, CONVERSA, { storage: { coachMinimizado: true, coachPos: { left: 120, top: 200 } } });
  await esperar(() => popup(p) !== null, { motivo: 'popup' });
  assert.equal(popup(p).style.left, '120px');
  assert.equal(popup(p).style.top, '200px');
  assert.equal(botao(p, 'Pedir dica'), undefined, 'minimizado: só o topo');
  botao(p, '+').click();
  assert.ok(botao(p, 'Pedir dica'));
});

test('cada conversa tem a sua dica: trocar e voltar mostra a de cada uma, sem pedir de novo', async () => {
  const srv = servidorFalso({ dica: (msg, n) => ({ ok: true, coach: { ...DICA, agora: 'Dica número ' + n } }) });
  const p = abrir(srv);
  await comDica(p);
  assert.match(texto(p), /Dica número 1/);
  trocarConversa(p, '+55 11 98888-7777');
  await esperar(() => !!botao(p, 'Pedir dica') && !/Dica número/.test(texto(p)), { motivo: '2ª conversa sem dica ainda' });
  botao(p, 'Pedir dica').click();
  await esperar(() => /Dica número 2/.test(texto(p)), { motivo: 'dica da 2ª conversa' });
  trocarConversa(p, '+55 71 99999-8888');
  await esperar(() => /Dica número 1/.test(texto(p)), { motivo: 'de volta à 1ª: a dica dela' });
  await dormir(300);
  assert.equal(srv.pedidos.coach.length, 2);
});

test('o coach não depende do RD: CRM desligado ou com erro, o popup aparece e a dica funciona', async () => {
  const semCrm = servidorFalso({ crm: () => ({ ok: true, configurado: false }) });
  const p = abrir(semCrm);
  await comDica(p);
  assert.equal(semCrm.pedidos.coach.length, 1);

  const comErro = servidorFalso({ crm: () => ({ ok: false, erro: 'RD Station fora do ar' }) });
  const q = abrir(comErro);
  await comDica(q);
  await esperar(() => cartao(q) && /RD Station fora do ar/.test(cartao(q).textContent), { motivo: 'o cartão mostra o erro do RD' });
});

test('com um report em andamento, pedir a dica avisa para esperar (e não lê nada)', async () => {
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
  const p = abrir(srv);
  await popupPronto(p);
  p.iniciar();
  await esperar(() => typeof soltar === 'function', { motivo: 'report em andamento' });
  botao(p, 'Pedir dica').click();
  await esperar(() => /Espere o report ou o resumo terminarem/.test(texto(p)), { motivo: 'aviso para esperar' });
  assert.equal(srv.pedidos.coach.length, 0);
  soltar();
  await esperar(() => /Report pronto/.test(p.badge()), { motivo: 'report terminou' });
  botao(p, 'Tentar de novo').click();
  await dicaNaTela(p);
  assert.equal(srv.pedidos.coach.length, 1);
});
