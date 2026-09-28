'use strict';
// Testes dos content scripts REAIS (Instagram e WhatsApp) em DOM simulado (jsdom).
// Cobrem o que não pode quebrar — ler a conversa inteira, na ordem, com o remetente certo e
// os áudios no lugar — e as correções de captura da auditoria (A01, A03, A04, A05, A09).
const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, montarInstagram, montarWhatsApp, esperar, indiceDoAudio, audioFake } = require('./helpers/dom');

const RESPOSTA_PDF = { ok: true, dados: { lead: 'X' }, arquivo: 'Report_X.pdf', arquivoBase64: 'AAAA' };

/** "Service worker" falso: transcreve devolvendo o índice do áudio; devolve um report pronto. */
function servidorFalso(opcoes = {}) {
  const chamadas = { transcricoes: 0, reports: [] };
  const aoEnviar = async (original) => {
    // As mensagens nascem na janela do jsdom (outro "realm"): copia para objetos do Node
    // para os asserts de igualdade profunda funcionarem.
    const msg = JSON.parse(JSON.stringify(original));
    if (msg.action === 'transcreverAudio') {
      chamadas.transcricoes++;
      if (opcoes.transcricaoFalha) return { ok: false, erro: 'falhou' };
      return { ok: true, texto: `transcrição do áudio ${indiceDoAudio(msg.base64)}` };
    }
    if (msg.action === 'reportFetch') {
      chamadas.reports.push(msg);
      if (opcoes.duplicado && !msg.forcarNovo) {
        return { ok: true, duplicado: true, existente: { id: 'abc', quando: Date.now(), lead: 'X', podeAbrir: true } };
      }
      return RESPOSTA_PDF;
    }
    if (msg.action === 'baixarExistente') {
      chamadas.baixou = msg;
      return { ok: true, arquivo: 'Report_Antigo.pdf', arquivoBase64: 'BBBB' };
    }
    return { ok: true };
  };
  return { aoEnviar, chamadas };
}

const terminou = (p) => /Report pronto|conversa mudou|Nenhuma mensagem|Não achei|Falha|Já existe/i.test(p.badge());
const limpar = (m) => ({ from: m.from, type: m.type, content: m.content });

async function rodarInstagram(conversa, { visiveis = 6, servidor = servidorFalso(), url = 'https://www.instagram.com/direct/t/111/', durante, opcoes = {} } = {}) {
  const pagina = abrirPagina({ arquivo: 'extension/content-instagram.js', url, aoEnviar: servidor.aoEnviar });
  const cenario = montarInstagram(pagina, conversa, { visiveis, ...opcoes });
  if (durante) durante(pagina, cenario);
  pagina.iniciar();
  await esperar(() => terminou(pagina), { motivo: 'fim do job do Instagram' });
  return { pagina, cenario, servidor, envio: servidor.chamadas.reports[0] };
}

const CONVERSA = [
  { from: 'eu', texto: 'Oi, tudo bem?' },
  { from: 'eles', texto: 'Tudo sim!' },
  { from: 'eu', texto: 'Vi que você vende online.' },
  { from: 'eles', tipo: 'audio', dur: '0:12' },
  { from: 'eu', texto: 'Legal, quanto você fatura?' },
  { from: 'eles', texto: 'Uns 50 mil por mês.' },
  { from: 'eu', texto: 'Consegue investir 3 mil?' },
  { from: 'eles', tipo: 'audio', dur: '0:05' },
  { from: 'eles', texto: 'ok' },
  { from: 'eu', texto: 'Fechado então.' },
  { from: 'eles', texto: 'Bora' },
  { from: 'eu', texto: 'Te chamo amanhã' },
];
const esperadas = (conversa) =>
  conversa.map((m, i) =>
    m.tipo === 'audio'
      ? { from: m.from, type: 'audio', content: `transcrição do áudio ${m.indiceAudio != null ? m.indiceAudio : i}` }
      : { from: m.from, type: 'texto', content: m.texto }
  );

