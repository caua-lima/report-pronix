'use strict';

// Marcas do lead que a extensão mostra no cartão do WhatsApp: a etiqueta "Qualificado" e o dia e
// horário da reunião agendada. Ficam guardadas por lead (8 últimos dígitos do telefone; sem telefone,
// o nome salvo) para aparecerem de novo quando a conversa for reaberta — mesmo que a mensagem do
// agendamento já tenha saído da tela ou que o card tenha mudado de etapa no RD.
// Não guarda nenhum texto de conversa: só a etiqueta e a data.

const db = require('./db');

const CHAVE_DB = 'lead_marcas';
const LIMITE = 4000; // leads lembrados; passando disso saem os mexidos há mais tempo
const QUANDO_OK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** { telefone, nome } da conversa -> as chaves do lead (telefone vale mais; o nome é o reserva). */
function chaves(conversa) {
  const c = conversa && typeof conversa === 'object' ? conversa : {};
  const tel = soDigitos(c.telefone);
  const nome = normalizar(c.nome).slice(0, 60);
  return {
    tel: tel.length >= 8 ? 'tel:' + tel.slice(-8) : '',
    nome: nome && !/^[\d ]+$/.test(nome) ? 'nome:' + nome : '',
  };
}

const todas = async () => {
  const j = await db.getJson(CHAVE_DB, {});
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
};

/** O que vai para a extensão (nada de quem marcou nem quando). */
function publica(m) {
  return {
    qualificado: Boolean(m && m.qualificado),
    agendadoPara: (m && QUANDO_OK.test(m.agendadoPara || '') && m.agendadoPara) || '',
    // Horário da mensagem de onde o agendamento saiu: a extensão não reenvia o que já foi anotado (ou apagado).
    agendaFonteTs: m && Number.isFinite(m.agendaFonteTs) ? m.agendaFonteTs : -1,
  };
}

/** Marca guardada do lead, ou null. Contato salvo só com nome que depois ganhou telefone continua achando a marca. */
async function ler(conversa) {
  const k = chaves(conversa);
  if (!k.tel && !k.nome) return null;
  const mapa = await todas();
  return (k.tel && mapa[k.tel]) || (k.nome && mapa[k.nome]) || null;
}

/**
 * Atualiza a marca do lead.
 *  - qualificado + manual: a escolha do usuário no cartão; vale sobre qualquer leitura automática.
 *  - qualificado: true (sem manual): leitura automática (etapa do RD, report gerado, agendamento) — nunca
 *    desfaz o que o usuário marcou à mão.
 *  - agendadoPara + fonteTs: só entra se vier de uma mensagem mais nova que a do agendamento guardado.
 *  - limparAgenda: apaga o agendamento (a mensagem de onde ele saiu não o traz de volta).
 * @returns {Promise<object|null>} a marca gravada (ou a que já existia, se nada mudou); null sem chave do lead
 */
async function marcar(conversa, campos = {}) {
  const k = chaves(conversa);
  const chave = k.tel || k.nome;
  if (!chave) return null;
  const mapa = await todas();
  const atual = mapa[k.tel] || mapa[k.nome] || {};
  const novo = { ...atual };
  let mudou = false;

  if (typeof campos.qualificado === 'boolean') {
    if (campos.manual === true) {
      novo.qualificado = campos.qualificado;
      novo.manual = true;
      novo.origem = 'manual';
      mudou = true;
    } else if (campos.qualificado && !atual.manual && !atual.qualificado) {
      novo.qualificado = true;
      novo.origem = ['rd', 'report', 'agenda'].includes(campos.origem) ? campos.origem : 'auto';
      mudou = true;
    }
  }
  if (campos.limparAgenda === true) {
    if (novo.agendadoPara) mudou = true;
    novo.agendadoPara = '';
  } else if (QUANDO_OK.test(String(campos.agendadoPara || ''))) {
    const fonte = Number.isFinite(Number(campos.fonteTs)) ? Number(campos.fonteTs) : 0;
    const guardada = Number.isFinite(atual.agendaFonteTs) ? atual.agendaFonteTs : -1;
    if (fonte > guardada) {
      novo.agendadoPara = campos.agendadoPara;
      novo.agendaFonteTs = fonte;
      mudou = true;
    }
  }
  if (!mudou) return atual;

  novo.atualizadoEm = new Date().toISOString();
  if (campos.por) novo.por = String(campos.por).slice(0, 80);
  mapa[chave] = novo;
  const ks = Object.keys(mapa);
  if (ks.length > LIMITE) {
    ks.sort((a, b) => String(mapa[a].atualizadoEm || '').localeCompare(String(mapa[b].atualizadoEm || '')))
      .slice(0, ks.length - LIMITE)
      .forEach((x) => delete mapa[x]);
  }
  await db.setJson(CHAVE_DB, mapa);
  return novo;
}

module.exports = { ler, marcar, publica, chaves, QUANDO_OK };
