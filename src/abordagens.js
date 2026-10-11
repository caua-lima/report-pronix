'use strict';

// Abordagens do primeiro contato: o pré-vendedor testa algumas variações da primeira mensagem
// (cada uma vira uma "mensagem rápida" no WhatsApp) e o sistema conta, por abordagem, quantos leads
// receberam, quantos responderam, quantos viraram report e quantos viraram VENDA.
//
// Como a conta é feita:
//   - a extensão reconhece a abordagem pelo trecho que só ela tem (a "assinatura") nas primeiras
//     mensagens do pré-vendedor, e avisa o servidor só a LETRA da abordagem — nenhum texto de conversa;
//   - "respondeu" entra quando existe mensagem do lead depois da do pré-vendedor;
//   - "virou report" e "venda" vêm dos reports do mesmo lead (o resultado marcado em Resultados ou
//     puxado do RD).
// Sem IA e sem custo: é só contagem.

const db = require('./db');
const { ehVenda } = require('./stats');
const { ehDaConversa } = require('./closerAuto');

const CHAVE_CFG = 'abordagens'; // { lista: [...], atualizadoEm }
const CHAVE_CONTATOS = 'abordagem_contatos'; // { [id]: { usuarioId, tel, nome, abordagem, em, respondeu, respondeuEm } }
const LIMITE = 6000; // contatos lembrados; passando disso saem os mais antigos
const MAX_ABORDAGENS = 8;
const MIN_AMOSTRA = 10; // envios para a taxa de uma abordagem valer como comparação

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const texto = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// As cinco de partida: a de hoje (controle) e quatro variações que mudam UMA coisa cada.
// Todas mantêm "Você agendou sua reunião para [DIA] às [HORA]": é a frase que o cartão lê para
// mostrar o agendamento. [NOME], [DIA] e [HORA] são trocados à mão na hora de enviar.
const PADRAO = [
  {
    id: 'A', nome: 'Controle (a de hoje)',
    hipotese: 'A referência: pergunta fechada, fácil de responder com um "sim".',
    mensagens: [
      'Boa tarde, [NOME]!',
      'Prazer em falar com você, sou o Cauã Lima.',
      'Especialista em Mercado Livre do time do Hugo Vasconcelos.',
      'Você agendou sua reunião para [DIA] às [HORA].',
      'Posso confirmar, [NOME]?',
    ],
    assinaturas: ['posso confirmar'],
  },
  {
    id: 'B', nome: 'Pergunta de situação',
    hipotese: 'Trocar o "posso confirmar?" por uma pergunta de duas opções: tão fácil de responder quanto, e a resposta já começa a qualificação.',
    mensagens: [
      'Boa tarde, [NOME]!',
      'Prazer em falar com você, sou o Cauã Lima.',
      'Especialista em Mercado Livre do time do Hugo Vasconcelos.',
      'Você agendou sua reunião para [DIA] às [HORA].',
      'Antes da reunião, me conta: você já vende no Mercado Livre ou vai começar do zero?',
    ],
    assinaturas: ['você já vende no Mercado Livre ou vai começar do zero'],
  },
  {
    id: 'C', nome: 'Motivo da confirmação',
    hipotese: 'Dizer por que está confirmando (preparar a reunião para o caso dele) e pedir a presença, não só um "ok".',
    mensagens: [
      'Boa tarde, [NOME]!',
      'Prazer em falar com você, sou o Cauã Lima.',
      'Especialista em Mercado Livre do time do Hugo Vasconcelos.',
      'Você agendou sua reunião para [DIA] às [HORA].',
      'Quero deixar tudo preparado para o seu caso. Posso confirmar a sua presença, [NOME]?',
    ],
    assinaturas: ['deixar tudo preparado para o seu caso'],
  },
  {
    id: 'D', nome: 'Curta (duas mensagens)',
    hipotese: 'O mesmo conteúdo em duas mensagens em vez de cinco: menos notificação e menos cara de roteiro.',
    mensagens: [
      'Boa tarde, [NOME]! Aqui é o Cauã Lima, especialista em Mercado Livre do time do Hugo Vasconcelos.',
      'Você agendou sua reunião para [DIA] às [HORA]. Posso confirmar?',
    ],
    assinaturas: ['aqui é o Cauã Lima, especialista em Mercado Livre'],
  },
  {
    id: 'E', nome: 'Horário reservado',
    hipotese: 'Tratar o horário como uma vaga já reservada e pedir o compromisso de presença: mais confirmação e menos no-show.',
    mensagens: [
      'Boa tarde, [NOME]!',
      'Prazer em falar com você, sou o Cauã Lima.',
      'Especialista em Mercado Livre do time do Hugo Vasconcelos.',
      'Você agendou sua reunião para [DIA] às [HORA], e o seu horário já está reservado na nossa agenda.',
      'Você confirma a sua presença, [NOME]?',
    ],
    assinaturas: ['seu horário já está reservado na nossa agenda'],
  },
];

