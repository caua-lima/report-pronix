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
const { textoDoPdf } = require('./textoDoPdf');

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

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const NO_SHOW = /no ?show|nao (compareceu|apareceu|veio|entrou)|faltou|ausente/;
/** Resultado da reunião para o histórico do closer: 'venda' | 'perda' | 'no_show' | 'aberto'. */
function resultadoDe(deal, catalogo) {
  if (deal.win === true) return 'venda';
  const onde = catalogo.get(idDe(deal.deal_stage));
  if (onde && onde.etapa.categoria === 'venda') return 'venda';
  if (deal.win === false) return NO_SHOW.test(semAcento(deal.deal_lost_reason && deal.deal_lost_reason.name)) ? 'no_show' : 'perda';
  return 'aberto';
}

function situacao(deal, catalogo) {
  if (deal.win === true) return 'Venda';
  if (deal.win === false) return 'Perdido' + (deal.deal_lost_reason && deal.deal_lost_reason.name ? ` (${crm.consertarAcentos(deal.deal_lost_reason.name)})` : '');
  const onde = catalogo.get(idDe(deal.deal_stage));
  return onde ? `${onde.funil.nome} › ${onde.etapa.nome}` : crm.consertarAcentos((deal.deal_stage && deal.deal_stage.name) || '');
}

/** Handoff escrito numa passagem de etapa (o CRM pede closer + handoff ao mover para algumas etapas). */
function handoffDoHistorico(deal) {
  const textos = (Array.isArray(deal.deal_stage_histories) ? deal.deal_stage_histories : [])
    .map((h) => crm.textoDoHandoff(h))
    .filter((x) => x.length > 20);
  return textos.length ? textos[textos.length - 1] : '';
}

/**
 * O arquivo do handoff anexado ao card (desde 22/10/2026 o CRM aceita o arquivo no lugar do texto: PDF, JPG, PNG ou
 * WebP). A API pública não diz no detalhe se há arquivo: a rota oficial é GET /deals/:id/handoff/file (404 = não há).
 * PDF com texto legível (o PDF do report) vira o texto do handoff; o arquivo vai sempre junto no .zip.
 */
async function lerArquivoDoHandoff(dealId) {
  const id = encodeURIComponent(dealId);
  const a = (await crm.baixarArquivo(`/deals/${id}/handoff/file`).catch(() => null)) || (await crm.baixarArquivo(`/deals/${id}/handoff/arquivo`).catch(() => null));
  if (!a || !a.buffer || !a.buffer.length) return null;
  const ehPdf = /pdf/i.test(a.tipo) || a.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  let texto = '';
  if (ehPdf) { try { texto = textoDoPdf(a.buffer); } catch (_) { texto = ''; } }
  texto = String(texto || '').trim();
  // PDF de outra origem (fonte embutida) pode sair sem texto legível: aí fica só o arquivo.
  if ((texto.match(/[A-Za-zÀ-ÿ]/g) || []).length < 80) texto = '';
  return { ...a, ehPdf, texto };
}

/** Há arquivo do handoff neste card? Guardado por versão do card (30 dias): pedir de novo não baixa outra vez. */
async function arquivoDoCard(deal) {
  const chave = `hr_arq1_${idDe(deal)}_${String(deal.updated_at || '')}`;
  const g = await db.cacheGet(chave).catch(() => null);
  if (g) { try { return JSON.parse(g); } catch (_) { /* relê */ } }
  const a = await lerArquivoDoHandoff(idDe(deal));
  const r = a ? { tem: true, ext: extensaoDe(a, crm.arquivoDoHandoff(deal)), nome: a.nome || '', texto: a.texto } : { tem: false };
  await db.cacheSet(chave, JSON.stringify(r), 30 * 86400).catch(() => {});
  return r;
}

