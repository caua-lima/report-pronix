'use strict';

// Handoffs das reuniões realizadas, por closer (só o master). Lê do Pronix CRM os cards que ENTRARAM numa etapa de
// reunião realizada no período (pelo histórico de etapas), de qualquer SDR, e o handoff de cada um: o que está no
// card do CRM ou, sem ele, o texto do report guardado aqui (60 dias). Nada é escrito no CRM.
//
// Custo: a lista de cards de cada funil é barata; o detalhe (histórico + handoff) é que custa. Só entram no detalhe os
// cards cuja etapa ATUAL é a de reunião realizada ou depois dela. O detalhe fica guardado por versão do card
// (crm.detalhesDe) e, quando o tempo do servidor acaba, a tela pede de novo e continua de onde parou.

const crm = require('./crm');
const db = require('./db');
const { emDiaLocal } = require('./stats');
const { handoffGuardado } = require('./fluxoReuniao');

const DEPOIS_DA_REUNIAO = new Set(['reuniao_realizada', 'fup', 'negociacao_avancada', 'venda']);
const idDe = (x) => String((x && (x.id || x._id)) || '');
const dia = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '';
const LISTA_SEG = 30 * 60;

function catalogoDe(funis) {
  const porEtapa = new Map();
  funis.forEach((f) => f.etapas.forEach((e) => porEtapa.set(String(e.id), { funil: f, etapa: e })));
  return porEtapa;
}

/** O card já está na reunião realizada ou depois dela (no funil atual)? Só esses podem ter passado por ela. */
function podeTerPassado(deal, catalogo) {
  if (deal.win === true) return true;
  const onde = catalogo.get(idDe(deal.deal_stage));
  if (!onde) return deal.win === false; // etapa desconhecida: o detalhe decide (perdido pode ter passado)
  if (DEPOIS_DA_REUNIAO.has(onde.etapa.categoria)) return true;
  const real = onde.funil.etapas.filter((e) => e.categoria === 'reuniao_realizada').map((e) => e.ordem);
  return real.length > 0 && onde.etapa.ordem >= Math.min(...real);
}

/** Quando o card entrou na reunião realizada pela primeira vez (dia local) — '' se nunca entrou. */
function diaDaRealizada(deal, catalogo) {
  const passagens = (Array.isArray(deal.deal_stage_histories) ? deal.deal_stage_histories : [])
    .filter((h) => h && h.start_date && (catalogo.get(String(h.deal_stage_id || '')) || {}).etapa && catalogo.get(String(h.deal_stage_id)).etapa.categoria === 'reuniao_realizada')
    .map((h) => emDiaLocal(h.start_date))
    .sort();
  return passagens[0] || '';
}

function situacao(deal, catalogo) {
  if (deal.win === true) return 'Venda';
  if (deal.win === false) return 'Perdido' + (deal.deal_lost_reason && deal.deal_lost_reason.name ? ` (${crm.consertarAcentos(deal.deal_lost_reason.name)})` : '');
  const onde = catalogo.get(idDe(deal.deal_stage));
  return onde ? `${onde.funil.nome} › ${onde.etapa.nome}` : crm.consertarAcentos((deal.deal_stage && deal.deal_stage.name) || '');
}

function sdrDe(deal) {
  const campo = (Array.isArray(deal.deal_custom_fields) ? deal.deal_custom_fields : [])
    .find((c) => String((c && c.custom_field && c.custom_field.label) || '').trim().toLowerCase() === 'sdr');
  return crm.consertarAcentos(String((deal.sdr && deal.sdr.name) || (campo && campo.value) || '').trim());
}

/**
 * Os cards que foram para a reunião realizada entre desde e ate (dias, AAAA-MM-DD), por closer.
 * @returns {{reunioes: Array, pendentes: number, desde, ate}}
 */
