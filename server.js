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
const { gerarResumoRapido } = require('./src/resumoRapido');
const { normalizarConsciencia } = require('./src/consciencia');

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
      if (u && u.papel === 'admin') {
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
app.get('/api/eu', auth, (req, res) => {
  res.json({ ok: true, nome: req.usuario.nome, id: req.usuario.id, papel: req.usuario.papel });
});

// ---------------------------------------------------------------------------
// Admin: criar/listar/remover acessos da equipe
// ---------------------------------------------------------------------------
app.post('/api/admin/login', admin, (_req, res) => res.json({ ok: true }));

app.get('/api/admin/usuarios', admin, async (_req, res) => {
  try {
    res.json({ usuarios: await usuarios.listar() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/usuarios', admin, async (req, res) => {
  try {
    const u = await usuarios.criar(req.body && req.body.nome, req.body && req.body.papel);
    res.json({ ok: true, usuario: u });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

/** Liga/desliga a ficha do RD Station no WhatsApp para um usuário (aba Acessos). */
app.patch('/api/admin/usuarios/:id', admin, async (req, res) => {
  try {
    if (typeof (req.body || {}).fichaCrm !== 'boolean') return res.status(400).json({ erro: 'Informe fichaCrm (true/false).' });
    const ok = await usuarios.definirFichaCrm(req.params.id, req.body.fichaCrm);
    if (!ok) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/admin/usuarios/:id', admin, async (req, res) => {
  try {
    await usuarios.remover(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin: closers (roster pra marcar quem fez cada call — sem login, só nome+e-mail)
// ---------------------------------------------------------------------------
app.get('/api/admin/closers', admin, async (_req, res) => {
  try {
    res.json({ closers: await closers.listar() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/closers', admin, async (req, res) => {
  try {
    const c = await closers.criar(req.body && req.body.nome, req.body && req.body.email);
    res.json({ ok: true, closer: c });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.delete('/api/admin/closers/:id', admin, async (req, res) => {
  try {
    await closers.remover(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Base de conhecimento (playbook) que entra em todo report.
app.get('/api/admin/base', admin, async (_req, res) => {
  try {
    res.json(await base.ler());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/base', admin, async (req, res) => {
  try {
    res.json({ ok: true, base: await base.salvar(req.body || {}) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Tira um report do histórico (testes que sujam os números). */
app.delete('/api/admin/reports/:id', admin, async (req, res) => {
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
app.patch('/api/admin/reports/:id/resultado', admin, async (req, res) => {
  try {
    const body = req.body || {};
    const tem = (k) => Object.prototype.hasOwnProperty.call(body, k);
    // Só entra no que veio no pedido: mudar um campo não apaga os outros. Se vier
    // "versao", o servidor recusa (409) quando o report já foi alterado por outra pessoa.
    const campos = {};
    ['leadEmail', 'resultado', 'dataReuniao', 'dataFechamento'].forEach((k) => {
      if (tem(k)) campos[k] = body[k];
    });
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
    const feito = await stats.atualizarResultado(req.params.id, campos, {
      versaoEsperada: tem('versao') ? body.versao : undefined,
    });
    if (!feito) return res.status(404).json({ erro: 'Report não encontrado.' });
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
app.get('/api/admin/stats', admin, async (req, res) => {
  try {
    res.json(await stats.resumo(filtroDaQuery(req.query)));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/** Baixa o PDF de um report já gerado (guardado em src/pdfStorage.js). */
app.get('/api/admin/reports/:id/pdf', admin, async (req, res) => {
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
    const permitido = r && (req.usuario.papel === 'admin' || r.usuarioId === req.usuario.id);
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
app.get('/api/admin/reports/pdf-zip', admin, async (req, res) => {
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
    // Só para quem o admin liberou (aba Acessos → "Ficha RD"). Para os outros é como se o CRM não
    // estivesse ligado: a extensão não mostra nada e o RD nem é consultado.
    if (!req.usuario.fichaCrm) return res.json({ configurado: false });
    const { telefone, nome, contatoId } = req.body || {};
    res.json(await crm.consultarLead({ telefone, nome, contatoId }));
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

/**
 * Resumo rápido da conversa aberta (botão no cartão do WhatsApp): cenário, onde parou, última
 * pergunta e próximo passo — para retomar um lead sem reler a conversa nem reouvir os áudios.
 * Liberado junto com a ficha do RD (aba Acessos). Conversa igual = resumo do cache, sem custo.
 */
app.post('/api/resumo-rapido', auth, async (req, res) => {
  try {
    if (!req.usuario.fichaCrm) return res.status(403).json({ erro: 'Resumo rápido não liberado para este usuário.' });
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
app.post('/api/admin/crm/teste', admin, async (req, res) => {
  try {
    const { telefone, nome } = req.body || {};
    res.json(await crm.consultarLead({ telefone, nome }, { diagnostico: true, semCache: true }));
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Reports do dia do PRÓPRIO usuário — o .zip que vai para o líder no fim do dia.
// Quando o mesmo lead teve mais de um report no dia, vale o último (src/diario.js).
// Qualquer usuário com chave usa; cada um só enxerga os seus.
// ---------------------------------------------------------------------------
async function meusReportsDoDia(usuario, dia) {
  const doDia = await stats.listar({ de: dia, ate: dia });
  return diario.marcarUltimos(doDia.filter((r) => r.usuarioId === usuario.id));
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
        substituidoPor: r.substituidoPor,
        geracoes: r.geracoes,
      })),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
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

async function responderReport(req, res, dados, nome, origem, reportKey, captura) {
  // Quem assina o report é o dono da chave, não uma variável do servidor.
  dados.sdr = req.usuario.nome;
  const uso = dados.uso;
  delete dados.uso; // consumo é assunto do admin: não vai junto do report.
  const meta = dados._meta || {};
  delete dados._meta; // métricas internas de qualidade: também não vão pro cliente.
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
    })
    .catch((err) => console.error('Falha ao registrar o report:', err.message));
  await pdfStorage
    .salvar(id, base64, arquivo)
    .catch((err) => console.error('Falha ao salvar o PDF do report:', err.message));
  res.json({ dados, arquivo, arquivoBase64: base64 });
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
          podeAbrir: req.usuario.papel === 'admin' || existente.usuarioId === req.usuario.id,
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
    const { mensagens, nome, qualidade, captureQuality } = req.body || {};
    const qualidadeFinal = qualidadeValida(qualidade);
    const { historico: normalizadas } = normalizarConversa(Array.isArray(mensagens) ? mensagens : []);
    reportKey = calcularReportKey({ historicoNormalizado: normalizadas, promptVersao: PROMPT_VERSAO, qualidade: qualidadeFinal });

    if (!(await checarDuplicataETravar(req, res, reportKey))) return;

    const dados = await dadosDireto({ mensagens, nome, sdr: req.usuario.nome, qualidade: qualidadeFinal });
    await responderReport(req, res, dados, nome, 'extensao', reportKey, sanitizarCaptura(captureQuality));
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
    console.log(`⚡ PRONIX Closer Report em http://localhost:${PORT}`);
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
