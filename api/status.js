'use strict';

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    ok: true,
    provider: process.env.LLM_PROVIDER || 'anthropic',
    transcricao: 'groq',
  });
};
