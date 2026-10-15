'use strict';
// Automação do cartão no WhatsApp Web (content.js + agenda.js REAIS em DOM simulado): mover o card para
// "Respondeu" quando o lead responde, etiqueta "Qualificado" e o dia/horário agendado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, montarWhatsApp, esperar, dormir } = require('./helpers/dom');

const fichaDoRd = (etapa) => ({
  nome: 'Marcos Pereira', telefones: ['(71) 99999-8888'], emails: [],
  negociacao: { nome: 'Marcos Pereira', etapa, funil: 'Funil SDR', responsavel: 'Cauã Lima', fonte: '', campanha: '', criadaEm: '', url: 'https://crm.rdstation.com/app/deals/d1' },
  totalNegociacoes: 1,
  negociacoes: [{ id: 'd1', nome: 'Marcos Pereira', etapa, funil: 'Funil SDR', responsavel: 'Cauã Lima', criadaEm: '28/09/2026', aberta: true, escolhida: true }],
  formulario: null, campos: [], anotacoes: [],
});
const SEM_MARCA = { qualificado: false, origem: '', agendadoPara: '', agendaFonteTs: -1 };

/** Service worker + servidor falsos: guarda cada pedido e aplica a marca como o servidor faria. */
function servidorFalso({ automacao = true, podeResponder = true, marca = SEM_MARCA, etapa = 'Contato iniciado', mover } = {}) {
  const pedidos = { ficha: [], respondeu: [], marca: [], report: [] };
  let atual = { ...marca };
  const aoEnviar = async (original) => {
    const msg = JSON.parse(JSON.stringify(original));
    if (msg.action === 'crmLead') {
      pedidos.ficha.push(msg);
      return { ok: true, configurado: true, encontrado: true, ficha: fichaDoRd(etapa), coach: false, ...(automacao ? { automacao: true, podeResponder, marca: { ...atual } } : {}) };
    }
    if (msg.action === 'crmRespondeu') {
      pedidos.respondeu.push(msg);
      return mover ? mover(msg) : { ok: true, movido: true, de: 'Contato iniciado', para: 'Respondeu', motivo: '' };
    }
    if (msg.action === 'leadMarca') {
      pedidos.marca.push(msg);
      if (typeof msg.qualificado === 'boolean') Object.assign(atual, { qualificado: msg.qualificado, origem: msg.qualificado ? (msg.manual ? 'manual' : msg.origem || '') : '' });
      if (msg.limparAgenda) atual.agendadoPara = '';
      else if (msg.agendadoPara) atual = { ...atual, agendadoPara: msg.agendadoPara, agendaFonteTs: msg.fonteTs };
      return { ok: true, marca: { ...atual } };
    }
    if (msg.action === 'reportFetch') {
      pedidos.report.push(msg);
      return { ok: true, dados: {}, arquivo: 'r.pdf', arquivoBase64: 'AAAA' };
    }
    return { ok: true };
  };
  return { aoEnviar, pedidos };
}

const RESPONDEU = [{ from: 'eu', texto: 'Oi Marcos, tudo bem?' }, { from: 'eles', texto: 'Tudo sim, pode falar' }];
const SO_EU = [{ from: 'eu', texto: 'Oi Marcos, tudo bem?' }, { from: 'eu', texto: 'Consegue falar agora?' }];

// Teste que falha no meio não pode deixar janela aberta (o vigia da ficha seguraria o processo para sempre).
const abertas = [];
test.afterEach(() => abertas.splice(0).forEach((p) => p.fechar()));

function abrir(srv, conversa = RESPONDEU, { contato = '+55 71 99999-8888', storage = {} } = {}) {
  const p = abrirPagina({ arquivo: 'extension/content.js', url: 'https://web.whatsapp.com/', aoEnviar: srv.aoEnviar, intervaloRapido: true, storage });
  montarWhatsApp(p, conversa, { contato, idsSimples: true });
  abertas.push(p);
  return p;
}
const cartao = (p) => p.document.getElementById('cr-ficha-crm');
const texto = (p) => (cartao(p) ? cartao(p).textContent : '');
const etiquetas = (p) => (p.document.getElementById('cr-etiquetas') ? p.document.getElementById('cr-etiquetas').textContent : '');
const botaoPorTitulo = (p, titulo) => [...cartao(p).querySelectorAll('button')].find((b) => b.title === titulo);
const fichaNaTela = (p) => esperar(() => /Funil SDR/.test(texto(p)), { motivo: 'ficha na tela' });

function chegarMensagemDoLead(p, textoMsg = 'Oi, vi sua mensagem') {
  const el = p.document.createElement('div');
  el.className = 'message-in';
  el.setAttribute('data-id', 'A5NOVA000001');
  el.innerHTML = '<div class="copyable-text" data-pre-plain-text="[10:05, 01/09/2026] Marcos: "><span class="selectable-text"></span></div>';
  el.querySelector('.selectable-text').textContent = textoMsg;
  p.document.getElementById('rolagem').appendChild(el);
}