async function levantar({ desde, ate, prazoMs = 40000 } = {}) {
  const ini = dia(desde);
  const fim = dia(ate);
  if (!ini || !fim || ini > fim) throw new Error('Período inválido.');
  if (!crm.configurado()) throw new Error('CRM não configurado no servidor.');
  const t0 = Date.now();
  const funis = await crm.funis();
  const catalogo = catalogoDe(funis);
  const comRealizada = funis.filter((f) => f.etapas.some((e) => e.categoria === 'reuniao_realizada'));
  if (!comRealizada.length) throw new Error('Nenhum funil do CRM tem etapa de reunião realizada.');

  // Listas por funil (4 de cada vez), guardadas 30 min: pedir de novo só lê o detalhe que faltou.
  const listas = await Promise.all(comRealizada.map(async (f) => {
    const chave = `hr_lista1_${f.id}_${ini}_${fim}`;
    const g = await db.cacheGet(chave).catch(() => null);
    if (g) { try { return JSON.parse(g); } catch (_) { /* relê */ } }
    const deals = await crm.listarNegociacoes({ deal_pipeline_id: f.id, updated_at_period: 'true', start_date: crm.instanteDoDia(ini), end_date: crm.instanteDoDia(fim, true) });
    const candidatos = deals.filter((d) => podeTerPassado(d, catalogo)).map((d) => ({ id: idDe(d), updated_at: d.updated_at || '' }));
    await db.cacheSet(chave, JSON.stringify(candidatos), LISTA_SEG).catch(() => {});
    return candidatos;
  }));
  const vistos = new Set();
  const candidatos = listas.flat().filter((c) => c.id && !vistos.has(c.id) && vistos.add(c.id));

  const sobra = Math.max(2000, prazoMs - (Date.now() - t0));
  const detalhes = await crm.detalhesDe(candidatos, { prazoMs: sobra });
  const reunioes = [];
  for (const d of detalhes) {
    if (!d) continue;
    const quando = diaDaRealizada(d, catalogo);
    if (!quando || quando < ini || quando > fim) continue;
    const id = idDe(d);
    let handoff = String((d.handoff && d.handoff.text) || '').trim();
    let origem = handoff ? 'crm' : '';
    if (!handoff) {
      const contato = (d.contacts || [])[0];
      const g = await handoffGuardado({ dealId: id, contatoId: idDe(contato) }).catch(() => null);
      if (g && g.texto) { handoff = String(g.texto).trim(); origem = 'report'; }
    }
    reunioes.push({
      dealId: id,
      card: crm.consertarAcentos(d.name || ''),
      lead: crm.consertarAcentos(((d.contacts || [])[0] && d.contacts[0].name) || d.name || ''),
      closer: crm.consertarAcentos((d.user && d.user.name) || '') || 'Sem closer',
      sdr: sdrDe(d),
      dia: quando,
      situacao: situacao(d, catalogo),
      url: crm.linkDoCard ? crm.linkDoCard(id) : '',
      handoff,
      origem,
    });
  }
  reunioes.sort((a, b) => a.closer.localeCompare(b.closer, 'pt-BR') || a.dia.localeCompare(b.dia) || a.lead.localeCompare(b.lead, 'pt-BR'));
  return { desde: ini, ate: fim, reunioes, pendentes: detalhes.pendentes || 0, candidatos: candidatos.length };
}

/** Resumo por closer para a tela (sem o texto dos handoffs). */
function resumo(r) {
  const porCloser = new Map();
  r.reunioes.forEach((x) => {
    const c = porCloser.get(x.closer) || { closer: x.closer, reunioes: 0, semHandoff: 0 };
    c.reunioes++;
    if (!x.handoff) c.semHandoff++;
    porCloser.set(x.closer, c);
  });
  return { desde: r.desde, ate: r.ate, pendentes: r.pendentes, total: r.reunioes.length, closers: [...porCloser.values()] };
}

const brData = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const nomeDeArquivo = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 _.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'sem-nome';

/** Os arquivos do zip de um closer: um .txt por reunião e o índice em CSV (abre no Excel). */
function arquivosDoCloser(r, closer) {
  const doCloser = r.reunioes.filter((x) => x.closer === closer);
  const arquivos = doCloser.map((x) => ({
    nome: `${x.dia.slice(8, 10)}-${x.dia.slice(5, 7)} - ${nomeDeArquivo(x.lead)}.txt`,
    texto: [
      `Lead: ${x.lead}`,
      `Card: ${x.card}`,
      `Closer: ${x.closer}`,
      x.sdr ? `SDR: ${x.sdr}` : '',
      `Reunião realizada em: ${brData(x.dia)}`,
      `Situação hoje: ${x.situacao}`,
      x.url ? `Card no CRM: ${x.url}` : '',
      '',
      'HANDOFF',
      x.handoff || '(sem handoff: o card não tem handoff no CRM e o Report PRONIX não guardou o texto do report deste lead)',
      x.origem === 'report' ? '\n(O handoff não estava no card do CRM; este é o texto do report guardado no Report PRONIX.)' : '',
    ].filter((l) => l !== '').join('\n').replace(/\n(HANDOFF)/, '\n\n$1'),
  }));
  const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const indice = ['Dia;Lead;SDR;Situação hoje;Handoff;Card no CRM']
    .concat(doCloser.map((x) => [brData(x.dia), x.lead, x.sdr, x.situacao, x.handoff ? (x.origem === 'crm' ? 'no CRM' : 'do report') : 'sem handoff', x.url].map(csv).join(';')))
    .join('\r\n');
  return arquivos.concat([{ nome: '_indice.csv', texto: '﻿' + indice }]);
}

module.exports = { levantar, resumo, arquivosDoCloser, podeTerPassado, diaDaRealizada, catalogoDe, nomeDeArquivo };
