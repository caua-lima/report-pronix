'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');

const { dadosDireto, dadosDeTexto, PROMPT_VERSAO } = require('./src/report');
const { gerarPdfBuffer } = require('./src/generatePdf');
const { transcribeBuffer } = require('./src/transcribe');
const { normalizarConversa, normalizarTextoLivre } = require('./src/conversation-normalizer');
const { calcularReportKey } = require('./src/idempotencia');
const { custoUSD } = require('./src/precos');
const usuarios = require('./src/usuarios');
const stats = require('./src/stats');
const db = require('./src/db');
const base = require('./src/base');

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
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
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

app.delete('/api/admin/usuarios/:id', admin, async (req, res) => {
  try {
    await usuarios.remover(req.params.id);
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
 * Números do dashboard: quantos reports, por quem, quanto custou.
 * Filtros: ?de=YYYY-MM-DD&ate=YYYY-MM-DD&sdr=Nome (todos opcionais).
 */
app.get('/api/admin/stats', admin, async (req, res) => {
  try {
    const dataOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
    res.json(
      await stats.resumo({
        de: dataOk(req.query.de),
        ate: dataOk(req.query.ate),
        sdr: req.query.sdr ? String(req.query.sdr) : undefined,
      })
    );
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Report (extensão e modo manual) — devolve o PDF em base64 (sem disco).
// ---------------------------------------------------------------------------
async function responderReport(req, res, dados, nome, origem, reportKey) {
  // Quem assina o report é o dono da chave, não uma variável do servidor.
  dados.sdr = req.usuario.nome;
  const uso = dados.uso;
  delete dados.uso; // consumo é assunto do admin: não vai junto do report.
  const buffer = await gerarPdfBuffer(dados);
  const arquivo = nomeArquivoPdf(dados.lead || nome);
  // O report é o que importa: se o registro falhar, não derruba a entrega do PDF.
  await stats
    .registrar({
      usuarioId: req.usuario.id,
      usuarioNome: req.usuario.nome,
      lead: dados.lead || nome || '',
      origem,
      uso,
      reportKey,
      arquivo,
      qualidade: (uso && uso.qualidade) || 'standard',
    })
    .catch((err) => console.error('Falha ao registrar o report:', err.message));
  res.json({ dados, arquivo, arquivoBase64: buffer.toString('base64') });
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
        existente: { id: existente.id, quando: existente.quando, lead: existente.lead, arquivo: existente.arquivo },
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
    const { mensagens, nome, qualidade } = req.body || {};
    const qualidadeFinal = qualidadeValida(qualidade);
    const { historico: normalizadas } = normalizarConversa(Array.isArray(mensagens) ? mensagens : []);
    reportKey = calcularReportKey({ historicoNormalizado: normalizadas, promptVersao: PROMPT_VERSAO, qualidade: qualidadeFinal });

    if (!(await checarDuplicataETravar(req, res, reportKey))) return;

    const dados = await dadosDireto({ mensagens, nome, sdr: req.usuario.nome, qualidade: qualidadeFinal });
    await responderReport(req, res, dados, nome, 'extensao', reportKey);
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
    abertura: txt(d.abertura).trim(),
    frase_impacto: txt(d.frase_impacto).trim(),
  };
}

// ---------------------------------------------------------------------------
// Transcrição de áudio (Whisper local)
// ---------------------------------------------------------------------------
app.post('/api/transcrever', auth, async (req, res) => {
  try {
    const { audioBase64, nome } = req.body || {};
    if (!audioBase64) return res.status(400).json({ erro: 'Nenhum áudio recebido.' });
    const buffer = Buffer.from(audioBase64, 'base64');
    const ext = path.extname((nome || '').toString()) || '.ogg';
    let texto = await transcribeBuffer(buffer, ext);
    // Ponto único onde áudio vira texto (extensão e modo manual passam por aqui):
    // corta transcrição excepcionalmente longa antes dela virar tokens de prompt.
    const limite = Number(process.env.MAX_AUDIO_TRANSCRIPTION_CHARS) || 6000;
    if (texto.length > limite) texto = texto.slice(0, limite) + '…';

    res.json({ texto });
  } catch (err) {
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
