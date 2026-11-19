'use strict';

// Os closers do NOSSO time comercial (o CRM tem também os do outro time, que não entram nos handoffs das realizadas
// nem na indicação de closer). Lista do calendário dos closers, conferida com os usuários do RD pelo Cauã em 19/11/2026.
//
// `nome` é o nome oficial (igual ao usuário no RD) e é o que as telas mostram. `outros` são as outras grafias que o RD
// usa para a MESMA pessoa (há usuários duplicados no RD, ex.: "Pedro Pasin" e "Pedro Henrique Pasin"): o card de
// qualquer uma delas conta para o nome oficial, sem linha repetida em "Meus closers".
// Cada nome (oficial ou não) também é reconhecido pelo começo: o CRM pode trazer o nome completo
// ("Paulo Henrique Pagoti de Oliveira").

const TIME = [
  { nome: 'Amarildo Queiroz' },
  { nome: 'André Granato Oliveira' },
  { nome: 'Daniel Camargo de Andrade' },
  { nome: 'Gabrielle Machado', outros: ['Gabrielle Vitória Machado', 'Gabrielle Machado Silveira'] },
  { nome: 'Giovane Ribeiro', outros: ['Giovane Ribeiro Romano'] },
  { nome: 'Jenniffer', outros: ['Jenniffer Lauany Barros'] },
  { nome: 'Paulo Henrique Pagoti' },
  { nome: 'Pedro Henrique Melo Palermo' },
  { nome: 'Pedro Henrique Pasin', outros: ['Pedro Pasin'] },
  { nome: 'Raphael Cassiano Ribeiro' },
  { nome: 'Rôselaynne Lima Costa Cabral' },
  { nome: 'Victoria Pinheiro de Carvalho' },
  { nome: 'Washington Gomes da Silva' },
  { nome: 'Zayra Beatriz da Silva Lima', outros: ['Zayra'] },
];

const CLOSERS_DO_TIME = TIME.map((c) => c.nome);

const palavras = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
const juntar = (s) => palavras(s).join(' ');

// Para cada closer: as chaves de começo de nome (3 primeiras palavras) e os nomes exatos (oficial + outras grafias).
const INDICE = TIME.map((c) => {
  const todos = [c.nome].concat(c.outros || []);
  return { nome: c.nome, chaves: todos.map((n) => palavras(n).slice(0, 3)), exatos: new Set(todos.map(juntar)) };
});

/** O closer do time a que este nome do CRM pertence (o nome oficial), ou '' se não é do time. */
function closerDoTime(nome) {
  const p = palavras(nome);
  if (!p.length) return '';
  const inteiro = p.join(' ');
  // nome exato (inclusive grafia de uma palavra só, como "Zayra", que só vale quando está na lista)
  const exato = INDICE.find((c) => c.exatos.has(inteiro));
  if (exato) return exato.nome;
  if (p.length < 2) return '';
  const porComeco = INDICE.find((c) => c.chaves.some((k) => {
    const n = Math.min(k.length, p.length);
    return n >= 2 && k.slice(0, n).every((w, i) => p[i] === w);
  }));
  return porComeco ? porComeco.nome : '';
}

/** O nome (do CRM) é de um closer do nosso time? */
const ehDoTime = (nome) => Boolean(closerDoTime(nome));

/**
 * O nome que as telas mostram: a grafia oficial quando o nome do CRM é uma das outras grafias conhecidas do mesmo
 * closer (ex.: "Pedro Pasin" → "Pedro Henrique Pasin"); senão, o próprio nome, sem mexer.
 */
function nomeOficial(nome) {
  const inteiro = juntar(nome);
  const c = inteiro && INDICE.find((x) => x.exatos.has(inteiro));
  return c ? c.nome : String(nome || '').trim();
}

module.exports = { CLOSERS_DO_TIME, TIME, ehDoTime, closerDoTime, nomeOficial };