// ---------------------------------------------------------------- Instagram: leitura
test('Instagram: lê a conversa inteira numa lista virtualizada, na ordem, com remetente e áudios', async () => {
  const { envio, pagina } = await rodarInstagram(CONVERSA);
  assert.deepEqual(envio.mensagens.map(limpar), esperadas(CONVERSA));
  assert.match(pagina.badge(), /Report pronto/);
  assert.match(pagina.badge(), /2 áudio\(s\) transcrito\(s\)/);
  assert.equal(envio.nome, 'Contato Teste');
  pagina.fechar();
});

test('Instagram: conversa longa (60 mensagens) também sai completa e sem duplicar', async () => {
  const longa = Array.from({ length: 60 }, (_, i) => ({ from: i % 3 === 0 ? 'eu' : 'eles', texto: `mensagem ${i} da conversa longa` }));
  const { envio, pagina } = await rodarInstagram(longa);
  assert.deepEqual(envio.mensagens.map(limpar), esperadas(longa));
  pagina.fechar();
});

test('Instagram: mensagem repetida em seguida ("ok", "ok", "ok") NÃO é engolida (A05)', async () => {
  const conversa = [
    { from: 'eu', texto: 'Consegue investir 3 mil?' },
    { from: 'eles', texto: 'ok' },
    { from: 'eles', texto: 'ok' },
    { from: 'eles', texto: 'ok' },
    { from: 'eu', texto: 'Perfeito' },
    { from: 'eu', texto: 'Perfeito' },
    { from: 'eles', texto: 'kkk' },
  ];
  const { envio, pagina } = await rodarInstagram(conversa, { visiveis: 4 });
  assert.deepEqual(envio.mensagens.map(limpar), esperadas(conversa));
  pagina.fechar();
});

test('Instagram: dois áudios seguidos com a mesma duração continuam sendo dois (A05)', async () => {
  const conversa = [
    { from: 'eu', texto: 'Me conta mais' },
    { from: 'eles', tipo: 'audio', dur: '0:10', indiceAudio: 1 },
    { from: 'eles', tipo: 'audio', dur: '0:10', indiceAudio: 2 },
    { from: 'eu', texto: 'Entendi' },
  ];
  const { envio, pagina } = await rodarInstagram(conversa, { visiveis: 3 });
  assert.equal(envio.mensagens.filter((m) => m.type === 'audio').length, 2);
  assert.deepEqual(envio.mensagens.map((m) => m.content).filter((c) => c.startsWith('transcrição')), [
    'transcrição do áudio 1',
    'transcrição do áudio 2',
  ]);
  pagina.fechar();
});

test('Instagram: se a transcrição falha, o áudio entra como [áudio] e o report sai mesmo assim', async () => {
  const { envio, pagina } = await rodarInstagram(CONVERSA, { servidor: servidorFalso({ transcricaoFalha: true }) });
  assert.equal(envio.mensagens.filter((m) => m.content === '[áudio]').length, 2);
  assert.match(pagina.badge(), /0 de 2|2 áudio/);
  pagina.fechar();
});

// ---------------------------------------------------------------- Instagram: A04 (qualidade da captura)
test('Instagram: envia o resumo da captura (áudios achados e transcritos) ao servidor (A04)', async () => {
  const { envio, pagina } = await rodarInstagram(CONVERSA);
  assert.deepEqual(envio.captureQuality, { plataforma: 'instagram', versao: 'teste', mensagens: 12, audios: 2, audiosTranscritos: 2, mensagensVendedor: 6, mensagensLead: 6 });
  pagina.fechar();

  const parcial = await rodarInstagram(CONVERSA, { servidor: servidorFalso({ transcricaoFalha: true }) });
  assert.deepEqual(parcial.envio.captureQuality, { plataforma: 'instagram', versao: 'teste', mensagens: 12, audios: 2, audiosTranscritos: 0, mensagensVendedor: 6, mensagensLead: 6 });
  parcial.pagina.fechar();
});

