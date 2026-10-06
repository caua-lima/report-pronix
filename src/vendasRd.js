'use strict';

// Desfecho da negociação lido do RD. O closer registra o fim no RD Station — marca o card como
// vendido, ou perdido / move para "Não compraram" com o motivo — e isso pode acontecer semanas depois
// da reunião. Aqui o sistema só LÊ o RD e leva o desfecho para o report:
//  - vendido: anota "vendido no RD" (o master só escolhe se foi em call, follow-up ou pix);
//  - não comprou: marca "Não fechou" com o motivo do RD em "o que deu a reunião" e encerra.
// Nunca escolhe o tipo de venda, nunca troca um resultado já marcado como venda ou "não fechou", e
// só vale desfecho registrado DEPOIS de o report ter sido gerado (card antigo do mesmo lead não conta).

const stats = require('./stats');
const crm = require('./crm');
const closerAuto = require('./closerAuto');
const closers = require('./closers');

const DIAS = 90; // reports acompanhados para trás (a perda pode vir semanas depois)
const POR_VEZ = 12; // leads consultados no RD por rodada (cada um custa algumas chamadas)

const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Etapas do funil dos closers (os nomes podem ser trocados por variável de ambiente, se o time renomear).
const etapaNaoComprou = () => normalizar(process.env.CRM_ETAPA_NAO_COMPROU || 'Não compraram');
const etapaVendido = () => normalizar(process.env.CRM_ETAPA_VENDIDO || 'Vendido');
const etapaFup = () => normalizar(process.env.CRM_ETAPA_FUP || 'Fluxo de FUP');
const naEtapa = (card, nome) => Boolean(card.etapa) && normalizar(card.etapa).startsWith(nome);

/** Ainda vale acompanhar no RD? Sem venda, sem "não fechou" e sem no-show. */
const emAberto = (r) => !r.vendidoNoRd && !stats.ehVenda(r.resultado) && r.resultado !== 'no_show' && r.resultado !== 'sem_venda';
const depoisDoReport = (card, r) => {
  const t = Date.parse(card.fechadaEm || card.atualizadaEm || '');
  return !Number.isFinite(t) || !r || !r.quando || t >= Date.parse(r.quando) - 3600000;
};

/**
 * O que o RD diz deste lead, para um report: { venda: true } | { perda: true, motivo } | { fup: true } | null.
 * Venda vale mais que perda (lead que perdeu num card e comprou em outro, comprou).
 */
function desfecho(ficha, report) {
  const cards = ((ficha && ficha.negociacoes) || []).filter((c) => depoisDoReport(c, report));
  const vendido = cards.find((c) => c.ganha || naEtapa(c, etapaVendido()));
  if (vendido) return vendido.valor > 0 ? { venda: true, valor: vendido.valor } : { venda: true };
  const perdido = cards.find((c) => c.perdida || naEtapa(c, etapaNaoComprou()));
  // Ainda em negociação, mas o closer já colocou no fluxo de follow-up.
  if (!perdido) return cards.some((c) => naEtapa(c, etapaFup())) ? { fup: true } : null;
  const motivo = [perdido.motivoPerda, perdido.notaPerda].map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' — ');
  return { perda: true, motivo: motivo || (perdido.perdida ? 'Marcado como perdido no RD (sem motivo informado).' : `Movido para "${perdido.etapa}" no RD.`) };
}
const temVenda = (ficha) => Boolean((desfecho(ficha, null) || {}).venda);
const temDesfecho = (ficha) => { const d = desfecho(ficha, null); return Boolean(d && (d.venda || d.perda)); };

/** Como achar no RD o lead de um report: pelo telefone se o contato for um número, senão pelo nome. */
function buscaDoReport(r) {
  const contato = String(r.contato || '').trim();
  const digitos = contato.replace(/\D/g, '');
  if (digitos.length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(contato)) return { telefone: digitos };
  const nome = contato || String(r.lead || '').trim();
  return nome ? { nome } : null;
}

