'use strict';

// Desfecho da negociação lido do RD. O closer registra o fim no RD Station — marca o card como
// vendido (com o produto e o valor), ou perdido / move para "Não compraram" com o motivo — e isso
// pode acontecer semanas depois da reunião. Aqui o sistema só LÊ o RD e leva o desfecho para o report:
//  - vendido: marca a venda sozinho (em call; ou em follow-up, se o card já tinha passado pelo
//    follow-up ou fechou depois do dia da reunião), com o produto e o ticket do card. Quem preenche
//    só completa a forma de pagamento;
//  - em follow-up: o card está numa etapa de follow-up do funil dos closers;
//  - não comprou: marca "Não fechou" com o motivo do RD em "o que deu a reunião" e encerra.
// Nunca troca um resultado marcado à mão como venda ou "não fechou", nem produto e ticket já
// preenchidos, e só vale desfecho registrado DEPOIS de o report ter sido gerado.
//
// Achar o lead no RD: o report guarda, do card que estava aberto quando foi gerado, o id do contato,
// o telefone e o e-mail. É por eles que se busca; o nome do contato no WhatsApp é o último recurso.
// Quando o lead é achado, o vínculo é gravado no report, e cada conferência anota o que o RD mostrou.

const db = require('./db');
const stats = require('./stats');
const crm = require('./crm');
const closerAuto = require('./closerAuto');
const closers = require('./closers');

const DIAS = 90; // reports acompanhados para trás (a perda pode vir semanas depois)
const POR_VEZ = 12; // leads consultados no RD por rodada (cada um custa algumas chamadas)
const DIAS_QUENTE = 7; // report recente: é onde o desfecho aparece primeiro
const HORAS_COMPLETAR = 72; // venda sem produto ou ticket: confere de novo por esse tempo

const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
// Etapas do funil dos closers (os nomes podem ser trocados por variável de ambiente, se o time renomear).
const etapaNaoComprou = () => normalizar(process.env.CRM_ETAPA_NAO_COMPROU || 'Não compraram');
const etapaVendido = () => normalizar(process.env.CRM_ETAPA_VENDIDO || 'Vendido');
const etapaFup = () => normalizar(process.env.CRM_ETAPA_FUP || 'Fluxo de FUP');
const naEtapa = (card, nome) => Boolean(card.etapa) && normalizar(card.etapa).startsWith(nome);
/** A reunião aconteceu e não fechou na hora: o card está no follow-up dos closers. */
function emFollowUp(card) {
  if (naEtapa(card, etapaFup()) || naEtapa(card, 'fup agendado')) return true;
  // "Em contato" e "Negociação avançada" só contam no funil dos closers (o nome é comum demais).
  return /closer/.test(normalizar(card.funil)) && (naEtapa(card, 'em contato') || naEtapa(card, 'negociacao avanc'));
}

/** Ainda vale acompanhar no RD? Sem venda, sem "não fechou" e sem no-show. */
const emAberto = (r) => !r.vendidoNoRd && !stats.ehVenda(r.resultado) && r.resultado !== 'no_show' && r.resultado !== 'sem_venda';
/**
 * Vendido no RD, mas ainda falta levar algo da venda: quem foi anotado antes de o sistema ler o tipo,
 * o produto e o ticket (uma vez), e venda recente sem produto ou ticket (o closer pode preencher depois).
 */
function faltaDadoDaVenda(r, agora = Date.now()) {
  if (!r.vendidoNoRd || r.resultado === 'no_show' || r.resultado === 'sem_venda') return false;
  if (!r.rdVendaLida) return true;
  return (!r.produto || !r.ticket) && agora - Date.parse(r.vendidoNoRd) < HORAS_COMPLETAR * 3600000;
}
const acompanhar = (r, agora) => emAberto(r) || faltaDadoDaVenda(r, agora);

const depoisDoReport = (card, r) => {
  const t = Date.parse(card.fechadaEm || card.atualizadaEm || '');
  return !Number.isFinite(t) || !r || !r.quando || t >= Date.parse(r.quando) - 3600000;
};