// ---------------------------------------------------------------- mover para "Respondeu"
test('lead respondeu e o card está antes de "Respondeu": pede para mover uma vez e o cartão mostra a etapa nova', async () => {
  const srv = servidorFalso();
  const p = abrir(srv);
  await esperar(() => srv.pedidos.respondeu.length === 1, { motivo: 'pedido para mover' });
  assert.deepEqual(srv.pedidos.respondeu[0], { action: 'crmRespondeu', telefone: '5571999998888', nome: '', contatoId: '', dealId: 'd1' });
  await esperar(() => /Movido para "Respondeu" no RD\./.test(texto(p)), { motivo: 'aviso no cartão' });
  assert.match(texto(p), /Respondeu · Funil SDR/, 'a etapa do cartão já é a nova');
  assert.doesNotMatch(texto(p), /Contato iniciado/);
  await dormir(120);
  assert.equal(srv.pedidos.respondeu.length, 1, 'não pede de novo');
  assert.deepEqual(srv.pedidos.ficha[0].conversa, { telefone: '5571999998888', nome: '+55 71 99999-8888' }, 'a ficha sabe de que conversa é');
  p.fechar();
});

test('só eu falei: nada é movido; quando a resposta do lead chega, aí move', async () => {
  const srv = servidorFalso();
  const p = abrir(srv, SO_EU);
  await fichaNaTela(p);
  await dormir(120);
  assert.equal(srv.pedidos.respondeu.length, 0, 'lead ainda não respondeu');
  chegarMensagemDoLead(p);
  await esperar(() => srv.pedidos.respondeu.length === 1, { motivo: 'move quando o lead responde' });
  p.fechar();
});

test('não tenta mover: card já adiante, automação desligada para a chave, ou lead que só escreveu antes de mim', async () => {
  const adiante = servidorFalso({ podeResponder: false, etapa: 'Qualificado' });
  const p1 = abrir(adiante);
  await fichaNaTela(p1);
  const desligada = servidorFalso({ automacao: false });
  const p2 = abrir(desligada);
  await fichaNaTela(p2);
  const leadPrimeiro = servidorFalso();
  const p3 = abrir(leadPrimeiro, [{ from: 'eles', texto: 'Oi, quero saber mais' }, { from: 'eu', texto: 'Oi! Claro' }]);
  await fichaNaTela(p3);
  await dormir(150);
  assert.equal(adiante.pedidos.respondeu.length, 0);
  assert.equal(desligada.pedidos.respondeu.length, 0);
  assert.equal(desligada.pedidos.marca.length, 0);
  assert.equal(p2.document.getElementById('cr-etiquetas'), null, 'sem automação o cartão não tem etiquetas');
  assert.equal(leadPrimeiro.pedidos.respondeu.length, 0);
  p1.fechar();
  p2.fechar();
  p3.fechar();
});

test('o RD não deixou mover: o cartão diz o motivo e não fica insistindo', async () => {
  const srv = servidorFalso({ mover: () => ({ ok: false, erro: 'O RD Station não deixou alterar este card.' }) });
  const p = abrir(srv);
  await esperar(() => /Não movi o card para "Respondeu": O RD Station não deixou alterar este card\./.test(texto(p)), { motivo: 'aviso de erro' });
  assert.match(texto(p), /Contato iniciado · Funil SDR/, 'a etapa continua a que o RD tem');
  chegarMensagemDoLead(p);
  await dormir(150);
  assert.equal(srv.pedidos.respondeu.length, 1);
  p.fechar();
});

test('servidor diz que o card já estava adiante: nada muda na tela', async () => {
  const srv = servidorFalso({ mover: () => ({ ok: true, movido: false, motivo: 'ja-adiante' }) });
  const p = abrir(srv);
  await esperar(() => srv.pedidos.respondeu.length === 1, { motivo: 'pedido' });
  await dormir(80);
  assert.match(texto(p), /Contato iniciado · Funil SDR/);
  assert.doesNotMatch(texto(p), /Movido|Não movi/);
  p.fechar();
});

// ---------------------------------------------------------------- etiqueta "Qualificado"
test('etiqueta Qualificado: aparece quando o lead está marcado; dá para tirar e colocar à mão', async () => {
  const srv = servidorFalso({ podeResponder: false, etapa: 'Ultima tentativa', marca: { ...SEM_MARCA, qualificado: true, origem: 'rd' } });
  const p = abrir(srv);
  await esperar(() => /QUALIFICADO/.test(etiquetas(p)), { motivo: 'etiqueta' });
  const chip = () => [...p.document.getElementById('cr-etiquetas').querySelectorAll('span')].find((x) => x.textContent === 'QUALIFICADO');
  assert.equal(chip().title, 'Qualificado: o card esteve na etapa Qualificado do RD.', 'passar o mouse diz de onde a etiqueta veio');
  botaoPorTitulo(p, 'Tirar a etiqueta Qualificado').click();
  await esperar(() => srv.pedidos.marca.length === 1, { motivo: 'pedido para tirar' });
  assert.deepEqual(srv.pedidos.marca[0], { action: 'leadMarca', telefone: '5571999998888', nome: '+55 71 99999-8888', qualificado: false, manual: true });
  await esperar(() => /\+ Qualificado/.test(etiquetas(p)) && !/QUALIFICADO/.test(etiquetas(p)), { motivo: 'sem a etiqueta' });
  botaoPorTitulo(p, 'Marcar este lead como qualificado').click();
  await esperar(() => srv.pedidos.marca.length === 2, { motivo: 'pedido para marcar' });
  assert.equal(srv.pedidos.marca[1].qualificado, true);
  assert.equal(srv.pedidos.marca[1].manual, true);
  await esperar(() => /QUALIFICADO/.test(etiquetas(p)), { motivo: 'etiqueta de volta' });
  assert.equal(chip().title, 'Qualificado: você marcou à mão.');
  p.fechar();
});

