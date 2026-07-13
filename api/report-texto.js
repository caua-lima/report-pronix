'use strict';

const { dadosDeTexto } = require('../src/report');
const { gerarDocxBuffer } = require('../src/generateDoc');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido.' });

  try {
    const { texto, nome } = req.body || {};
    const dados = await dadosDeTexto({ texto, nome });
    const { buffer, nome: arquivo } = await gerarDocxBuffer(dados, nome || dados.lead);
    res.json({ dados, arquivo, docxBase64: buffer.toString('base64') });
  } catch (err) {
    const vazio = /Cole a conversa/i.test(err.message);
    res.status(vazio ? 400 : 500).json({ erro: err.message });
  }
};