/** Deixa uma abordagem no formato guardado; devolve null se não der para usar. */
function limpar(a, i) {
  if (!a || typeof a !== 'object') return null;
  const id = texto(a.id, 3).toUpperCase().replace(/[^A-Z0-9]/g, '') || String.fromCharCode(65 + i);
  const nome = texto(a.nome, 40);
  const mensagens = (Array.isArray(a.mensagens) ? a.mensagens : []).map((m) => texto(m, 400)).filter(Boolean).slice(0, 8);
  // Assinatura curta demais casaria com qualquer conversa.
  const assinaturas = (Array.isArray(a.assinaturas) ? a.assinaturas : []).map((s) => texto(s, 120)).filter((s) => normalizar(s).length >= 8).slice(0, 3);
  if (!nome || !mensagens.length || !assinaturas.length) return null;
  return { id, nome, hipotese: texto(a.hipotese, 240), mensagens, assinaturas };
}

/** As abordagens em teste (as de partida, enquanto ninguém editou). */
async function ler() {
  const j = await db.getJson(CHAVE_CFG, null).catch(() => null);
  const lista = j && Array.isArray(j.lista) ? j.lista.map(limpar).filter(Boolean) : [];
  return lista.length ? lista : PADRAO.map((a) => ({ ...a }));
}

/**
 * Grava as abordagens. Recusa letra repetida e assinatura que aparece em mais de uma (a conta
 * ficaria errada). Trocar o texto de uma abordagem não apaga o que já foi contado para a letra dela.
 */
async function salvar(lista) {
  const limpas = (Array.isArray(lista) ? lista : []).slice(0, MAX_ABORDAGENS).map(limpar).filter(Boolean);
  if (!limpas.length) throw new Error('Cada abordagem precisa de nome, ao menos uma mensagem e uma assinatura (8 letras ou mais).');
  const ids = limpas.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duas abordagens com a mesma letra.');
  const vistas = new Map();
  for (const a of limpas) {
    for (const s of a.assinaturas.map(normalizar)) {
      if (vistas.has(s) && vistas.get(s) !== a.id) throw new Error(`A assinatura "${s}" está em duas abordagens (${vistas.get(s)} e ${a.id}).`);
      vistas.set(s, a.id);
    }
    // A assinatura tem de estar no texto que vai ser enviado, senão a abordagem nunca é reconhecida.
    const corpo = a.mensagens.map(normalizar);
    const fora = a.assinaturas.find((s) => !corpo.some((m) => m.includes(normalizar(s))));
    if (fora) throw new Error(`Abordagem ${a.id}: a assinatura "${fora}" não aparece inteira em nenhuma das mensagens.`);
  }
  await db.setJson(CHAVE_CFG, { lista: limpas, atualizadoEm: new Date().toISOString() });
  return limpas;
}

/** O que a extensão precisa para reconhecer a abordagem: só a letra e as assinaturas. */
const paraExtensao = (lista) => (lista || []).map((a) => ({ id: a.id, assinaturas: a.assinaturas }));

// ---------------------------------------------------------------- contatos
const contatos = async () => {
  const j = await db.getJson(CHAVE_CONTATOS, {});
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
};

/** Do { telefone, nome } da conversa, o que identifica o lead: os 8 últimos dígitos e/ou o nome. */
function identificar(conversa) {
  const c = conversa && typeof conversa === 'object' ? conversa : {};
  const d = soDigitos(c.telefone);
  const nome = normalizar(c.nome).slice(0, 60);
  return { tel: d.length >= 8 ? d.slice(-8) : '', nome: nome && !/^[\d ]+$/.test(nome) ? nome : '' };
}
const mesmoLead = (r, usuarioId, k) =>
  r.usuarioId === usuarioId && ((k.tel && r.tel === k.tel) || (k.nome && r.nome === k.nome));
const achar = (mapa, usuarioId, k) => Object.keys(mapa).find((id) => mesmoLead(mapa[id], usuarioId, k)) || '';
const publico = (r) => ({ abordagem: (r && r.abordagem) || '', respondeu: Boolean(r && r.respondeu) });

/** O que já foi anotado para o lead desta conversa. */
async function doLead(usuarioId, conversa) {
  const k = identificar(conversa);
  if (!k.tel && !k.nome) return publico(null);
  const mapa = await contatos();
  return publico(mapa[achar(mapa, usuarioId, k)]);
}

