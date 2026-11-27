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

// Frases que o Whisper inventa em ruído (vêm de legendas de vídeo do treino dele): ninguém fala isso numa ligação.
const INVENCOES = /\blegendas? (por|pela) [^.!?]*|\blegendas pela comunidade[^.!?]*|\bamara\.org\b|obrigad[oa] por assistir[^.!?]*|inscreva-se no (nosso )?canal[^.!?]*|at[ée] o pr[óo]ximo v[íi]deo[^.!?]*/gi;

/** Tira as invenções conhecidas e o laço sem pontuação ("Mercado Pago, CNPJ, Mercado Pago, CNPJ…", "an an an an"). */
function semInvencoes(texto) {
  return String(texto)
    .replace(INVENCOES, ' ')
    .replace(/(?<![\p{L}\p{N}])((?:[\p{L}\p{N}]+[\s,]+){0,3}[\p{L}\p{N}]+)(?:[\s,]+\1(?![\p{L}\p{N}])){3,}/giu, '$1')
    .replace(/\b(Pornix|Pr[ôo]nix|Pr[ôo]nia)\b/g, 'Pronix')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s.,;!?-]+$/, '')
    .trim();
}

/** "Sim. Sim. Sim. Sim." ou a mesma frase em laço: fica no máximo duas vezes seguidas. */
function semRepeticaoEmLaco(texto) {
  const frases = String(texto).match(/[^.!?]+[.!?]*/g) || [];
  const igual = (a, b) => a && b && a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return frases.filter((f, i) => !(igual(f, frases[i - 1]) && igual(f, frases[i - 2]))).join('').trim();
}

/**
 * Tira o que o Whisper inventa em silêncio e ruído: trecho que o próprio modelo marca como provável silêncio e sem
 * confiança, ou texto em laço (muito repetitivo). Fala baixa mas reconhecida com confiança fica.
 */
function limparSegmentos(segments) {
  const num = (v, padrao) => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);
  const saida = [];
  for (const x of segments) {
    const silencio = num(x.no_speech_prob, 0) > 0.6 && num(x.avg_logprob, 0) < -0.7;
    const semSentido = num(x.compression_ratio, 1) > 2.4 && num(x.avg_logprob, 0) < -0.5;
    if (silencio || semSentido) continue;
    const texto = semInvencoes(semRepeticaoEmLaco(String(x.text || '').trim()));
    if (!texto) continue;
    const anterior = saida[saida.length - 1];
    const antes = saida[saida.length - 2];
    if (anterior && antes && anterior.texto === texto && antes.texto === texto) continue;
    saida.push({ inicio: Number(x.start) || 0, fim: Number(x.end) || 0, texto });
  }
  return saida;
}

/**
 * Transcreve um buffer de áudio usando o Groq.
 * @param {Buffer} buffer
 * @param {string} [filename='audio.ogg']
 * @param {{ segmentos?: boolean }} [opcoes] segmentos: devolve também cada trecho com o tempo (gravação de ligação)
 * @returns {Promise<string|{texto: string, segmentos: Array<{inicio: number, fim: number, texto: string}>}>}
 */
async function transcreverGroq(buffer, filename = 'audio.ogg', { segmentos = false } = {}) {
  if (!segmentos) return pedirTranscricao(buffer, filename, {});
  // Às vezes o serviço devolve um trecho sem nenhum acento, com os pedaços acentuados faltando ("voc", "cria" no
  // lugar de "você", "criação"). Detectado, pede de novo de outro jeito e fica a resposta menos estragada.
  const modelo = process.env.GROQ_MODEL_LIGACAO || 'whisper-large-v3';
  const tentativas = [{ modelo, temperatura: 0 }, { modelo, temperatura: 0.2 }, { modelo: 'whisper-large-v3-turbo', temperatura: 0 }];
  let melhor = null;
  for (const t of tentativas) {
    let r;
    try { r = await pedirTranscricao(buffer, filename, { segmentos: true, ...t }); } catch (e) {
      if (melhor) break; // já há uma resposta: a nova tentativa era só para melhorar
      throw e;
    }
    const estrago = r.segmentos.filter((x) => faltamAcentos(x.texto)).length;
    if (!melhor || estrago < melhor.estrago) melhor = { r, estrago };
    if (!estrago) break;
  }
  return melhor.r;
}

/** Fala em português com 8 palavras ou mais sem um acento e sem pontuação, ou com "voc" solto: veio faltando pedaço. */
function faltamAcentos(texto) {
  const t = String(texto || '');
  if (/(^|\s)voc(\s|$)/i.test(t)) return true;
  return t.split(/\s+/).length >= 8 && !/[áàâãéêíóôõúç.,!?]/i.test(t);
}

