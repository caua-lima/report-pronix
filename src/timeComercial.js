'use strict';

// Os closers do NOSSO time comercial (o CRM tem também os do outro time, que não entram nos handoffs das realizadas
// nem na indicação de closer). Lista passada pelo Cauã em 12/11/2026. Cada um é reconhecido pelo começo do nome
// no CRM (o CRM pode trazer o nome completo: "Paulo Henrique Pagoti de Oliveira").

const CLOSERS_DO_TIME = [
  'Amarildo Queiroz',
  'Giovane Ribeiro Romano',
  'Raphael Cassiano Ribeiro',
  'Daniel Camargo de Andrade',
  'Gabrielle Vitória Machado',
  'Jenniffer Lauany Barros',
  'Paulo Henrique Pagoti',
  'Pedro Henrique Melo Palermo',
  'Pedro Pasin',
  'Rôselaynne Lima Costa Cabral',
  'Zayra Beatriz da Silva Lima',
];

const palavras = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
const CHAVES = CLOSERS_DO_TIME.map((n) => palavras(n).slice(0, 3));

/** O nome (do CRM) é de um closer do nosso time? Bate pelo começo: as primeiras palavras da lista, na ordem. */
function ehDoTime(nome) {
  const p = palavras(nome);
  if (p.length < 2) return false;
  return CHAVES.some((k) => {
    const n = Math.min(k.length, p.length);
    return n >= 2 && k.slice(0, n).every((w, i) => p[i] === w);
  });
}

module.exports = { CLOSERS_DO_TIME, ehDoTime };