// ---------------------------------------------------------------- Instagram: A03 (trava de conversa)
test('Instagram: se o SDR troca de conversa no meio da leitura, aborta e não manda nada (A03)', async () => {
  const servidor = servidorFalso();
  let passos = 0;
  const { pagina } = await rodarInstagram(CONVERSA, {
    servidor,
    durante: (p) => {
      // Depois de alguns passos de rolagem, o "usuário" abre outra conversa.
      const original = p.w.Element.prototype.scrollIntoView;
      p.w.Element.prototype.scrollIntoView = function (...a) {
        if (++passos === 3) p.w.history.pushState({}, '', '/direct/t/999/');
        return original.apply(this, a);
      };
    },
  });
  assert.equal(servidor.chamadas.reports.length, 0, 'nenhum report pode ser gerado com a conversa trocada');
  assert.match(pagina.badge(), /conversa mudou/i);
  pagina.fechar();
});

test('Instagram: o nome do contato é o do INÍCIO da leitura, não o do fim (A03)', async () => {
  const { envio, pagina } = await rodarInstagram(CONVERSA, {
    durante: (p) => {
      // O cabeçalho muda para outro nome só no final (durante a transcrição, quando o DOM já não importa).
      const original = p.w.chrome.runtime.sendMessage;
      p.w.chrome.runtime.sendMessage = (msg, cb) => {
        if (msg.action === 'transcreverAudio') p.document.querySelector('header span').textContent = 'Outra Pessoa';
        return original(msg, cb);
      };
    },
  });
  assert.equal(envio.nome, 'Contato Teste');
  pagina.fechar();
});

// ---------------------------------------------------------------- Instagram: A09 (duplicado)
test('Instagram: duplicado oferece abrir o existente sem chamar a IA de novo (A09)', async () => {
  const servidor = servidorFalso({ duplicado: true });
  const pagina = abrirPagina({ arquivo: 'extension/content-instagram.js', url: 'https://www.instagram.com/direct/t/111/', aoEnviar: servidor.aoEnviar });
  montarInstagram(pagina, CONVERSA, { visiveis: 6 });
  pagina.iniciar();
  await esperar(() => /Já existe/.test(pagina.badge()), { motivo: 'aviso de duplicado' });
  assert.equal(servidor.chamadas.reports.length, 1, 'só uma chamada de geração até o SDR decidir');
  const botoes = [...pagina.document.querySelectorAll('#closer-report-badge [data-cr-acao]')].map((b) => b.dataset.crAcao);
  assert.deepEqual(botoes.sort(), ['abrir', 'gerar']);

  pagina.document.querySelector('[data-cr-acao="abrir"]').click();
  await esperar(() => /Report pronto|existente/i.test(pagina.badge()) && !!servidor.chamadas.baixou, { motivo: 'abrir existente' });
  assert.equal(servidor.chamadas.baixou.id, 'abc');
  assert.equal(servidor.chamadas.reports.length, 1, 'abrir o existente não gera de novo');
  assert.match(pagina.document.querySelector('#closer-report-badge a').getAttribute('href'), /base64,BBBB/);
  pagina.fechar();
});

test('Instagram: no duplicado, "Gerar de novo" manda forcarNovo', async () => {
  const servidor = servidorFalso({ duplicado: true });
  const pagina = abrirPagina({ arquivo: 'extension/content-instagram.js', url: 'https://www.instagram.com/direct/t/111/', aoEnviar: servidor.aoEnviar });
  montarInstagram(pagina, CONVERSA, { visiveis: 6 });
  pagina.iniciar();
  await esperar(() => /Já existe/.test(pagina.badge()), { motivo: 'aviso de duplicado' });
  pagina.document.querySelector('[data-cr-acao="gerar"]').click();
  await esperar(() => /Report pronto/.test(pagina.badge()), { motivo: 'report novo' });
  assert.equal(servidor.chamadas.reports.length, 2);
  assert.equal(servidor.chamadas.reports[1].forcarNovo, true);
  pagina.fechar();
});

// ---------------------------------------------------------------- WhatsApp
const CONVERSA_WA = [
  { from: 'eu', texto: 'Oi, tudo bem?', hora: '10:00, 01/09/2026' },
  { from: 'eles', texto: 'Tudo sim', hora: '10:01, 01/09/2026' },
  { from: 'eles', tipo: 'audio' },
  { from: 'eu', texto: 'Consegue investir 3 mil?', hora: '10:03, 01/09/2026' },
  { from: 'eles', texto: 'ok', hora: '10:04, 01/09/2026' },
  { from: 'eles', texto: 'ok', hora: '10:04, 01/09/2026' },
];

