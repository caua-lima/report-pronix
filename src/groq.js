'use strict';

// Transcrição de áudio via API do Groq (Whisper, compatível com OpenAI).
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Transcreve um buffer de áudio usando o Groq.
 * @param {Buffer} buffer
 * @param {string} [filename='audio.ogg']
 * @returns {Promise<string>} texto transcrito
 */
async function transcreverGroq(buffer, filename = 'audio.ogg') {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY não configurada.');
  const model = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', model);
  form.append('language', 'pt');
  form.append('response_format', 'text');

  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    throw new Error(`Groq respondeu ${r.status}: ${detalhe.slice(0, 250)}`);
  }
  return (await r.text()).trim();
}

module.exports = { transcreverGroq };
