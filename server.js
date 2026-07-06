'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');

const { loadConversation, listarContatosComHistorico, jidToNumero } = require('./src/store');
const { gerarReport } = require('./src/report');

const app = express();
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, 'output');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Normaliza um número/JID para o JID completo do WhatsApp.
function paraJid(numeroOuJid) {
  const num = jidToNumero(numeroOuJid);
  return `${num}@s.whatsapp.net`;
}

// GET / — página principal
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GET /api/contatos — lista contatos monitorados que já têm arquivo em data/
app.get('/api/contatos', (_req, res) => {
  try {
    const monitorados = (process.env.WATCHED_CONTACTS || '')
      .split(',')
      .map((n) => n.replace(/[^0-9]/g, ''))
      .filter(Boolean);

    const comHistorico = new Set(listarContatosComHistorico());

    // Une os monitorados do .env com quaisquer arquivos já existentes em data/.
    const numeros = new Set([...monitorados, ...comHistorico]);

    const lista = [...numeros].map((numero) => ({
      jid: paraJid(numero),
      numero,
      temHistorico: comHistorico.has(numero),
    }));

    res.json(lista);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/conversa/:jid — histórico cru e completo (botão "Ler conversa")
app.get('/api/conversa/:jid', (req, res) => {
  try {
    const historico = loadConversation(req.params.jid);
    res.json(historico);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/report/:jid — gera o relatório (botão "Gerar Report")
app.post('/api/report/:jid', async (req, res) => {
  try {
    const { dados, arquivo } = await gerarReport(req.params.jid);
    res.json({ dados, arquivo: path.basename(arquivo) });
  } catch (err) {
    const semHistorico = /Nenhuma conversa salva/i.test(err.message);
    res.status(semHistorico ? 404 : 500).json({ erro: err.message });
  }
});

// GET /api/download/:arquivo — baixa o .docx gerado
app.get('/api/download/:arquivo', (req, res) => {
  // Evita path traversal: só o basename é aceito.
  const nome = path.basename(req.params.arquivo);
  const caminho = path.join(OUTPUT_DIR, nome);
  if (!nome.endsWith('.docx') || !fs.existsSync(caminho)) {
    return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  }
  res.download(caminho, nome);
});

app.listen(PORT, () => {
  console.log(`🌐 Interface web em http://localhost:${PORT}`);
});
