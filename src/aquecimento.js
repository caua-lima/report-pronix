'use strict';

// Cache do prompt do report sempre quente nas pausas curtas do dia.
//
// O report manda à Anthropic um prefixo grande e fixo (ferramenta + regras + playbook + exemplos). Com o
// cache de 1h, esse prefixo custa 0,1x quando é relido e 2x quando precisa ser escrito de novo — e ele
// expira 1h depois do último uso. Report depois de uma pausa de 1h a 3h paga a reescrita inteira, que é a
// maior parte do custo dele. Aqui, enquanto houve report nas últimas 2h, uma batida a cada ~55min relê o
// prefixo (custo de leitura, ~20x menor que a reescrita) e renova a validade. Nada no report muda: é o
// mesmo prompt, a mesma IA, só deixa de pagar a escrita de novo.
//
// Quem bate é a extensão (alarme marcado depois de cada report), porque o cron gratuito da Vercel é diário.
// O servidor decide se vale: só renova perto de expirar, nunca depois de expirado (aí a batida pagaria a
// escrita sem garantia de report) e para quando o último report ficou para trás.

const db = require('./db');
const report = require('./report');
const stats = require('./stats');

const MIN = 60 * 1000;
const CHAVE = 'cache_prompt_report';
const VALIDADE_MIN = 60; // TTL do cache (ttl: '1h' em src/report.js)
const RENOVAR_APOS_MIN = 50; // antes disso o cache ainda está novo: não gasta
const FOLGA_MIN = 2; // perto demais do fim, a batida pode chegar com o cache já vencido
const alvoMin = () => Number(process.env.AQUECER_A_CADA_MIN) || 55;
const janelaMin = () => Number(process.env.AQUECER_JANELA_MIN) || 120;
const ligado = () => process.env.AQUECER_CACHE !== 'nao' && (process.env.LLM_PROVIDER || 'anthropic').toLowerCase() === 'anthropic';

async function estado() {
  const s = await db.getJson(CHAVE, null).catch(() => null);
  return s && typeof s === 'object' ? s : {};
}

/** Report gerado com o prompt padrão: o cache acabou de ser usado (e escrito, se tinha vencido). */
async function marcarReport(agora = Date.now()) {
  const em = new Date(agora).toISOString();
  await db.setJson(CHAVE, { ...(await estado()), report: em, uso: em });
}

/**
 * Batida da extensão. Devolve { feito, motivo, proximoEmMs } — proximoEmMs null = não precisa bater mais.
 * @param {{agora?: number, usuarioNome?: string}} opcoes
 */
async function aquecer({ agora = Date.now(), usuarioNome = '' } = {}) {
  if (!ligado()) return { feito: false, motivo: 'desligado', proximoEmMs: null };
  const s = await estado();
  const ultimoReport = Date.parse(s.report || '');
  const ultimoUso = Math.max(ultimoReport || 0, Date.parse(s.uso || '') || 0);
  if (!ultimoReport) return { feito: false, motivo: 'sem-report', proximoEmMs: null };
  if (agora - ultimoReport > janelaMin() * MIN) return { feito: false, motivo: 'parado', proximoEmMs: null };
  const idade = agora - ultimoUso;
  if (idade < RENOVAR_APOS_MIN * MIN) {
    // Outro report (ou outra batida) renovou há pouco: volta perto do fim da validade.
    return { feito: false, motivo: 'recente', proximoEmMs: Math.max(MIN, alvoMin() * MIN - idade) };
  }
  if (idade >= (VALIDADE_MIN - FOLGA_MIN) * MIN) return { feito: false, motivo: 'expirado', proximoEmMs: null };

  if (!(await db.travar('aquecer_cache', 90))) return { feito: false, motivo: 'em-andamento', proximoEmMs: alvoMin() * MIN };
  try {
    const uso = await report.aquecerCache();
    await db.setJson(CHAVE, { ...s, uso: new Date(agora).toISOString() });
    if (uso) await stats.registrarAquecimento({ usuarioNome, uso }).catch((e) => console.error('[aquecimento] registro:', e.message));
    // Ainda dentro da janela do último report? Marca a próxima batida.
    const resta = janelaMin() * MIN - (agora - ultimoReport);
    return { feito: true, motivo: 'renovado', proximoEmMs: resta > alvoMin() * MIN ? alvoMin() * MIN : null, uso };
  } finally {
    await db.destravar('aquecer_cache').catch(() => {});
  }
}

module.exports = { marcarReport, aquecer, CHAVE };