function extensaoDe(arq, info) {
  const doNome = /\.([a-z0-9]{2,5})$/i.exec(String((info && info.nome) || (arq && arq.nome) || ''));
  if (doNome) return doNome[1].toLowerCase();
  if (arq && arq.ehPdf) return 'pdf';
  if (/png/i.test((arq && arq.tipo) || '')) return 'png';
  if (/jpe?g/i.test((arq && arq.tipo) || '')) return 'jpg';
  return 'bin';
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
  // Os arquivos de handoff dos cards do período sem texto: 6 downloads por vez, até o tempo acabar.
  const precisamArquivo = detalhes.filter((d) => {
    if (!d || crm.textoDoHandoff(d) || handoffDoHistorico(d)) return false;
    const q = diaDaRealizada(d, catalogo);
    return q && q >= ini && q <= fim;
  });
  const arquivos = new Map();
  let proximo = 0;
  const limiteArquivos = t0 + prazoMs + 8000;
  await Promise.all(Array.from({ length: Math.min(6, precisamArquivo.length) }, async () => {
    while (proximo < precisamArquivo.length && Date.now() < limiteArquivos) {
      const d = precisamArquivo[proximo++];
      arquivos.set(idDe(d), await arquivoDoCard(d).catch(() => ({ tem: false })));
    }
  }));

  const reunioes = [];
  let pendentesDeArquivo = 0;
  for (const d of detalhes) {
    if (!d) continue;
    const quando = diaDaRealizada(d, catalogo);
    if (!quando || quando < ini || quando > fim) continue;
    const id = idDe(d);
    // O handoff, na ordem: texto do card, texto da passagem de etapa, arquivo anexado (PDF vira texto), report guardado.
    let handoff = crm.textoDoHandoff(d) || handoffDoHistorico(d);
    let origem = handoff ? 'crm' : '';
    // Sem texto no card: o handoff pode ser só o arquivo anexado (a maioria dos cards desde 22/10).
    let arquivo = null;
    if (!handoff && arquivos.has(id)) {
      const a = arquivos.get(id);
      if (a.tem) {
        arquivo = { nome: a.nome, ext: a.ext };
        if (a.texto) { handoff = a.texto; origem = 'arquivo'; } else origem = 'arquivo-sem-texto';
      }
    } else if (!handoff) {
      pendentesDeArquivo++;
    }
    if (!handoff && !arquivo) {
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
      resultado: resultadoDe(d, catalogo),
      url: crm.linkDoCard ? crm.linkDoCard(id) : '',
      handoff,
      origem,
      arquivo,
    });
  }
  reunioes.sort((a, b) => a.closer.localeCompare(b.closer, 'pt-BR') || a.dia.localeCompare(b.dia) || a.lead.localeCompare(b.lead, 'pt-BR'));
  // Arquivo que não deu tempo de conferir conta como pendente: a tela pede de novo e continua (o que já foi visto fica guardado).
  return { desde: ini, ate: fim, reunioes, pendentes: (detalhes.pendentes || 0) + pendentesDeArquivo, candidatos: candidatos.length };
}

/** Resumo por closer para a tela (sem o texto dos handoffs). */
function resumo(r) {
  const porCloser = new Map();
  r.reunioes.forEach((x) => {
    const c = porCloser.get(x.closer) || { closer: x.closer, reunioes: 0, semHandoff: 0 };
    c.reunioes++;
    if (!x.handoff && !x.arquivo) c.semHandoff++;
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
      x.handoff || (x.arquivo ? '(o handoff deste card é o arquivo anexado — está junto, com o mesmo nome)' : '(sem handoff: o card não tem handoff no CRM e o Report PRONIX não guardou o texto do report deste lead)'),
      x.origem === 'arquivo' ? '\n(Texto tirado do PDF anexado ao card como handoff; o PDF está junto.)' : '',
      x.origem === 'report' ? '\n(O handoff não estava no card do CRM; este é o texto do report guardado no Report PRONIX.)' : '',
    ].filter((l) => l !== '').join('\n').replace(/\n(HANDOFF)/, '\n\n$1'),
  }));
  const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const indice = ['Dia;Lead;SDR;Situação hoje;Handoff;Card no CRM']
    .concat(doCloser.map((x) => [brData(x.dia), x.lead, x.sdr, x.situacao, x.handoff || x.arquivo ? ({ crm: 'no CRM', report: 'do report' }[x.origem] || 'arquivo anexado') : 'sem handoff', x.url].map(csv).join(';')))
    .join('\r\n');
  return arquivos.concat([{ nome: '_indice.csv', texto: '﻿' + indice }]);
}

/** Os anexos (arquivo do handoff) das reuniões de um closer, baixados agora do CRM, com o nome do .txt. */
async function anexosDoCloser(r, closer) {
  const saida = [];
  for (const x of r.reunioes.filter((y) => y.closer === closer && y.arquivo)) {
    const a = await lerArquivoDoHandoff(x.dealId);
    if (a) saida.push({ nome: `${x.dia.slice(8, 10)}-${x.dia.slice(5, 7)} - ${nomeDeArquivo(x.lead)} - handoff.${extensaoDe(a, x.arquivo)}`, buffer: a.buffer });
  }
  return saida;
}

module.exports = { resultadoDe, levantar, resumo, arquivosDoCloser, anexosDoCloser, handoffDoHistorico, podeTerPassado, diaDaRealizada, catalogoDe, nomeDeArquivo };