/** "Pronix Performance" -> 'performance'; "PRONIX Acelera" -> 'acelera'; outro nome -> '' (não se inventa). */
function produtoPeloNome(nomes) {
  const t = normalizar((Array.isArray(nomes) ? nomes : [nomes]).join(' '));
  if (/performance/.test(t)) return 'performance';
  if (/acelera/.test(t)) return 'acelera';
  return '';
}

/**
 * O que o RD diz deste lead, para um report:
 * { venda: true, cardId?, valor?, produto?, fechadaEm? } | { perda: true, motivo } | { fup: true } | null.
 * Venda vale mais que perda (lead que perdeu num card e comprou em outro, comprou).
 */
function desfecho(ficha, report) {
  const cards = ((ficha && ficha.negociacoes) || []).filter((c) => depoisDoReport(c, report));
  const vendido = cards.find((c) => c.ganha || naEtapa(c, etapaVendido()));
  if (vendido) {
    const d = { venda: true };
    if (vendido.id) d.cardId = String(vendido.id);
    if (vendido.valor > 0) d.valor = vendido.valor;
    const produto = produtoPeloNome(vendido.produtos || []);
    if (produto) d.produto = produto;
    if (vendido.fechadaEm) d.fechadaEm = vendido.fechadaEm;
    return d;
  }
  const perdido = cards.find((c) => c.perdida || naEtapa(c, etapaNaoComprou()));
  // Ainda em negociação, mas o closer já colocou no follow-up.
  if (!perdido) return cards.some(emFollowUp) ? { fup: true } : null;
  const motivo = [perdido.motivoPerda, perdido.notaPerda].map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' — ');
  return { perda: true, motivo: motivo || (perdido.perdida ? 'Marcado como perdido no RD (sem motivo informado).' : `Movido para "${perdido.etapa}" no RD.`) };
}
const temVenda = (ficha) => Boolean((desfecho(ficha, null) || {}).venda);
const temDesfecho = (ficha) => { const d = desfecho(ficha, null); return Boolean(d && (d.venda || d.perda)); };

/** Como achar no RD o lead de um report só pelo contato: telefone se for um número, senão o nome. */
function buscaDoReport(r) {
  const contato = String(r.contato || '').trim();
  const digitos = contato.replace(/\D/g, '');
  if (digitos.length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(contato)) return { telefone: digitos };
  const nome = contato || String(r.lead || '').trim();
  return nome ? { nome } : null;
}

/**
 * As buscas possíveis, em ordem: e-mail e telefone (acham também os cadastros repetidos do mesmo lead —
 * o card da reunião às vezes está em outro cadastro), depois o id do contato e, por fim, o contato do WhatsApp.
 */
function buscasDoReport(r) {
  const lista = [];
  const email = String(r.leadEmail || '').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) lista.push({ email });
  const tel = soDigitos(r.telefone);
  if (tel.length >= 10) lista.push({ telefone: tel });
  if (r.rdContatoId) lista.push({ contatoId: String(r.rdContatoId) });
  const peloContato = buscaDoReport(r);
  if (peloContato && !(peloContato.telefone && peloContato.telefone === tel)) lista.push(peloContato);
  return lista;
}

/** A ficha ainda não mostra o card da reunião: nenhum com closer, vendido nem perdido. */
const semCardDeCloser = (ficha) => !closerAuto.closerDoRd(ficha) && !desfecho(ficha, null);

/** Dois cadastros do mesmo lead: os cards, telefones e e-mails do segundo entram no primeiro (sem repetir). */
function juntarFichas(a, b) {
  const ids = new Set((a.negociacoes || []).map((c) => String(c.id)));
  const uniao = (x, y) => [...new Set((x || []).concat(y || []))];
  return {
    ...a,
    negociacoes: (a.negociacoes || []).concat((b.negociacoes || []).filter((c) => !ids.has(String(c.id))).map((c) => ({ ...c, escolhida: false }))),
    telefones: uniao(a.telefones, b.telefones), emails: uniao(a.emails, b.emails),
  };
}

