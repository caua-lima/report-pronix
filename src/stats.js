'use strict';

// Histórico de reports gerados e do quanto cada um custou.
// Alimenta a aba "Reports gerados" do dashboard.

const crypto = require('crypto');
const db = require('./db');
const { custoUSD } = require('./precos');

const CHAVE_DB = 'reports';
const LIMITE = 5000;

/** Registra um report gerado, com o consumo de tokens e o custo em dólares. */
async function registrar({ usuarioId, usuarioNome, lead, origem, uso }) {
  const quando = new Date().toISOString();
  const u = uso || {};
  await db.push(
    CHAVE_DB,
    {
      id: crypto.randomBytes(5).toString('hex'),
      usuarioId: usuarioId || '',
      usuarioNome: usuarioNome || '',
      lead: lead || '',
      origem: origem || 'extensao', // extensao | manual
      quando,
      dia: emDiaLocal(quando), // dia no fuso do time, para o filtro do dashboard
      modelo: u.modelo || '',
      entrada: u.entrada || 0,
      saida: u.saida || 0,
      cacheLeitura: u.cacheLeitura || 0,
      cacheEscrita: u.cacheEscrita || 0,
      // Guardado junto porque o preço do modelo muda com o tempo (promoção, troca de
      // modelo): recalcular depois daria um número diferente do que foi cobrado.
      custo: custoUSD({
        modelo: u.modelo,
        entrada: u.entrada,
        saida: u.saida,
        cacheLeitura: u.cacheLeitura,
        cacheEscrita: u.cacheEscrita,
        quando,
      }),
    },
    LIMITE
  );
}

// O carimbo é gravado em UTC, mas o dashboard filtra por dia do Brasil. Sem converter,
// tudo que sai depois das 21h cairia no dia seguinte e sumiria do "Hoje".
const TZ = process.env.TZ_RELATORIO || 'America/Sao_Paulo';
const emDiaLocal = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // en-CA já sai como YYYY-MM-DD
};

const dia = (r) => r.dia || emDiaLocal(r.quando); // dia: gravado a partir de agora; quando: histórico
const hojeStr = () => emDiaLocal(new Date());

/**
 * Resumo para o dashboard, já filtrado.
 * @param {{de?: string, ate?: string, sdr?: string}} filtro datas em YYYY-MM-DD; sdr é o nome.
 */
async function resumo({ de, ate, sdr } = {}) {
  const todos = await db.range(CHAVE_DB);

  const dentro = todos.filter((r) => {
    const d = dia(r);
    if (de && d < de) return false;
    if (ate && d > ate) return false;
    if (sdr && (r.usuarioNome || '') !== sdr) return false;
    return true;
  });

  const soma = (lista) => lista.reduce((t, r) => t + (r.custo || 0), 0);

  // Por SDR
  const porUsuario = new Map();
  dentro.forEach((r) => {
    const nome = r.usuarioNome || '—';
    const u = porUsuario.get(nome) || { nome, total: 0, custo: 0, entrada: 0, saida: 0 };
    u.total++;
    u.custo += r.custo || 0;
    u.entrada += r.entrada || 0;
    u.saida += r.saida || 0;
    porUsuario.set(nome, u);
  });

  // Por dia (para ver o gasto diário)
  const porDia = new Map();
  dentro.forEach((r) => {
    const d = dia(r);
    const x = porDia.get(d) || { dia: d, total: 0, custo: 0 };
    x.total++;
    x.custo += r.custo || 0;
    porDia.set(d, x);
  });

  const hoje = hojeStr();
  return {
    // Do período filtrado
    total: dentro.length,
    custo: soma(dentro),
    custoMedio: dentro.length ? soma(dentro) / dentro.length : 0,
    tokensEntrada: dentro.reduce((t, r) => t + (r.entrada || 0), 0),
    tokensSaida: dentro.reduce((t, r) => t + (r.saida || 0), 0),
    porUsuario: [...porUsuario.values()].sort((a, b) => b.total - a.total),
    porDia: [...porDia.values()].sort((a, b) => (a.dia < b.dia ? 1 : -1)),
    ultimos: dentro.slice(-60).reverse(),
    // Sempre sobre tudo, para o filtro não esconder o retrato geral
    geral: {
      total: todos.length,
      custo: soma(todos),
      hoje: todos.filter((r) => dia(r) === hoje).length,
      custoHoje: soma(todos.filter((r) => dia(r) === hoje)),
      custoMes: soma(todos.filter((r) => dia(r) >= hoje.slice(0, 8) + '01')),
      sdrs: [...new Set(todos.map((r) => r.usuarioNome).filter(Boolean))].sort(),
    },
  };
}

/**
 * Remove um report do histórico (para tirar testes que sujam os números).
 * @returns {Promise<boolean>} true se achou e removeu.
 */
async function remover(id) {
  if (!id) return false;
  return db.removerDaLista(CHAVE_DB, (r) => r.id === id);
}

module.exports = { registrar, resumo, remover, hojeStr };
