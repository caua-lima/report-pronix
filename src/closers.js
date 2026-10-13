'use strict';

// Cadastro dos closers (quem conduz a call) — não tem chave/login, é só um
// roster pra marcar quem fez cada reunião e puxar o e-mail depois se precisar.
// Guardado via src/db (Redis na Vercel, arquivo local no npm start).

const crypto = require('crypto');
const db = require('./db');

const CHAVE_DB = 'closers';

async function ler() {
  const j = await db.getJson(CHAVE_DB, { closers: [] });
  const lista = Array.isArray(j && j.closers) ? j.closers : [];
  return { closers: lista };
}

async function listar() {
  return (await ler()).closers;
}

async function criar(nome, email) {
  const limpo = String(nome || '').trim();
  if (!limpo) throw new Error('Informe o nome do closer.');
  const emailLimpo = String(email || '').trim().toLowerCase();
  const dados = await ler();
  if (dados.closers.some((c) => c.nome.toLowerCase() === limpo.toLowerCase())) {
    throw new Error('Já existe um closer com esse nome.');
  }
  const closer = {
    id: crypto.randomBytes(6).toString('hex'),
    nome: limpo,
    email: emailLimpo,
    criadoEm: new Date().toISOString(),
  };
  dados.closers.push(closer);
  await db.setJson(CHAVE_DB, dados);
  return closer;
}

async function remover(id) {
  const dados = await ler();
  const antes = dados.closers.length;
  dados.closers = dados.closers.filter((c) => c.id !== id);
  await db.setJson(CHAVE_DB, dados);
  return dados.closers.length < antes;
}

async function porId(id) {
  if (!id) return null;
  return (await ler()).closers.find((c) => c.id === id) || null;
}

const MAX_INTELIGENCIA = 8000;
const MAX_APELIDO = 20;

/** Como o botão chama o closer ("Analisar Match com PH"): o apelido ou o primeiro nome. */
const apelidoDe = (c) => (c && (c.apelido || String(c.nome || '').trim().split(/\s+/)[0])) || '';

/**
 * Inteligência do closer: o que as calls dele ensinaram (com que tipo de lead fecha, como conduz,
 * onde trava). É texto destilado, sem nome nem dado de lead — é o que alimenta a análise de
 * afinidade (src/afinidade.js). Texto vazio desliga a análise para este closer.
 * `analiseAtiva` liga e desliga a análise sem apagar o texto: desligada, o botão some da extensão
 * e a rota recusa o pedido.
 */
async function definirInteligencia(id, { apelido, inteligencia, analiseAtiva } = {}) {
  const dados = await ler();
  const c = dados.closers.find((x) => x.id === id);
  if (!c) return null;
  if (apelido !== undefined) c.apelido = String(apelido || '').replace(/\s+/g, ' ').trim().slice(0, MAX_APELIDO);
  if (inteligencia !== undefined) {
    c.inteligencia = String(inteligencia || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_INTELIGENCIA);
    c.inteligenciaEm = c.inteligencia ? new Date().toISOString() : '';
  }
  if (analiseAtiva !== undefined) {
    if (analiseAtiva) delete c.analiseDesligada;
    else c.analiseDesligada = true;
  }
  await db.setJson(CHAVE_DB, dados);
  return c;
}

/**
 * Pasta do Google Drive com as transcrições das calls do closer, e a partir de que dia ler (AAAA-MM-DD).
 * Pasta vazia desliga a leitura. O que já foi lido continua guardado.
 */
async function definirDrive(id, { pasta, desde } = {}) {
  const dados = await ler();
  const c = dados.closers.find((x) => x.id === id);
  if (!c) return null;
  const antes = [c.drivePasta || '', c.driveDesde || ''].join('|');
  if (pasta !== undefined) c.drivePasta = /^[A-Za-z0-9_-]{10,80}$/.test(String(pasta || '')) ? String(pasta) : '';
  if (desde !== undefined) c.driveDesde = /^\d{4}-\d{2}-\d{2}$/.test(String(desde || '')) ? String(desde) : '';
  // Pasta ou data nova: a leitura recomeça da data escolhida, e não de onde a anterior parou.
  if ([c.drivePasta || '', c.driveDesde || ''].join('|') !== antes) delete c.driveUltima;
  await db.setJson(CHAVE_DB, dados);
  return c;
}

/** Como foi a última leitura do Drive deste closer (quando, quantos documentos, o erro, se houve). */
async function anotarLeituraDoDrive(id, info) {
  const dados = await ler();
  const c = dados.closers.find((x) => x.id === id);
  if (!c) return null;
  const n = (v) => Math.max(0, Math.round(Number(v)) || 0);
  // `ate`: até que dia a pasta já foi lida (a próxima leitura começa daí). Leitura que falhou não muda isso.
  const dia = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const ate = dia(info && info.ate) || dia(c.driveUltima && c.driveUltima.ate);
  c.driveUltima = { em: String((info && info.em) || new Date().toISOString()).slice(0, 30), lidos: n(info && info.lidos), casos: n(info && info.casos), semConversa: n(info && info.semConversa), restantes: n(info && info.restantes), erro: String((info && info.erro) || '').slice(0, 300), ...(ate ? { ate } : {}) };
  await db.setJson(CHAVE_DB, dados);
  return c;
}

/** Closers com análise de afinidade ligada (só id, nome e apelido — a inteligência não sai daqui). */
async function comAnalise() {
  return (await listar())
    .filter((c) => c.inteligencia && !c.analiseDesligada)
    .map((c) => ({ id: c.id, nome: c.nome, apelido: apelidoDe(c) }));
}

/** Algum closer tem a inteligência cadastrada e a análise desligada pelo master? */
async function temDesligada() {
  return (await listar()).some((c) => c.inteligencia && c.analiseDesligada);
}

/** Como o botão chamaria os closers que ainda NÃO têm inteligência (para o popup dizer o que falta). */
async function semAnalise() {
  return (await listar()).filter((c) => !c.inteligencia).map(apelidoDe).filter(Boolean).slice(0, 5);
}

module.exports = { listar, criar, remover, porId, definirInteligencia, definirDrive, anotarLeituraDoDrive, comAnalise, semAnalise, temDesligada, apelidoDe, MAX_INTELIGENCIA };
