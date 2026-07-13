'use strict';

const { transcreverGroq } = require('../src/groq');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido.' });

  try {
    const { audioBase64, nome } = req.body || {};
    if (!audioBase64) return res.status(400).json({ erro: 'Nenhum áudio recebido.' });
    const buffer = Buffer.from(audioBase64, 'base64');
    const texto = await transcreverGroq(buffer, nome || 'audio.ogg');
    // Serverless não faz separação de voz (EU/LEAD): quem = null.
    res.json({ texto, quem: null, similaridade: null });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
};
