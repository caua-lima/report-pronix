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
