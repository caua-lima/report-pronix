'use strict';

// Marcas do lead que a extensão mostra no cartão do WhatsApp: a etiqueta "Qualificado" e o dia e
// horário da reunião agendada. Ficam guardadas por lead para aparecerem de novo quando a conversa for
// reaberta — mesmo que a mensagem do agendamento já tenha saído da tela ou que o card tenha mudado
// de etapa no RD. Não guarda nenhum texto de conversa: só a etiqueta e a data.
//
// "Qualificado" só entra por um destes caminhos: o card está na etapa Qualificado do RD ('rd'), um
// report foi gerado para o lead ('report') ou o usuário marcou à mão ('manual'). Ter agendamento lido
// na conversa NÃO marca como qualificado.

const db = require('./db');

const CHAVE_DB = 'lead_marcas';
const LIMITE = 4000; // marcas lembradas; passando disso saem as mexidas há mais tempo
const QUANDO_OK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
// Versão da leitura de agendamento (a mesma de extension/agenda.js). Agendamento anotado por uma regra
// antiga deixa de valer, e extensão antiga não consegue anotar com a regra nova.
const REGRA_AGENDA = 2;
const ORIGENS_AUTOMATICAS = ['rd', 'report'];

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * { telefone, nome } da conversa -> as chaves do lead. O telefone identifica o lead para todos; o nome
 * salvo é da agenda de quem está usando, então a chave por nome é de cada usuário.
 * (nomeAntigo: como a chave por nome era gravada antes de ser por usuário — só para leitura.)
 */
function chaves(conversa, usuarioId) {
  const c = conversa && typeof conversa === 'object' ? conversa : {};
  const tel = soDigitos(c.telefone);
  const nome = normalizar(c.nome).slice(0, 60);
  const temNome = Boolean(nome) && !/^[\d ]+$/.test(nome);
  return {
    tel: tel.length >= 8 ? 'tel:' + tel.slice(-8) : '',
    nome: temNome ? `nome:${String(usuarioId || '').replace(/[^A-Za-z0-9_-]/g, '')}:${nome}` : '',
    nomeAntigo: temNome ? 'nome:' + nome : '',
  };
}

const todas = async () => {
  const j = await db.getJson(CHAVE_DB, {});
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
};

/**
 * A mesma conversa pode chegar só com o nome (aberta pela lista do WhatsApp) ou com nome e telefone
 * (aberta pelo link do RD): vale a marca mexida por último entre as chaves que ela tem.
 */
function daConversa(mapa, k) {
  const achadas = [k.tel, k.nome, k.nomeAntigo].filter(Boolean).map((x) => mapa[x]).filter(Boolean);
  if (!achadas.length) return null;
  return achadas.reduce((a, b) => (String(b.atualizadoEm || '') > String(a.atualizadoEm || '') ? b : a));
}

/** Está qualificado de fato? (marca deixada pela regra antiga, que qualificava por agendamento, não conta) */
const qualificado = (m) => Boolean(m && m.qualificado && m.origem !== 'agenda');
const agendaVale = (m) => Boolean(m && m.agendaRegra === REGRA_AGENDA);

/** O que vai para a extensão (nada de quem marcou nem quando). */
function publica(m) {
  const q = qualificado(m);
  return {
    qualificado: q,
    origem: q ? m.origem || '' : '', // 'rd' | 'report' | 'manual': o cartão diz de onde veio a etiqueta
    agendadoPara: (agendaVale(m) && QUANDO_OK.test(m.agendadoPara || '') && m.agendadoPara) || '',
    // Horário da mensagem de onde o agendamento saiu: a extensão não reenvia o que já foi anotado (ou apagado).
    agendaFonteTs: agendaVale(m) && Number.isFinite(m.agendaFonteTs) ? m.agendaFonteTs : -1,
  };
}

/** Marca guardada do lead desta conversa, ou null. */
async function ler(conversa, usuarioId) {
  const k = chaves(conversa, usuarioId);
  if (!k.tel && !k.nome) return null;
  return daConversa(await todas(), k);
}

/**
 * Atualiza a marca do lead.
 *  - qualificado + manual: a escolha do usuário no cartão; vale sobre qualquer leitura automática.
 *  - qualificado: true + origem 'rd' ou 'report': leitura automática — nunca desfaz o que o usuário
 *    marcou à mão. Outra origem é ignorada.
 *  - agendadoPara + fonteTs + regra: só entra se a leitura veio da regra atual e de uma mensagem mais
 *    nova que a do agendamento guardado.
 *  - limparAgenda: apaga o agendamento (a mensagem de onde ele saiu não o traz de volta).
 * @returns {Promise<object|null>} a marca gravada (ou a que já existia, se nada mudou); null sem chave do lead
 */
async function marcar(conversa, campos = {}) {
  const k = chaves(conversa, campos.usuarioId);
  if (!k.tel && !k.nome) return null;
  const mapa = await todas();
  const atual = daConversa(mapa, k) || {};
  const novo = { ...atual };
  let mudou = false;

  if (typeof campos.qualificado === 'boolean') {
    if (campos.manual === true) {
      novo.qualificado = campos.qualificado;
      novo.manual = true;
      novo.origem = 'manual';
      mudou = true;
    } else if (campos.qualificado && ORIGENS_AUTOMATICAS.includes(campos.origem) && !atual.manual && !qualificado(atual)) {
      novo.qualificado = true;
      novo.origem = campos.origem;
      mudou = true;
    }
  }
  if (campos.limparAgenda === true) {
    if (novo.agendadoPara) mudou = true;
    novo.agendadoPara = '';
  } else if (QUANDO_OK.test(String(campos.agendadoPara || '')) && Number(campos.regra) === REGRA_AGENDA) {
    const fonte = Number.isFinite(Number(campos.fonteTs)) ? Number(campos.fonteTs) : 0;
    const guardada = agendaVale(atual) && Number.isFinite(atual.agendaFonteTs) ? atual.agendaFonteTs : -1;
    if (fonte > guardada) {
      novo.agendadoPara = campos.agendadoPara;
      novo.agendaFonteTs = fonte;
      novo.agendaRegra = REGRA_AGENDA;
      mudou = true;
    }
  }
  if (!mudou) return atual;

  novo.atualizadoEm = new Date().toISOString();
  if (campos.por) novo.por = String(campos.por).slice(0, 80);
  // Grava em todas as chaves que a conversa tem: a próxima abertura (só com nome, ou com telefone) acha.
  if (k.tel) mapa[k.tel] = novo;
  if (k.nome) mapa[k.nome] = novo;
  const ks = Object.keys(mapa);
  if (ks.length > LIMITE) {
    ks.sort((a, b) => String(mapa[a].atualizadoEm || '').localeCompare(String(mapa[b].atualizadoEm || '')))
      .slice(0, ks.length - LIMITE)
      .forEach((x) => delete mapa[x]);
  }
  await db.setJson(CHAVE_DB, mapa);
  return novo;
}

module.exports = { ler, marcar, publica, qualificado, chaves, QUANDO_OK, REGRA_AGENDA };