async function rodarWhatsApp(conversa, { servidor = servidorFalso(), durante, opcoes } = {}) {
  const pagina = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar: servidor.aoEnviar });
  const cenario = montarWhatsApp(pagina, conversa, opcoes);
  if (durante) durante(pagina, cenario);
  pagina.iniciar();
  await esperar(() => terminou(pagina), { motivo: 'fim do job do WhatsApp' });
  return { pagina, cenario, servidor, envio: servidor.chamadas.reports[0] };
}

test('WhatsApp: lê tudo na ordem, com remetente, áudio transcrito e mensagens repetidas preservadas', async () => {
  const { envio, pagina } = await rodarWhatsApp(CONVERSA_WA);
  assert.deepEqual(envio.mensagens.map(limpar), [
    { from: 'eu', type: 'texto', content: 'Oi, tudo bem?' },
    { from: 'eles', type: 'texto', content: 'Tudo sim' },
    { from: 'eles', type: 'audio', content: 'transcrição do áudio 2' },
    { from: 'eu', type: 'texto', content: 'Consegue investir 3 mil?' },
    { from: 'eles', type: 'texto', content: 'ok' },
    { from: 'eles', type: 'texto', content: 'ok' },
  ]);
  assert.deepEqual(envio.captureQuality, { plataforma: 'whatsapp', versao: 'teste', mensagens: 6, audios: 1, audiosTranscritos: 1, mensagensVendedor: 2, mensagensLead: 4 });
  pagina.fechar();
});

test('WhatsApp: troca de conversa no meio da leitura aborta e não manda nada (A03)', async () => {
  const servidor = servidorFalso();
  const { pagina } = await rodarWhatsApp(CONVERSA_WA, {
    servidor,
    durante: (p) => {
      // Assim que a leitura começa a rolar, o SDR abre outro chat: as mensagens ganham outro id de conversa.
      let rolou = 0;
      const rolagem = p.document.getElementById('rolagem');
      const desc = Object.getOwnPropertyDescriptor(rolagem, 'scrollTop');
      Object.defineProperty(rolagem, 'scrollTop', {
        get: desc.get,
        set: (v) => {
          if (++rolou === 3) {
            p.document.querySelectorAll('[data-id]').forEach((el) => {
              el.setAttribute('data-id', el.getAttribute('data-id').replace('5511999990000@c.us', '5511888880000@c.us'));
            });
          }
          desc.set(v);
        },
      });
    },
  });
  assert.equal(servidor.chamadas.reports.length, 0);
  assert.match(pagina.badge(), /conversa mudou/i);
  pagina.fechar();
});

test('WhatsApp: o nome do contato é o do início da leitura (A03)', async () => {
  const { envio, pagina } = await rodarWhatsApp(CONVERSA_WA, {
    durante: (p) => {
      const original = p.w.chrome.runtime.sendMessage;
      p.w.chrome.runtime.sendMessage = (msg, cb) => {
        if (msg.action === 'transcreverAudio') {
          const s = p.document.querySelector('#main header span');
          s.setAttribute('title', 'Outra Pessoa');
          s.textContent = 'Outra Pessoa';
        }
        return original(msg, cb);
      };
    },
  });
  assert.equal(envio.nome, 'Contato Teste');
  pagina.fechar();
});

// O WhatsApp Web passou a usar data-id só com hexadecimais (visto ao vivo). Sem o id da conversa, a
// trava (A03) cai para o nome do cabeçalho.
test('WhatsApp (data-id no formato novo): lê tudo normalmente', async () => {
  const { envio, pagina } = await rodarWhatsApp(CONVERSA_WA, { opcoes: { idsSimples: true } });
  assert.equal(envio.mensagens.length, 6);
  assert.deepEqual(envio.mensagens.map((m) => m.from), ['eu', 'eles', 'eles', 'eu', 'eles', 'eles']);
  assert.equal(envio.nome, 'Contato Teste');
  pagina.fechar();
});

