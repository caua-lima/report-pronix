'use strict';

// Armazenamento dos dados (acessos e histórico de reports).
// Na Vercel o disco não persiste, então usamos Redis (Vercel KV / Upstash).
// Sem as variáveis do Redis, cai no arquivo local — é assim que o npm start continua funcionando.

const fs = require('fs');
const path = require('path');

const URL_REDIS = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN_REDIS = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const usandoRedis = Boolean(URL_REDIS && TOKEN_REDIS);

const DATA_DIR = process.env.CR_DATA_DIR || path.join(__dirname, '..', 'data');
const arquivo = (chave) => path.join(DATA_DIR, `${chave}.json`);

// Na Vercel sem KV o disco é só leitura: falha na hora, com o motivo, em vez de
// dar um EROFS sem sentido na primeira vez que alguém criar um acesso.
if (process.env.VERCEL && !usandoRedis) {
  console.error('⚠ Sem KV_REST_API_URL/KV_REST_API_TOKEN: conecte o KV ao projeto na Vercel.');
}

function exigirBanco() {
  if (process.env.VERCEL && !usandoRedis) {
    throw new Error('Banco não configurado: conecte o KV (Upstash) ao projeto na Vercel.');
  }
}

async function redis(comando) {
  const r = await fetch(URL_REDIS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_REDIS}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Banco indisponível (${j.error || r.status}).`);
  return j.result;
}

function lerArquivo(chave, padrao) {
  try {
    return JSON.parse(fs.readFileSync(arquivo(chave), 'utf8'));
  } catch (_) {
    return padrao;
  }
}

function salvarArquivo(chave, valor) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(arquivo(chave), JSON.stringify(valor, null, 2), 'utf8');
}

/** Lê um documento JSON inteiro. */
async function getJson(chave, padrao) {
  exigirBanco();
  if (!usandoRedis) return lerArquivo(chave, padrao);
  const v = await redis(['GET', chave]);
  if (v == null) return padrao;
  try {
    return JSON.parse(v);
  } catch (_) {
    return padrao;
  }
}

/** Grava um documento JSON inteiro. */
async function setJson(chave, valor) {
  exigirBanco();
  if (!usandoRedis) return salvarArquivo(chave, valor);
  await redis(['SET', chave, JSON.stringify(valor)]);
}

/**
 * Acrescenta um item a uma lista e corta no limite.
 * Em lista o append é atômico: dois SDRs gerando report ao mesmo tempo não se atropelam.
 */
async function push(chave, item, limite) {
  exigirBanco();
  if (!usandoRedis) {
    const bruto = lerArquivo(chave, []);
    const lista = Array.isArray(bruto) ? bruto : [];
    lista.push(item);
    salvarArquivo(chave, limite && lista.length > limite ? lista.slice(-limite) : lista);
    return;
  }
  await redis(['RPUSH', chave, JSON.stringify(item)]);
  if (limite) await redis(['LTRIM', chave, -limite, -1]);
}

/** Lê a lista inteira. */
async function range(chave) {
  exigirBanco();
  if (!usandoRedis) {
    const bruto = lerArquivo(chave, []);
    return Array.isArray(bruto) ? bruto : [];
  }
  const v = await redis(['LRANGE', chave, 0, -1]);
  return (v || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Remove da lista o primeiro item que casar com o predicado.
 * No Redis é um LREM do valor exato — uma operação só. Reescrever a lista
 * (apagar e regravar) arriscaria perder o histórico inteiro se falhasse no meio.
 * @returns {Promise<boolean>} true se achou e removeu.
 */
async function removerDaLista(chave, predicado) {
  exigirBanco();
  if (!usandoRedis) {
    const bruto = lerArquivo(chave, []);
    const lista = Array.isArray(bruto) ? bruto : [];
    const restantes = lista.filter((i) => !predicado(i));
    if (restantes.length === lista.length) return false;
    salvarArquivo(chave, restantes);
    return true;
  }
  const brutos = (await redis(['LRANGE', chave, 0, -1])) || [];
  // Guarda a string original: o LREM casa por valor exato, então ela tem que ir intacta.
  const alvo = brutos.find((s) => {
    try {
      return predicado(JSON.parse(s));
    } catch (_) {
      return false;
    }
  });
  if (alvo === undefined) return false;
  return Number(await redis(['LREM', chave, 1, alvo])) > 0;
}

/**
 * Atualiza o primeiro item da lista que casar com o predicado, aplicando
 * `transformar(itemAtual)` → item novo. No Redis usa LSET por índice (troca
 * atômica de uma posição só — diferente de remover, aqui dá pra usar índice
 * porque não precisamos casar pelo valor exato, só achar e substituir).
 * @returns {Promise<boolean>} true se achou e atualizou.
 */
async function atualizarNaLista(chave, predicado, transformar) {
  exigirBanco();
  if (!usandoRedis) {
    const bruto = lerArquivo(chave, []);
    const lista = Array.isArray(bruto) ? bruto : [];
    const i = lista.findIndex(predicado);
    if (i === -1) return false;
    lista[i] = transformar({ ...lista[i] });
    salvarArquivo(chave, lista);
    return true;
  }
  const brutos = (await redis(['LRANGE', chave, 0, -1])) || [];
  let indice = -1;
  let item = null;
  for (let i = 0; i < brutos.length; i++) {
    try {
      const obj = JSON.parse(brutos[i]);
      if (predicado(obj)) {
        indice = i;
        item = obj;
        break;
      }
    } catch (_) {
      /* ignora entrada corrompida */
    }
  }
  if (indice === -1) return false;
  const novo = transformar({ ...item });
  await redis(['LSET', chave, indice, JSON.stringify(novo)]);
  return true;
}

// --- Trava simples de concorrência (evita gerar o mesmo report 2x em paralelo,
// ex.: um retry de rede duplicando a chamada enquanto a primeira ainda roda) ---
const travasLocais = new Map(); // chave -> timestamp de expiração (só o processo local)

/**
 * Tenta travar `chave` por `ttlSeg` segundos. Devolve true se conseguiu
 * (ninguém travou antes, ou a trava anterior já expirou), false se já está
 * travada por outra geração em andamento. No Redis usa SET...NX EX (atômico,
 * vale entre instâncias da Vercel); localmente um Map em memória basta,
 * porque o modo local é sempre um processo só.
 */
async function travar(chave, ttlSeg = 120) {
  if (usandoRedis) {
    const ok = await redis(['SET', `lock:${chave}`, '1', 'NX', 'EX', String(ttlSeg)]);
    return ok === 'OK';
  }
  const agora = Date.now();
  const expiraEm = travasLocais.get(chave);
  if (expiraEm && expiraEm > agora) return false;
  travasLocais.set(chave, agora + ttlSeg * 1000);
  return true;
}

/** Libera a trava antes do TTL — chamar sempre no finally de quem travou. */
async function destravar(chave) {
  if (usandoRedis) {
    await redis(['DEL', `lock:${chave}`]).catch(() => {});
    return;
  }
  travasLocais.delete(chave);
}

// --- Cache com validade ---------------------------------------------------
const cacheLocal = new Map(); // chave -> { valor, expiraEm }

/** Lê um valor do cache (string) ou null se não existe/expirou. Falha do banco = null (é só cache). */
async function cacheGet(chave) {
  try {
    if (usandoRedis) {
      const v = await redis(['GET', `cache:${chave}`]);
      return v == null ? null : String(v);
    }
    const e = cacheLocal.get(chave);
    if (!e) return null;
    if (e.expiraEm <= Date.now()) {
      cacheLocal.delete(chave);
      return null;
    }
    return e.valor;
  } catch (_) {
    return null;
  }
}

/** Grava no cache por `ttlSeg` segundos. Nunca lança: cache que falha não pode derrubar quem chama. */
async function cacheSet(chave, valor, ttlSeg) {
  if (!ttlSeg || ttlSeg <= 0) return;
  try {
    if (usandoRedis) {
      await redis(['SET', `cache:${chave}`, String(valor), 'EX', String(Math.floor(ttlSeg))]);
      return;
    }
    if (cacheLocal.size > 500) cacheLocal.clear(); // teto simples: é só o modo local
    cacheLocal.set(chave, { valor: String(valor), expiraEm: Date.now() + ttlSeg * 1000 });
  } catch (_) {
    /* ignora */
  }
}

module.exports = {
  getJson, setJson, push, range, removerDaLista, atualizarNaLista, travar, destravar, cacheGet, cacheSet, usandoRedis,
};