/** O card do lead tem a ver com quem gerou o report? (responsável do card ou campo SDR com o nome dele) */
function ehDoSdr(ficha, r) {
  const palavras = normalizar(r.usuarioNome).split(' ').filter(Boolean);
  if (!palavras.length) return false;
  const cabe = (nome) => { const p = new Set(normalizar(nome).split(' ')); return palavras.every((x) => p.has(x)); };
  if (((ficha && ficha.negociacoes) || []).some((c) => cabe(c.responsavel))) return true;
  return ((ficha && ficha.campos) || []).some((c) => normalizar(c.rotulo) === 'sdr' && normalizar(c.valor).split(' ')[0] === palavras[0]);
}

/**
 * Acha o lead do report no RD. Nome que bate com mais de um contato não é chute: entre os candidatos,
 * só vale se exatamente um tiver card do próprio pré-vendedor.
 * @returns {Promise<{ficha: object, por: string} | {ficha: null, candidatos: number}>}
 */
async function acharNoRd(r) {
  let candidatos = [];
  let achada = null;
  let por = '';
  for (const busca of buscasDoReport(r)) {
    const tipo = Object.keys(busca)[0];
    // Já achou: só vale olhar o outro dado (e-mail ou telefone) se ainda não apareceu card com closer.
    if (achada && !(semCardDeCloser(achada) && (tipo === 'email' || tipo === 'telefone'))) break;
    const lead = await crm.consultarLead(busca);
    if (lead && lead.encontrado !== false && lead.ficha) {
      achada = achada ? juntarFichas(achada, lead.ficha) : lead.ficha;
      por = por || tipo;
    } else if (lead && Array.isArray(lead.candidatos) && lead.candidatos.length) candidatos = lead.candidatos;
  }
  if (achada) return { ficha: achada, por };
  const doSdr = [];
  for (const c of candidatos.slice(0, 4)) {
    const lead = c && c.id ? await crm.consultarLead({ contatoId: c.id }).catch(() => null) : null;
    if (lead && lead.ficha && ehDoSdr(lead.ficha, r)) doSdr.push(lead.ficha);
  }
  if (doSdr.length === 1) return { ficha: doSdr[0], por: 'nome' };
  return { ficha: null, candidatos: candidatos.length };
}

/** O que gravar no report para a próxima busca ser exata (só o que ainda está vazio). */
function vinculoQueFalta(r, ficha) {
  const v = stats.vinculoLimpo({ telefone: ((ficha && ficha.telefones) || [])[0], email: ((ficha && ficha.emails) || [])[0], contatoId: ficha && ficha.contatoId });
  const campos = {};
  if (v.contatoId && !r.rdContatoId) campos.rdContatoId = v.contatoId;
  if (v.telefone && !r.telefone) campos.telefone = v.telefone;
  if (v.email && !r.leadEmail) campos.leadEmail = v.email;
  return campos;
}

/** Em uma linha, o que o RD mostra do lead: o card vendido, senão o que está com closer, senão o da ficha. */
function situacaoNoRd(ficha) {
  const cards = (ficha && ficha.negociacoes) || [];
  const card = cards.find((c) => c.ganha || naEtapa(c, etapaVendido())) || cards.find((c) => closerAuto.closerDoRd({ negociacao: c })) || cards.find((c) => c.escolhida) || cards[0] || (ficha && ficha.negociacao);
  if (!card) return 'Achei o contato no RD, mas ele não tem negociação.';
  const estado = card.ganha ? ' (vendido)' : card.perdida ? ' (perdido)' : '';
  return [String(card.etapa || 'sem etapa') + estado, card.funil, card.responsavel].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
}

/** Venda em call ou em follow-up? Follow-up se o card já tinha passado por lá ou fechou depois do dia da reunião. */
function tipoDaVenda(r, d) {
  if (r.resultado === 'em_followup') return 'venda_fup';
  const diaDaVenda = d.fechadaEm ? stats.emDiaLocal(d.fechadaEm) : '';
  if (r.dataReuniao && diaDaVenda && diaDaVenda > r.dataReuniao) return 'venda_fup';
  return 'venda_call';
}

