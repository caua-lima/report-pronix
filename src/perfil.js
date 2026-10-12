'use strict';

// Perfil comportamental do lead — a mesma régua no report, no coach e na inteligência (qual closer
// se dá bem com qual tipo de lead). É leitura de COMO o lead responde (texto e áudio transcrito),
// nunca um rótulo de valor: todo perfil vem com "como conduzir".

const PERFIS = [
  {
    chave: 'dominante',
    rotulo: 'Dominante',
    sinais: 'respostas curtas e diretas, vai ao ponto, quer saber resultado, prazo e preço logo, toma a frente da conversa, decide rápido, pouca paciência para rodeio',
    conduzir: 'responder direto ao que ele perguntou (inclusive valor), fazer a conta na hora, dar opções para ELE escolher e não enrolar: ele mesmo puxa o fechamento',
  },
  {
    chave: 'analitico',
    rotulo: 'Analítico',
    sinais: 'pede números, detalhes e passo a passo, pergunta "como funciona exatamente", compara opções, quer entender o método antes de avançar, respostas organizadas',
    conduzir: 'falar de lucro e retorno (não de faturamento), mostrar o processo de validação de produto com estoque pequeno, deixar que leia o contrato e a garantia: ele decide quando a conta fecha',
  },
  {
    chave: 'cetico',
    rotulo: 'Cético',
    sinais: 'desconfia, pede prova e garantia, cita experiência ruim com curso/mentoria/golpe, questiona promessas, "isso funciona mesmo?"',
    conduzir: 'dizer a garantia exatamente como está no contrato, admitir o que pode dar errado e por quê, mostrar casos de quem começou sem nada e nunca prometer demais; se já pagou outra mentoria, responder ao que falhou lá',
  },
  {
    chave: 'relacional',
    rotulo: 'Relacional',
    sinais: 'conta a história pessoal, fala de família, sonho e sentimento, áudios longos, busca conexão e confiança na pessoa, responde com calor',
    conduzir: 'criar conexão verdadeira antes do método, ligar a solução ao motivo pessoal que ele citou, mostrar que o acompanhamento é feito por gente, não por robô',
  },
  {
    chave: 'cauteloso',
    rotulo: 'Cauteloso',
    sinais: 'hesita, pede tempo, quer consultar sócio/cônjuge, medo de errar ou perder dinheiro, "vou ver", respostas com ressalva',
    conduzir: 'dar segurança com passo a passo e risco controlado, propor uma forma de pagamento que ele sustente mesmo no pior cenário, começar pelo que ele já tem e envolver quem decide junto',
  },
  {
    chave: 'entusiasta',
    rotulo: 'Entusiasta',
    sinais: 'animado, responde rápido, muitos emojis/exclamações, já se imagina vendendo, quer começar logo, topa as coisas com facilidade',
    conduzir: 'aproveitar o embalo, ancorar em plano concreto e próximo passo com data, e conferir valor total, cartão e limite antes de fechar para o entusiasmo virar compromisso',
  },
];

const semAcento = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Nomes que o modelo (ou uma versão antiga do coach) pode devolver para o mesmo perfil.
const APELIDOS = {
  emocional: 'relacional', expressivo: 'relacional', afetivo: 'relacional',
  apressado: 'dominante', direto: 'dominante', pragmatico: 'dominante',
  indeciso: 'cauteloso', inseguro: 'cauteloso', conservador: 'cauteloso', estavel: 'cauteloso',
  curioso: 'analitico', racional: 'analitico', tecnico: 'analitico',
  desconfiado: 'cetico',
  animado: 'entusiasta', influente: 'entusiasta', empolgado: 'entusiasta',
};

/** "Analítico", "ANALITICO", "curioso" -> 'analitico'. Desconhecido -> null. */
function chaveDoPerfil(v) {
  const k = semAcento(v);
  if (PERFIS.some((p) => p.chave === k)) return k;
  return APELIDOS[k] || null;
}

const infoDoPerfil = (chave) => PERFIS.find((p) => p.chave === chave) || null;