async function pedirTranscricao(buffer, filename, { segmentos = false, modelo, temperatura = 0 } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY não configurada.');
  // Ligação gravada: o modelo completo (mais preciso que o turbo, usado nos áudios curtos da conversa).
  const model = modelo || process.env.GROQ_MODEL || 'whisper-large-v3-turbo';

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', model);
  form.append('language', 'pt');
  form.append('response_format', segmentos ? 'verbose_json' : 'text');
  // Sem "prompt" de vocabulário: nos trechos baixos o modelo copiava a lista de termos como se alguém tivesse falado.
  if (segmentos) form.append('temperature', String(temperatura));

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
  if (!segmentos) return (await r.text()).trim();
  const j = await r.json().catch(() => ({}));
  const brutos = Array.isArray(j.segments) ? j.segments : [];
  const lista = limparSegmentos(brutos);
  // Com trechos, o texto sai deles (já sem o ruído); sem trechos na resposta, vale o texto corrido.
  return { texto: (brutos.length ? lista.map((x) => x.texto).join(' ') : String(j.text || '')).trim(), segmentos: lista };
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
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  // O Groq troca os modelos de tempos em tempos: se o configurado saiu do ar, tenta o seguinte.
  const modelos = filaDeModelos(process.env.GROQ_VISION_MODEL, ['qwen/qwen3.6-27b', 'qwen/qwen3.8-27b']);
  let r;
  for (let i = 0; i < modelos.length; i++) {
    r = await fetch(GROQ_CHAT_URL, {
      signal: AbortSignal.timeout(Number(process.env.GROQ_TIMEOUT_MS) || 50000),
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelos[i],
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
    if (r.ok || i === modelos.length - 1) break;
    const detalhe = await r.clone().text().catch(() => '');
    if (!modeloIndisponivel(r.status, detalhe)) break;
  }

  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    throw new Error(`Groq (visão) respondeu ${r.status}: ${detalhe.slice(0, 250)}`);
  }
  const j = await r.json().catch(() => ({}));
  const texto = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  if (!texto) throw new Error('O modelo não devolveu texto para esta imagem.');
  return texto;
}

/** Modelo configurado primeiro, depois os padrões, sem repetir. */
function filaDeModelos(configurado, padroes) {
  return [...new Set([String(configurado || '').trim(), ...padroes].filter(Boolean))];
}

/** O erro é do MODELO (saiu do ar, não existe, não está no plano)? Aí vale tentar o próximo da fila. */
function modeloIndisponivel(status, detalhe) {
  if (status === 404) return true;
  return (status === 400 || status === 403) && /model|decommission|deprecat|not (found|supported|available)|does not exist/i.test(String(detalhe || ''));
}

// Modelos de texto do plano gratuito do Groq, do melhor para o reserva. O plano gratuito limita
// tokens por minuto (cerca de 8 mil por modelo): por isso quem chama mantém o pedido enxuto.
const MODELOS_CHAT = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

/**
 * Chat de texto no Groq (plano gratuito: sem custo, com limite de chamadas). Devolve o texto da resposta.
 * Tenta a fila de modelos: se um saiu do ar ou bateu no limite, passa para o seguinte.
 * `prazoMs` é o tempo total que a chamada pode levar, somando as tentativas (a função da Vercel tem
 * tempo contado: quem faz mais de um pedido reparte o tempo entre eles).
 */
async function chatGroq({ system, user, modelo, maxTokens = 900, json = true, prazoMs }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY não configurada — é ela que mantém a IA gratuita sem custo.');
  const modelos = filaDeModelos(modelo, MODELOS_CHAT);
  const porTentativa = Number(process.env.GROQ_TIMEOUT_MS) || 50000;
  const fim = Number(prazoMs) > 0 ? Date.now() + Number(prazoMs) : 0;
  let ultimoErro = null;
  let limite = false;

  for (const model of modelos) {
    const raciocina = /gpt-oss/.test(model); // modelos que "pensam" gastam parte da saída pensando
    // 1ª tentativa com resposta em JSON; se o modelo recusar o parâmetro, tenta sem ele.
    for (const comExtras of [true, false]) {
      const corpo = {
        model,
        temperature: 0.4,
        max_tokens: raciocina ? maxTokens + 600 : maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
      if (comExtras && json) corpo.response_format = { type: 'json_object' };
      if (comExtras && raciocina) corpo.reasoning_effort = 'low';
      const resta = fim ? fim - Date.now() : porTentativa;
      if (resta < 2000) throw new Error('A IA gratuita demorou demais. Tente de novo.');
      const r = await fetch(GROQ_CHAT_URL, {
        signal: AbortSignal.timeout(Math.min(porTentativa, resta)),
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      }).catch(erroDeRede('A IA gratuita demorou demais. Tente de novo.'));

      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const t = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
        if (t) return t;
        ultimoErro = new Error('A IA gratuita não devolveu texto.');
        break; // próximo modelo
      }
      const detalhe = await r.text().catch(() => '');
      if (r.status === 401) throw new Error('GROQ_API_KEY inválida. Confira a variável na Vercel.');
      if (r.status === 429 || r.status === 413) {
        // Limite por minuto/dia deste modelo (ou pedido grande demais para ele): tenta o próximo.
        limite = true;
        ultimoErro = new Error(`Groq respondeu ${r.status} em ${model}`);
        break;
      }
      ultimoErro = new Error(`Groq respondeu ${r.status} em ${model}: ${detalhe.slice(0, 200)}`);
      if (modeloIndisponivel(r.status, detalhe)) break; // próximo modelo
      if (r.status === 400 && comExtras) continue; // parâmetro não aceito: de novo, sem os extras
      break;
    }
  }
  if (limite) throw new Error('O limite gratuito da IA foi atingido por agora. Tente de novo em 1 minuto.');
  throw ultimoErro || new Error('A IA gratuita não respondeu.');
}

module.exports = { limparSegmentos, faltamAcentos, transcreverGroq, lerImagemGroq, chatGroq, filaDeModelos, modeloIndisponivel, MODELOS_CHAT };
