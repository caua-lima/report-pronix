'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');

const { gerarReportDireto, gerarReportDeTexto } = require('./src/report');
const { transcribeBuffer } = require('./src/transcribe');
const voz = require('./src/voiceprint');

const app = express();
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, 'output');

// Conversas longas + áudio em base64 geram payloads grandes.
app.use(express.json({ limit: '25mb' }));

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
       <p>Resumo diário de atividade:
       <a href="/dia" style="color:#25d366"><b>📊 Report do dia</b></a>.</p>
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

// GET /dia — relatório diário de atividade (registra ao longo do dia)
app.get('/dia', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dia.html'));
});

// Contadores automáticos do dia (enviados pela extensão) — guardados em data/.
const DATA_DIR = path.join(__dirname, 'data');
function arquivoDia(data) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(data || '') ? data : new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `dia_${d}.json`);
}

// POST /api/dia — a extensão envia { data, iniciados, respostas, recontatos }
app.post('/api/dia', (req, res) => {
  try {
    const { data, iniciados = 0, respostas = 0, recontatos = 0 } = req.body || {};
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      arquivoDia(data),
      JSON.stringify({ data, iniciados, respostas, recontatos, atualizado: new Date().toISOString() })
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/dia/hoje — a página /dia lê os contadores automáticos do dia
app.get('/api/dia/hoje', (_req, res) => {
  try {
    const caminho = arquivoDia(new Date().toISOString().slice(0, 10));
    if (!fs.existsSync(caminho)) return res.json({ iniciados: 0, respostas: 0, recontatos: 0, vazio: true });
    res.json(JSON.parse(fs.readFileSync(caminho, 'utf8')));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/transcrever — recebe áudio em base64 (JSON), transcreve com Whisper local
// e, se houver voz cadastrada, marca EU/LEAD.
app.post('/api/transcrever', async (req, res) => {
  try {
    const { audioBase64, nome } = req.body || {};
    if (!audioBase64) {
      return res.status(400).json({ erro: 'Nenhum áudio recebido.' });
    }
    const buffer = Buffer.from(audioBase64, 'base64');
    const ext = path.extname((nome || '').toString()) || '.ogg';
    const texto = await transcribeBuffer(buffer, ext);

    // Classificação de voz é best-effort: nunca derruba a transcrição.
    let quem = null;
    let similaridade = null;
    try {
      if (voz.temVoiceprint()) {
        const c = await voz.classificar(buffer, ext);
        quem = c.quem;
        similaridade = c.similaridade;
      }
    } catch (e) {
      console.error('[voz] classificação falhou:', e.message);
    }

    res.json({ texto, quem, similaridade });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/voz — status do cadastro da sua voz
app.get('/api/voz', (_req, res) => {
  res.json({ cadastrada: voz.temVoiceprint() });
});

// POST /api/voz/cadastrar — recebe uma amostra da sua voz e guarda a impressão vocal
app.post(
  '/api/voz/cadastrar',
  express.raw({ type: () => true, limit: '100mb' }),
  async (req, res) => {
    try {
      const buffer = req.body;
      if (!buffer || !buffer.length) {
        return res.status(400).json({ erro: 'Nenhum áudio recebido.' });
      }
      const ext = path.extname((req.query.nome || '').toString()) || '.ogg';
      const emb = await voz.embedBuffer(buffer, ext);
      voz.salvarVoiceprint(emb);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: 'Não consegui processar sua voz: ' + err.message });
    }
  }
);

// POST /api/voz/remover — apaga a voz cadastrada
app.post('/api/voz/remover', (_req, res) => {
  voz.removerVoiceprint();
  res.json({ ok: true });
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