/**
 * Leva o desfecho do RD para o report. `extra` são campos que vão na mesma gravação (vínculo, situação).
 * Devolve 'venda' | 'perda' | ''.
 */
async function aplicar(r, d, extra = {}) {
  const agora = new Date().toISOString();
  if (!d) {
    await stats.atualizarResultado(r.id, { ...extra, rdConferidoEm: agora });
    return '';
  }
  if (d.venda) {
    const campos = { ...extra, vendidoNoRd: r.vendidoNoRd || agora, rdVendaLida: agora, rdConferidoEm: agora };
    // O tipo da venda só entra se ninguém escolheu; o que foi preenchido à mão nunca é trocado.
    if (!r.resultado || r.resultado === 'em_followup') campos.resultado = tipoDaVenda(r, d);
    if (d.valor && !r.ticket) campos.ticket = d.valor;
    if (d.produto && !r.produto) campos.produto = d.produto;
    if (d.fechadaEm && !r.dataFechamento) campos.dataFechamento = stats.emDiaLocal(d.fechadaEm);
    await stats.atualizarResultado(r.id, campos);
    return r.vendidoNoRd ? '' : 'venda';
  }
  if (d.fup) {
    // Só preenche se ninguém marcou nada ainda; o report continua em aberto, esperando o desfecho.
    await stats.atualizarResultado(r.id, r.resultado ? { ...extra, rdConferidoEm: agora } : { ...extra, resultado: 'em_followup', rdConferidoEm: agora });
    return '';
  }
  // O motivo do RD entra em "o que deu a reunião" sem apagar o que já estava anotado.
  const anotado = String(r.obsReuniao || '').trim();
  const doRd = 'RD: ' + d.motivo;
  await stats.atualizarResultado(r.id, {
    ...extra, resultado: 'sem_venda', encerradoPeloRd: agora, rdConferidoEm: agora,
    obsReuniao: anotado ? (anotado.includes(d.motivo) ? anotado : `${anotado} | ${doRd}`) : doRd,
  });
  return 'perda';
}

/** Card vendido sem produto na ficha: pergunta ao RD os produtos dele (uma chamada a mais, só na venda). */
async function comProduto(d) {
  if (!d || !d.venda || d.produto || !d.cardId) return d;
  const produto = produtoPeloNome(await crm.produtosDoCard(d.cardId).catch(() => []));
  return produto ? { ...d, produto } : d;
}

/**
 * Quem conferir agora. Os recentes vêm primeiro (é neles que a reunião está acontecendo), mas um terço
 * da rodada fica para os antigos — a perda pode vir semanas depois. Dentro de cada grupo, os conferidos
 * há mais tempo. Com `minutosQuente`/`horasFrio`, quem foi conferido há pouco fica para a próxima.
 */
function escolherFila(reports, { porVez, minutosQuente = 0, horasFrio = 0, agora = Date.now() }) {
  const limite = stats.emDiaLocal(new Date(agora - DIAS * 86400000).toISOString());
  const quente = (r) => agora - Date.parse(r.quando || 0) < DIAS_QUENTE * 86400000 || faltaDadoDaVenda(r, agora);
  const recemConferido = (r) => {
    const t = Date.parse(r.rdConferidoEm || '');
    return Number.isFinite(t) && agora - t < (quente(r) ? minutosQuente * 60000 : horasFrio * 3600000);
  };
  const ordem = (a, b) => String(a.rdConferidoEm || '').localeCompare(String(b.rdConferidoEm || '')) || String(b.quando || '').localeCompare(String(a.quando || ''));
  const fila = (reports || []).filter((r) => acompanhar(r, agora) && String(r.dia || '') >= limite && buscasDoReport(r).length && !recemConferido(r));
  const quentes = fila.filter(quente).sort(ordem);
  const frios = fila.filter((r) => !quente(r)).sort(ordem);
  const cota = frios.length ? Math.max(1, Math.ceil((porVez * 2) / 3)) : porVez;
  const escolhidos = quentes.slice(0, cota);
  escolhidos.push(...frios.slice(0, porVez - escolhidos.length));
  escolhidos.push(...quentes.slice(cota, cota + porVez - escolhidos.length));
  return { escolhidos, total: fila.length };
}