/**
 * Anota a abordagem usada com um lead e/ou que ele respondeu.
 *  - a abordagem só entra uma vez: a primeira reconhecida é a do primeiro contato;
 *  - "respondeu" só vale para lead que tem abordagem anotada.
 * @returns {Promise<{abordagem: string, respondeu: boolean}|null>} null sem telefone nem nome
 */
async function anotar({ usuarioId, conversa, abordagem, respondeu }) {
  const k = identificar(conversa);
  if (!usuarioId || (!k.tel && !k.nome)) return null;
  const mapa = await contatos();
  let id = achar(mapa, usuarioId, k);
  let mudou = false;
  const agora = new Date().toISOString();
  if (!id && abordagem) {
    const validas = (await ler()).map((a) => a.id);
    const letra = String(abordagem).toUpperCase();
    if (!validas.includes(letra)) return publico(null);
    id = `${usuarioId}:${k.tel || k.nome}`;
    mapa[id] = { usuarioId, tel: k.tel, nome: k.nome, abordagem: letra, em: agora, respondeu: false, respondeuEm: '' };
    mudou = true;
  }
  const r = id ? mapa[id] : null;
  if (!r) return publico(null);
  // A conversa pode chegar ora só com o nome, ora com o telefone: guarda os dois quando aparecem.
  if (k.tel && !r.tel) { r.tel = k.tel; mudou = true; }
  if (k.nome && !r.nome) { r.nome = k.nome; mudou = true; }
  if (respondeu === true && !r.respondeu) {
    r.respondeu = true;
    r.respondeuEm = agora;
    mudou = true;
  }
  if (mudou) {
    const ids = Object.keys(mapa);
    if (ids.length > LIMITE) {
      ids.sort((a, b) => String(mapa[a].em || '').localeCompare(String(mapa[b].em || ''))).slice(0, ids.length - LIMITE).forEach((x) => delete mapa[x]);
    }
    await db.setJson(CHAVE_CONTATOS, mapa);
  }
  return publico(r);
}

// ---------------------------------------------------------------- placar
const taxa = (v, t) => (t ? v / t : 0);

/**
 * O placar das abordagens: enviadas, respostas, reports e vendas de cada uma.
 * @param {{usuarioId?: string, reports: object[], desde?: string}} o  usuarioId vazio = a equipe toda;
 *   desde = 'AAAA-MM-DD' (só contatos feitos a partir desse dia)
 */
async function placar({ usuarioId, reports, desde } = {}) {
  const lista = await ler();
  const mapa = await contatos();
  const registros = Object.values(mapa).filter(
    (r) => r && r.abordagem && (!usuarioId || r.usuarioId === usuarioId) && (!desde || String(r.em || '') >= desde)
  );
  const porUsuario = new Map();
  (reports || []).forEach((rep) => {
    const l = porUsuario.get(rep.usuarioId) || [];
    l.push(rep);
    porUsuario.set(rep.usuarioId, l);
  });
  const linhas = lista.map((a) => {
    const meus = registros.filter((r) => r.abordagem === a.id);
    let respostas = 0;
    let comReport = 0;
    let vendas = 0;
    meus.forEach((r) => {
      if (r.respondeu) respostas++;
      const doLeadR = (porUsuario.get(r.usuarioId) || []).filter((rep) => ehDaConversa(rep, { telefone: r.tel, nome: r.nome }));
      if (doLeadR.length) comReport++;
      if (doLeadR.some((rep) => ehVenda(rep.resultado) || rep.vendidoNoRd)) vendas++;
    });
    return {
      id: a.id, nome: a.nome, enviadas: meus.length, respostas, comReport, vendas,
      taxaResposta: taxa(respostas, meus.length), taxaVenda: taxa(vendas, meus.length),
      amostraPequena: meus.length < MIN_AMOSTRA,
    };
  });
  // Só disputa quem já tem amostra; empate fica com quem tem mais envios.
  const disputa = linhas.filter((l) => !l.amostraPequena);
  const melhor = (campo, minimo) =>
    disputa.filter((l) => l[minimo] > 0).sort((x, y) => y[campo] - x[campo] || y.enviadas - x.enviadas)[0] || null;
  const emResposta = melhor('taxaResposta', 'respostas');
  const emVenda = melhor('taxaVenda', 'vendas');
  // Lead com abordagem que saiu da lista (letra apagada): aparece no total, não numa linha.
  const letras = new Set(lista.map((a) => a.id));
  return {
    linhas,
    total: registros.length,
    semAbordagemAtual: registros.filter((r) => !letras.has(r.abordagem)).length,
    melhorEmResposta: emResposta ? emResposta.id : '',
    melhorEmVenda: emVenda ? emVenda.id : '',
    minAmostra: MIN_AMOSTRA,
  };
}

module.exports = { ler, salvar, paraExtensao, doLead, anotar, placar, PADRAO, MIN_AMOSTRA, normalizar };