test('WhatsApp (data-id no formato novo): troca de conversa é pega pelo nome do contato (A03)', async () => {
  const servidor = servidorFalso();
  const { pagina } = await rodarWhatsApp(CONVERSA_WA, {
    servidor,
    opcoes: { idsSimples: true },
    durante: (p) => {
      let rolou = 0;
      const rolagem = p.document.getElementById('rolagem');
      const desc = Object.getOwnPropertyDescriptor(rolagem, 'scrollTop');
      Object.defineProperty(rolagem, 'scrollTop', {
        get: desc.get,
        set: (v) => {
          if (++rolou === 1) {
            const s = p.document.querySelector('#main header span');
            s.setAttribute('title', 'Outra Pessoa');
            s.textContent = 'Outra Pessoa';
          }
          desc.set(v);
        },
      });
    },
  });
  assert.equal(servidor.chamadas.reports.length, 0);
  assert.match(pagina.badge(), /conversa mudou/i);
  pagina.fechar();
});

// ---------------------------------------------------------------- WhatsApp: áudio que não chega
const coletarLogs = (p) => {
  const logs = [];
  p.w.console.log = (...a) => logs.push(a.join(' '));
  return logs;
};

test('WhatsApp: se o WhatsApp não entrega nenhum áudio (mídia expirada), faz UMA passada só e explica', async () => {
  const conversa = [
    { from: 'eu', texto: 'Oi', hora: '10:00, 01/09/2026' },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eu', texto: 'Entendi', hora: '10:05, 01/09/2026' },
  ];
  let logs;
  const { envio, pagina } = await rodarWhatsApp(conversa, { opcoes: { idsSimples: true }, durante: (p) => { logs = coletarLogs(p); } });

  assert.equal(envio.mensagens.filter((m) => m.content === '[áudio]').length, 4, 'os áudios entram como [áudio]');
  assert.deepEqual(envio.captureQuality, { plataforma: 'whatsapp', versao: 'teste', mensagens: 6, audios: 4, audiosTranscritos: 0, mensagensVendedor: 2, mensagensLead: 4 });
  assert.equal(logs.filter((l) => /sem blob de áudio/.test(l)).length, 4, 'uma tentativa por áudio, sem repescagem');
  assert.ok(logs.some((l) => /não vou repescar/.test(l)));
  assert.ok(logs.some((l) => /fila anterior ao clique/.test(l)), 'diagnóstico da fila aparece no console');
  assert.ok(logs.every((l) => !/^\[CR-audio\]/.test(l)), 'nenhum log de áudio sem versão');
  assert.ok(logs.some((l) => l.startsWith('[CR-audio vteste]')));
  assert.match(pagina.badge(), /não entregou os arquivos de áudio/);
  pagina.fechar();
});

test('WhatsApp: se ALGUM áudio baixa, os que faltam ainda são repescados (comportamento de sempre)', async () => {
  const conversa = [
    { from: 'eu', texto: 'Oi', hora: '10:00, 01/09/2026' },
    { from: 'eles', tipo: 'audio' },
    { from: 'eles', tipo: 'audio' },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eles', tipo: 'audio', semBytes: true },
  ];
  let logs;
  const { envio, pagina } = await rodarWhatsApp(conversa, { durante: (p) => { logs = coletarLogs(p); } });
  assert.equal(envio.captureQuality.audiosTranscritos, 2);
  assert.ok(!logs.some((l) => /não vou repescar/.test(l)));
  assert.ok(logs.filter((l) => /sem blob de áudio/.test(l)).length >= 4, 'os 2 que faltam foram tentados de novo');
  assert.match(pagina.badge(), /2 de 4 áudio/);
  pagina.fechar();
});

// ---------------------------------------------------------------- WhatsApp: arquivos que o WhatsApp cria ANTES do clique
// O jsdom não preenche "source" no postMessage (o script confere ev.source === window): dispara o evento à mão.
const avisarBlob = (p, url, ts) =>
  p.w.dispatchEvent(new p.w.MessageEvent('message', { data: { __crAudio: true, url, ts }, source: p.w }));