test('as etiquetas ficam à vista com o cartão minimizado', async () => {
  const srv = servidorFalso({ podeResponder: false, marca: { qualificado: true, agendadoPara: '2031-03-15T15:00', agendaFonteTs: 5 } });
  const p = abrir(srv, RESPONDEU, { storage: { fichaCrmMinimizada: true } });
  await esperar(() => /QUALIFICADO/.test(etiquetas(p)), { motivo: 'etiquetas' });
  assert.match(etiquetas(p), /Agendado: \S+, 15\/03 às 15:00/);
  assert.doesNotMatch(texto(p), /Funil SDR/, 'o corpo da ficha segue minimizado');
  p.fechar();
});

// ---------------------------------------------------------------- agendamento
const DIA_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const AGENDOU = [
  { from: 'eu', texto: 'Oi Marcos, tudo bem?', hora: '09:00, 01/09/2026' },
  { from: 'eles', texto: 'Tudo! Pode ser sim', hora: '09:30, 01/09/2026' },
  { from: 'eu', texto: 'Perfeito! Sua reunião ficou agendada para 15/03/2031 às 15h com o nosso especialista.', hora: '10:00, 01/09/2026' },
];
const TS_AGENDOU = new Date(2026, 8, 1, 10, 0).getTime();

test('agendamento dito na conversa: o cartão mostra o dia e a hora e o servidor guarda só a data', async () => {
  const srv = servidorFalso({ podeResponder: false, etapa: 'Qualificado' });
  const p = abrir(srv, AGENDOU);
  await esperar(() => srv.pedidos.marca.length === 1, { motivo: 'agendamento enviado' });
  assert.deepEqual(srv.pedidos.marca[0], {
    action: 'leadMarca', telefone: '5571999998888', nome: '+55 71 99999-8888', agendadoPara: '2031-03-15T15:00', fonteTs: TS_AGENDOU, regra: 2,
  }, 'vai o dia e a hora — nenhum texto da conversa');
  const dia = DIA_CURTO[new Date(2031, 2, 15).getDay()];
  await esperar(() => etiquetas(p).includes(`Agendado: ${dia}, 15/03 às 15:00`), { motivo: 'agendamento no cartão' });
  assert.doesNotMatch(etiquetas(p), /QUALIFICADO/, 'ter agendamento não coloca a etiqueta Qualificado');
  await dormir(120);
  assert.equal(srv.pedidos.marca.length, 1, 'a mesma mensagem não é enviada de novo');

  // apagar: some do cartão e a mesma mensagem não o traz de volta
  botaoPorTitulo(p, 'Apagar este agendamento').click();
  await esperar(() => srv.pedidos.marca.length === 2, { motivo: 'pedido para apagar' });
  assert.equal(srv.pedidos.marca[1].limparAgenda, true);
  await esperar(() => !/Agendado/.test(etiquetas(p)), { motivo: 'agendamento fora do cartão' });
  chegarMensagemDoLead(p, 'Combinado');
  await dormir(150);
  assert.equal(srv.pedidos.marca.length, 2);
  assert.doesNotMatch(etiquetas(p), /Agendado/);
  p.fechar();
});

test('agendamento já anotado para esta mensagem: não reenvia; reunião que já passou aparece como "Estava agendado"', async () => {
  const srv = servidorFalso({ podeResponder: false, marca: { qualificado: true, agendadoPara: '2020-01-10T09:00', agendaFonteTs: TS_AGENDOU } });
  const p = abrir(srv, AGENDOU);
  const dia = DIA_CURTO[new Date(2020, 0, 10).getDay()];
  await esperar(() => etiquetas(p).includes(`Estava agendado: ${dia}, 10/01 às 09:00`), { motivo: 'agendamento guardado' });
  await dormir(150);
  assert.equal(srv.pedidos.marca.length, 0);
  p.fechar();
});

test('remarcou: uma mensagem mais nova troca o agendamento do cartão', async () => {
  const srv = servidorFalso({ podeResponder: false, marca: { qualificado: true, agendadoPara: '2020-01-10T09:00', agendaFonteTs: TS_AGENDOU - 60000 } });
  const p = abrir(srv, AGENDOU);
  await esperar(() => srv.pedidos.marca.length === 1, { motivo: 'novo agendamento' });
  assert.equal(srv.pedidos.marca[0].agendadoPara, '2031-03-15T15:00');
  await esperar(() => /Agendado: \S+, 15\/03 às 15:00/.test(etiquetas(p)), { motivo: 'cartão atualizado' });
  p.fechar();
});

