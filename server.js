'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');

const { dadosDireto, dadosDeTexto } = require('./src/report');
const { gerarPdfBuffer } = require('./src/generatePdf');
const { transcribeBuffer } = require('./src/transcribe');
const usuarios = require('./src/usuarios');
const stats = require('./src/stats');

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
function auth(req, res, next) {
  const chave = req.get('x-cr-key') || req.query.chave;
  const u = usuarios.porChave(chave && String(chave).trim());
  if (!u) {
    return res.status(401).json({
      erro: 'Chave inválida ou ausente. Peça sua chave ao admin e cole no popup da extensão.',
    });
  }
  req.usuario = u;
  next();
}

/** Exige a senha de admin (ADMIN_PASSWORD no .env). */
function admin(req, res, next) {
  const esperada = process.env.ADMIN_PASSWORD;
  if (!esperada) {
    return res.status(500).json({ erro: 'ADMIN_PASSWORD não configurada no .env do servidor.' });
  }
  const senha = req.get('x-admin-pass') || (req.body && req.body.senha) || req.query.senha;
  if (senha !== esperada) return res.status(401).json({ erro: 'Senha de admin incorreta.' });
  next();
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

// Status é público (serve para o botão "Testar" da extensão).
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, provider: process.env.LLM_PROVIDER || 'anthropic' });
});

/** Quem sou eu (valida a chave e devolve o nome). */
app.get('/api/eu', auth, (req, res) => {
  res.json({ ok: true, nome: req.usuario.nome, id: req.usuario.id });
});

// ---------------------------------------------------------------------------
// Admin: criar/listar/remover acessos da equipe
// ---------------------------------------------------------------------------
app.post('/api/admin/login', admin, (_req, res) => res.json({ ok: true }));

app.get('/api/admin/usuarios', admin, (_req, res) => {
  res.json({ usuarios: usuarios.listar() });
});

app.post('/api/admin/usuarios', admin, (req, res) => {
  try {
    const u = usuarios.criar(req.body && req.body.nome);
    res.json({ ok: true, usuario: u });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.delete('/api/admin/usuarios/:id', admin, (req, res) => {
  usuarios.remover(req.params.id);
  res.json({ ok: true });
});

/** Números do dashboard: quantos reports, por quem, quando. */
app.get('/api/admin/stats', admin, (_req, res) => res.json(stats.resumo()));

// ---------------------------------------------------------------------------
// Report (extensão e modo manual) — devolve o PDF em base64 (sem disco).
// ---------------------------------------------------------------------------
async function responderReport(req, res, dados, nome, origem) {
  const buffer = await gerarPdfBuffer(dados);
  stats.registrar({
    usuarioId: req.usuario.id,
    usuarioNome: req.usuario.nome,
    lead: dados.lead || nome || '',
    origem,
  });
  const empresa = (process.env.COMPANY_NAME || 'PRONIX').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PRONIX';
  const slug = String(dados.lead || nome || 'lead')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'lead';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const carimbo = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  res.json({
    dados,
    arquivo: `${empresa}_relatorio_${slug}_${carimbo}.pdf`,
    arquivoBase64: buffer.toString('base64'),
  });
}

app.post('/api/report-direto', auth, async (req, res) => {
  try {
    const { mensagens, nome } = req.body || {};
    const dados = await dadosDireto({ mensagens, nome });
    await responderReport(req, res, dados, nome, 'extensao');
  } catch (err) {
    res.status(/Nenhuma mensagem/i.test(err.message) ? 400 : 500).json({ erro: err.message });
  }
});

app.post('/api/report-texto', auth, async (req, res) => {
  try {
    const { texto, nome } = req.body || {};
    const dados = await dadosDeTexto({ texto, nome });
    await responderReport(req, res, dados, nome, 'manual');
  } catch (err) {
    res.status(/Cole a conversa/i.test(err.message) ? 400 : 500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Transcrição de áudio (Whisper local)
// ---------------------------------------------------------------------------
app.post('/api/transcrever', auth, async (req, res) => {
  try {
    const { audioBase64, nome } = req.body || {};
    if (!audioBase64) return res.status(400).json({ erro: 'Nenhum áudio recebido.' });
    const buffer = Buffer.from(audioBase64, 'base64');
    const ext = path.extname((nome || '').toString()) || '.ogg';
    const texto = await transcribeBuffer(buffer, ext);

    res.json({ texto });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`⚡ PRONIX Closer Report em http://localhost:${PORT}`);
  console.log(`   Dashboard (report, acessos e números): http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('   ⚠ Defina ADMIN_PASSWORD no .env para usar o painel de admin.');
  }
});