const postarBlobsAntigos = (p, indices) =>
  indices.forEach((ix, k) => {
    const url = 'blob:antigo-' + k;
    p.blobs.set(url, audioFake(ix));
    avisarBlob(p, url, Date.now() - 60000);
  });

test('WhatsApp: áudio cujo arquivo já existia na fila antes do clique AINDA é lido (plano B)', async () => {
  const conversa = [
    { from: 'eu', texto: 'Oi', hora: '10:00, 01/09/2026' },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eu', texto: 'Ok', hora: '10:05, 01/09/2026' },
  ];
  const { envio, pagina } = await rodarWhatsApp(conversa, { opcoes: { idsSimples: true }, durante: (p) => postarBlobsAntigos(p, [41, 42]) });
  assert.deepEqual(envio.mensagens.filter((m) => m.type === 'audio').map((m) => m.content), ['transcrição do áudio 41', 'transcrição do áudio 42']);
  assert.deepEqual(envio.captureQuality, { plataforma: 'whatsapp', versao: 'teste', mensagens: 4, audios: 2, audiosTranscritos: 2, mensagensVendedor: 2, mensagensLead: 2 });
  pagina.fechar();
});

test('WhatsApp: arquivo criado pelo clique tem prioridade sobre os antigos da fila', async () => {
  const conversa = [
    { from: 'eu', texto: 'Oi', hora: '10:00, 01/09/2026' },
    { from: 'eles', tipo: 'audio', semBytes: true },
    { from: 'eles', tipo: 'audio', semBytes: true },
  ];
  const { envio, pagina } = await rodarWhatsApp(conversa, {
    opcoes: { idsSimples: true },
    durante: (p) => {
      postarBlobsAntigos(p, [41, 42]);
      // Ao clicar em cada play, o WhatsApp "cria" o arquivo certo daquela mensagem.
      p.document.querySelectorAll('[data-icon="audio-play"]').forEach((span, k) => {
        span.addEventListener('click', () => {
          const url = 'blob:novo-' + k;
          p.blobs.set(url, audioFake(90 + k));
          avisarBlob(p, url, Date.now());
        });
      });
    },
  });
  assert.deepEqual(envio.mensagens.filter((m) => m.type === 'audio').map((m) => m.content), ['transcrição do áudio 90', 'transcrição do áudio 91']);
  pagina.fechar();
});

test('WhatsApp: mensagens de remetentes diferentes com o mesmo texto e hora não se fundem (A05)', async () => {
  const conversa = [
    { from: 'eu', texto: 'ok', hora: '10:00, 01/09/2026' },
    { from: 'eles', texto: 'ok', hora: '10:00, 01/09/2026' },
  ];
  const { envio, pagina } = await rodarWhatsApp(conversa);
  assert.deepEqual(envio.mensagens.map((m) => m.from), ['eu', 'eles']);
  pagina.fechar();
});

test('WhatsApp: duplicado oferece abrir o existente (A09)', async () => {
  const servidor = servidorFalso({ duplicado: true });
  const pagina = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar: servidor.aoEnviar });
  montarWhatsApp(pagina, CONVERSA_WA);
  pagina.iniciar();
  await esperar(() => /Já existe/.test(pagina.badge()), { motivo: 'aviso de duplicado' });
  pagina.document.querySelector('[data-cr-acao="abrir"]').click();
  await esperar(() => !!servidor.chamadas.baixou, { motivo: 'abrir existente' });
  assert.equal(servidor.chamadas.reports.length, 1);
  pagina.fechar();
});

// ---------------------------------------------------------------- leitura mais resistente a mudanças de layout
test('Instagram: histórico que demora a carregar ainda é lido desde a primeira mensagem', async () => {
  const longa = Array.from({ length: 40 }, (_, i) => ({ from: i % 2 ? 'eles' : 'eu', texto: `mensagem ${i}` }));
  // Só as últimas 8 estão na tela; as antigas chegam de 10 em 10, e só na 3ª tentativa parada no topo.
  const { envio, pagina } = await rodarInstagram(longa, { opcoes: { carregadasNoInicio: 8, atrasoTopo: 2 } });
  assert.equal(envio.mensagens.length, 40, 'nenhuma mensagem antiga pode faltar');
  assert.equal(envio.mensagens[0].content, 'mensagem 0');
  assert.deepEqual(envio.mensagens.map(limpar), esperadas(longa));
  pagina.fechar();
});