test('contato salvo com nome: a etiqueta vale para a conversa (nome), mesmo sem telefone', async () => {
  const srv = servidorFalso({ podeResponder: false });
  const p = abrir(srv, RESPONDEU, { contato: 'Marcos PRONIX Pereira' });
  await fichaNaTela(p);
  assert.deepEqual(srv.pedidos.ficha[0].conversa, { telefone: '', nome: 'Marcos PRONIX Pereira' });
  botaoPorTitulo(p, 'Marcar este lead como qualificado').click();
  await esperar(() => srv.pedidos.marca.length === 1, { motivo: 'marca' });
  assert.deepEqual(srv.pedidos.marca[0], { action: 'leadMarca', telefone: '', nome: 'Marcos PRONIX Pereira', qualificado: true, manual: true });
  p.fechar();
});

// ---------------------------------------------------------------- report gerado = qualificado
test('report gerado: o lead ganha a etiqueta Qualificado (e o agendamento lido na conversa inteira)', async () => {
  const srv = servidorFalso({ podeResponder: false });
  const p = abrir(srv, RESPONDEU);
  await fichaNaTela(p);
  assert.match(etiquetas(p), /\+ Qualificado/);
  p.iniciar();
  await esperar(() => srv.pedidos.marca.some((m) => m.origem === 'report'), { motivo: 'marca do report' });
  assert.deepEqual(srv.pedidos.marca.find((m) => m.origem === 'report'), {
    action: 'leadMarca', telefone: '5571999998888', nome: '+55 71 99999-8888', qualificado: true, origem: 'report',
  });
  await esperar(() => /QUALIFICADO/.test(etiquetas(p)), { motivo: 'etiqueta no cartão' });
  assert.deepEqual(srv.pedidos.report[0].mensagens.map((m) => m.content), RESPONDEU.map((m) => m.texto), 'o report continua lendo só a conversa');

  // sem a automação, gerar report não marca nada
  const sem = servidorFalso({ automacao: false });
  const q = abrir(sem, RESPONDEU);
  await fichaNaTela(q);
  q.iniciar();
  await esperar(() => sem.pedidos.report.length === 1, { motivo: 'report sem automação' });
  await dormir(100);
  assert.equal(sem.pedidos.marca.length, 0);
  p.fechar();
  q.fechar();
});

// ---------------------------------------------------------------- o report nasce vinculado ao card do RD
test('report: leva o vínculo com o card do RD que está na tela (id do contato e do card, e-mail e telefone)', async () => {
  const servidorCom = (resposta) => {
    const pedidos = [];
    return {
      pedidos,
      aoEnviar: async (original) => {
        const msg = JSON.parse(JSON.stringify(original));
        if (msg.action === 'crmLead') return { ok: true, configurado: true, coach: false, ...resposta };
        if (msg.action === 'reportFetch') { pedidos.push(msg); return { ok: true, dados: {}, arquivo: 'r.pdf', arquivoBase64: 'AAAA' }; }
        return { ok: true };
      },
    };
  };
  const comCard = servidorCom({ encontrado: true, ficha: { ...fichaDoRd('Respondeu'), contatoId: 'k77', emails: ['marcos@exemplo.com', 'outro@exemplo.com'] } });
  const p = abrir(comCard);
  await fichaNaTela(p);
  p.iniciar();
  await esperar(() => comCard.pedidos.length === 1, { motivo: 'report pedido' });
  assert.deepEqual(comCard.pedidos[0].vinculo, { telefone: '5571999998888', email: 'marcos@exemplo.com', contatoId: 'k77', dealId: 'd1' });

  // o RD não achou o lead: vai só o telefone da conversa, e o servidor tenta o resto
  const semCard = servidorCom({ encontrado: false });
  const q = abrir(semCard);
  await dormir(150);
  q.iniciar();
  await esperar(() => semCard.pedidos.length === 1, { motivo: 'report pedido sem ficha' });
  assert.deepEqual(semCard.pedidos[0].vinculo, { telefone: '5571999998888', email: '', contatoId: '', dealId: '' });
});

// ---------------------------------------------------------------- lead que só respondeu a primeira pergunta
test('lead respondeu só a primeira pergunta: o card vai para "Respondeu" e NÃO ganha etiqueta nem agendamento', async () => {
  const srv = servidorFalso();
  const p = abrir(srv, [
    { from: 'eu', texto: 'Oi Marcos! Aqui é o Cauã, da PRONIX. Vi que você se inscreveu hoje às 14h para o diagnóstico com o nosso especialista. Você já vende no Mercado Livre ou está começando do zero?', hora: '14:05, 01/09/2026' },
    { from: 'eles', texto: 'Estou começando do zero', hora: '14:20, 01/09/2026' },
  ]);
  await esperar(() => srv.pedidos.respondeu.length === 1, { motivo: 'card movido' });
  await esperar(() => /Movido para "Respondeu" no RD\./.test(texto(p)), { motivo: 'aviso' });
  await dormir(150);
  assert.equal(srv.pedidos.marca.length, 0, 'nada de etiqueta nem de agendamento vai para o servidor');
  assert.doesNotMatch(etiquetas(p), /QUALIFICADO|Agendado/);
  assert.match(etiquetas(p), /\+ Qualificado/, 'fica só o botão para marcar à mão');
});

