'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const archiver = require('archiver');

const { dadosDireto, dadosDeTexto, PROMPT_VERSAO } = require('./src/report');
const { gerarPdfBuffer } = require('./src/generatePdf');
const { transcribeBuffer } = require('./src/transcribe');
const { lerImagemGroq } = require('./src/groq');
const { normalizarConversa, normalizarTextoLivre } = require('./src/conversation-normalizer');
const { calcularReportKey } = require('./src/idempotencia');
const { custoUSD } = require('./src/precos');
const usuarios = require('./src/usuarios');
const closers = require('./src/closers');
const stats = require('./src/stats');
const pdfStorage = require('./src/pdfStorage');
const db = require('./src/db');
const base = require('./src/base');
const diario = require('./src/diario');
const crm = require('./src/crm');
const leads = require('./src/leads');
const agendaGoogle = require('./src/agendaGoogle');
const closerAuto = require('./src/closerAuto');
const vendasRd = require('./src/vendasRd');
const { gerarResumoRapido } = require('./src/resumoRapido');
const coachIa = require('./src/coach');
const inteligencia = require('./src/inteligencia');
const afinidadeIa = require('./src/afinidade');
const casosDoCloser = require('./src/casos');
const transcricoes = require('./src/transcricoes');
const driveGoogle = require('./src/driveGoogle');
const limpezaRd = require('./src/limpezaRd');
const diagnostico = require('./src/diagnostico');
const { gerarAfinidadePdfBuffer, nomeDoArquivo: nomeDoArquivoAfinidade } = require('./src/afinidadePdf');
const { textoDoPdf } = require('./src/textoDoPdf');
const importarReports = require('./src/importarReports');
const reportDoDia = require('./src/reportDoDia');
const vendasDoRd = require('./src/vendasDoRd');
const aprendizado = require('./src/aprendizado');
const { normalizarConsciencia } = require('./src/consciencia');
const { normalizarDores } = require('./src/dores');

const QUALIDADES_VALIDAS = new Set(['eco', 'standard', 'premium']);
const qualidadeValida = (q) => (QUALIDADES_VALIDAS.has(q) ? q : 'standard');

const app = express();
const PORT = process.env.PORT || 3000;

// Conversas longas + áudio em base64 geram payloads grandes.
app.use(express.json({ limit: '25mb' }));

// CORS — a extensão (chrome-extension://) chama este servidor.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-cr-key, x-admin-pass');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  // A extensão lê o nome do .zip e quantos reports foram nele.
  res.header('Access-Control-Expose-Headers', 'Content-Disposition, X-Reports-No-Zip, X-Reports-Sem-Pdf');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