test('Instagram: sem o row-reverse, mensagem MINHA comprida continua sendo minha (posição por folga)', async () => {
  const conversa = [
    { from: 'eu', texto: 'Oi, tudo bem? Vi que você vende no Mercado Livre e queria entender a sua operação hoje' },
    { from: 'eles', texto: 'Tudo sim! Vendo peças de moto, comecei faz uns dois anos e quero crescer' },
    { from: 'eu', texto: 'Perfeito. Quanto você fatura por mês, mais ou menos, contando todos os canais?' },
    { from: 'eles', texto: 'Uns 50 mil' },
  ];
  const { envio, pagina } = await rodarInstagram(conversa, { opcoes: { semFlex: true, longas: true } });
  assert.deepEqual(envio.mensagens.map((m) => m.from), ['eu', 'eles', 'eu', 'eles']);
  pagina.fechar();
});

const CONVERSA_SEM_SINAIS = [
  { from: 'eu', texto: 'Oi Marcos, tudo bem?', hora: '10:00, 01/09/2026' },
  { from: 'eles', texto: 'Tudo sim', hora: '10:01, 01/09/2026' },
  { from: 'eu', texto: 'Consegue investir 3 mil?', hora: '10:02, 01/09/2026' },
  { from: 'eles', tipo: 'audio' },
  { from: 'eles', texto: 'ok', hora: '10:04, 01/09/2026' },
  { from: 'eu', texto: 'Fechado', hora: '10:05, 01/09/2026' },
  { from: 'eles', texto: 'Bora', hora: '10:06, 01/09/2026' },
  { from: 'eu', texto: 'Te chamo amanhã', hora: '10:07, 01/09/2026' },
];

test('WhatsApp: sem classes, sem "true_/false_" e sem tique, o remetente sai pela posição da bolha', async () => {
  const { envio, pagina } = await rodarWhatsApp(CONVERSA_SEM_SINAIS, { opcoes: { semSinais: true } });
  assert.deepEqual(envio.mensagens.map((m) => m.from), ['eu', 'eles', 'eu', 'eles', 'eles', 'eu', 'eles', 'eu']);
  assert.equal(envio.mensagens[3].content, 'transcrição do áudio 3');
  assert.equal(envio.captureQuality.mensagensVendedor, 4);
  assert.equal(envio.captureQuality.mensagensLead, 4);
  assert.match(pagina.badge(), /8 mensagens · 4 suas · 4 do lead/);
  assert.doesNotMatch(pagina.badge(), /Confira o report/);
  pagina.fechar();
});

test('WhatsApp: se nada indica quem mandou, o aviso final manda conferir (em vez de passar batido)', async () => {
  const { envio, pagina } = await rodarWhatsApp(CONVERSA_SEM_SINAIS, { opcoes: { semSinais: true, posicao: false } });
  assert.equal(envio.captureQuality.mensagensVendedor, 0);
  assert.match(pagina.badge(), /Confira o report: nenhuma mensagem sua foi reconhecida/);
  pagina.fechar();
});

test('Instagram: o aviso final mostra quantas mensagens são suas e quantas do lead', async () => {
  const { pagina } = await rodarInstagram(CONVERSA);
  assert.match(pagina.badge(), /12 mensagens · 6 suas · 6 do lead/);
  pagina.fechar();
});

test('Instagram: conversa curta, que cabe inteira na tela (sem rolagem), é lida', async () => {
  const conversa = [
    { from: 'eu', texto: 'Oi, tudo bem?' },
    { from: 'eles', texto: 'Tudo, e você?' },
    { from: 'eu', texto: 'Tudo ótimo' },
  ];
  const { envio, pagina } = await rodarInstagram(conversa, { visiveis: 6 });
  assert.deepEqual(envio.mensagens.map(limpar), esperadas(conversa));
  pagina.fechar();
});