/** { tipo, evidencia, conduzir, evitar? } vindo da IA -> formato limpo, ou null se o tipo não for reconhecido. */
function normalizarPerfil(p) {
  if (!p || typeof p !== 'object') return null;
  const tipo = chaveDoPerfil(p.tipo);
  if (!tipo) return null;
  const txt = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const saida = { tipo, evidencia: txt(p.evidencia, 300), conduzir: txt(p.conduzir, 300) };
  // O que faz este lead esfriar na reunião (uma frase). Só entra quando a IA escreveu.
  const evitar = txt(p.evitar, 200).replace(/^evit(e|ar)\s*:?\s*/i, '');
  if (evitar) saida.evitar = evitar;
  return saida;
}

/** Texto da régua para entrar num prompt (report e coach usam a mesma). */
function reguaParaPrompt() {
  return PERFIS.map((p) => `- "${p.chave}" (${p.rotulo}): ${p.sinais}. Como conduzir: ${p.conduzir}.`).join('\n');
}

/**
 * Como escolher entre os perfis (report e coach usam o mesmo texto). Existe porque, sem um critério, a IA
 * cai em "cauteloso" para quase todo lead educado — e aí o perfil não serve para escolher closer.
 */
function comoDecidirPerfil() {
  return [
    'COMO DECIDIR — o perfil é o PADRÃO das falas do LEAD na conversa inteira, não uma frase solta (o que o vendedor disse não conta):',
    'a) Passe pelas falas do lead e marque qual perfil cada uma PROVA. A maioria não prova nenhum: resposta a uma pergunta do vendedor, "sim", "ok", dado de formulário e confirmação de horário não contam.',
    'b) Fique com o perfil que tem MAIS falas-prova. Vale mais a fala em que o lead tomou a INICIATIVA (perguntou, contou, pediu, cobrou) do que a fala em que só respondeu.',
    'c) Empate: o perfil da fala mais forte perto do fim da conversa (é o estado em que ele chega à reunião); persistindo, a ordem abaixo.',
    'O QUE É PROVA DE CADA UM:',
    '1. "cetico": desconfiança dita — pediu prova ou garantia, citou golpe, curso ou mentoria que não deu certo, perguntou "funciona mesmo?", quis saber quem está por trás.',
    '2. "analitico": por conta própria, pediu número, detalhe ou passo a passo; comparou opções; quis entender o método, a margem ou o retorno ANTES de avançar. Uma pergunta isolada ("como funciona?") não basta: precisa de duas provas, ou de uma pergunta de conta (margem, prazo de retorno, custo).',
    '3. "dominante": respostas curtas e diretas; perguntou preço, prazo ou resultado logo; conduziu a conversa, cortou rodeio ou cobrou objetividade.',
    '4. "entusiasta": animação dita — exclamações, "quero começar já", topou as coisas na hora, já se imagina vendendo.',
    '5. "relacional": contou a própria história sem ser perguntado, falou de família, sonho ou sentimento, mandou áudio longo, agradeceu a atenção.',
    '6. "cauteloso": SÓ com hesitação dita — pediu tempo, disse que precisa de outra pessoa para DECIDIR, falou do medo de perder dinheiro ou de errar, respondeu "vou ver". Um "vou ver" isolado numa conversa animada não faz ninguém cauteloso.',
    'ARMADILHAS: "cauteloso" e "analitico" não são perfis padrão — são os dois erros mais comuns. Ser educado, responder "sim", confirmar a reunião, ter pouco dinheiro, estar começando do zero ou dizer que conversa com o cônjuge mas decide sozinho NÃO é cautela. Responder com números porque o vendedor PERGUNTOU os números NÃO é ser analítico. Em conversa curta, decida pelo JEITO das falas que existem (tamanho, tom, quem puxa o assunto) e nunca escolha um perfil só porque não achou prova dos outros.',
    'SEJA AFIRMATIVO: escolha um perfil e sustente. Nada de "parece", "talvez", "aparenta ser" ou "pode ser" na evidência e no como conduzir.',
  ].join('\n');
}

module.exports = { PERFIS, chaveDoPerfil, infoDoPerfil, normalizarPerfil, reguaParaPrompt, comoDecidirPerfil, semAcento };
