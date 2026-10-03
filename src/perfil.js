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

/** { tipo, evidencia, conduzir } vindo da IA -> formato limpo, ou null se o tipo não for reconhecido. */
function normalizarPerfil(p) {
  if (!p || typeof p !== 'object') return null;
  const tipo = chaveDoPerfil(p.tipo);
  if (!tipo) return null;
  const txt = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  return { tipo, evidencia: txt(p.evidencia, 300), conduzir: txt(p.conduzir, 300) };
}

/** Texto da régua para entrar num prompt (report e coach usam a mesma). */
function reguaParaPrompt() {
  return PERFIS.map((p) => `- "${p.chave}" (${p.rotulo}): ${p.sinais}. Como conduzir: ${p.conduzir}.`).join('\n');
}

module.exports = { PERFIS, chaveDoPerfil, infoDoPerfil, normalizarPerfil, reguaParaPrompt, semAcento };
