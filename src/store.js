'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * Converte um JID/número em um nome de arquivo seguro.
 * "5511999998888@s.whatsapp.net" -> "5511999998888"
 */
function jidToNumero(jid) {
  if (!jid) return 'desconhecido';
  return String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || 'desconhecido';
}

function arquivoDoContato(jid) {
  return path.join(DATA_DIR, `${jidToNumero(jid)}.json`);
}

function garantirDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Carrega o histórico completo (ordem cronológica) de um contato.
 * Retorna [] se ainda não houver arquivo.
 * @returns {Array<{timestamp:string, from:'eu'|'eles', type:'texto'|'audio', content:string}>}
 */
function loadConversation(jid) {
  const arquivo = arquivoDoContato(jid);
  if (!fs.existsSync(arquivo)) return [];
  try {
    const raw = fs.readFileSync(arquivo, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(`Falha ao ler histórico de ${jid}: ${err.message}`);
  }
}

/**
 * Acrescenta uma mensagem ao histórico de um contato.
 * @param {string} jid
 * @param {{timestamp?:string, from:'eu'|'eles', type:'texto'|'audio', content:string}} msg
 */
function appendMessage(jid, msg) {
  garantirDir();
  const historico = loadConversation(jid);
  const registro = {
    timestamp: msg.timestamp || new Date().toISOString(),
    from: msg.from,
    type: msg.type,
    content: msg.content,
  };
  historico.push(registro);
  fs.writeFileSync(arquivoDoContato(jid), JSON.stringify(historico, null, 2), 'utf8');
  return registro;
}

/**
 * Lista os números que já possuem arquivo salvo em data/.
 * @returns {string[]} lista de números (sem sufixo @...)
 */
function listarContatosComHistorico() {
  garantirDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

module.exports = {
  DATA_DIR,
  jidToNumero,
  loadConversation,
  appendMessage,
  listarContatosComHistorico,
};
