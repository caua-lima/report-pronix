'use strict';

// Histórico de reports gerados e do quanto cada um custou.
// Alimenta a aba "Reports gerados" do dashboard.

const crypto = require('crypto');
const db = require('./db');
const pdfStorage = require('./pdfStorage');
const { custoUSD } = require('./precos');

const CHAVE_DB = 'reports';
const LIMITE = 5000;

/**
 * Registra um report gerado, com o consumo de tokens e o custo em dólares.
 * @param {{id?: string}} params.id — se o chamador já gerou o id (pra salvar o
 *   PDF sob a mesma chave em src/pdfStorage.js), passa aqui; senão gera um novo.
 */
async function registrar({ id, usuarioId, usuarioNome, lead, origem, uso, reportKey, arquivo, qualidade }) {
  const quando = new Date().toISOString();
  const u = uso || {};
  await db.push(
    CHAVE_DB,
    {
      id: id || crypto.randomBytes(5).toString('hex'),
      usuarioId: usuarioId || '',
      usuarioNome: usuarioNome || '',
      lead: lead || '',
      origem: origem || 'extensao', // extensao | manual
      quando,
      dia: emDiaLocal(quando), // dia no fuso do time, para o filtro do dashboard
      // Identifica a geração (idempotência/duplicidade) e o arquivo/modo usados —
      // reportKey e arquivo não guardam a conversa, só metadados.
      reportKey: reportKey || '',
      arquivo: arquivo || '',
      qualidade: qualidade || 'standard',
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

/** Mesmo filtro usado por resumo() e listar() — de/ate em YYYY-MM-DD, sdr é o nome. */
function filtrar(todos, { de, ate, sdr } = {}) {
  return todos.filter((r) => {
    const d = dia(r);
    if (de && d < de) return false;
    if (ate && d > ate) return false;
    if (sdr && (r.usuarioNome || '') !== sdr) return false;
    return true;
  });
}

/**
 * Lista os registros crus (sem agregação) que batem com o filtro — usado pelo
 * download em massa (GET /api/admin/reports/pdf-zip), que precisa do id e do
 * usuarioNome de cada report pra buscar o PDF e organizar por SDR no zip.
 * @param {{de?: string, ate?: string, sdr?: string}} filtro
 */
async function listar({ de, ate, sdr } = {}) {
  const todos = await db.range(CHAVE_DB);
  return filtrar(todos, { de, ate, sdr });
}

/**
 * Resumo para o dashboard, já filtrado.
 * @param {{de?: string, ate?: string, sdr?: string}} filtro datas em YYYY-MM-DD; sdr é o nome.
 */
async function resumo({ de, ate, sdr } = {}) {
  const todos = await db.range(CHAVE_DB);
  const dentro = filtrar(todos, { de, ate, sdr });

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

  // Por dia e por mês, sobre TODO o histórico — a pergunta "quanto gasta por mês"
  // só faz sentido olhando pra tudo, não só pro período filtrado no topo.
  const porDiaGeral = new Map();
  const porMesGeral = new Map();
  todos.forEach((r) => {
    const d = dia(r);
    const m = d.slice(0, 7); // YYYY-MM
    const custo = r.custo || 0;
    const xd = porDiaGeral.get(d) || { dia: d, total: 0, custo: 0 };
    xd.total++;
    xd.custo += custo;
    porDiaGeral.set(d, xd);
    const xm = porMesGeral.get(m) || { mes: m, total: 0, custo: 0 };
    xm.total++;
    xm.custo += custo;
    porMesGeral.set(m, xm);
  });

  const hoje = hojeStr();
  return {
    // Do período filtrado — sempre em ordem cronológica: da primeira pra última.
    total: dentro.length,
    custo: soma(dentro),
    custoMedio: dentro.length ? soma(dentro) / dentro.length : 0,
    tokensEntrada: dentro.reduce((t, r) => t + (r.entrada || 0), 0),
    tokensSaida: dentro.reduce((t, r) => t + (r.saida || 0), 0),
    porUsuario: [...porUsuario.values()].sort((a, b) => b.total - a.total),
    porDia: [...porDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1)),
    ultimos: dentro.slice(-60),
    // Sempre sobre tudo, para o filtro não esconder o retrato geral
    geral: {
      total: todos.length,
      custo: soma(todos),
      hoje: todos.filter((r) => dia(r) === hoje).length,
      custoHoje: soma(todos.filter((r) => dia(r) === hoje)),
      custoMes: soma(todos.filter((r) => dia(r) >= hoje.slice(0, 8) + '01')),
      mediaDiaria: porDiaGeral.size ? soma(todos) / porDiaGeral.size : 0,
      mediaMensal: porMesGeral.size ? soma(todos) / porMesGeral.size : 0,
      porMes: [...porMesGeral.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1)),
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
  const removeu = await db.removerDaLista(CHAVE_DB, (r) => r.id === id);
  if (removeu) await pdfStorage.remover(id).catch(() => {});
  return removeu;
}

/**
 * Acha o report mais recente com a mesma reportKey (idempotência — evita
 * gerar/cobrar de novo a mesma conversa sem intenção explícita).
 * Varredura linear: a base já é limitada a LIMITE registros, não precisa de
 * índice — mesmo padrão simples usado em removerDaLista.
 * @returns {Promise<object|null>}
 */
async function buscarPorChave(reportKey) {
  if (!reportKey) return null;
  const todos = await db.range(CHAVE_DB);
  for (let i = todos.length - 1; i >= 0; i--) {
    if (todos[i].reportKey === reportKey) return todos[i];
  }
  return null;
}

module.exports = { registrar, resumo, listar, remover, buscarPorChave, hojeStr };