// ---------------------------------------------------------------- etiquetas do formulário
test('etiquetas do formulário: investimento ("R$ 3 a 5k", "R$ 5k+") e se já vende — permissão própria, separada da automação', async () => {
  const comFormulario = (campos, { etiquetas = true, automacao = false } = {}) => ({
    aoEnviar: async (msg) => {
      if (msg.action !== 'crmLead') return { ok: true };
      const ficha = { ...fichaDoRd('Respondeu'), formulario: { campos, autor: '', quando: '' } };
      return {
        ok: true, configurado: true, encontrado: true, ficha, coach: false,
        ...(etiquetas ? { etiquetas: true } : {}), ...(automacao ? { automacao: true, podeResponder: false, marca: SEM_MARCA } : {}),
      };
    },
  });
  const chips = (p) => [...p.document.getElementById('cr-etiquetas').querySelectorAll('span')].map((x) => x.textContent);
  const casos = [
    [[{ rotulo: 'Investimento', valor: 'R$3.000 a R$5.000' }, { rotulo: 'Vende online', valor: 'Quero começar a vender no Mercado Livre' }, { rotulo: 'Profissão', valor: 'Lojista/Comerciante' }], ['R$ 3 a 5k', 'Ainda não vende', 'Lojista/Comerciante']],
    [[{ rotulo: 'Investimento', valor: '+ de R$5.000' }, { rotulo: 'Vende online?', valor: 'Já vendo e quero aumentar meus resultados no Mercado Livre' }], ['R$ 5k+', 'Já vende']],
    [[{ rotulo: 'Investimento', valor: 'Até R$ 3 mil' }, { rotulo: 'Vende online', valor: 'Não' }, { rotulo: 'Qual a sua profissão?', valor: 'Funcionário  público concursado da prefeitura municipal' }], ['R$ até 3k', 'Ainda não vende', 'Funcionário público concursad…']],
  ];
  for (const [campos, esperado] of casos) {
    // só as etiquetas ligadas (sem a automação): aparecem as do formulário, e nada de "Qualificado"
    const p = abrir(comFormulario(campos));
    await esperar(() => !!p.document.getElementById('cr-etiquetas'), { motivo: 'etiquetas' });
    assert.deepEqual(chips(p), esperado);
    assert.doesNotMatch(etiquetas(p), /Qualificado/, 'sem a automação não há etiqueta nem botão de Qualificado');
  }
  // as duas permissões ligadas: tudo junto
  const tudo = abrir(comFormulario(casos[1][0], { automacao: true }));
  await esperar(() => /\+ Qualificado/.test(etiquetas(tudo)), { motivo: 'etiquetas' });
  assert.deepEqual(chips(tudo), ['R$ 5k+', 'Já vende']);
  // mais aparentes que as outras: preenchidas e em letra maior
  const investimento = [...tudo.document.getElementById('cr-etiquetas').querySelectorAll('span')][0];
  assert.equal(investimento.style.fontSize, '12px');
  assert.equal(investimento.style.fontWeight, '800');
  assert.notEqual(investimento.style.background, 'transparent');

  // só a automação (etiquetas desligadas): nenhuma etiqueta do formulário
  const soAuto = abrir(comFormulario(casos[0][0], { etiquetas: false, automacao: true }));
  await esperar(() => /\+ Qualificado/.test(etiquetas(soAuto)), { motivo: 'etiquetas' });
  assert.deepEqual(chips(soAuto), []);
  // formulário sem esses campos, ou nenhuma permissão: nada
  const vazio = abrir(comFormulario([{ rotulo: 'Estado', valor: 'Bahia' }]));
  await fichaNaTela(vazio);
  assert.deepEqual(chips(vazio), []);
  const nada = abrir(comFormulario(casos[0][0], { etiquetas: false }));
  await fichaNaTela(nada);
  assert.equal(nada.document.getElementById('cr-etiquetas'), null);
});

