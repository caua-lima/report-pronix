'use strict';

// Groq (API compatível com OpenAI): transcrição de áudio (Whisper) e leitura de
// print de conversa (modelo com visão). Os dois no mesmo plano gratuito — é por
// isso que ler imagem não entra no custo por report; o que custa continua sendo
// só a geração do relatório em si, na Anthropic.
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Estourou o tempo? Mensagem clara em vez de "The operation was aborted due to timeout".
const erroDeRede = (msgTimeout) => (e) => {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(msgTimeout);
  throw e;
};

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
    signal: AbortSignal.timeout(Number(process.env.GROQ_TIMEOUT_MS) || 50000),
  }).catch(erroDeRede('A transcrição demorou demais. Tente de novo.'));

  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    throw new Error(`Groq respondeu ${r.status}: ${detalhe.slice(0, 250)}`);
  }
  return (await r.text()).trim();
}

// Instrução do print -> conversa. A saída tem que sair no MESMO formato que o
// modo manual já espera (VENDEDOR:/LEAD: por linha), pra cair direto na caixa da
// conversa e seguir pelo fluxo de sempre — nada de um caminho novo de report.
const PROMPT_IMAGEM = `Você recebe o PRINT de uma conversa (WhatsApp ou Instagram Direct). Transcreva a conversa como texto puro, uma mensagem por linha, na ordem em que aparecem (de cima para baixo).

REGRAS:
- Mensagem alinhada à DIREITA (a bolha de quem tirou o print) começa com "VENDEDOR:".
- Mensagem alinhada à ESQUERDA começa com "LEAD:".
- Copie o texto EXATAMENTE como está escrito. Não corrija, não resuma, não traduza, não complete.
- Ignore o que não é mensagem: relógio e bateria do celular, nome no cabeçalho, "digitando...", barra de busca, botões.
- Mensagem sem texto: escreva "[áudio]", "[imagem]" ou "[figurinha]" na linha, com o remetente certo.
- NUNCA invente conteúdo. Se um trecho estiver cortado ou ilegível, escreva "[ilegível]".
- Responda SÓ com a transcrição, sem nenhum comentário antes ou depois.`;

/**
 * Lê um print de conversa e devolve a transcrição em texto (VENDEDOR:/LEAD:).
 * Usa o modelo com visão do Groq — mesmo plano gratuito da transcrição de áudio.
 * @param {Buffer} buffer imagem
 * @param {string} mime ex.: 'image/jpeg'
 * @returns {Promise<string>}
 */
async function lerImagemGroq(buffer, mime = 'image/jpeg') {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY não configurada — é ela que faz a leitura de imagem sair de graça.');
  const model = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const r = await fetch(GROQ_CHAT_URL, {
    signal: AbortSignal.timeout(Number(process.env.GROQ_TIMEOUT_MS) || 50000),
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0, // transcrição: queremos o que está escrito, não criatividade
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT_IMAGEM },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  }).catch(erroDeRede('A leitura da imagem demorou demais. Tente de novo.'));

  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    throw new Error(`Groq (visão) respondeu ${r.status}: ${detalhe.slice(0, 250)}`);
  }
  const j = await r.json().catch(() => ({}));
  const texto = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  if (!texto) throw new Error('O modelo não devolveu texto para esta imagem.');
  return texto;
}

module.exports = { transcreverGroq, lerImagemGroq };