/**
 * Confere no RD os reports ainda em aberto.
 * @param {object[]} reports
 * @param {{porVez?: number, minutosQuente?: number, horasFrio?: number}} opcoes  os dois últimos são o
 *   intervalo mínimo da rodada automática (o botão "Puxar do RD" não usa: confere na hora)
 * @returns {Promise<{conferidos: number, vendidos: number, encerrados: number, restantes: number}>}
 */
async function sincronizar(reports, { porVez = POR_VEZ, minutosQuente = 0, horasFrio = 0 } = {}) {
  if (!crm.configurado()) throw new Error('O RD Station não está configurado no servidor.');
  const { escolhidos, total } = escolherFila(reports, { porVez, minutosQuente, horasFrio });
  const cadastrados = escolhidos.some((r) => !r.closerId) ? await closers.listar() : [];
  let vendidos = 0;
  let encerrados = 0;
  for (const r of escolhidos) {
    const achado = await acharNoRd(r).catch(() => undefined); // um lead que falhou não para os outros
    if (achado === undefined) continue;
    if (!achado.ficha) {
      const porque = achado.candidatos > 1 ? `Não achei no RD: ${achado.candidatos} contatos com esse nome. Informe o e-mail ou o telefone do lead.` : 'Não achei este lead no RD. Informe o e-mail ou o telefone dele.';
      await stats.atualizarResultado(r.id, { rdConferidoEm: new Date().toISOString(), rdSituacao: porque });
      continue;
    }
    const ficha = achado.ficha;
    // De quebra: o lead já está com o closer no funil dele? Preenche o closer do report (se estiver vazio).
    if (!r.closerId) {
      const c = closerAuto.acharCloser(cadastrados, closerAuto.closerDoRd(ficha));
      if (c && c.nome !== r.usuarioNome) await stats.atualizarResultado(r.id, { closerId: c.id, closerNome: c.nome });
    }
    const extra = { ...vinculoQueFalta(r, ficha), rdSituacao: situacaoNoRd(ficha) };
    const feito = await aplicar(r, await comProduto(desfecho(ficha, r)), extra);
    if (feito === 'venda') vendidos++;
    if (feito === 'perda') encerrados++;
  }
  return { conferidos: escolhidos.length, vendidos, encerrados, restantes: total - escolhidos.length };
}

/**
 * Ao abrir a conversa com a ficha do RD na tela: grava o vínculo nos reports daquele lead (do próprio
 * usuário) e, se a ficha já mostra o desfecho, leva para eles. A lista de reports é lida no máximo uma
 * vez a cada 10 minutos por conversa quando não há desfecho novo.
 */
async function anotarPelaFicha({ usuario, conversa, ficha }) {
  if (!usuario || !conversa || !ficha) return 0;
  const comDesfecho = temDesfecho(ficha);
  if (!comDesfecho) {
    const chave = `vinculo:${usuario.id}:${soDigitos(conversa.telefone).slice(-8) || normalizar(conversa.nome)}`;
    if (await db.cacheGet(chave)) return 0;
    await db.cacheSet(chave, '1', 600);
  }
  const de = stats.emDiaLocal(new Date(Date.now() - DIAS * 86400000).toISOString());
  const doLead = (await stats.listar({ de })).filter((r) => r.usuarioId === usuario.id && acompanhar(r) && closerAuto.ehDaConversa(r, conversa, ficha));
  let n = 0;
  for (const r of doLead) {
    const extra = vinculoQueFalta(r, ficha);
    if (comDesfecho) {
      if (await aplicar(r, await comProduto(desfecho(ficha, r)), { ...extra, rdSituacao: situacaoNoRd(ficha) })) n++;
    } else if (Object.keys(extra).length) {
      await stats.atualizarResultado(r.id, extra);
    }
  }
  return n;
}

module.exports = { sincronizar, anotarPelaFicha, buscaDoReport, buscasDoReport, desfecho, temVenda, produtoPeloNome, situacaoNoRd, escolherFila, emFollowUp };