// ---------------------------------------------------------------- perda no RD
test('card perdido no RD: o cartão mostra DESQUALIFICADO (ou PERDIDO) com o motivo, mesmo sem as outras etiquetas ligadas', async () => {
  const comCards = (cards, extra = {}) => ({
    aoEnviar: async (msg) => (msg.action === 'crmLead'
      ? { ok: true, configurado: true, encontrado: true, coach: false, ficha: { ...fichaDoRd(cards.find((c) => c.escolhida).etapa), negociacoes: cards, totalNegociacoes: cards.length }, ...extra }
      : { ok: true }),
  });
  const card = (campos) => ({ id: 'd1', nome: 'Marcos Pereira', etapa: 'Desqualificados', funil: 'Funil SDR', responsavel: 'Cauã Lima', criadaEm: '28/09/2026', aberta: false, perdida: true, motivoPerda: 'Nunca respondeu', notaPerda: '', escolhida: true, ...campos });
  const perda = (p) => p.document.getElementById('cr-etiqueta-perda');

  // sem automação nem etiquetas do formulário: a perda aparece assim mesmo (vem da ficha do RD)
  const p = abrir(comCards([card()]));
  await esperar(() => !!perda(p), { motivo: 'etiqueta de perda' });
  assert.equal(perda(p).textContent, 'DESQUALIFICADO · Nunca respondeu');
  assert.equal(perda(p).title, 'Card dado como perdido no RD (etapa Desqualificados). Motivo: Nunca respondeu.');
  assert.equal(perda(p).parentElement.id, 'cr-etiquetas', 'fica na linha de etiquetas, à vista com o cartão minimizado');

  // perdido fora da etapa de desqualificados, com anotação; o texto do RD nunca vira HTML e motivo comprido é encurtado
  const outro = abrir(comCards([card({ etapa: 'Não Compraram', motivoPerda: 'Sem  limite no cartão para a entrada do projeto <b>x</b>', notaPerda: 'Volta em janeiro' })]));
  await esperar(() => !!perda(outro), { motivo: 'etiqueta de perda' });
  assert.equal(perda(outro).textContent, 'PERDIDO · Sem limite no cartão para a entra…');
  assert.match(perda(outro).title, /Motivo: Sem limite no cartão para a entrada do projeto <b>x<\/b>\. Anotação: Volta em janeiro\./);
  assert.equal(perda(outro).querySelector('b'), null);
  // sem motivo no RD: só o rótulo
  const semMotivo = abrir(comCards([card({ motivoPerda: '' })]));
  await esperar(() => !!perda(semMotivo), { motivo: 'etiqueta de perda' });
  assert.equal(perda(semMotivo).textContent, 'DESQUALIFICADO');

  // com a automação ligada: a perda vem primeiro e não se oferece "+ Qualificado" para card perdido
  const comAuto = abrir(comCards([card()], { automacao: true, podeResponder: false, marca: SEM_MARCA }));
  await esperar(() => !!perda(comAuto), { motivo: 'etiqueta de perda' });
  assert.equal(etiquetas(comAuto), 'DESQUALIFICADO · Nunca respondeu');

  // lead com um card perdido e outro em aberto: o escolhido é o aberto, então não há etiqueta de perda
  const reaberto = abrir(comCards([{ ...card({ id: 'd2', etapa: 'Respondeu', aberta: true, perdida: false, motivoPerda: '' }) }, card({ escolhida: false })], { automacao: true, podeResponder: false, marca: SEM_MARCA }));
  await esperar(() => /\+ Qualificado/.test(etiquetas(reaberto)), { motivo: 'etiquetas' });
  assert.equal(perda(reaberto), null);
  // card em aberto e nenhuma permissão: continua sem a linha de etiquetas
  const aberto = abrir(comCards([card({ etapa: 'Contato iniciado', aberta: true, perdida: false, motivoPerda: '' })]));
  await fichaNaTela(aberto);
  assert.equal(aberto.document.getElementById('cr-etiquetas'), null);
});

// ---------------------------------------------------------------- reunião do Google Agenda
test('reunião do Google Agenda: o cartão mostra dia, hora e closer, e ela vale mais que o agendamento lido na conversa', async () => {
  const comReuniao = (reuniao, marca = SEM_MARCA) => ({
    aoEnviar: async (msg) => (msg.action === 'crmLead'
      ? { ok: true, configurado: true, encontrado: true, ficha: fichaDoRd('Qualificado'), coach: false, automacao: true, podeResponder: false, marca, reuniao }
      : { ok: true }),
  });
  const dia = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(2031, 2, 15).getDay()];
  const p = abrir(comReuniao({ quando: '2031-03-15T14:00', closer: 'Vitor Augusto', titulo: 'Diagnóstico Pronix — Marcos' }, { ...SEM_MARCA, agendadoPara: '2031-03-10T09:00', agendaFonteTs: 9e15 }));
  await esperar(() => /Agendado/.test(etiquetas(p)), { motivo: 'etiqueta da agenda' });
  assert.ok(etiquetas(p).includes(`Agendado: ${dia}, 15/03 às 14:00 · Vitor Augusto`));
  assert.doesNotMatch(etiquetas(p), /10\/03/, 'o que foi lido na conversa dá lugar ao que está na agenda');
  const chip = [...p.document.getElementById('cr-etiquetas').querySelectorAll('span')].find((x) => /Agendado/.test(x.textContent));
  assert.equal(chip.title, 'Do Google Agenda: Diagnóstico Pronix — Marcos');
  assert.equal(botaoPorTitulo(p, 'Apagar este agendamento'), undefined, 'o que vem da agenda não se apaga pelo cartão');

  // reunião que já passou, e sem closer (evento na própria agenda)
  const q = abrir(comReuniao({ quando: '2020-01-10T09:00', closer: '', titulo: '' }));
  await esperar(() => /Estava agendado/.test(etiquetas(q)), { motivo: 'reunião passada' });
  assert.match(etiquetas(q), /Estava agendado: \S+, 10\/01 às 09:00$|Estava agendado: \S+, 10\/01 às 09:00[^·]*$/);
});

