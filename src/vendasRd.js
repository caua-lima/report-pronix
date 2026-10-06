'use strict';

// Venda marcada no RD: quando o closer fecha, ele marca o card como vendido no RD Station. Aqui o
// sistema só LÊ isso e anota no report ("vendido no RD"), para o master não precisar descobrir quem
// fechou — ele só escolhe se foi em call, em follow-up ou pix de compromisso.
// Nunca escolhe o tipo de venda sozinho e nunca mexe em report que já tem resultado de venda.

const stats = require('./stats');
const crm = require('./crm');
const closerAuto = require('./closerAuto');

const DIAS = 60; // reports conferidos para trás
const POR_VEZ = 12; // leads consultados no RD por clique (cada um custa algumas chamadas)

const pendente = (r) => !r.vendidoNoRd && !stats.ehVenda(r.resultado) && r.resultado !== 'no_show';
const temVenda = (ficha) => Boolean(ficha && (ficha.negociacoes || []).some((c) => c.ganha));

/** Como achar no RD o lead de um report: pelo telefone se o contato for um número, senão pelo nome. */
function buscaDoReport(r) {
  const contato = String(r.contato || '').trim();
  const digitos = contato.replace(/\D/g, '');
  if (digitos.length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(contato)) return { telefone: digitos };
  const nome = contato || String(r.lead || '').trim();
  return nome ? { nome } : null;
}

const anotar = (id) => stats.atualizarResultado(id, { vendidoNoRd: new Date().toISOString() });

/**
 * Botão "Puxar vendas do RD": confere no RD os leads dos reports ainda sem venda marcada.
 * @param {object[]} reports os do período e do escopo que a tela está mostrando
 * @returns {Promise<{conferidos: number, vendidos: number, restantes: number}>}
 */
async function sincronizar(reports) {
  if (!crm.configurado()) throw new Error('O RD Station não está configurado no servidor.');
  const limite = stats.emDiaLocal(new Date(Date.now() - DIAS * 86400000).toISOString());
  const fila = (reports || []).filter((r) => pendente(r) && String(r.dia || '') >= limite && buscaDoReport(r)).reverse();
  let vendidos = 0;
  const agora = fila.slice(0, POR_VEZ);
  for (const r of agora) {
    const lead = await crm.consultarLead(buscaDoReport(r)).catch(() => null); // um lead que falhou não para os outros
    if (lead && temVenda(lead.ficha)) {
      await anotar(r.id);
      vendidos++;
    }
  }
  return { conferidos: agora.length, vendidos, restantes: fila.length - agora.length };
}

/** Ao abrir a conversa: a ficha mostra um card vendido? Anota nos reports deste lead (do próprio usuário). */
async function anotarPelaFicha({ usuario, conversa, ficha }) {
  if (!usuario || !conversa || !temVenda(ficha)) return 0;
  const de = stats.emDiaLocal(new Date(Date.now() - DIAS * 86400000).toISOString());
  const doLead = (await stats.listar({ de })).filter((r) => r.usuarioId === usuario.id && pendente(r) && closerAuto.ehDaConversa(r, conversa, ficha));
  for (const r of doLead) await anotar(r.id);
  return doLead.length;
}

module.exports = { sincronizar, anotarPelaFicha, buscaDoReport, temVenda };