/** Leva o desfecho do RD para o report. Devolve 'venda' | 'perda' | ''. */
async function aplicar(r, d) {
  const agora = new Date().toISOString();
  if (!d) {
    await stats.atualizarResultado(r.id, { rdConferidoEm: agora });
    return '';
  }
  if (d.venda) {
    // O valor do card no RD entra como ticket só se ninguém preencheu ainda.
    await stats.atualizarResultado(r.id, { vendidoNoRd: agora, rdConferidoEm: agora, ...(d.valor && !r.ticket ? { ticket: d.valor } : {}) });
    return 'venda';
  }
  if (d.fup) {
    // Só preenche se ninguém marcou nada ainda; o report continua em aberto, esperando o desfecho.
    await stats.atualizarResultado(r.id, r.resultado ? { rdConferidoEm: agora } : { resultado: 'em_followup', rdConferidoEm: agora });
    return '';
  }
  // O motivo do RD entra em "o que deu a reunião" sem apagar o que já estava anotado.
  const anotado = String(r.obsReuniao || '').trim();
  const doRd = 'RD: ' + d.motivo;
  await stats.atualizarResultado(r.id, {
    resultado: 'sem_venda', encerradoPeloRd: agora, rdConferidoEm: agora,
    obsReuniao: anotado ? (anotado.includes(d.motivo) ? anotado : `${anotado} | ${doRd}`) : doRd,
  });
  return 'perda';
}

/**
 * Confere no RD os reports ainda em aberto, começando pelos conferidos há mais tempo.
 * @param {object[]} reports
 * @returns {Promise<{conferidos: number, vendidos: number, encerrados: number, restantes: number}>}
 */
async function sincronizar(reports, { porVez = POR_VEZ } = {}) {
  if (!crm.configurado()) throw new Error('O RD Station não está configurado no servidor.');
  const limite = stats.emDiaLocal(new Date(Date.now() - DIAS * 86400000).toISOString());
  const fila = (reports || [])
    .filter((r) => emAberto(r) && String(r.dia || '') >= limite && buscaDoReport(r))
    .sort((a, b) => String(a.rdConferidoEm || '').localeCompare(String(b.rdConferidoEm || '')) || String(b.quando || '').localeCompare(String(a.quando || '')));
  const agora = fila.slice(0, porVez);
  const cadastrados = agora.some((r) => !r.closerId) ? await closers.listar() : [];
  let vendidos = 0;
  let encerrados = 0;
  for (const r of agora) {
    const lead = await crm.consultarLead(buscaDoReport(r)).catch(() => null); // um lead que falhou não para os outros
    if (!lead) continue;
    // De quebra: o card já está com o closer no funil dele? Preenche o closer do report (se estiver vazio).
    if (!r.closerId) {
      const c = closerAuto.acharCloser(cadastrados, closerAuto.closerDoRd(lead.ficha));
      if (c && c.nome !== r.usuarioNome) await stats.atualizarResultado(r.id, { closerId: c.id, closerNome: c.nome });
    }
    const feito = await aplicar(r, desfecho(lead.ficha, r));
    if (feito === 'venda') vendidos++;
    if (feito === 'perda') encerrados++;
  }
  return { conferidos: agora.length, vendidos, encerrados, restantes: fila.length - agora.length };
}

/** Ao abrir a conversa: a ficha já mostra o desfecho? Leva para os reports deste lead (do próprio usuário). */
async function anotarPelaFicha({ usuario, conversa, ficha }) {
  if (!usuario || !conversa || !temDesfecho(ficha)) return 0;
  const de = stats.emDiaLocal(new Date(Date.now() - DIAS * 86400000).toISOString());
  const doLead = (await stats.listar({ de })).filter((r) => r.usuarioId === usuario.id && emAberto(r) && closerAuto.ehDaConversa(r, conversa, ficha));
  let n = 0;
  for (const r of doLead) if (await aplicar(r, desfecho(ficha, r))) n++;
  return n;
}

module.exports = { sincronizar, anotarPelaFicha, buscaDoReport, desfecho, temVenda };
