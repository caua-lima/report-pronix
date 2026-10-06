'use strict';

// Closer do handoff preenchido sozinho. O pré-vendedor já diz quem é o closer em dois lugares, e
// não precisa dizer de novo no report:
//  - no RD: quando a reunião acontece, o card vai para "Reunião Realizada" / funil dos closers e o
//    responsável passa a ser o closer;
//  - no Google Agenda: a reunião do lead está na agenda do closer.
// Ao abrir a conversa do lead, se um desses lugares aponta um closer CADASTRADO, os reports desse
// lead que ainda estão sem closer são preenchidos. Nunca troca um closer já marcado.

const db = require('./db');
const stats = require('./stats');
const closers = require('./closers');

const DIAS = 30; // reports do lead olhados para trás

const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const digitos = (s) => String(s || '').replace(/\D/g, '');

/**
 * Closer cadastrado que corresponde a um nome vindo do RD ou da agenda. "Vitor Augusto" (cadastro)
 * casa com "Vitor Augusto Manoel dos Santos": todas as palavras do cadastro estão no nome. Dois
 * cadastros casando = ambíguo, não escolhe.
 */
function acharCloser(lista, nome) {
  const palavras = new Set(normalizar(nome).split(' ').filter(Boolean));
  if (!palavras.size) return null;
  const casam = (lista || []).filter((c) => {
    const doCadastro = normalizar(c.nome).split(' ').filter(Boolean);
    return doCadastro.length > 0 && doCadastro.every((p) => palavras.has(p));
  });
  return casam.length === 1 ? casam[0] : null;
}

/** No RD, o responsável do card só é o closer depois que a reunião aconteceu (ou no funil dos closers). */
function closerDoRd(ficha) {
  const n = ficha && ficha.negociacao;
  if (!n || !n.responsavel) return '';
  const etapa = normalizar(n.etapa);
  const funil = normalizar(n.funil);
  return /reuniao realizada/.test(etapa) || /closer/.test(funil) ? n.responsavel : '';
}

/** O report é desta conversa? Pelo telefone (8 últimos dígitos) ou pelo nome do contato. */
function ehDaConversa(report, conversa, ficha) {
  const contato = String(report.contato || '');
  const tel = digitos(conversa.telefone);
  if (tel.length >= 8 && digitos(contato).length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(contato)) return digitos(contato).slice(-8) === tel.slice(-8);
  const c = normalizar(contato);
  if (!c) return false;
  return [conversa.nome, ficha && ficha.nome].map(normalizar).filter(Boolean).includes(c);
}

/**
 * @param {{usuario: object, conversa: {telefone: string, nome: string}, ficha?: object, reuniao?: {closer: string}|null}} o
 * @returns {Promise<{closerNome: string, origem: 'rd'|'agenda', preenchidos: number} | null>}
 */
async function preencher({ usuario, conversa, ficha, reuniao }) {
  const doRd = closerDoRd(ficha);
  const nome = doRd || (reuniao && reuniao.closer) || '';
  if (!nome || !usuario || !conversa) return null;
  const closer = acharCloser(await closers.listar(), nome);
  // O responsável pode ser o próprio pré-vendedor (card ainda com ele): aí não é closer.
  if (!closer || normalizar(closer.nome) === normalizar(usuario.nome)) return null;

  // Uma tentativa por lead e closer a cada 10 min: abrir a mesma conversa várias vezes não relê o histórico.
  const chave = `closerauto:${usuario.id}:${digitos(conversa.telefone).slice(-8) || normalizar(conversa.nome)}:${closer.id}`;
  if (await db.cacheGet(chave)) return null;
  await db.cacheSet(chave, '1', 600);

  const de = stats.emDiaLocal(new Date(Date.now() - DIAS * 86400000).toISOString());
  const doLead = (await stats.listar({ de }))
    .filter((r) => r.usuarioId === usuario.id && !r.closerId && r.resultado !== 'no_show' && ehDaConversa(r, conversa, ficha));
  for (const r of doLead) {
    await stats.atualizarResultado(r.id, { closerId: closer.id, closerNome: closer.nome });
  }
  return doLead.length ? { closerNome: closer.nome, origem: doRd ? 'rd' : 'agenda', preenchidos: doLead.length } : null;
}

module.exports = { preencher, acharCloser, closerDoRd, ehDaConversa };
