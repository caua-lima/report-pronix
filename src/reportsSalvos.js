'use strict';

// O report em JSON, guardado 60 dias (o mesmo prazo do texto do handoff): reabrir, revisar e regerar o PDF não chamam
// a IA. Guarda só o que a tela e o PDF usam — sem consumo, sem análise interna da prospecção.

const db = require('./db');
const handoff = require('./handoff');

const TTL = 60 * 24 * 3600;
const chave = (id) => `reportdados:${String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 40)}`;

async function salvar(id, dados) {
  if (!id || !dados) return false;
  const copia = JSON.parse(JSON.stringify(dados));
  delete copia.uso;
  delete copia.analise;
  delete copia._meta;
  await db.cacheSet(chave(id), JSON.stringify(copia), TTL);
  return true;
}

async function ler(id) {
  const bruto = await db.cacheGet(chave(id)).catch(() => null);
  if (!bruto) return null;
  try {
    return JSON.parse(bruto);
  } catch (_) {
    return null;
  }
}

/**
 * Junta a revisão do painel ao guardado: o conteúdo editável vem da revisão; o ORIGINAL da leitura do SDR e o
 * autor vêm sempre do guardado (o cliente não reescreve o que o SDR escreveu). Sobe o número da revisão.
 */
function aplicarRevisao(guardado, revisado, editor) {
  const novo = { ...guardado, ...revisado };
  if (guardado.visaoSdr && guardado.visaoSdr.original) {
    const v = revisado.visaoSdr || guardado.visaoSdr;
    novo.visaoSdr = { ...v, original: guardado.visaoSdr.original, autor: guardado.visaoSdr.autor };
  } else delete novo.visaoSdr;
  // Campos internos que a revisão não traz continuam os guardados.
  ['consciencia', 'perfil', 'dores', 'sinais_compra', 'promptVersao', 'reportId', 'sdr'].forEach((k) => {
    if (guardado[k] !== undefined && (revisado[k] === undefined || revisado[k] === null)) novo[k] = guardado[k];
  });
  novo.revisao = (guardado.revisao || 1) + 1;
  novo.revisadoEm = new Date().toISOString();
  if (editor) novo.revisadoPor = String(editor).slice(0, 80);
  novo.edicaoHumana = true;
  handoff.sincronizarLegado(novo);
  return novo;
}

module.exports = { salvar, ler, aplicarRevisao, TTL };
