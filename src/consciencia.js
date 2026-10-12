'use strict';

// Nível de consciência do lead (escala de Eugene Schwartz), classificado pela IA só com o que o
// lead disse/demonstrou na conversa. São duas coisas diferentes:
//  - o NÍVEL (1 a 5) é a medida da gestão: aparece no painel, entra nas estatísticas e é o que o
//    master corrige. Tem de estar certo, mesmo quando é baixo;
//  - o MOMENTO DO LEAD é o que vai para o report. O report é uma VENDA do lead para o closer, então
//    o selo aparece sempre e sempre com algo bom e verdadeiro: um título escrito para aquele lead,
//    a fala dele que sustenta o título e o porquê. Nada de rótulo de livro ("consciente do problema")
//    nem de "nível 2 de 5": a barra de degraus só entra quando o nível é bom (3 ou mais).

const NIVEIS = [
  { chave: 'inconsciente', numero: 1, rotulo: 'Inconsciente do problema' },
  { chave: 'problema', numero: 2, rotulo: 'Consciente do problema' },
  { chave: 'solucao', numero: 3, rotulo: 'Consciente da solução' },
  { chave: 'produto', numero: 4, rotulo: 'Consciente da nossa entrega' },
  { chave: 'pronto', numero: 5, rotulo: 'Pronto para decidir' },
];
const NIVEL_MINIMO_DA_BARRA = 3;

// Títulos de reserva, para quando a IA não mandou o dela (report antigo, resposta incompleta). Vários por
// nível, e a escolha muda de lead para lead: o closer não lê a mesma frase em todo report.
const TITULOS = {
  inconsciente: ['Chega aberto para ouvir o caminho', 'Curioso e disposto a entender o modelo', 'Veio conhecer como funciona', 'Quer entender se é para ele'],
  problema: ['Sabe o que quer mudar', 'Tem um motivo claro para agir', 'Chega com o objetivo definido', 'Já deu nome ao que incomoda'],
  solucao: ['Já procura quem mostre o caminho', 'Quer método em vez de tentativa', 'Busca direção para avançar', 'Decidiu que precisa de ajuda certa'],
  produto: ['Entendeu a entrega e quer mais', 'Viu valor no acompanhamento', 'Já pergunta como funciona por dentro', 'Reagiu bem ao que foi apresentado'],
  pronto: ['Chega querendo começar', 'Já fala em começar', 'Decisão encaminhada', 'Pronto para combinar o início'],
};
// O título é escrito para o lead: o nome da régua e número de nível não servem.
const TITULO_DE_LIVRO = /consciente\s+d[oae]|inconsciente|n[ií]vel\s*\d|\d\s*de\s*5/i;

/** "Solução", "SOLUCAO", "solucao" -> 'solucao'. Qualquer outra coisa -> null. */
function chaveDoNivel(v) {
  const k = String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  return NIVEIS.some((n) => n.chave === k) ? k : null;
}

const limpo = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** { nivel, porque, titulo?, fala? } vindo da IA ou da tela de edição -> formato limpo, ou null se inválido. */
function normalizarConsciencia(c) {
  if (!c || typeof c !== 'object') return null;
  const nivel = chaveDoNivel(c.nivel);
  if (!nivel) return null;
  const porque = typeof c.porque === 'string' ? c.porque.trim().slice(0, 400) : '';
  const saida = { nivel, porque };
  const titulo = limpo(c.titulo, 70).replace(/[.:;,\s]+$/, '');
  if (titulo.length >= 6 && !TITULO_DE_LIVRO.test(titulo)) saida.titulo = titulo;
  const fala = limpo(c.fala, 220).replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
  if (fala.length >= 4) saida.fala = fala;
  return saida;
}

const infoDoNivel = (c) => (c && NIVEIS.find((n) => n.chave === c.nivel)) || null;

/** O selo vai para o report sempre que há um nível lido: o título é positivo em qualquer um deles. */
const mostrarConsciencia = (c) => Boolean(infoDoNivel(c));
/** A barra de degraus só entra quando o nível é bom; abaixo disso, mostrar "2 de 5" desanima e não ajuda. */
const mostrarBarra = (c) => {
  const info = infoDoNivel(c);
  return Boolean(info && info.numero >= NIVEL_MINIMO_DA_BARRA);
};

/**
 * O título do "Momento do lead": o que a IA escreveu para este lead; sem ele, um de reserva do nível,
 * escolhido pela semente (nome do lead + o porquê) para variar entre os reports.
 */
function tituloDoMomento(c, semente) {
  const info = infoDoNivel(c);
  if (!info) return '';
  if (c.titulo && !TITULO_DE_LIVRO.test(c.titulo)) return String(c.titulo);
  const opcoes = TITULOS[info.chave];
  const s = String(semente || '') + String(c.porque || '');
  let soma = 0;
  for (let i = 0; i < s.length; i++) soma = (soma * 31 + s.charCodeAt(i)) >>> 0;
  return opcoes[soma % opcoes.length];
}

module.exports = {
  NIVEIS, NIVEL_MINIMO_DA_BARRA, TITULOS, chaveDoNivel, normalizarConsciencia, infoDoNivel, mostrarConsciencia, mostrarBarra, tituloDoMomento,
};