// ---------------------------------------------------------------- desqualificar pelo cartão
test('Desqualificar: escolhe o motivo do RD, confirma e o cartão mostra DESQUALIFICADO — só no card em aberto, com a automação', async () => {
  const srv = servidorFalso({ etapa: 'Respondeu' });
  const pedidos = { motivos: 0, perda: [] };
  let resposta = { ok: true, motivo: 'Sem dinheiro', etapa: 'Desqualificados' };
  const original = srv.aoEnviar;
  srv.aoEnviar = async (msg) => {
    if (msg.action === 'crmMotivosPerda') { pedidos.motivos++; return { ok: true, motivos: [{ id: 'm1', nome: 'Nunca respondeu' }, { id: 'm2', nome: 'Sem dinheiro' }] }; }
    if (msg.action === 'crmDesqualificar') { pedidos.perda.push(JSON.parse(JSON.stringify(msg))); return resposta; }
    return original(msg);
  };
  const p = abrir(srv);
  await fichaNaTela(p);
  const btn = () => p.document.getElementById('cr-desqualificar-btn');
  const caixa = () => p.document.getElementById('cr-desqualificar');
  await esperar(() => btn(), { motivo: 'botão Desqualificar' });

  btn().click();
  await esperar(() => caixa() && caixa().querySelectorAll('[data-motivo]').length === 2, { motivo: 'motivos do RD' });
  assert.equal(pedidos.motivos, 1);
  // escolher o motivo pede confirmação; ainda não dá perda
  caixa().querySelector('[data-motivo="m2"]').click();
  await esperar(() => p.document.getElementById('cr-desq-confirmar'), { motivo: 'confirmação' });
  assert.match(caixa().textContent, /Dar perda no RD com o motivo:Sem dinheiro/);
  assert.equal(pedidos.perda.length, 0);

  // o RD recusou: o erro aparece e dá para tentar de novo
  resposta = { ok: false, erro: 'O RD Station não deixou alterar este card.' };
  p.document.getElementById('cr-desq-confirmar').click();
  await esperar(() => /não deixou alterar/.test(caixa().textContent), { motivo: 'erro do RD' });
  resposta = { ok: true, motivo: 'Sem dinheiro', etapa: 'Desqualificados' };
  p.document.getElementById('cr-desq-confirmar').click();
  await esperar(() => /DESQUALIFICADO · Sem dinheiro/.test(etiquetas(p)), { motivo: 'etiqueta da perda' });
  assert.deepEqual(pedidos.perda.map((x) => [x.dealId, x.motivoId]), [['d1', 'm2'], ['d1', 'm2']]);
  assert.match(etiquetas(p), /Card dado como perdido no RD: Sem dinheiro\./);
  assert.equal(btn(), null, 'perdido não tem mais o botão');
  assert.equal(caixa(), null);
});

test('Desqualificar: sem a automação do cartão o botão não aparece; cancelar fecha sem dar perda', async () => {
  const sem = abrir(servidorFalso({ automacao: false, etapa: 'Respondeu' }));
  await fichaNaTela(sem);
  await dormir(60);
  assert.equal(sem.document.getElementById('cr-desqualificar-btn'), null);

  const srv = servidorFalso({ etapa: 'Respondeu' });
  const original = srv.aoEnviar;
  let perdas = 0;
  srv.aoEnviar = async (msg) => {
    if (msg.action === 'crmMotivosPerda') return { ok: true, motivos: [{ id: 'm1', nome: 'Nunca respondeu' }] };
    if (msg.action === 'crmDesqualificar') { perdas++; return { ok: true }; }
    return original(msg);
  };
  const p = abrir(srv);
  await fichaNaTela(p);
  await esperar(() => p.document.getElementById('cr-desqualificar-btn'), { motivo: 'botão' });
  p.document.getElementById('cr-desqualificar-btn').click();
  await esperar(() => p.document.querySelector('#cr-desqualificar [data-motivo]'), { motivo: 'motivos' });
  [...p.document.querySelectorAll('#cr-desqualificar button')].find((b) => b.textContent === 'Cancelar').click();
  await esperar(() => !p.document.getElementById('cr-desqualificar') && p.document.getElementById('cr-desqualificar-btn'), { motivo: 'fechou' });
  assert.equal(perdas, 0);
});

// ---------------------------------------------------------------- report automático: a contagem do dia
const horaWpp = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}, ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; };
const AGORA_DO_TESTE = new Date();
const HOJE_WPP = horaWpp(new Date(AGORA_DO_TESTE.getFullYear(), AGORA_DO_TESTE.getMonth(), AGORA_DO_TESTE.getDate(), 12, 0));
const ONTEM_WPP = horaWpp(new Date(AGORA_DO_TESTE.getFullYear(), AGORA_DO_TESTE.getMonth(), AGORA_DO_TESTE.getDate() - 1, 12, 0));

