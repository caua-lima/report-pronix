'use strict';

// Aviso no celular a cada lead novo no funil "Pronix Club" (o de ticket mais alto).
// Como funciona, sem custo:
//  - um agendador grátis de fora (ex.: cron-job.org) chama GET /api/pronix-club/verificar/<segredo> a cada minuto
//    (o agendador da Vercel no plano grátis só roda uma vez por dia); um webhook do CRM pode chamar a mesma rota;
//  - aqui o servidor lista os cards do funil criados de ontem para cá, tira os já avisados e manda um push pelo
//    ntfy (app grátis no celular, sem conta: basta assinar o tópico).
// O push NÃO leva dado do lead (o ntfy é um servidor de terceiros): só "Novo lead no Pronix Club". Tocar nele abre a
// aba Pronix Club do dashboard (com login), onde estão nome, telefone e o botão do WhatsApp — guardados no nosso banco.
// Só lê o CRM. O tópico e o segredo ficam no banco (gerados no dashboard), nunca no código.

const crypto = require('crypto');
const db = require('./db');
const crm = require('./crm');
const stats = require('./stats');
const { leadDoCard } = require('./vendasDoRd');

const CHAVE_CONFIG = 'pronixclub_config';
const CHAVE_STATUS = 'pronixclub_status';
const CHAVE_VISTOS = 'pronixclub_vistos';
const CHAVE_LEADS = 'pronixclub_leads';
const NTFY = () => (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
const FUNIL = () => new RegExp(process.env.PRONIX_CLUB_FUNIL || 'pronix ?club');
const MAX_POR_RODADA = 10;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idDe = (d) => String((d && (d.id || d._id)) || '');

/** "5511987654321" ou "(11) 98765-4321" -> { bonito: "(11) 98765-4321", whatsapp: "5511987654321" }. */
function telefoneDe(bruto) {
  let d = String(bruto || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return { bonito: `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`, whatsapp: '55' + d };
  if (d.length === 10) return { bonito: `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`, whatsapp: '55' + d };
  return { bonito: d, whatsapp: d.length >= 10 ? d : '' };
}

async function config() {
  return db.getJson(CHAVE_CONFIG, null);
}

/** Liga o aviso (cria tópico e segredo na primeira vez). Só avisa os leads que entrarem DEPOIS de ligar. */
async function ativar() {
  const atual = (await config()) || {};
  const cfg = {
    topico: atual.topico || 'pronix-club-' + crypto.randomBytes(9).toString('hex'),
    segredo: atual.segredo || crypto.randomBytes(18).toString('hex'),
    ativo: true,
    desde: atual.ativo && atual.desde ? atual.desde : new Date().toISOString(),
  };
  await db.setJson(CHAVE_CONFIG, cfg);
  return cfg;
}

async function desativar() {
  const atual = await config();
  if (!atual) return null;
  const cfg = { ...atual, ativo: false };
  await db.setJson(CHAVE_CONFIG, cfg);
  return cfg;
}

async function status() {
  return db.getJson(CHAVE_STATUS, {});
}

/** Os últimos leads avisados (do mais novo para o mais antigo), para a aba do dashboard. */
async function leads() {
  const lista = await db.range(CHAVE_LEADS).catch(() => []);
  const vistos = new Set(); // se o push falhou e a rodada repetiu, o lead foi guardado duas vezes: fica o mais novo
  return lista.slice().reverse().filter((l) => l && !vistos.has(l.id) && vistos.add(l.id));
}

/** Push no ntfy, sem dado do lead. Lança se o ntfy recusar. */
async function enviarPush(topico, { titulo, mensagem, link, prioridade = 5 }) {
  const corpo = { topic: topico, title: titulo, message: mensagem, priority: prioridade, tags: ['moneybag'] };
  if (link) {
    corpo.click = link;
    corpo.actions = [{ action: 'view', label: 'Ver o lead', url: link, clear: true }];
  }
  const r = await fetch(NTFY(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`O ntfy recusou o aviso (${r.status}).`);
}

/** Notificação de teste (botão do dashboard). */
async function testar({ link } = {}) {
  const cfg = await config();
  if (!cfg || !cfg.topico) throw new Error('Ligue o aviso primeiro.');
  await enviarPush(cfg.topico, { titulo: 'Teste: aviso do Pronix Club', mensagem: 'Se chegou, está tudo certo. Cada lead novo no funil vai avisar assim.', link, prioridade: 4 });
}

/** O telefone do contato do card: do próprio card ou do detalhe do contato. */
async function telefoneDoCard(d) {
  const c = (d.contacts || [])[0] || {};
  const direto = ((c.phones || [])[0] || {}).phone;
  if (direto) return String(direto);
  const id = idDe(c);
  if (!id) return '';
  const r = await crm.rd(`/contacts/${encodeURIComponent(id)}`, {}, { timeoutMs: 8000 }).catch(() => null);
  const ct = r && (r.contact || r);
  return String((((ct && ct.phones) || [])[0] || {}).phone || '');
}

/**
 * Quando o card entrou no funil (ms): o começo da última sequência de etapas do funil no histórico de etapas.
 * Card criado direto no funil: a criação. Movido de outro funil: o dia em que chegou aqui.
 */
function entradaNoFunil(deal, funil) {
  const ids = new Set((funil.etapas || []).map((e) => String(e.id)));
  const hist = (Array.isArray(deal.deal_stage_histories) ? deal.deal_stage_histories : [])
    .map((h) => {
      const v = h && (h.deal_stage_id || h.deal_stage);
      return { id: v && typeof v === 'object' ? idDe(v) : String(v || ''), t: Date.parse((h && h.start_date) || '') };
    })
    .filter((h) => h.id && Number.isFinite(h.t))
    .sort((a, b) => a.t - b.t);
  let entrada = 0;
  for (const h of hist) {
    if (ids.has(h.id)) { if (!entrada) entrada = h.t; } else entrada = 0;
  }
  return entrada || Date.parse(deal.created_at) || 0;
}

/** O segredo da URL confere? (comparação de tempo constante) */
async function segredoConfere(segredo) {
  const cfg = await config();
  if (!cfg || !cfg.segredo) return false;
  // copiar e colar às vezes traz espaço, ponto ou quebra de linha junto: o segredo é só hexadecimal
  const a = Buffer.from(String(segredo || '').replace(/[^0-9a-f]/gi, '').toLowerCase());
  const b = Buffer.from(cfg.segredo);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Uma rodada: os cards novos do funil viram um push. Trava de 50 s para o agendador e o webhook não avisarem duas vezes.
 * @param {{ agora?: Date, link?: string }} p  link = a aba Pronix Club do dashboard
 * @returns {Promise<{ok: boolean, motivo?: string, novos?: number, avisados?: number}>}
 */
async function verificar({ agora = new Date(), link } = {}) {
  const cfg = await config();
  if (!cfg || !cfg.ativo) return { ok: false, motivo: 'desligado' };
  if (!crm.configurado()) return { ok: false, motivo: 'O CRM não está configurado no servidor.' };
  if (!(await db.travar('pronixclub_trava', 50).catch(() => false))) return { ok: true, motivo: 'outra rodada em andamento', novos: 0, avisados: 0 };
  const registro = { ultimaVerificacao: agora.toISOString() };
  try {
    const funil = (await crm.funis()).find((f) => FUNIL().test(norm(f.nome)));
    if (!funil) throw new Error('Não achei o funil "Pronix Club" no CRM.');
    const hoje = stats.emDiaLocal(agora.toISOString());
    const ontem = stats.emDiaLocal(new Date(agora.getTime() - 24 * 3600 * 1000).toISOString());
    // Os cards do funil mexidos de ontem para cá: criar o card ou movê-lo de outro funil para cá muda o updated_at.
    const deals = (await crm.listarNegociacoes(
      { deal_pipeline_id: funil.id, updated_at_period: 'true', start_date: crm.instanteDoDia(ontem), end_date: crm.instanteDoDia(hoje, true) },
      { maxPaginas: 3, timeoutMs: 20000 }
    )).filter((d) => idDe(d) && (!d.deal_pipeline || !idDe(d.deal_pipeline) || idDe(d.deal_pipeline) === funil.id));
    const desde = Date.parse(cfg.desde) || 0;
    const vistos = new Set(await db.getJson(CHAVE_VISTOS, []));
    const naoVistos = deals.filter((d) => !vistos.has(idDe(d)));
    // não mexido desde que o aviso foi ligado: já estava no funil antes (não avisa)
    const antigos = naoVistos.filter((d) => Math.max(Date.parse(d.updated_at) || 0, Date.parse(d.created_at) || 0) < desde);
    antigos.forEach((d) => vistos.add(idDe(d)));
    // os outros: quando ENTROU no funil, pelo histórico de etapas (o lead movido de outro funil foi criado antes)
    const candidatos = naoVistos.filter((d) => !antigos.includes(d));
    const detalhes = candidatos.length ? await crm.detalhesDe(candidatos, { prazoMs: 25000 }).catch(() => []) : [];
    const porId = new Map(detalhes.map((d) => [idDe(d), d]));
    const entrou = (d) => entradaNoFunil(porId.get(idDe(d)) || d, funil);
    const novos = [];
    for (const d of candidatos) {
      if (!porId.has(idDe(d)) && !(Date.parse(d.created_at) >= desde)) continue; // sem o detalhe agora: tenta na próxima
      if (entrou(d) >= desde) novos.push({ ...d, ...(porId.get(idDe(d)) || {}), _entrou: entrou(d) });
      else vistos.add(idDe(d)); // já estava no funil antes de ligar o aviso
    }
    novos.sort((a, b) => a._entrou - b._entrou).splice(MAX_POR_RODADA);
    registro.noFunilMexidos = deals.length;
    // primeiro guarda os leads (nome e telefone ficam no nosso banco), depois um push só, sem dado do lead
    for (const d of novos) {
      const tel = telefoneDe(await telefoneDoCard(d));
      await db.push(CHAVE_LEADS, {
        id: idDe(d),
        nome: leadDoCard(d) || 'Lead',
        telefone: tel.bonito,
        whatsapp: tel.whatsapp,
        etapa: (d.deal_stage && d.deal_stage.name) || '',
        criadoEm: d._entrou ? new Date(d._entrou).toISOString() : d.created_at || '',
        avisadoEm: agora.toISOString(),
      }, 100);
    }
    if (novos.length) {
      await enviarPush(cfg.topico, {
        titulo: novos.length === 1 ? 'Novo lead no Pronix Club' : `${novos.length} leads novos no Pronix Club`,
        mensagem: 'Toque para ver o nome, o telefone e chamar no WhatsApp.',
        link,
      });
    }
    novos.forEach((d) => vistos.add(idDe(d)));
    await db.setJson(CHAVE_VISTOS, [...vistos].slice(-1000));
    Object.assign(registro, { ultimoErro: '', ultimosNovos: novos.length });
    if (novos.length) registro.ultimoAviso = agora.toISOString();
    return { ok: true, novos: novos.length, avisados: novos.length };
  } catch (err) {
    registro.ultimoErro = err.message;
    return { ok: false, motivo: err.message };
  } finally {
    await db.setJson(CHAVE_STATUS, { ...(await status().catch(() => ({}))), ...registro }).catch(() => {});
    await db.destravar('pronixclub_trava').catch(() => {});
  }
}

module.exports = { ativar, desativar, config, status, leads, testar, verificar, segredoConfere, telefoneDe };