/** Exige a chave do SDR (header x-cr-key ou ?chave=). Popula req.usuario. */
async function auth(req, res, next) {
  try {
    const chave = req.get('x-cr-key') || req.query.chave;
    const u = await usuarios.porChave(chave && String(chave).trim());
    if (!u) {
      return res.status(401).json({
        erro: 'Chave inválida ou ausente. Peça sua chave ao admin e cole no popup da extensão.',
      });
    }
    req.usuario = u;
    next();
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

/**
 * Exige admin: a chave de um usuário com papel admin ou, como reserva, a
 * ADMIN_PASSWORD (é ela que permite criar o primeiro admin).
 */
async function admin(req, res, next) {
  try {
    const chave = req.get('x-cr-key') || req.query.chave;
    if (chave) {
      const u = await usuarios.porChave(String(chave).trim());
      if (usuarios.ehAdmin(u)) { // admin ou gestor
        req.usuario = u;
        return next();
      }
    }
    const esperada = process.env.ADMIN_PASSWORD;
    const senha = req.get('x-admin-pass') || (req.body && req.body.senha) || req.query.senha;
    if (esperada && senha === esperada) return next();
    res.status(401).json({ erro: 'Acesso de admin necessário.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

/**
 * Exige MASTER: só o master (ou a ADMIN_PASSWORD, que é o reserva e cria o primeiro master)
 * cria, edita e remove usuários. O gestor vê e faz tudo o mais.
 */
async function master(req, res, next) {
  try {
    const chave = req.get('x-cr-key') || req.query.chave;
    if (chave) {
      const u = await usuarios.porChave(String(chave).trim());
      if (usuarios.ehMaster(u)) {
        req.usuario = u;
        return next();
      }
    }
    const esperada = process.env.ADMIN_PASSWORD;
    const senha = req.get('x-admin-pass') || (req.body && req.body.senha) || req.query.senha;
    if (esperada && senha === esperada) return next();
    res.status(403).json({ erro: 'Só o master pode criar, editar ou remover usuários.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

/**
 * Exige uma das abas liberadas para a chave (aba Acessos do painel) ou, como reserva, a ADMIN_PASSWORD.
 * É o que deixa o master escolher, pessoa por pessoa, quem abre cada parte do painel.
 */
const acesso = (abas, { status = 401, erro = 'Acesso de admin necessário.' } = {}) => async (req, res, next) => {
  try {
    const chave = req.get('x-cr-key') || req.query.chave;
    if (chave) {
      const u = await usuarios.porChave(String(chave).trim());
      if (u && abas.some((a) => usuarios.podeAba(u, a))) {
        req.usuario = u;
        return next();
      }
    }
    const esperada = process.env.ADMIN_PASSWORD;
    const senha = req.get('x-admin-pass') || (req.body && req.body.senha) || req.query.senha;
    if (esperada && senha === esperada) return next();
    res.status(status).json({ erro });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};
const SO_MASTER_ERRO = { status: 403, erro: 'Esta parte do painel não está liberada para você.' };

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------
const dashboard = (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));

// Tudo cai no dashboard: as abas de dentro fazem o resto.
app.get('/', dashboard);
app.get('/manual', dashboard);
app.get('/admin', dashboard);
app.get('/dia', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dia.html')));

// Política de privacidade — exigida pela Chrome Web Store; URL fixa e pública.
app.get('/privacidade', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'privacidade.html'))
);

// Status é público (serve para o botão "Testar" da extensão).
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, provider: process.env.LLM_PROVIDER || 'anthropic' });
});

/** Quem sou eu (valida a chave e devolve nome e papel). */
app.get('/api/eu', auth, async (req, res) => {
  // Closers com análise de afinidade: é daqui que o popup tira o botão "Analisar Match com …".
  const analises = await closers.comAnalise().catch(() => []);
  // Só para o master: quem ainda não tem inteligência cadastrada (o popup explica por que o botão não aparece).
  // Se ele mesmo desligou a análise de alguém, não há o que explicar: o popup fica sem botão e sem aviso.
  const explicar = usuarios.ehMaster(req.usuario) && !(await closers.temDesligada().catch(() => false));
  const analisesFaltando = explicar ? await closers.semAnalise().catch(() => []) : undefined;
  res.json({
    ok: true, nome: req.usuario.nome, id: req.usuario.id, papel: req.usuario.papel,
    // O que o master liberou para esta chave (a extensão mostra no popup).
    coach: Boolean(req.usuario.coach), fichaCrm: Boolean(req.usuario.fichaCrm), automacao: Boolean(req.usuario.automacao),
    abas: usuarios.abasDe(req.usuario), // abas do painel liberadas para esta chave
    etiquetas: Boolean(req.usuario.etiquetas),
    analises,
    analisesFaltando,
  });
});

// ---------------------------------------------------------------------------
// Admin: criar/listar/remover acessos da equipe
// ---------------------------------------------------------------------------
app.post('/api/admin/login', admin, (_req, res) => res.json({ ok: true }));

app.get('/api/admin/usuarios', master, async (_req, res) => {
  try {
    res.json({ usuarios: (await usuarios.listar()).map((u) => ({ ...u, abas: Object.fromEntries(usuarios.ABAS.map((a) => [a, usuarios.podeAba(u, a)])) })), abas: usuarios.ABAS });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/usuarios', master, async (req, res) => {
  try {
    const u = await usuarios.criar(req.body && req.body.nome, req.body && req.body.papel);
    res.json({ ok: true, usuario: u });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.patch('/api/admin/usuarios/:id', master, async (req, res) => {
  try {
    const corpo = req.body || {};
    let ok;
    if (typeof corpo.fichaCrm === 'boolean') ok = await usuarios.definirFichaCrm(req.params.id, corpo.fichaCrm);
    else if (typeof corpo.coach === 'boolean') ok = await usuarios.definirCoach(req.params.id, corpo.coach);
    else if (typeof corpo.automacao === 'boolean') ok = await usuarios.definirAutomacao(req.params.id, corpo.automacao);
    else if (typeof corpo.etiquetas === 'boolean') ok = await usuarios.definirEtiquetas(req.params.id, corpo.etiquetas);
    else if (typeof corpo.corAgenda === 'string') ok = await usuarios.definirCorAgenda(req.params.id, corpo.corAgenda);
    else if (typeof corpo.aba === 'string') ok = await usuarios.definirAba(req.params.id, corpo.aba, corpo.liberada === true);
    else ok = await usuarios.definirPapel(req.params.id, String(corpo.papel || ''));
    if (!ok) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.delete('/api/admin/usuarios/:id', master, async (req, res) => {
  try {
    await usuarios.remover(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(/único master/.test(err.message) ? 400 : 500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Closers: quem conduz a reunião. O SDR escolhe o closer de cada report na própria extensão;
// só o master adiciona e remove da lista.
// ---------------------------------------------------------------------------
/** Sugestão de closer para um perfil de lead, com base no histórico de resultados (sem IA). */
async function sugestaoDeCloser(perfil, usuarioId) {
  const lista = await closers.listar();
  if (!lista.length) return { closers: [], sugestao: null, motivo: '' };
  const s = inteligencia.sugerirCloser(await reportsDoEscopo(usuarioId), perfil, lista);
  return { closers: lista.map((c) => ({ id: c.id, nome: c.nome })), sugestao: s.sugestao, motivo: s.motivo };
}

/**
 * Reports que entram em "Resultados da reunião" e na inteligência. Por enquanto o master levanta os
 * dados só com os leads DELE: com usuarioId, ficam só os reports desse usuário; sem (escopo "todos"
 * ou entrada pela senha reserva), a equipe inteira.
 */
async function reportsDoEscopo(usuarioId, filtro) {
  const todos = await stats.listar(filtro);
  return usuarioId ? todos.filter((r) => r.usuarioId === usuarioId) : todos;
}
// "Toda a equipe" só para master e gestor: quem recebeu a aba Resultados como usuário vê só os próprios reports.
// Master e gestor também podem olhar os de UMA pessoa (escopo = id dela), para conferir o que ela preencheu.
const donoDoEscopo = (req) => {
  const escopo = String(req.query.escopo || '');
  if (!req.usuario) return null;
  if (!usuarios.ehAdmin(req.usuario)) return req.usuario.id;
  if (escopo === 'todos') return null;
  return /^[a-f0-9]{6,32}$/i.test(escopo) ? escopo : req.usuario.id;
};

/**
 * Leva para os reports o desfecho que os closers registraram no RD (vendido / não comprou, com o motivo).
 * Roda sozinho no máximo a cada 30 min: quando alguém abre a aba Resultados, de hora em hora pela
 * extensão (enquanto o Chrome está aberto) e uma vez por dia pelo agendador da Vercel — a perda pode
 * vir semanas depois, sem ninguém abrir a conversa. Para não gastar consulta à toa, report recente
 * conferido há menos de 50 min e report antigo conferido há menos de 20 h ficam para a próxima.
 */
async function conferirDesfechosNoRd({ porVez } = {}) {
  if (!crm.configurado() || !(await db.travar('rd-desfechos', 1800))) return null;
  const r = await vendasRd.sincronizar(await stats.listar({}), { porVez, minutosQuente: 50, horasFrio: 20 });
  // Quando rodou por último: o diagnóstico mostra, para dar para ver se a batida de hora em hora está chegando.
  await db.setJson('rd_ultima_rodada', { em: new Date().toISOString(), ...r }).catch(() => {});
  return r;
}

/**
 * Transcrições novas das calls, lidas da pasta de cada closer no Drive: no máximo uma rodada a cada 45 min
 * e dois documentos por closer (é o que cabe na IA gratuita e no tempo do servidor). null = nada a fazer agora.
 */
async function lerTranscricoesNovas() {
  if (!(await closers.listar()).some((c) => c.drivePasta && !c.analiseDesligada)) return null;
  if (!(await db.travar('drive-transcricoes', 2700))) return null;
  return transcricoes.sincronizarTodos({ porVez: 2 });
}

/**
 * Batida de hora em hora da extensão: mantém venda, follow-up, perda e closer dos reports em dia com o
 * RD. Qualquer chave válida pode bater; a trava de 30 min vale para todos, então não acumula.
 */
app.post('/api/rd/atualizar', auth, async (_req, res) => {
  try {
    // As duas rodadas falam com serviços diferentes (RD e Google): vão juntas, para caber no tempo do servidor.
    const [r, lidas] = await Promise.all([
      conferirDesfechosNoRd({ porVez: 10 }),
      lerTranscricoesNovas().catch((err) => { console.error('Falha ao ler as transcrições do Drive:', err.message); return null; }),
    ]);
    const transc = lidas ? { transcricoes: { lidos: lidas.lidos, casos: lidas.casos } } : {};
    res.json(r ? { ok: true, ...r, ...transc } : { ok: true, emDia: true, ...transc });
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Report automático do dia: o que a extensão viu nas conversas (novos, respostas, recontatos), as
// desqualificações por motivo e o que o pré-vendedor digita; o texto sai pronto para mandar.
// ---------------------------------------------------------------------------
/** A extensão avisa o que viu numa conversa hoje (escrevi / já havia histórico / o lead escreveu). Só flags. */
app.post('/api/atividade', auth, async (req, res) => {
  try {
    if (!req.usuario.automacao) return res.status(403).json({ erro: 'Automação do cartão não liberada para este usuário.' });
    const { telefone, nome, eu, antes, eles, elesAntes } = req.body || {};
    const ok = await reportDoDia.registrarAtividade({
      usuarioId: req.usuario.id, telefone: String(telefone || '').slice(0, 30), nome: String(nome || '').slice(0, 80), eu, antes, eles, elesAntes,
    });
    res.json({ ok: true, registrado: ok });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/report-dia', auth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await reportDoDia.montar(req.usuario, req.query.dia)) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Guarda o que o pré-vendedor digitou no dia (automáticas, realizadas, agendas que caíram, no-show, observações). */
app.put('/api/report-dia', auth, async (req, res) => {
  try {
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body || {}).dia || '')) ? req.body.dia : undefined;
    const d = dia || stats.hojeStr();
    await reportDoDia.salvarManual(req.usuario.id, d, (req.body || {}).manual);
    res.json({ ok: true, ...(await reportDoDia.montar(req.usuario, d)) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Lista de closers (só id e nome) para quem gera report; com ?perfil= vem a sugestão. */
app.get('/api/closers', auth, async (req, res) => {
  try {
    res.json(await sugestaoDeCloser(String(req.query.perfil || ''), req.usuario.id));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** O SDR marca o closer do PRÓPRIO report (gestor/master marcam de qualquer um). */
app.post('/api/reports/:id/closer', auth, async (req, res) => {
  try {
    const r = await stats.buscarPorId(req.params.id);
    if (!r || (r.usuarioId !== req.usuario.id && !usuarios.ehAdmin(req.usuario))) {
      return res.status(404).json({ erro: 'Report não encontrado.' });
    }
    const id = String((req.body || {}).closerId || '');
    const closer = id ? await closers.porId(id) : null;
    if (id && !closer) return res.status(400).json({ erro: 'Closer não encontrado.' });
    await stats.atualizarResultado(r.id, {
      closerId: closer ? closer.id : '',
      closerNome: closer ? closer.nome : '',
      closerEmail: closer ? closer.email : '',
    });
    res.json({ ok: true, closerNome: closer ? closer.nome : '' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/**
 * "Analisar Match com o closer" — nota de 0 a 10 com os motivos, os pontos de atenção e como
 * conduzir a call, mais o PDF. Vem depois do report: a extensão manda o que o report levantou e a
 * conversa. IA gratuita (Groq) e PDF montado aqui: não entra no gasto.
 */
/**
 * A análise de match e o PDF dela. `entrada` = { closerId, reportId, dados, mensagens, nome, relato }:
 * do WhatsApp vêm a conversa e o report; de uma ligação, o texto do report de handoff (`relato`).
 */
async function responderMatch(req, res, { closerId, reportId, dados, mensagens, nome, relato }) {
  try {
    const closer = await closers.porId(String(closerId || ''));
    if (!closer) return res.status(404).json({ erro: 'Closer não encontrado.' });
    if (closer.analiseDesligada) {
      return res.status(403).json({ erro: `A análise do ${closers.apelidoDe(closer)} está desligada. Ligue em Closers, no painel.` });
    }
    // O histórico do closer é dele, não de quem gerou o report: master e gestor cruzam com a equipe toda.
    const reports = await reportsDoEscopo(usuarios.ehAdmin(req.usuario) ? null : req.usuario.id).catch(() => []);
    // Os casos das calls dele (transcrições importadas + reuniões com resultado) valem para todos: é o padrão do closer.
    const todos = usuarios.ehAdmin(req.usuario) ? reports : await stats.listar().catch(() => []);
    const casos = await casosDoCloser.doCloser(closer.id, todos).catch(() => []);
    const r = await afinidadeIa.analisar({ closer, dados, mensagens, nome, relato, reports, casos });
    const lead = String((dados && dados.lead) || nome || '').slice(0, 80);
    const buffer = await gerarAfinidadePdfBuffer({ afinidade: r.afinidade, lead, sdr: req.usuario.nome });
    // A nota fica no report (só no do próprio usuário, ou de qualquer um para master/gestor).
    if (reportId) {
      const rep = await stats.buscarPorId(String(reportId)).catch(() => null);
      if (rep && (rep.usuarioId === req.usuario.id || usuarios.ehAdmin(req.usuario))) {
        await stats.anotarAfinidade(rep.id, r.afinidade).catch((err) => console.error('Falha ao anotar a afinidade:', err.message));
      }
    }
    res.json({ ok: true, afinidade: r.afinidade, cache: r.cache, arquivo: nomeDoArquivoAfinidade(r.afinidade, lead), arquivoBase64: buffer.toString('base64') });
  } catch (err) {
    res.status(/inteligência cadastrada|Sem dados do lead/.test(err.message) ? 400 : 502).json({ erro: err.message });
  }
}

/**
 * O report mais recente DESTE usuário para este lead (pelo nome do contato), de até 30 dias: o que a análise de
 * match aproveita (perfil e nível de consciência) quando o botão é só a análise, sem gerar report de novo.
 */
async function reportRecenteDoLead(usuarioId, nome) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const alvo = norm(nome);
  if (!alvo) return null;
  const de = stats.emDiaLocal(new Date(Date.now() - 30 * 86400000).toISOString());
  const meus = (await stats.listar({ de })).filter((r) => r.usuarioId === usuarioId && (norm(r.contato) === alvo || norm(r.lead) === alvo));
  return meus.length ? meus[meus.length - 1] : null;
}

app.post('/api/afinidade', auth, async (req, res) => {
  let { closerId, reportId, dados, mensagens, nome } = req.body || {};
  // Só a análise (sem report novo): se este lead já tem report seu, usa o perfil e a consciência dele.
  if (!dados && nome) {
    const rep = await reportRecenteDoLead(req.usuario.id, nome).catch(() => null);
    if (rep) {
      dados = { lead: rep.lead || nome };
      if (rep.perfil) dados.perfil = { tipo: rep.perfilReal || rep.perfil, evidencia: rep.perfilEvidencia || '' };
      if (rep.consciencia) dados.consciencia = { nivel: rep.conscienciaReal || rep.consciencia, porque: rep.conscienciaPorque || '' };
      reportId = reportId || rep.id;
    }
  }
  return responderMatch(req, res, { closerId, reportId, dados, mensagens, nome });
});

/**
 * Match quando a conversa foi por LIGAÇÃO: não há conversa escrita, então a análise lê o PDF do handoff
 * (o que o próprio sistema gera) — ou o texto do report colado. O PDF não fica guardado.
 */
app.post('/api/afinidade/handoff', auth, (req, res) => {
  const { closerId, pdfBase64, texto, nome } = req.body || {};
  let relato = '';
  if (pdfBase64) {
    const buf = Buffer.from(String(pdfBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ erro: 'O PDF é grande demais (máximo 15 MB).' });
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ erro: 'Esse arquivo não é um PDF. Envie o PDF do handoff.' });
    relato = textoDoPdf(buf);
  } else {
    relato = String(texto || '');
  }
  relato = relato.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (relato.replace(/[^A-Za-zÀ-ÿ]/g, '').length < 120) {
    return res.status(400).json({
      erro: pdfBase64
        ? 'Não consegui ler o texto deste PDF (pode ser um PDF de imagem ou escaneado). Use o PDF do handoff gerado pelo Report PRONIX, ou cole o texto do report.'
        : 'Cole o texto do report de handoff (ou envie o PDF dele).',
    });
  }
  // O nome do lead vem do campo; sem ele, da linha "Lead:" do próprio report.
  const doTexto = (/^Lead:\s*(.+)$/m.exec(relato) || [])[1] || '';
  const lead = String(nome || doTexto || '').trim().slice(0, 80);
  return responderMatch(req, res, { closerId, dados: { lead }, nome: lead, relato });
});

// ---------------------------------------------------------------------------
// Master: resultados da reunião e inteligência (closer × perfil, prospecção que funciona)
// ---------------------------------------------------------------------------
app.get('/api/master/resultados', acesso(['resultados'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const filtro = filtroDaQuery(req.query);
    await conferirDesfechosNoRd({ porVez: 8 }).catch((err) => console.error('Falha ao conferir desfechos no RD:', err.message));
    // Do mesmo lead gerado mais de uma vez no dia, só o último (é o que foi para o closer).
    const linhas = diario
      .marcarUltimos(await reportsDoEscopo(donoDoEscopo(req), filtro))
      .filter((r) => r.usar)
      .reverse()
      .slice(0, 300)
      .map((r) => ({
        id: r.id, lead: r.lead, contato: r.contato, usuarioNome: r.usuarioNome, quando: r.quando, dia: r.dia,
        closerId: r.closerId || '', closerNome: r.closerNome || '', resultado: r.resultado || '', obsReuniao: r.obsReuniao || '',
        vendidoNoRd: Boolean(r.vendidoNoRd), encerradoPeloRd: Boolean(r.encerradoPeloRd),
        // O que a última conferência achou no RD (etapa, funil, responsável) e por onde o lead está vinculado.
        rdSituacao: r.rdSituacao || '', rdConferidoEm: r.rdConferidoEm || '', vinculado: Boolean(r.rdContatoId || r.telefone || r.leadEmail),
        produto: r.produto || '', ticket: Number(r.ticket) || 0, pagamento: r.pagamento || '',
        perfil: r.perfil || '', perfilReal: r.perfilReal || '', perfilEvidencia: r.perfilEvidencia || '',
        consciencia: r.consciencia || '', conscienciaReal: r.conscienciaReal || '', conscienciaPorque: r.conscienciaPorque || '',
        versao: Number(r.versao) || 0,
      }));
    res.json({ reports: linhas, closers: (await closers.listar()).map((c) => ({ id: c.id, nome: c.nome })) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/**
 * Agendador da Vercel (vercel.json → crons), uma vez por dia. Só aceita com o CRON_SECRET que a própria
 * Vercel envia no cabeçalho Authorization.
 */
app.get('/api/cron/rd', async (req, res) => {
  const segredo = String(process.env.CRON_SECRET || '').trim();
  if (!segredo || req.get('authorization') !== 'Bearer ' + segredo) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    await db.destravar('rd-desfechos'); // a rodada diária não depende de quando a aba foi aberta
    // A rodada diária também lê as transcrições novas do Drive (vale mesmo com o Chrome fechado).
    const lidas = await db.travar('drive-transcricoes', 2700).then((ok) => (ok ? transcricoes.sincronizarTodos({ porVez: 4 }) : null)).catch((err) => { console.error('Falha ao ler o Drive no agendador:', err.message); return null; });
    res.json({ ok: true, ...(await conferirDesfechosNoRd({ porVez: 25 })), ...(lidas ? { transcricoes: { lidos: lidas.lidos, casos: lidas.casos } } : {}) });
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

/**
 * Trazer as vendas de um closer direto do RD (cards ganhos em que o usuário é o SDR): completa o report
 * que já existe ou cria um com a venda. Para quem gerou o report em outro sistema.
 */
app.post('/api/master/trazer-vendas-rd', acesso(['resultados'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const { desde, closer } = req.body || {};
    res.json({ ok: true, ...(await vendasDoRd.trazer({ usuario: req.usuario, desde, closer })) });
  } catch (err) {
    res.status(/Informe/.test(err.message) ? 400 : 502).json({ erro: err.message });
  }
});

/**
 * Botão "Puxar do RD": confere agora os leads do período (vendidos, follow-up, os que não compraram e
 * o closer). Com ?varredura=<quando começou>, é o retroativo: o painel chama de novo até não sobrar
 * nenhum report do período sem conferir desde aquele momento.
 */
app.post('/api/master/vendas-rd', acesso(['resultados'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const varredura = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(req.query.varredura || '')) ? String(req.query.varredura) : '';
    const reports = await reportsDoEscopo(donoDoEscopo(req), filtroDaQuery(req.query));
    res.json(await vendasRd.sincronizar(reports, varredura ? { varredura, porVez: 10 } : {}));
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

/**
 * Trazer do Report Closer: os reports (com o PDF) exportados de lá, em Resultados → "Levar para o Report
 * PRONIX". Entram só os do próprio usuário, sem duplicar; o painel manda em lotes pequenos.
 */
app.post('/api/master/importar-reports', acesso(['resultados'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const { formato, reports } = req.body || {};
    if (formato !== importarReports.FORMATO || !Array.isArray(reports)) {
      return res.status(400).json({ erro: 'Esse arquivo não é a exportação do Report Closer (lá: Resultados → Levar para o Report PRONIX).' });
    }
    if (reports.length > importarReports.MAX_POR_VEZ) return res.status(400).json({ erro: `Mande no máximo ${importarReports.MAX_POR_VEZ} reports por vez.` });
    res.json({ ok: true, ...(await importarReports.importar(reports, { usuario: req.usuario })) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/master/inteligencia', acesso(['resultados'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const painel = inteligencia.painel(await reportsDoEscopo(donoDoEscopo(req)), await closers.listar());
    res.json({ ...painel, insights: await inteligencia.ultimosInsights(), calibragens: (await aprendizado.ajustes()).length });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Limpeza do funil no RD: card parado em "Contato iniciado" ou "Respondeu" vira perda em
// "Desqualificados". Só o master; a prévia não altera nada e a execução vai em lotes pequenos.
// ---------------------------------------------------------------------------
/** Diagnóstico das automações (mover para "Respondeu" e pintar a reunião na agenda): só confere, não altera nada. */
app.get('/api/master/diagnostico', master, async (req, res) => {
  try {
    res.json(await diagnostico.rodar(req.usuario || null));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Os funis do RD em que a limpeza pode rodar (para o master escolher). */
app.get('/api/master/limpeza-rd/funis', master, async (_req, res) => {
  try {
    res.json({ funis: await limpezaRd.funisElegiveis() });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.get('/api/master/limpeza-rd/previa', master, async (req, res) => {
  try {
    res.json(await limpezaRd.previa({ usuario: req.usuario || { nome: process.env.MASTER_NOME || 'Cauã Lima', id: '' }, dias: req.query.dias, escopo: String(req.query.escopo || 'meus'), funil: String(req.query.funil || '') }));
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.post('/api/master/limpeza-rd/executar', master, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await limpezaRd.executar({ usuario: req.usuario || { nome: process.env.MASTER_NOME || 'Cauã Lima', id: '' }, ids: b.ids, dias: b.dias, escopo: String(b.escopo || 'meus'), funil: String(b.funil || ''), execucao: String(b.execucao || '') }));
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** Cadastros duplicados no funil (mesmo e-mail ou telefone, só os cards de quem pediu): prévia, sem alterar nada. */
app.get('/api/master/limpeza-rd/duplicados', master, async (req, res) => {
  try {
    res.json(await limpezaRd.previaDuplicados({ usuario: req.usuario || { nome: process.env.MASTER_NOME || 'Cauã Lima', id: '' }, funil: String(req.query.funil || '') }));
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** Fecha um lote de duplicados (pares {id, fica}) em Desqualificados, com a perda "Duplicado". */
app.post('/api/master/limpeza-rd/duplicados', master, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await limpezaRd.fecharDuplicados({ usuario: req.usuario || { nome: process.env.MASTER_NOME || 'Cauã Lima', id: '' }, pares: b.pares, funil: String(b.funil || ''), execucao: String(b.execucao || '') }));
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.post('/api/master/limpeza-rd/desfazer', master, async (req, res) => {
  try {
    res.json(await limpezaRd.desfazer({ usuario: req.usuario || { nome: process.env.MASTER_NOME || 'Cauã Lima', id: '' }, ids: (req.body || {}).ids }));
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** Os relatórios salvos das limpezas já feitas (um por execução), do mais novo para o mais antigo. */
app.get('/api/master/limpeza-rd/relatorios', master, async (_req, res) => {
  try {
    res.json({ relatorios: await limpezaRd.relatoriosSalvos() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/master/limpeza-rd/relatorio', master, async (req, res) => {
  try {
    const dia = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
    res.json(await limpezaRd.relatorio({ de: dia(req.query.de), ate: dia(req.query.ate) }));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Texto de insights escrito pela IA gratuita (Groq) em cima dos números — sem custo. */
app.post('/api/master/insights', acesso(['resultados'], SO_MASTER_ERRO), async (req, res) => {
  try {
    res.json({ insights: await inteligencia.gerarInsights(await reportsDoEscopo(donoDoEscopo(req)), await closers.listar()) });
  } catch (err) {
    res.status(/Marque o resultado/.test(err.message) ? 400 : 502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin: closers (lista completa, com e-mail)
// ---------------------------------------------------------------------------
app.get('/api/admin/closers', acesso(['closers', 'numeros', 'resultados']), async (_req, res) => {
  try {
    res.json({ closers: await closers.listar() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/closers', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const c = await closers.criar(req.body && req.body.nome, req.body && req.body.email);
    res.json({ ok: true, closer: c });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/**
 * Apelido e inteligência do closer (o que as calls dele ensinaram): alimenta a análise de afinidade.
 * `analiseAtiva` liga e desliga o botão "Analisar Match com …" sem apagar o texto.
 */
app.patch('/api/admin/closers/:id', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const corpo = req.body || {};
    const campos = {};
    if (typeof corpo.apelido === 'string') campos.apelido = corpo.apelido;
    if (typeof corpo.inteligencia === 'string') campos.inteligencia = corpo.inteligencia;
    if (typeof corpo.analiseAtiva === 'boolean') campos.analiseAtiva = corpo.analiseAtiva;
    let c = await closers.definirInteligencia(req.params.id, campos);
    if (!c) return res.status(404).json({ erro: 'Closer não encontrado.' });
    // Pasta do Drive com as transcrições das calls dele (o link da pasta) e a partir de que dia ler.
    if (typeof corpo.drivePasta === 'string' || typeof corpo.driveDesde === 'string') {
      const drive = {};
      if (typeof corpo.drivePasta === 'string') {
        const id = driveGoogle.idDaPasta(corpo.drivePasta);
        if (corpo.drivePasta.trim() && !id) return res.status(400).json({ erro: 'Não reconheci o link da pasta do Drive. Cole o endereço da pasta (…/folders/…).' });
        drive.pasta = id;
      }
      if (typeof corpo.driveDesde === 'string') drive.desde = corpo.driveDesde;
      c = await closers.definirDrive(req.params.id, drive);
    }
    res.json({ ok: true, closer: c });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/**
 * Pacote do closer: cadastro, apelido, inteligência e os casos das calls dele (o que a análise das
 * transcrições classificou), tudo de uma vez. Acha o closer pelo nome ou pelo apelido e cria se não
 * existir. Importar de novo troca os casos das transcrições, sem duplicar.
 */
app.post('/api/admin/closers/importar', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const p = req.body || {};
    const nome = String(p.nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!nome) return res.status(400).json({ erro: 'O pacote não traz o nome do closer.' });
    if (p.casos !== undefined && !Array.isArray(p.casos)) return res.status(400).json({ erro: 'No pacote, "casos" precisa ser uma lista.' });
    const apelido = typeof p.apelido === 'string' ? p.apelido.replace(/\s+/g, ' ').trim().slice(0, 20) : '';
    const igual = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const lista = await closers.listar();
    let closer = lista.find((c) => igual(c.nome, nome)) || (apelido && lista.find((c) => igual(c.apelido, apelido))) || closerAuto.acharCloser(lista, nome);
    const criado = !closer;
    if (!closer) closer = await closers.criar(nome, typeof p.email === 'string' ? p.email : '');
    const campos = {};
    if (apelido) campos.apelido = apelido;
    if (typeof p.inteligencia === 'string' && p.inteligencia.trim()) campos.inteligencia = p.inteligencia;
    if (Object.keys(campos).length) closer = await closers.definirInteligencia(closer.id, campos);
    const n = Array.isArray(p.casos) ? await casosDoCloser.importar(closer.id, p.casos) : (await casosDoCloser.importados(closer.id)).length;
    res.json({
      ok: true, criado, casos: n, inteligencia: Boolean(campos.inteligencia),
      closer: { id: closer.id, nome: closer.nome, apelido: closers.apelidoDe(closer) },
    });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** Lê agora os documentos novos da pasta do closer no Drive (três por clique) e devolve o que aconteceu. */
app.post('/api/admin/closers/:id/drive/ler', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const closer = await closers.porId(req.params.id);
    if (!closer) return res.status(404).json({ erro: 'Closer não encontrado.' });
    res.json({ ok: true, ...(await transcricoes.sincronizar(closer, { porVez: 3 })) });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** Os casos lidos do Drive deste closer (os mais novos primeiro) e como foi a última leitura. */
app.get('/api/admin/closers/:id/drive', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const closer = await closers.porId(req.params.id);
    if (!closer) return res.status(404).json({ erro: 'Closer não encontrado.' });
    const lista = await casosDoCloser.doDrive(closer.id);
    res.json({
      ok: true, pasta: closer.drivePasta || '', desde: closer.driveDesde || '', ultima: closer.driveUltima || null, total: lista.length,
      casos: lista.slice().sort((a, b) => String(b.data).localeCompare(String(a.data))).slice(0, 60).map((c) => ({
        id: c.id, data: c.data, rotulo: c.rotulo || '', quem: c.quem, todosNaCall: c.todosNaCall, momento: c.momento, resultado: c.resultado, motivo: c.motivo, perfil: c.perfil, reunioes: c.reunioes, minutos: c.minutos, revisado: Boolean(c.revisado),
      })),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Corrige um caso lido do Drive (resultado, quem decide, presença, momento): caso corrigido não é mais mexido pela leitura. */
app.patch('/api/admin/closers/:id/casos/:caso', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const c = await casosDoCloser.editarDoDrive(req.params.id, req.params.caso, req.body || {});
    if (!c) return res.status(404).json({ erro: 'Caso não encontrado.' });
    res.json({ ok: true, caso: c });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.delete('/api/admin/closers/:id/casos/:caso', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const c = await casosDoCloser.editarDoDrive(req.params.id, req.params.caso, null);
    if (!c) return res.status(404).json({ erro: 'Caso não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** O padrão das calls do closer: as contas dos casos (transcrições importadas + reuniões com resultado). */
app.get('/api/admin/closers/:id/padrao', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    const closer = await closers.porId(req.params.id);
    if (!closer) return res.status(404).json({ erro: 'Closer não encontrado.' });
    const casos = await casosDoCloser.doCloser(closer.id, await stats.listar().catch(() => []));
    res.json({ ok: true, padrao: casosDoCloser.padrao(casos) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/admin/closers/:id', acesso(['closers'], SO_MASTER_ERRO), async (req, res) => {
  try {
    await closers.remover(req.params.id);
    await casosDoCloser.removerDoCloser(req.params.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Base de conhecimento (playbook) que entra em todo report.
app.get('/api/admin/base', acesso(['base']), async (_req, res) => {
  try {
    res.json(await base.ler());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/base', acesso(['base']), async (req, res) => {
  try {
    res.json({ ok: true, base: await base.salvar(req.body || {}) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Volta um campo (body.campo) ou a base inteira para o texto recomendado. */
app.post('/api/admin/base/recomendada', acesso(['base']), async (req, res) => {
  try {
    res.json({ ok: true, base: await base.usarRecomendada(String((req.body || {}).campo || '')) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Devolve os textos que existiam antes da base recomendada entrar. */
app.post('/api/admin/base/restaurar', acesso(['base']), async (_req, res) => {
  try {
    res.json({ ok: true, base: await base.restaurarAnterior() });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** Tira um report do histórico (testes que sujam os números). */
app.delete('/api/admin/reports/:id', acesso(['numeros']), async (req, res) => {
  try {
    const ok = await stats.remover(req.params.id);
    if (!ok) return res.status(404).json({ erro: 'Report não encontrado (já foi removido?).' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/**
 * Marca manualmente o closer e o resultado de um report (preenchido aos
 * poucos pelo admin, nada disso vem da IA). closerId vazio limpa a marcação.
 */
app.patch('/api/admin/reports/:id/resultado', acesso(['numeros', 'resultados']), async (req, res) => {
  try {
    const body = req.body || {};
    // Quem recebeu só a aba Resultados (não é gestor nem master, nem vê os números da equipe) mexe
    // apenas nos próprios reports.
    if (req.usuario && !usuarios.ehAdmin(req.usuario) && !usuarios.podeAba(req.usuario, 'numeros')) {
      const dono = await stats.buscarPorId(req.params.id);
      if (!dono || dono.usuarioId !== req.usuario.id) return res.status(404).json({ erro: 'Report não encontrado.' });
    }
    const tem = (k) => Object.prototype.hasOwnProperty.call(body, k);
    // Só entra no que veio no pedido: mudar um campo não apaga os outros. Se vier
    // "versao", o servidor recusa (409) quando o report já foi alterado por outra pessoa.
    const campos = {};
    ['leadEmail', 'telefone', 'resultado', 'dataReuniao', 'dataFechamento', 'obsReuniao', 'perfilReal', 'conscienciaReal', 'produto', 'ticket', 'pagamento'].forEach((k) => {
      if (tem(k)) campos[k] = body[k];
    });
    const antes = tem('conscienciaReal') || tem('perfilReal') ? await stats.buscarPorId(req.params.id) : null;
    if (tem('closerId')) {
      let closer = null;
      if (body.closerId) {
        closer = await closers.porId(body.closerId);
        if (!closer) return res.status(400).json({ erro: 'Closer não encontrado.' });
      }
      campos.closerId = closer ? closer.id : '';
      campos.closerNome = closer ? closer.nome : '';
      campos.closerEmail = closer ? closer.email : '';
    }
    // E-mail ou telefone do lead digitado na linha vira a única pista: o outro dado (que tinha vindo de um
    // contato do RD que não era o certo) sai, e a busca recomeça só com o que foi informado.
    if (tem('telefone') && !tem('leadEmail')) campos.leadEmail = '';
    if (tem('leadEmail') && !tem('telefone')) campos.telefone = '';
    const feito = await stats.atualizarResultado(req.params.id, campos, {
      versaoEsperada: tem('versao') ? body.versao : undefined,
    });
    if (!feito) return res.status(404).json({ erro: 'Report não encontrado.' });
    // Corrigir o nível de consciência ensina a IA: a correção entra como exemplo nos próximos reports.
    if (antes && body.conscienciaReal && body.conscienciaReal !== antes.conscienciaReal) {
      await aprendizado
        .registrarAjusteConsciencia({
          reportId: antes.id, de: antes.consciencia, para: body.conscienciaReal,
          evidencia: antes.conscienciaPorque, nota: body.notaConsciencia,
        })
        .catch((err) => console.error('Falha ao guardar a calibragem:', err.message));
    }
    // Corrigir o perfil do lead também: a troca vira exemplo para os próximos reports.
    if (antes && body.perfilReal && body.perfilReal !== antes.perfilReal) {
      await aprendizado
        .registrarAjustePerfil({ reportId: antes.id, de: antes.perfil, para: body.perfilReal, evidencia: antes.perfilEvidencia })
        .catch((err) => console.error('Falha ao guardar a calibragem do perfil:', err.message));
    }
    // Informou o e-mail ou o telefone do lead: procura no RD agora, com o dado novo (o vínculo antigo sai).
    if ((tem('leadEmail') || tem('telefone')) && crm.configurado()) {
      await stats.atualizarResultado(req.params.id, { rdContatoId: '' });
      const atual = await stats.buscarPorId(req.params.id);
      if (atual) await vendasRd.sincronizar([atual], { porVez: 1 }).catch((err) => console.error('Falha ao vincular o report no RD:', err.message));
      const depois = await stats.buscarPorId(req.params.id);
      return res.json({ ok: true, versao: Number(depois && depois.versao) || feito.versao, rdSituacao: (depois && depois.rdSituacao) || '', recarregar: true });
    }
    res.json({ ok: true, versao: feito.versao });
  } catch (err) {
    if (err.codigo === 'CONFLITO') return res.status(409).json({ erro: err.message, atual: err.atual });
    res.status(500).json({ erro: err.message });
  }
});

// Filtro de data/SDR compartilhado por /api/admin/stats e as rotas de PDF abaixo.
const dataOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
const filtroDaQuery = (q) => ({
  de: dataOk(q.de),
  ate: dataOk(q.ate),
  sdr: q.sdr ? String(q.sdr) : undefined,
});

/**
 * Números do dashboard: quantos reports, por quem, quanto custou.
 * Filtros: ?de=YYYY-MM-DD&ate=YYYY-MM-DD&sdr=Nome (todos opcionais).
 */
app.get('/api/admin/stats', acesso(['numeros']), async (req, res) => {
  try {
    res.json(await stats.resumo(filtroDaQuery(req.query)));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Baixa o PDF de um report já gerado (guardado em src/pdfStorage.js). */
app.get('/api/admin/reports/:id/pdf', acesso(['arquivos']), async (req, res) => {
  try {
    const salvo = await pdfStorage.ler(req.params.id);
    if (!salvo || !salvo.base64) {
      return res.status(404).json({
        erro: 'PDF não encontrado — reports gerados antes desta atualização não têm PDF salvo, ou ele já foi removido.',
      });
    }
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${salvo.arquivo || 'report.pdf'}"`);
    res.send(Buffer.from(salvo.base64, 'base64'));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/**
 * Reabre o PDF de um report já gerado, sem chamar a IA. O SDR só enxerga os
 * seus; o admin enxerga todos. Devolve JSON (e não o arquivo) para a extensão
 * conseguir baixar mandando a chave no header, sem pôr a chave na URL.
 */
app.get('/api/reports/:id/pdf', auth, async (req, res) => {
  try {
    const r = await stats.buscarPorId(req.params.id);
    const permitido = r && (usuarios.ehAdmin(req.usuario) || r.usuarioId === req.usuario.id);
    // Report de outra pessoa responde igual a "não existe" — não confirma que o id existe.
    if (!permitido) return res.status(404).json({ erro: 'Report não encontrado.' });
    const salvo = await pdfStorage.ler(r.id);
    if (!salvo || !salvo.base64) {
      return res.status(404).json({ erro: 'O PDF deste report não está mais guardado.' });
    }
    res.json({ arquivo: salvo.arquivo || r.arquivo || 'report.pdf', arquivoBase64: salvo.base64, lead: r.lead, quando: r.quando });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Nome de pasta seguro dentro do zip (sem barra, sem ".." no início).
const pastaSegura = (nome) =>
  String(nome || 'Sem SDR').replace(/[\\/]+/g, '-').replace(/^\.+/, '').trim() || 'Sem SDR';

const TETO_ZIP = 500; // protege contra timeout/memória num filtro largo demais na Vercel.

/**
 * Baixa em massa os PDFs de um período/SDR num .zip, organizado em pastas por
 * SDR — pra baixar só de uma pessoa é só filtrar (?sdr=Nome) igual à aba Números.
 */
app.get('/api/admin/reports/pdf-zip', acesso(['arquivos']), async (req, res) => {
  try {
    const todos = await stats.listar(filtroDaQuery(req.query));
    // ?ultimo=1: do mesmo lead no mesmo dia (por SDR), só o report gerado por último.
    const registros = req.query.ultimo === '1' ? diario.marcarUltimos(todos).filter((r) => r.usar) : todos;
    if (registros.length > TETO_ZIP) {
      return res.status(400).json({
        erro: `Filtro largo demais (${registros.length} reports). Estreite o período ou escolha um SDR — o limite por download é ${TETO_ZIP}.`,
      });
    }

    const comPdf = await lerPdfs(registros);
    if (comPdf.length === 0) {
      return res.status(404).json({ erro: 'Nenhum PDF encontrado para esse filtro.' });
    }

    const nomeZip = `Reports_PRONIX_${new Date().toISOString().slice(0, 10)}.zip`;
    await enviarZip(
      res,
      nomeZip,
      comPdf.map(({ r, salvo }) => ({ nome: `${pastaSegura(r.usuarioNome)}/${salvo.arquivo || r.id + '.pdf'}`, base64: salvo.base64 }))
    );
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ erro: err.message });
  }
});

/** Lê os PDFs guardados dos reports (os que não têm PDF — reports antigos — ficam de fora). */
async function lerPdfs(registros) {
  const lidos = await Promise.all(registros.map(async (r) => ({ r, salvo: await pdfStorage.ler(r.id).catch(() => null) })));
  return lidos.filter((x) => x.salvo && x.salvo.base64);
}

/** Monta e envia o .zip. Nomes repetidos (dois leads com o mesmo nome) ganham " (2)" para não se sobrescreverem. */
async function enviarZip(res, nomeZip, arquivos) {
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${nomeZip}"`);
  const zip = archiver('zip', { zlib: { level: 9 } });
  zip.on('error', (err) => res.status(500).end(err.message));
  zip.pipe(res);
  const nomes = diario.nomesUnicos(arquivos.map((a) => a.nome));
  arquivos.forEach((a, i) => zip.append(Buffer.from(a.base64, 'base64'), { name: nomes[i] }));
  await zip.finalize();
}

// ---------------------------------------------------------------------------
// Ficha do lead no RD Station CRM — o cartão que a extensão mostra no WhatsApp Web.
// POST (e não GET) para o telefone/nome do lead não ficar em URL nem em log de acesso.
// ---------------------------------------------------------------------------
app.post('/api/crm/lead', auth, async (req, res) => {
  try {
    // O master escolhe quem vê a ficha (aba Acessos). Desligado: a extensão não mostra nada e o RD nem é consultado.
    if (!req.usuario.fichaCrm) return res.json({ configurado: false, coach: Boolean(req.usuario.coach) });
    const { telefone, nome, contatoId, dealId, lembrar, conversa } = req.body || {};
    const r = await crm.consultarLead({ telefone, nome, contatoId, dealId, lembrar: lembrar === true });
    // "coach" avisa a extensão se este usuário vê o botão Coach da conversa.
    const extra = { coach: Boolean(req.usuario.coach) };
    if (req.usuario.automacao) Object.assign(extra, await automacaoDoLead(r, conversaDoPedido(conversa, { telefone, nome }), req.usuario));
    if (req.usuario.etiquetas) extra.etiquetas = true; // etiquetas do formulário (investimento, já vende) no cartão
    // Reunião do lead no Google Agenda (dia, hora e closer). Falha do Google nunca derruba a ficha.
    if (req.usuario.automacao && r.encontrado && r.ficha) {
      const reuniao = await agendaGoogle.reuniaoDoLead({ emails: r.ficha.emails, nome: r.ficha.nome }).catch((err) => {
        console.error('Falha ao consultar o Google Agenda:', err.message);
        return null;
      });
      if (reuniao) {
        // Para a extensão vai só o que o cartão mostra.
        extra.reuniao = { quando: reuniao.quando, closer: reuniao.closer, titulo: reuniao.titulo };
        // Lead que este pré-vendedor está atendendo: a reunião ganha a cor dele na agenda (se ainda não tiver cor).
        if (req.usuario.corAgenda) {
          await agendaGoogle.pintarReuniao(reuniao, req.usuario.corAgenda).catch((err) => console.error('Falha ao pintar a reunião na agenda:', err.message));
        }
      }
      // O RD (reunião realizada, card com o closer) ou a agenda dizem quem é o closer: os handoffs
      // deste lead que ainda estão sem closer são preenchidos sozinhos.
      await closerAuto
        .preencher({ usuario: req.usuario, conversa: conversaDoPedido(conversa, { telefone, nome }), ficha: r.ficha, reuniao })
        .catch((err) => console.error('Falha ao preencher o closer do report:', err.message));
      // Card marcado como vendido no RD: os reports deste lead ganham o aviso "vendido no RD".
      await vendasRd
        .anotarPelaFicha({ usuario: req.usuario, conversa: conversaDoPedido(conversa, { telefone, nome }), ficha: r.ficha })
        .catch((err) => console.error('Falha ao anotar a venda do RD:', err.message));
    }
    res.json({ ...r, ...extra });
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Automação do cartão (só para quem o master ligou em Acessos; padrão: só o master):
//  - mover o card para "Respondeu" no RD quando o lead responde no WhatsApp;
//  - etiqueta "Qualificado" e o dia/horário agendado, lembrados por lead (src/leads.js).
// ---------------------------------------------------------------------------

/** De que conversa do WhatsApp se trata (telefone e nome do cabeçalho) — a busca no RD pode ter sido por outro dado. */
function conversaDoPedido(conversa, reserva = {}) {
  const c = conversa && typeof conversa === 'object' ? conversa : reserva;
  return { telefone: String(c.telefone || '').slice(0, 30), nome: String(c.nome || '').slice(0, 80) };
}

/** O que a extensão precisa para as etiquetas e para saber se vale tentar mover o card. Falha aqui nunca derruba a ficha. */
async function automacaoDoLead(r, conversa, usuario) {
  const saida = { automacao: true };
  try {
    let marca = await leads.ler(conversa, usuario.id);
    const etapa = (r.ficha && r.ficha.negociacao && r.ficha.negociacao.etapa) || '';
    // Card na etapa "Qualificado": a etiqueta fica lembrada mesmo que depois ele mude de etapa (remarcou, sumiu).
    if (crm.ehEtapaQualificado(etapa) && !leads.qualificado(marca) && !(marca && marca.manual)) {
      marca = await leads.marcar(conversa, { qualificado: true, origem: 'rd', por: usuario.nome, usuarioId: usuario.id });
    }
    saida.marca = leads.publica(marca);
  } catch (err) {
    console.error('Falha ao ler a marca do lead:', err.message);
  }
  saida.podeResponder = r.encontrado ? await crm.antesDeRespondeu(r.ficha).catch(() => false) : false;
  return saida;
}

const semAutomacao = (req, res) => {
  if (req.usuario.automacao) return false;
  res.status(403).json({ erro: 'Automação do cartão não liberada para este usuário.' });
  return true;
};

/** Os motivos de perda cadastrados no RD: são as opções do botão "Desqualificar" do cartão. */
app.get('/api/crm/motivos-perda', auth, async (req, res) => {
  try {
    if (semAutomacao(req, res)) return;
    if (!crm.configurado()) return res.status(400).json({ erro: 'O RD Station CRM não está configurado no servidor.' });
    res.json({ ok: true, motivos: await limpezaRd.motivosDePerda() });
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

/**
 * Botão "Desqualificar" do cartão: o card deste lead vira perda no RD, com o motivo escolhido. O card
 * tem de ser do lead da conversa aberta (confere na ficha) — id de outro lead não é mexido.
 */
app.post('/api/crm/desqualificar', auth, async (req, res) => {
  try {
    if (semAutomacao(req, res)) return;
    if (!req.usuario.fichaCrm) return res.status(403).json({ erro: 'Ficha do lead desligada para este usuário.' });
    const { telefone, nome, contatoId, dealId, motivoId } = req.body || {};
    const busca = { telefone, nome, contatoId };
    const lead = await crm.consultarLead(busca);
    const cards = (lead && lead.ficha && lead.ficha.negociacoes) || [];
    if (!cards.some((c) => String(c.id) === String(dealId || ''))) {
      return res.status(400).json({ erro: 'Este card não é do lead desta conversa. Abra a conversa de novo e tente outra vez.' });
    }
    const r = await limpezaRd.desqualificarCard({ usuario: req.usuario, dealId, motivoId });
    await crm.esquecerLead(busca).catch(() => {});
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(/Escolha um|não é do lead|já está como perdido|já foi fechado|Não sei qual/.test(err.message) ? 400 : 502).json({ erro: err.message });
  }
});

/** O lead respondeu no WhatsApp: avança o card para "Respondeu" (só se ainda estiver antes dela). */
app.post('/api/crm/respondeu', auth, async (req, res) => {
  try {
    if (semAutomacao(req, res)) return;
    if (!req.usuario.fichaCrm) return res.status(403).json({ erro: 'Ficha do lead desligada para este usuário.' });
    const { telefone, nome, contatoId, dealId } = req.body || {};
    res.json(await crm.moverParaRespondeu({ telefone, nome, contatoId, dealId }, { usuarioNome: req.usuario.nome }));
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

/**
 * Etiqueta "Qualificado" (à mão, ou automática quando um report é gerado) e o agendamento lido na conversa.
 * Agendamento NÃO qualifica ninguém: a etiqueta só vem da etapa do RD, de report gerado ou do usuário.
 */
app.post('/api/lead/marca', auth, async (req, res) => {
  try {
    if (semAutomacao(req, res)) return;
    const b = req.body || {};
    const conversa = conversaDoPedido({ telefone: b.telefone, nome: b.nome });
    const campos = { por: req.usuario.nome, usuarioId: req.usuario.id };
    if (typeof b.qualificado === 'boolean') Object.assign(campos, { qualificado: b.qualificado, manual: b.manual === true, origem: b.origem });
    if (b.limparAgenda === true) campos.limparAgenda = true;
    else if (b.agendadoPara !== undefined) {
      if (!leads.QUANDO_OK.test(String(b.agendadoPara))) return res.status(400).json({ erro: 'Data do agendamento inválida.' });
      // "regra" = versão da leitura de agendamento da extensão: leitura de uma regra antiga é ignorada.
      Object.assign(campos, { agendadoPara: b.agendadoPara, fonteTs: b.fonteTs, regra: b.regra });
    }
    const marca = await leads.marcar(conversa, campos);
    if (!marca) return res.status(400).json({ erro: 'Conversa sem telefone nem nome.' });
    res.json({ ok: true, marca: leads.publica(marca) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/**
 * Coach da conversa (botão no cartão): perfil do lead, como abordar, objeções com resposta e perguntas de
 * aprofundamento, no Groq gratuito. Só para quem o master ligou (padrão: só o master).
 */
app.post('/api/coach', auth, async (req, res) => {
  try {
    if (!req.usuario.coach) return res.status(403).json({ erro: 'Coach não liberado para este usuário.' });
    const { mensagens, nome } = req.body || {};
    res.json(await coachIa.gerarCoach({ mensagens, nome }));
  } catch (err) {
    res.status(/Nenhuma mensagem/.test(err.message) ? 400 : 502).json({ erro: err.message });
  }
});

/** "Funcionou" / "não ajudou" numa sugestão do coach: é assim que ele aprende. */
app.post('/api/coach/feedback', auth, async (req, res) => {
  try {
    if (!req.usuario.coach) return res.status(403).json({ erro: 'Coach não liberado para este usuário.' });
    const { tipo, texto, contexto, util } = req.body || {};
    await coachIa.registrarFeedback({ tipo, texto, contexto, util: util !== false, usuarioNome: req.usuario.nome });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/**
 * Resumo rápido da conversa aberta (botão no cartão do WhatsApp): cenário, onde parou, última
 * pergunta e próximo passo — para retomar um lead sem reler a conversa nem reouvir os áudios.
 * Disponível para todo usuário com chave. Conversa igual = resumo do cache, sem custo.
 */
app.post('/api/resumo-rapido', auth, async (req, res) => {
  try {
    if (!req.usuario.fichaCrm) return res.status(403).json({ erro: 'Resumo rápido desligado para este usuário.' });
    const { mensagens, nome } = req.body || {};
    const r = await gerarResumoRapido({ mensagens, nome });
    if (r.uso) {
      await stats
        .registrarResumoRapido({ usuarioNome: req.usuario.nome, uso: r.uso })
        .catch((err) => console.error('Falha ao registrar o consumo do resumo:', err.message));
    }
    res.json({ resumo: r.resumo, cache: r.cache });
  } catch (err) {
    res.status(/Nenhuma mensagem/.test(err.message) ? 400 : 502).json({ erro: err.message });
  }
});

/** Teste do admin: mesma busca, sem cache e com o passo a passo (quais formatos de telefone foram tentados). */
app.post('/api/admin/crm/teste', acesso(['extensao']), async (req, res) => {
  try {
    const { telefone, nome } = req.body || {};
    res.json(await crm.consultarLead({ telefone, nome }, { diagnostico: true, semCache: true }));
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Google Agenda: o master conecta a conta dele (com quem os closers compartilharam a agenda) e o
// cartão passa a mostrar a reunião do lead. O servidor só LÊ agenda (escopo calendar.readonly).
// ---------------------------------------------------------------------------
const enderecoDoServidor = (req) => `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
const retornoDoGoogle = (req) => enderecoDoServidor(req) + '/api/google/retorno';

app.get('/api/master/google', master, async (req, res) => {
  try {
    res.json({ ...(await agendaGoogle.status()), retorno: retornoDoGoogle(req), suaCor: req.usuario.corAgenda || '', suaAutomacao: Boolean(req.usuario.automacao) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Devolve o endereço da tela de consentimento do Google. O "state" amarra a volta a este pedido. */
app.post('/api/master/google/conectar', master, async (req, res) => {
  try {
    if (!agendaGoogle.configurado()) {
      return res.status(400).json({ erro: 'Falta criar GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET na Vercel.' });
    }
    const state = crypto.randomBytes(18).toString('hex');
    await db.cacheSet('google:state:' + state, (req.usuario && req.usuario.nome) || 'master', 600);
    res.json({ url: agendaGoogle.urlDeAutorizacao(retornoDoGoogle(req), state) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/master/google', master, async (_req, res) => {
  try {
    await agendaGoogle.desconectar();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Volta do Google (o navegador chega aqui sem a chave: quem autoriza é o "state" criado pelo master há pouco). */
app.get('/api/google/retorno', async (req, res) => {
  const pagina = (titulo, texto) =>
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>${titulo}</title><body style="font:16px system-ui;background:#121214;color:#e6edf3;padding:40px"><h2>${titulo}</h2><p>${texto}</p></body>`);
  try {
    const state = String(req.query.state || '');
    const por = /^[a-f0-9]{36}$/.test(state) ? await db.cacheGet('google:state:' + state) : null;
    if (!por) return pagina('Pedido expirado', 'Volte ao painel (aba Extensão) e clique em "Conectar Google Agenda" de novo.');
    await db.cacheDel('google:state:' + state);
    if (!req.query.code) return pagina('Conexão cancelada', 'Nenhuma agenda foi conectada. Você pode fechar esta aba.');
    await agendaGoogle.concluirConexao(String(req.query.code), retornoDoGoogle(req), por);
    pagina('Google Agenda conectado', 'Pode fechar esta aba e voltar ao painel.');
  } catch (err) {
    pagina('Não deu para conectar', 'Volte ao painel e tente de novo.');
    console.error('Falha ao conectar o Google Agenda:', err.message);
  }
});

// ---------------------------------------------------------------------------
// Reports do dia do PRÓPRIO usuário — o .zip que vai para o líder no fim do dia.
// Quando o mesmo lead teve mais de um report no dia, vale o último (src/diario.js).
// Qualquer usuário com chave usa; cada um só enxerga os seus.
// ---------------------------------------------------------------------------
/**
 * Report de reunião que não aconteceu (no-show) não vai para o líder: sai do .zip padrão e aparece
 * desmarcado na lista do dia (dá para marcar à mão se for o caso).
 */
const semNoShow = (marcados) => marcados.map((r) => (r.resultado === 'no_show' ? { ...r, usar: false, noShow: true } : { ...r, noShow: false }));

async function meusReportsDoDia(usuario, dia) {
  const doDia = await stats.listar({ de: dia, ate: dia });
  return semNoShow(diario.marcarUltimos(doDia.filter((r) => r.usuarioId === usuario.id)));
}

app.get('/api/meus-reports', auth, async (req, res) => {
  try {
    const dia = dataOk(req.query.dia) || stats.hojeStr();
    const marcados = await meusReportsDoDia(req.usuario, dia);
    res.json({
      dia,
      total: marcados.length,
      leads: marcados.filter((r) => r.usar).length,
      reports: marcados.map((r) => ({
        id: r.id,
        lead: r.lead,
        contato: r.contato || '',
        quando: r.quando,
        origem: r.origem,
        arquivo: r.arquivo,
        usar: r.usar,
        noShow: r.noShow,
        substituidoPor: r.substituidoPor,
        geracoes: r.geracoes,
      })),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Reports do dia da EQUIPE (gestor e admin): todos os SDRs, o último report de cada lead,
// um .zip com uma pasta por SDR.
// ---------------------------------------------------------------------------
async function reportsDaEquipe(dia) {
  return semNoShow(diario.marcarUltimos(await stats.listar({ de: dia, ate: dia })));
}

app.get('/api/equipe-reports', acesso(['equipe']), async (req, res) => {
  try {
    const dia = dataOk(req.query.dia) || stats.hojeStr();
    const marcados = await reportsDaEquipe(dia);
    res.json({
      dia,
      total: marcados.length,
      leads: marcados.filter((r) => r.usar).length,
      sdrs: new Set(marcados.map((r) => r.usuarioNome || '')).size,
      reports: marcados.map((r) => ({
        id: r.id,
        lead: r.lead,
        contato: r.contato || '',
        usuarioNome: r.usuarioNome || '',
        quando: r.quando,
        origem: r.origem,
        arquivo: r.arquivo,
        usar: r.usar,
        noShow: r.noShow,
        substituidoPor: r.substituidoPor,
        geracoes: r.geracoes,
      })),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/equipe-reports/zip', acesso(['equipe']), async (req, res) => {
  try {
    const body = req.body || {};
    const dia = dataOk(body.dia) || stats.hojeStr();
    const marcados = await reportsDaEquipe(dia);
    let escolhidos;
    if (Array.isArray(body.ids)) {
      const pedidos = new Set(body.ids.slice(0, TETO_ZIP).map(String));
      escolhidos = marcados.filter((r) => pedidos.has(r.id));
    } else {
      escolhidos = marcados.filter((r) => r.usar);
    }
    if (!escolhidos.length) {
      return res.status(400).json({ erro: marcados.length ? 'Marque pelo menos um report para baixar.' : 'Nenhum report gerado neste dia.' });
    }
    if (escolhidos.length > TETO_ZIP) return res.status(400).json({ erro: `Reports demais para um .zip (${escolhidos.length}).` });
    const comPdf = await lerPdfs(escolhidos);
    if (!comPdf.length) return res.status(404).json({ erro: 'O PDF desses reports não está guardado.' });

    res.set('X-Reports-No-Zip', String(comPdf.length));
    res.set('X-Reports-Sem-Pdf', String(escolhidos.length - comPdf.length));
    await enviarZip(
      res,
      `Reports_Equipe_${dia.split('-').reverse().join('-')}.zip`,
      comPdf.map(({ r, salvo }) => ({ nome: `${pastaSegura(r.usuarioNome)}/${salvo.arquivo || r.arquivo || r.id + '.pdf'}`, base64: salvo.base64 }))
    );
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ erro: err.message });
  }
});

app.post('/api/meus-reports/zip', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const dia = dataOk(body.dia) || stats.hojeStr();
    const marcados = await meusReportsDoDia(req.usuario, dia);
    // Sem "ids": o último de cada lead. Com "ids": o que o usuário marcou na tela — sempre
    // restrito aos reports DELE naquele dia (id de outra pessoa é simplesmente ignorado).
    let escolhidos;
    if (Array.isArray(body.ids)) {
      const pedidos = new Set(body.ids.slice(0, 500).map(String));
      escolhidos = marcados.filter((r) => pedidos.has(r.id));
    } else {
      escolhidos = marcados.filter((r) => r.usar);
    }
    if (!escolhidos.length) {
      return res.status(400).json({
        erro: marcados.length ? 'Marque pelo menos um report para baixar.' : 'Você não gerou nenhum report neste dia.',
      });
    }
    const comPdf = await lerPdfs(escolhidos);
    if (!comPdf.length) return res.status(404).json({ erro: 'O PDF desses reports não está guardado.' });

    const diaBr = dia.split('-').reverse().join('-');
    res.set('X-Reports-No-Zip', String(comPdf.length));
    res.set('X-Reports-Sem-Pdf', String(escolhidos.length - comPdf.length));
    await enviarZip(
      res,
      `Reports_${diario.nomeAscii(req.usuario.nome)}_${diaBr}.zip`,
      comPdf.map(({ r, salvo }) => ({ nome: salvo.arquivo || r.arquivo || r.id + '.pdf', base64: salvo.base64 }))
    );
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Report (extensão e modo manual) — devolve o PDF em base64 (sem disco).
// ---------------------------------------------------------------------------
/**
 * Sanitiza o resumo de captura enviado pela extensão (áudios achados/transcritos).
 * Nunca confia em "incompleta" vindo do cliente: recalcula dos números.
 */
function sanitizarCaptura(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x >= 0 ? Math.min(x, 100000) : 0;
  };
  const audios = n(c.audios);
  const audiosTranscritos = Math.min(n(c.audiosTranscritos), audios);
  const mensagens = n(c.mensagens);
  // Extensões antigas não mandam a contagem por remetente: aí fica null (e nada é marcado como suspeito).
  const temRemetente = c.mensagensVendedor != null && c.mensagensLead != null;
  const vendedor = temRemetente ? n(c.mensagensVendedor) : null;
  const lead = temRemetente ? n(c.mensagensLead) : null;
  return {
    plataforma: c.plataforma === 'whatsapp' || c.plataforma === 'instagram' ? c.plataforma : '',
    versao: String(c.versao || '').slice(0, 12),
    mensagens,
    audios,
    audiosTranscritos,
    incompleta: audiosTranscritos < audios,
    mensagensVendedor: vendedor,
    mensagensLead: lead,
    // Conversa de 6+ mensagens com um dos lados zerado: quase sempre é leitura errada do remetente.
    remetenteSuspeito: temRemetente && mensagens >= 6 && (vendedor === 0 || lead === 0),
  };
}

/**
 * O vínculo do report com o lead no RD. A extensão manda o que leu do card aberto (id do contato e do
 * card, e-mail, telefone); sem isso, tenta achar pelo contato da conversa — a ficha costuma estar em
 * cache, porque o cartão estava na tela — e desiste em 3 segundos para não segurar o report.
 */
async function vinculoDoReport(vinculo, nome) {
  const v = stats.vinculoLimpo(vinculo);
  if (v.contatoId || v.telefone || v.email || !crm.configurado()) return v;
  const busca = vendasRd.buscaDoReport({ contato: nome });
  if (!busca) return v;
  const lead = await Promise.race([crm.consultarLead(busca).catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))]);
  const ficha = lead && lead.encontrado !== false && lead.ficha;
  if (!ficha) return v;
  const escolhido = (ficha.negociacoes || []).find((c) => c.escolhida);
  return stats.vinculoLimpo({ telefone: (ficha.telefones || [])[0], email: (ficha.emails || [])[0], contatoId: ficha.contatoId, dealId: escolhido && escolhido.id });
}

async function responderReport(req, res, dados, nome, origem, reportKey, captura, vinculo) {
  // Quem assina o report é o dono da chave, não uma variável do servidor.
  dados.sdr = req.usuario.nome;
  const uso = dados.uso;
  delete dados.uso; // consumo é assunto do admin: não vai junto do report.
  const meta = dados._meta || {};
  delete dados._meta; // métricas internas de qualidade: também não vão pro cliente.
  // Análise da prospecção (BANT/SPIN/perguntas-chave) é da gestão: fica no histórico, não no report.
  const leitura = {
    perfil: (dados.perfil && dados.perfil.tipo) || '',
    perfilEvidencia: (dados.perfil && dados.perfil.evidencia) || '',
    consciencia: (dados.consciencia && dados.consciencia.nivel) || '',
    conscienciaPorque: (dados.consciencia && dados.consciencia.porque) || '',
    analise: dados.analise || null,
  };
  delete dados.analise;
  const buffer = await gerarPdfBuffer(dados);
  const arquivo = nomeArquivoPdf(dados.lead || nome);
  // Gera o id aqui (não dentro de stats.registrar) pra poder salvar o PDF sob
  // a mesma chave — ver src/pdfStorage.js.
  const id = crypto.randomBytes(5).toString('hex');
  const base64 = buffer.toString('base64');
  // O report é o que importa: se o registro ou o salvamento do PDF falharem,
  // não derruba a entrega — o SDR já recebe o PDF de qualquer jeito.
  await stats
    .registrar({
      id,
      usuarioId: req.usuario.id,
      usuarioNome: req.usuario.nome,
      lead: dados.lead || nome || '',
      contato: nome,
      origem,
      uso,
      reportKey,
      arquivo,
      qualidade: (uso && uso.qualidade) || 'standard',
      captura,
      citacoesRemovidas: meta.citacoesRemovidas || 0,
      leitura,
      vinculo: await vinculoDoReport(vinculo, nome).catch(() => null),
    })
    .catch((err) => console.error('Falha ao registrar o report:', err.message));
  await pdfStorage
    .salvar(id, base64, arquivo)
    .catch((err) => console.error('Falha ao salvar o PDF do report:', err.message));
  // Para a extensão oferecer o closer logo no aviso final (com a sugestão pelo perfil do lead).
  const semEscolha = { closers: [], sugestao: null, motivo: '' };
  const escolha = usuarios.ehMaster(req.usuario)
    ? await sugestaoDeCloser(leitura.perfil, req.usuario.id).catch(() => semEscolha)
    : semEscolha;
  res.json({ dados, arquivo, arquivoBase64: base64, id, closers: escolha.closers, sugestaoCloser: escolha.sugestao, motivoSugestao: escolha.motivo });
}

// Report_Nome_Data.pdf — "Nome" é o lead, que é de quem o report fala.
function nomeArquivoPdf(lead) {
  const limpo = String(lead || 'Lead')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim().split(/\s+/).slice(0, 3).join('-').slice(0, 40) || 'Lead';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Report_${limpo}_${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}.pdf`;
}

/**
 * Idempotência + trava de concorrência: calcula a reportKey da conversa (já
 * normalizada), confere se já existe um report idêntico (a não ser que o
 * pedido mande forcarNovo) e trava a chave enquanto gera — assim um retry de
 * rede não paga duas vezes pela mesma conversa. Devolve null se já respondeu
 * (duplicata encontrada) ou a reportKey para o chamador usar/destravar.
 */
async function checarDuplicataETravar(req, res, reportKey) {
  if (!req.body || !req.body.forcarNovo) {
    const existente = await stats.buscarPorChave(reportKey);
    if (existente) {
      res.json({
        duplicado: true,
        existente: {
          id: existente.id,
          quando: existente.quando,
          lead: existente.lead,
          arquivo: existente.arquivo,
          // Só dá para reabrir o próprio report (admin abre qualquer um).
          podeAbrir: usuarios.ehAdmin(req.usuario) || existente.usuarioId === req.usuario.id,
        },
      });
      return false;
    }
  }
  if (!(await db.travar(reportKey))) {
    res.status(409).json({ erro: 'Já existe uma geração em andamento para esta conversa.' });
    return false;
  }
  return true;
}

app.post('/api/report-direto', auth, async (req, res) => {
  let reportKey = null;
  try {
    const { mensagens, nome, qualidade, captureQuality, vinculo } = req.body || {};
    const qualidadeFinal = qualidadeValida(qualidade);
    const { historico: normalizadas } = normalizarConversa(Array.isArray(mensagens) ? mensagens : []);
    reportKey = calcularReportKey({ historicoNormalizado: normalizadas, promptVersao: PROMPT_VERSAO, qualidade: qualidadeFinal });

    if (!(await checarDuplicataETravar(req, res, reportKey))) return;

    const dados = await dadosDireto({ mensagens, nome, sdr: req.usuario.nome, qualidade: qualidadeFinal });
    await responderReport(req, res, dados, nome, 'extensao', reportKey, sanitizarCaptura(captureQuality), vinculo);
  } catch (err) {
    res.status(/Nenhuma mensagem/i.test(err.message) ? 400 : 500).json({ erro: err.message });
  } finally {
    if (reportKey) await db.destravar(reportKey).catch(() => {});
  }
});

app.post('/api/report-texto', auth, async (req, res) => {
  let reportKey = null;
  try {
    const { texto, nome, qualidade } = req.body || {};
    const qualidadeFinal = qualidadeValida(qualidade);
    const { texto: textoNormalizado } = normalizarTextoLivre(String(texto || ''));
    reportKey = calcularReportKey({ historicoNormalizado: textoNormalizado, promptVersao: PROMPT_VERSAO, qualidade: qualidadeFinal });

    if (!(await checarDuplicataETravar(req, res, reportKey))) return;

    const dados = await dadosDeTexto({ texto, nome, sdr: req.usuario.nome, qualidade: qualidadeFinal });
    await responderReport(req, res, dados, nome, 'manual', reportKey);
  } catch (err) {
    res.status(/Cole a conversa/i.test(err.message) ? 400 : 500).json({ erro: err.message });
  } finally {
    if (reportKey) await db.destravar(reportKey).catch(() => {});
  }
});

// Regera o PDF a partir de um report já EDITADO no dashboard. Não chama a IA
// (é só desenhar), então não custa nem entra nos números — é o mesmo report.
app.post('/api/pdf', auth, async (req, res) => {
  try {
    const dados = saneadorDeReport(req.body && req.body.dados);
    if (!dados) return res.status(400).json({ erro: 'Report inválido para gerar o PDF.' });
    dados.sdr = req.usuario.nome; // a assinatura é sempre de quem está logado
    const buffer = await gerarPdfBuffer(dados);
    res.json({ arquivo: nomeArquivoPdf(dados.lead), arquivoBase64: buffer.toString('base64') });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Aceita só os campos esperados do report editado (blinda o gerador de PDF).
function saneadorDeReport(d) {
  if (!d || typeof d !== 'object') return null;
  const txt = (v) => (typeof v === 'string' ? v : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    lead: txt(d.lead).trim(),
    resumo: arr(d.resumo)
      .map((r) => ({ rotulo: txt(r && r.rotulo).trim(), valor: txt(r && r.valor).trim() }))
      .filter((r) => r.rotulo || r.valor),
    secoes: arr(d.secoes)
      .map((s) => ({
        titulo: txt(s && s.titulo).trim(),
        numerada: !!(s && s.numerada),
        itens: arr(s && s.itens).map(txt).map((t) => t.trim()).filter(Boolean),
      }))
      .filter((s) => s.titulo || s.itens.length),
    citacoes: arr(d.citacoes).map(txt).map((t) => t.trim()).filter(Boolean),
    consciencia: normalizarConsciencia(d.consciencia),
    conversa: arr(d.conversa).map(txt).map((t) => t.trim()).filter(Boolean).slice(0, 6),
    sinais_compra: arr(d.sinais_compra).map(txt).map((t) => t.trim()).filter(Boolean).slice(0, 5),
    dores: normalizarDores(d.dores),
    abertura: txt(d.abertura).trim(),
    frase_impacto: txt(d.frase_impacto).trim(),
  };
}

// ---------------------------------------------------------------------------
// Transcrição de áudio (Whisper local)
// ---------------------------------------------------------------------------
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES) || 20 * 1024 * 1024;

/** Por quanto tempo a transcrição de um mesmo áudio fica em cache (0 desliga). Padrão 24h. */
function ttlCacheTranscricao() {
  const v = process.env.TRANSCRIPTION_CACHE_TTL_SEG;
  if (v === undefined || v === '') return 86400;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Tipo REAL do áudio pelos magic bytes — não confia no nome que o cliente manda
 * (a extensão nomeava tudo "audio.ogg"). 'nao-audio' = claramente outra coisa
 * (imagem, PDF, HTML/JSON, zip); 'desconhecido' = deixa passar como antes.
 * @returns {{tipo: 'audio'|'nao-audio'|'desconhecido', ext: string}}
 */
function tipoDeAudio(buf) {
  if (!buf || buf.length < 12) return { tipo: 'desconhecido', ext: '' };
  const eq = (i, s) => s.split('').every((c, k) => buf[i + k] === c.charCodeAt(0));
  if (buf[0] === 0xff && buf[1] === 0xd8) return { tipo: 'nao-audio', ext: '' }; // JPEG
  if (buf[0] === 0x89 && eq(1, 'PNG')) return { tipo: 'nao-audio', ext: '' };
  if (eq(0, 'GIF8') || eq(0, '%PDF') || eq(0, 'PK')) return { tipo: 'nao-audio', ext: '' };
  if (eq(0, 'RIFF') && eq(8, 'WEBP')) return { tipo: 'nao-audio', ext: '' };
  const primeiro = buf.slice(0, 64).toString('utf8').trimStart()[0];
  if (primeiro === '<' || primeiro === '{') return { tipo: 'nao-audio', ext: '' }; // HTML/JSON de erro
  if (eq(0, 'OggS')) return { tipo: 'audio', ext: '.ogg' };
  if (eq(0, 'fLaC')) return { tipo: 'audio', ext: '.flac' };
  if (eq(0, 'RIFF') && eq(8, 'WAVE')) return { tipo: 'audio', ext: '.wav' };
  if (eq(4, 'ftyp')) return { tipo: 'audio', ext: '.m4a' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { tipo: 'audio', ext: '.webm' };
  if (eq(0, 'ID3')) return { tipo: 'audio', ext: '.mp3' };
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { tipo: 'audio', ext: '.mp3' };
  return { tipo: 'desconhecido', ext: '' };
}

app.post('/api/transcrever', auth, async (req, res) => {
  try {
    const { audioBase64, nome } = req.body || {};
    if (!audioBase64) return res.status(400).json({ erro: 'Nenhum áudio recebido.' });
    const buffer = Buffer.from(String(audioBase64), 'base64');
    if (!buffer.length) return res.status(400).json({ erro: 'Nenhum áudio recebido.' });
    if (buffer.length > MAX_AUDIO_BYTES) {
      return res.status(400).json({
        erro: `Áudio grande demais (${Math.round(buffer.length / 1048576)}MB). O limite é ${Math.round(MAX_AUDIO_BYTES / 1048576)}MB.`,
      });
    }
    const detectado = tipoDeAudio(buffer);
    if (detectado.tipo === 'nao-audio') {
      return res.status(400).json({ erro: 'Isso não parece um arquivo de áudio.' });
    }
    // O tipo detectado manda; só sem detecção usa a extensão do nome (com validação em transcribeBuffer).
    const ext = detectado.ext || path.extname((nome || '').toString()) || '.ogg';

    // Mesmo áudio (mesmos bytes) = mesma transcrição: evita retranscrever ao gerar de novo.
    const ttl = ttlCacheTranscricao();
    const chaveCache = 'tr:' + crypto.createHash('sha256').update(buffer).digest('hex');
    let texto = ttl ? await db.cacheGet(chaveCache) : null;
    let doCache = texto !== null;
    if (texto === null) {
      texto = await transcribeBuffer(buffer, ext);
      if (texto && texto.trim()) await db.cacheSet(chaveCache, texto, ttl);
    }
    // Ponto único onde áudio vira texto (extensão e modo manual passam por aqui):
    // corta transcrição excepcionalmente longa antes dela virar tokens de prompt.
    const limite = Number(process.env.MAX_AUDIO_TRANSCRIPTION_CHARS) || 6000;
    if (texto.length > limite) texto = texto.slice(0, limite) + '…';

    res.json({ texto, cache: doCache });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Print de conversa -> texto (Groq com visão, mesmo plano gratuito do áudio).
// Não gera report: devolve a conversa transcrita pra cair na caixa do modo
// manual, e daí segue o fluxo de sempre.
// ---------------------------------------------------------------------------

/** Tipo REAL da imagem pelos magic bytes — não confia na extensão nem no que o cliente diz. */
function tipoDeImagem(buf) {
  if (!buf || buf.length < 12) return null;
  const eq = (i, s) => s.split('').every((c, k) => buf[i + k] === c.charCodeAt(0));
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && eq(1, 'PNG')) return 'image/png';
  if (eq(0, 'RIFF') && eq(8, 'WEBP')) return 'image/webp';
  if (eq(0, 'GIF8')) return 'image/gif';
  return null;
}

const MAX_IMAGEM_BYTES = Number(process.env.MAX_IMAGEM_BYTES) || 4 * 1024 * 1024;

app.post('/api/ler-imagem', auth, async (req, res) => {
  try {
    const { imagemBase64 } = req.body || {};
    if (!imagemBase64) return res.status(400).json({ erro: 'Nenhuma imagem recebida.' });
    const buffer = Buffer.from(String(imagemBase64), 'base64');
    if (buffer.length > MAX_IMAGEM_BYTES) {
      return res.status(400).json({
        erro: `Imagem grande demais (${Math.round(buffer.length / 1024)}KB). O limite é ${Math.round(MAX_IMAGEM_BYTES / 1024)}KB.`,
      });
    }
    const mime = tipoDeImagem(buffer);
    if (!mime) return res.status(400).json({ erro: 'Isso não é uma imagem válida (aceita PNG, JPG, WebP ou GIF).' });
    const texto = await lerImagemGroq(buffer, mime);
    res.json({ texto });
  } catch (err) {
    // Não loga a imagem nem o texto lido — é conversa de lead.
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Estimativa de custo (antes de gerar) — determinística, sem chamar a LLM nem
// nenhuma API de câmbio: usa o mesmo normalizador do report + src/precos.js.
// ---------------------------------------------------------------------------
const SAIDA_ESTIMADA_TOKENS = { eco: 800, standard: 1400, premium: 1800 };

app.post('/api/estimar-custo', auth, async (req, res) => {
  try {
    const { mensagens, texto, qualidade } = req.body || {};
    const qualidadeFinal = qualidadeValida(qualidade);
    const { stats: normStats, resumida } = Array.isArray(mensagens)
      ? normalizarConversa(mensagens)
      : normalizarTextoLivre(String(texto || ''));

    const modelo =
      qualidadeFinal === 'eco'
        ? process.env.ANTHROPIC_MODEL_ECO || 'claude-haiku-4-5'
        : qualidadeFinal === 'premium'
          ? process.env.ANTHROPIC_MODEL_PREMIUM || 'claude-opus-4-8'
          : process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

    const entrada = normStats.tokensEstimadosDepois;
    const saida = SAIDA_ESTIMADA_TOKENS[qualidadeFinal];
    const custoUsd = custoUSD({ modelo, entrada, saida });
    // Taxa fixa/configurável — nunca busca câmbio externo a cada estimativa.
    const taxa = Number(process.env.USD_BRL_RATE) || 5.3;

    res.json({
      qualidade: qualidadeFinal,
      modelo,
      resumida,
      tokensEntradaEstimados: entrada,
      tokensSaidaEstimados: saida,
      custoUsdEstimado: custoUsd,
      custoBrlEstimado: custoUsd * taxa,
      aviso: 'Estimativa aproximada — o custo final pode variar com o cache de prompt e o tamanho real da resposta.',
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Na Vercel o app é exportado (api/index.js) e a plataforma cuida da porta.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`⚡ Report PRONIX em http://localhost:${PORT}`);
    console.log(`   Dashboard (report, acessos e números): http://localhost:${PORT}`);
    console.log(`   Dados: ${db.usandoRedis ? 'Redis (KV)' : 'arquivo local (data/)'}`);
    console.log(`   Transcrição: ${process.env.GROQ_API_KEY ? 'Groq (API)' : 'Whisper local (Python)'}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('   ⚠ Defina ADMIN_PASSWORD no .env para usar o painel de admin.');
    }
  });
}

module.exports = app;
module.exports.tipoDeAudio = tipoDeAudio;
module.exports.sanitizarCaptura = sanitizarCaptura;