/** Abre a conversa e devolve o que a extensão avisou ao servidor sobre o dia (action "atividade"). */
async function atividadeDe(conversa, opcoes = {}) {
  const srv = servidorFalso(opcoes);
  const avisos = [];
  const original = srv.aoEnviar;
  srv.aoEnviar = async (msg) => { if (msg.action === 'atividade') { avisos.push(JSON.parse(JSON.stringify(msg))); return { ok: true }; } return original(msg); };
  const p = abrir(srv, conversa);
  await fichaNaTela(p);
  await dormir(150);
  return { avisos, p };
}

test('contagem do dia: lead novo (só eu escrevi hoje), lead que respondeu, recontato (já havia histórico) — e só avisa uma vez', async () => {
  let r = await atividadeDe([{ from: 'eu', texto: 'Oi Marcos, tudo bem?', hora: HOJE_WPP }]);
  assert.deepEqual(r.avisos.map((a) => [a.telefone, a.eu, a.antes, a.eles]), [['5571999998888', true, false, false]]);
  await dormir(150);
  assert.equal(r.avisos.length, 1, 'nada mudou: não avisa de novo');

  r = await atividadeDe([{ from: 'eu', texto: 'Oi Marcos, tudo bem?', hora: HOJE_WPP }, { from: 'eles', texto: 'Tudo sim, pode falar', hora: HOJE_WPP }]);
  assert.deepEqual(r.avisos.map((a) => [a.eu, a.antes, a.eles]), [[true, false, true]]);

  r = await atividadeDe([
    { from: 'eu', texto: 'Oi Marcos', hora: ONTEM_WPP }, { from: 'eles', texto: 'Oi', hora: ONTEM_WPP },
    { from: 'eu', texto: 'Voltando aqui, conseguiu pensar?', hora: HOJE_WPP },
  ]);
  assert.deepEqual(r.avisos.map((a) => [a.eu, a.antes, a.eles]), [[true, true, false]], 'recontato: havia mensagens de antes');

  // áudio e foto não têm hora: valem a da mensagem de antes (aqui, a de hoje)
  r = await atividadeDe([{ from: 'eles', texto: 'Oi', hora: ONTEM_WPP }, { from: 'eu', texto: 'Bom dia!', hora: HOJE_WPP }, { from: 'eu', tipo: 'audio' }]);
  assert.deepEqual(r.avisos.map((a) => [a.eu, a.antes, a.eles]), [[true, true, false]]);
});

test('contagem do dia: conversa só com mensagens de ontem, ou sem nenhuma data, não gera aviso; sem a automação a extensão nem conta', async () => {
  let r = await atividadeDe([{ from: 'eu', texto: 'Oi', hora: ONTEM_WPP }, { from: 'eles', texto: 'Oi', hora: ONTEM_WPP }]);
  assert.deepEqual(r.avisos, []);
  r = await atividadeDe([{ from: 'eu', tipo: 'audio' }]);
  assert.deepEqual(r.avisos, [], 'sem nenhuma hora não dá para dizer o dia');
  r = await atividadeDe([{ from: 'eu', texto: 'Oi Marcos', hora: HOJE_WPP }], { automacao: false });
  assert.deepEqual(r.avisos, []);
});

// ---------------------------------------------------------------- etiquetas de outros funis (ex.: Análise)
test('etiquetas do funil de Análise: MOMENTO vira "Já vende", FATURAMENTO vira faixa, e o modelo não preenchido ({{…}}) é ignorado', async () => {
  const comCampos = (campos) => ({
    aoEnviar: async (msg) => {
      if (msg.action !== 'crmLead') return { ok: true };
      return { ok: true, configurado: true, encontrado: true, ficha: { ...fichaDoRd('Sem contato'), formulario: { campos, autor: 'Gustavo Dias', quando: '' } }, coach: false, etiquetas: true };
    },
  });
  const chips = (p) => [...p.document.getElementById('cr-etiquetas').querySelectorAll('span')].map((x) => x.textContent);
  const p = abrir(comCampos([
    { rotulo: 'MOMENTO', valor: 'Sim, já vendo' }, { rotulo: 'FATURAMENTO', valor: 'Entre R$10.000 a R$50.000' },
    { rotulo: 'BUSCA', valor: '{{data.Qual Modalidade você trabalha hoje?}}' },
  ]));
  await esperar(() => !!p.document.getElementById('cr-etiquetas'), { motivo: 'etiquetas' });
  assert.deepEqual(chips(p), ['Fat. R$ 10 a 50k', 'Já vende']);
  // BUSCA já preenchida aparece
  const q = abrir(comCampos([{ rotulo: 'MOMENTO', valor: 'Ainda não vendo' }, { rotulo: 'FATURAMENTO', valor: 'Acima de R$50.000' }, { rotulo: 'BUSCA', valor: 'Revenda de semijoias' }]));
  await esperar(() => !!q.document.getElementById('cr-etiquetas'), { motivo: 'etiquetas' });
  assert.deepEqual(chips(q), ['Fat. R$ 50k+', 'Ainda não vende', 'Revenda de semijoias']);
});
