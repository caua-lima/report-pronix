'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');

const { gerarReportDireto, gerarReportDeTexto } = require('./src/report');

const app = express();
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, 'output');

// Conversas longas geram payloads grandes.
app.use(express.json({ limit: '10mb' }));

// CORS — a extensão (origem chrome-extension://) chama este servidor local.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Página simples de status (a UI de verdade é a extensão).
app.get('/', (_req, res) => {
  res.type('html').send(
    `<!doctype html><meta charset="utf-8">
     <title>Closer Report</title>
     <div style="font-family:sans-serif;max-width:520px;margin:60px auto;line-height:1.5">
       <h2>✅ Servidor do Closer Report rodando</h2>
       <p>Deixe este servidor ligado e use a <b>extensão no WhatsApp Web</b>:
       abra uma conversa e clique em <b>Gerar Report</b>.</p>
       <p>Ou cole a conversa manualmente no
       <a href="/manual" style="color:#25d366"><b>📝 Modo manual</b></a>
       (útil quando você já tem a conversa/áudios transcritos em texto).</p>
       <p style="color:#888">Porta ${PORT} · provedor: ${process.env.LLM_PROVIDER || 'anthropic'}</p>
     </div>`
  );
});

// Health check para a extensão testar a conexão.
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, provider: process.env.LLM_PROVIDER || 'anthropic' });
});

// POST /api/report-direto — recebe a conversa raspada e devolve dados + arquivo .docx
app.post('/api/report-direto', async (req, res) => {
  try {
    const { mensagens, nome } = req.body || {};
    const { dados, arquivo } = await gerarReportDireto({ mensagens, nome });
    res.json({ dados, arquivo: path.basename(arquivo) });
  } catch (err) {
    const semMsgs = /Nenhuma mensagem/i.test(err.message);
    res.status(semMsgs ? 400 : 500).json({ erro: err.message });
  }
});

// GET /manual — página para colar a conversa manualmente e gerar o report
app.get('/manual', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manual.html'));
});

// POST /api/report-texto — gera o report a partir da conversa colada como texto
app.post('/api/report-texto', async (req, res) => {
  try {
    const { texto, nome } = req.body || {};
    const { dados, arquivo } = await gerarReportDeTexto({ texto, nome });
    res.json({ dados, arquivo: path.basename(arquivo) });
  } catch (err) {
    const vazio = /Cole a conversa/i.test(err.message);
    res.status(vazio ? 400 : 500).json({ erro: err.message });
  }
});

// GET /api/download/:arquivo — baixa o .docx gerado
app.get('/api/download/:arquivo', (req, res) => {
  const nome = path.basename(req.params.arquivo); // evita path traversal
  const caminho = path.join(OUTPUT_DIR, nome);
  if (!nome.endsWith('.docx') || !fs.existsSync(caminho)) {
    return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  }
  res.download(caminho, nome);
});

app.listen(PORT, () => {
  console.log(`✅ Closer Report rodando em http://localhost:${PORT}`);
  console.log('   Deixe ligado e use a extensão no WhatsApp Web.');
});
