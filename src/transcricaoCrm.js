'use strict';

// A conversa do WhatsApp (com os áudios já transcritos) vai para o card do lead no PronixCRM a cada report:
// POST /deals/:id/whatsapp_transcripts. Sem custo de IA — é o que a extensão já leu para o report. Falha aqui nunca
// derruba o report. external_id é a impressão digital do texto: a mesma conversa mandada de novo não duplica no CRM.
// Desliga com CRM_TRANSCRICAO=0.

const crypto = require('crypto');
const crm = require('./crm');
const db = require('./db');

const TZ = process.env.TZ_RELATORIO || 'America/Sao_Paulo';
const MAX_CARACTERES = 200000; // o limite do CRM
const ligado = () => !/^(0|false|nao|não|off)$/i.test(String(process.env.CRM_TRANSCRICAO || '').trim());

const quando = (iso) => {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
};

/**
 * A conversa em texto, uma mensagem por linha: "[21/10/2026 14:05] Cauã Lima: oi" / "[…] Lead: (áudio) …".
 * Mensagem sem data fica sem o colchete. Passou de 200 mil caracteres: fica o fim (o mais recente), com aviso.
 */
function textoDaConversa(mensagens, { sdr = '', lead = '' } = {}) {
  const eu = String(sdr || '').trim() || 'Pré-vendedor';
  const ele = String(lead || '').trim() || 'Lead';
  const linhas = [];
  for (const m of Array.isArray(mensagens) ? mensagens : []) {
    if (!m || typeof m !== 'object') continue;
    const conteudo = String(m.content || '').replace(/\r\n?/g, '\n').trim();
    if (!conteudo) continue;
    const audio = m.type === 'audio';
    if (audio && /^\[áudio/i.test(conteudo)) {
      linhas.push(`${quando(m.timestamp) ? `[${quando(m.timestamp)}] ` : ''}${m.from === 'eu' ? eu : ele}: (áudio sem transcrição)`);
      continue;
    }
    const data = quando(m.timestamp);
    linhas.push(`${data ? `[${data}] ` : ''}${m.from === 'eu' ? eu : ele}: ${audio ? '(áudio) ' : ''}${conteudo}`);
  }
  let texto = linhas.join('\n');
  if (texto.length > MAX_CARACTERES) {
    const aviso = '(início da conversa cortado: passou de 200 mil caracteres)\n';
    texto = aviso + texto.slice(texto.length - (MAX_CARACTERES - aviso.length));
  }
  return texto;
}

/** A 1ª e a última data das mensagens (ISO), para started_at / ended_at. */
function periodo(mensagens) {
  const datas = (Array.isArray(mensagens) ? mensagens : []).map((m) => Date.parse((m && m.timestamp) || '')).filter(Number.isFinite);
  if (!datas.length) return {};
  return { started_at: new Date(Math.min(...datas)).toISOString(), ended_at: new Date(Math.max(...datas)).toISOString() };
}

const ID_OK = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Manda a transcrição para o card. Nunca lança: devolve { enviada, motivo?, erro? } (e guarda num registro curto
 * para conferência: crm_transcricoes, os últimos 500, sem o texto da conversa).
 * @param {{ dealId: string, mensagens: object[], sdr?: string, lead?: string, telefone?: string, reportId?: string }} p
 */
async function enviar({ dealId, mensagens, sdr, lead, telefone, reportId } = {}) {
  const r = await (async () => {
    if (!ligado()) return { enviada: false, motivo: 'desligada' };
    if (!crm.configurado() || !crm.ehPronix()) return { enviada: false, motivo: 'sem-pronixcrm' };
    if (!ID_OK.test(String(dealId || ''))) return { enviada: false, motivo: 'sem-card' };
    const transcript = textoDaConversa(mensagens, { sdr, lead });
    if (!transcript) return { enviada: false, motivo: 'conversa-vazia' };
    const externalId = 'wa-' + crypto.createHash('sha256').update(`${dealId}\n${transcript}`).digest('hex').slice(0, 32);
    const tel = String(telefone || '').replace(/\D/g, '');
    const corpo = { transcript, external_id: externalId, ...periodo(mensagens), ...(tel.length >= 10 ? { phone: tel } : {}) };
    try {
      await crm.rd(`/deals/${encodeURIComponent(dealId)}/whatsapp_transcripts`, {}, { metodo: 'POST', corpo });
      return { enviada: true, externalId, caracteres: transcript.length };
    } catch (e) {
      return { enviada: false, motivo: 'erro', erro: String((e && e.message) || e).slice(0, 200) };
    }
  })();
  await db
    .push('crm_transcricoes', { quando: new Date().toISOString(), reportId: reportId || '', dealId: String(dealId || ''), ...r }, 500)
    .catch(() => {});
  return r;
}

module.exports = { enviar, textoDaConversa, periodo, MAX_CARACTERES };
