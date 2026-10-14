'use strict';

// Linha do tempo do contato, tirada das DATAS das mensagens (sem IA), para o report de handoff:
//  - "Conversando com o lead desde 23/09 (21 dias)": quando o primeiro contato tem mais de 7 dias;
//  - "Confirmado desde quarta-feira (08/10)": quando o lead confirmou a reunião num dia ANTERIOR ao do
//    report (vale até a véspera); "· reconfirmado no dia (sábado, 11/10)" quando ele confirmou de novo no
//    dia do report.
// O que conta como confirmação: o lead escrever que confirma ("confirmado", "confirmo", "estarei lá"…),
// ou responder que sim ("sim", "ok", "combinado"…) logo depois de o pré-vendedor pedir a confirmação.
// Remarcou depois de confirmar: vale a confirmação que veio depois da remarcação.
// Sem data nas mensagens (conversa colada como texto), não diz nada.

const TZ = process.env.TZ_RELATORIO || 'America/Sao_Paulo';
const MAIS_DE_DIAS = 7;
const JANELA_DA_RESPOSTA_MS = 48 * 3600000;

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const diaLocal = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); // AAAA-MM-DD
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const dataBr = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
const diaDaSemana = (dia) => new Date(dia + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });

const CONFIRMA = /\b(confirmad[oa]s?|confirmadissim[oa]|confirmo|confirmei|confirmando|presenca confirmada|estarei (la|presente|sim|na reuniao|na call|no horario)|vou estar (la|presente|sim)|estaremos (la|presentes))\b/;
const NEGA = /\b(nao|n|desmarc\w*|remarc\w*|reagend\w*|cancel\w*|adiar|imprevisto)\b/;
const AFIRMA = /^(sim|s|ss|sim sim|ok|okay|okk|certo|certinho|beleza|blz|combinado|fechado|perfeito|pode ser|claro|com certeza|ta|ta bom|ta certo|show|top|pode|isso|positivo|confirmado|confirmo|👍|✅|🙏)(\s*[!.,]*\s*(👍|✅|🙏|😊|🙂))*[!.\s]*$/u;
const MUDOU = /\b(remarc\w*|reagend\w*|desmarc\w*|outro horario|outro dia|mudar o horario|adiar)\b/;

/**
 * @param {{from: 'eu'|'eles', content: string, timestamp?: string}[]} mensagens
 * @param {{agora?: number}} opcoes
 * @returns {{desde: string, dias: number, hoje: string, confirmadoEm: string, reconfirmadoNoDia: boolean} | null}
 */
function linhaDoTempo(mensagens, { agora = Date.now() } = {}) {
  const comData = (Array.isArray(mensagens) ? mensagens : [])
    .map((m) => ({ from: m && m.from === 'eu' ? 'eu' : 'eles', texto: normalizar(m && m.content), ms: Date.parse((m && m.timestamp) || '') }))
    .filter((m) => Number.isFinite(m.ms) && m.ms <= agora + 3600000)
    .sort((a, b) => a.ms - b.ms);
  if (!comData.length) return null;
  const hoje = diaLocal(agora);
  const desde = diaLocal(comData[0].ms);

  let confirmacoes = [];
  let pedido = null; // a última mensagem do pré-vendedor que pediu a confirmação
  for (const m of comData) {
    if (!m.texto) continue;
    // Remarcou (qualquer lado): a confirmação de antes não vale mais.
    if (MUDOU.test(m.texto)) confirmacoes = [];
    if (m.from === 'eu') {
      if (/confirm/.test(m.texto)) pedido = m;
      continue;
    }
    const escreveu = CONFIRMA.test(m.texto) && !NEGA.test(m.texto);
    const respondeu = AFIRMA.test(m.texto) && pedido && m.ms - pedido.ms <= JANELA_DA_RESPOSTA_MS;
    if (escreveu || respondeu) confirmacoes.push(diaLocal(m.ms));
  }
  const antes = confirmacoes.filter((d) => d < hoje);
  return {
    desde,
    dias: diasEntre(desde, hoje),
    hoje,
    confirmadoEm: antes.length ? antes[0] : '',
    reconfirmadoNoDia: antes.length > 0 && confirmacoes.includes(hoje),
  };
}

/** As linhas do resumo do report: [{ rotulo, valor }] (vazio quando não há o que dizer). */
function linhasDoResumo(lt) {
  if (!lt) return [];
  const linhas = [];
  if (lt.dias > MAIS_DE_DIAS) linhas.push({ rotulo: 'Contato', valor: `Conversando com o lead desde ${dataBr(lt.desde)} (${lt.dias} dias)` });
  if (lt.confirmadoEm) {
    const ha = diasEntre(lt.confirmadoEm, lt.hoje);
    const quando = ha <= 6 ? `${diaDaSemana(lt.confirmadoEm)} (${dataBr(lt.confirmadoEm)})` : dataBr(lt.confirmadoEm);
    linhas.push({
      rotulo: 'Confirmação',
      valor: `Confirmado desde ${quando}` + (lt.reconfirmadoNoDia ? ` · reconfirmado no dia (${diaDaSemana(lt.hoje)}, ${dataBr(lt.hoje)})` : ''),
    });
  }
  return linhas;
}

/** Põe as linhas no começo do resumo do report (sem repetir um rótulo que a IA já tenha usado). */
function aplicarNoReport(dados, mensagens, opcoes) {
  const linhas = linhasDoResumo(linhaDoTempo(mensagens, opcoes));
  if (!linhas.length || !dados) return dados;
  const atuais = Array.isArray(dados.resumo) ? dados.resumo : [];
  const ja = new Set(atuais.map((r) => normalizar(r && r.rotulo)));
  dados.resumo = linhas.filter((l) => !ja.has(normalizar(l.rotulo))).concat(atuais);
  return dados;
}

module.exports = { linhaDoTempo, linhasDoResumo, aplicarNoReport, MAIS_DE_DIAS };
