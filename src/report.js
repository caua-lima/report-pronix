'use strict';

require('dotenv').config();

const { gerarDocx } = require('./generateDoc');

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// Chaves fixas esperadas no JSON do relatório.
const CAMPOS_LISTA = [
  'perfil_contexto',
  'momento_atual',
  'sinais_tracao',
  'capacidade_decisao',
  'agendamento_status',
  'leitura_estrategica',
  'closer_deve_bater',
];
const CAMPOS_TEXTO = ['lead', 'status', 'nicho', 'investimento', 'frase_impacto'];

const EXEMPLO_FEWSHOT = {
  lead: 'Vitor da Silva',
  status: 'Loja física + e-commerce',
  nicho: 'Moto peças',
  investimento: 'Mais de R$5.000',
  perfil_contexto: [
    'Vitor está saindo do CLT com o objetivo de ganhar qualidade de vida.',
    'Já vende no Mercado Livre há 15 dias e está estruturando o e-commerce com foco em crescimento.',
    'Tem uma loja física com a irmã, com divisão 50/50 nas decisões de investimento.',
  ],
  momento_atual: [
    'Hoje a operação gira em torno de uma loja física já existente e da expansão para o digital.',
    'Ele vende eletrônicos, fones e também uma pistola de alta pressão.',
    'Ainda não tem Full liberado e está trocando o CNAE do ME.',
  ],
  sinais_tracao: [
    'Em 15 dias no Mercado Livre já realizou 104 vendas.',
    'Isso mostra que ele já superou a barreira de começar e está validando produto na prática.',
    'O próximo passo é parar de depender só do impulso inicial e estruturar a operação para escala.',
  ],
  capacidade_decisao: [
    'O comercial confirmou que há cerca de R$10 mil em estoque hoje e que a intenção é usar metade para o projeto.',
    'A decisão é compartilhada com a irmã na operação da loja física, mas ele está à frente do movimento digital.',
    'O investimento disponível é suficiente para avançar com organização e estratégia.',
  ],
  agendamento_status: [
    'A reunião ficou confirmada para hoje, 06/07/2026, às 14h.',
    'O grupo de alinhamento já foi encaminhado e o link será enviado por lá.',
    'O contato mostrou boa abertura e seguiu as orientações de horários e alinhamento.',
  ],
  leitura_estrategica: [
    'O lead já tem experiência prática, entende operação e está vendendo rápido, mas ainda precisa de estrutura para sair do modo correria.',
    'O foco da conversa deve ser como acelerar a operação, organizar o catálogo e liberar Full.',
    'Como ele quer sair do CLT por qualidade de vida, a reunião precisa mostrar caminho de transição com previsibilidade.',
  ],
  closer_deve_bater: [
    'Validar a tração inicial de 104 vendas em 15 dias.',
    'Mostrar como usar a estrutura da loja física para sustentar a operação digital.',
    'Explicar o caminho para liberar Full e padronizar o crescimento.',
    'Conectar a operação atual ao objetivo de qualidade de vida fora do CLT.',
  ],
  frase_impacto:
    'Ele já vendeu muito rápido no começo; agora a reunião precisa mostrar como transformar tração em estrutura para ele sair do CLT com segurança e sem perder o ritmo.',
};

const SYSTEM_PROMPT = `Você é um assistente de pré-vendas que lê a conversa completa de WhatsApp entre um vendedor (pré-vendedor) e um lead e produz um relatório de handoff para o closer.

REGRAS OBRIGATÓRIAS:
- Responda APENAS com um objeto JSON válido, sem texto antes ou depois, sem blocos de markdown.
- Use EXATAMENTE estas chaves, todas presentes, nada além delas: "lead", "status", "nicho", "investimento", "perfil_contexto", "momento_atual", "sinais_tracao", "capacidade_decisao", "agendamento_status", "leitura_estrategica", "closer_deve_bater", "frase_impacto".
- "lead", "status", "nicho", "investimento" e "frase_impacto" são strings.
- Os demais campos são arrays de strings (2 a 4 bullets curtos, linguagem direta e comercial, sem enrolação).
- Use SOMENTE informações que realmente apareceram na conversa. NÃO invente números, datas ou fatos.
- Se um campo não tiver informação suficiente na conversa, preencha com "Não identificado na conversa" (string) ou, no caso de arrays, com um único item ["Não identificado na conversa"].
- "frase_impacto" é uma frase única e impactante, sem aspas dentro do texto.`;

function montarHistoricoFormatado(historico) {
  return historico
    .map((m) => {
      const quem = m.from === 'eu' ? 'VENDEDOR' : 'LEAD';
      const tipo = m.type === 'audio' ? ' (áudio transcrito)' : '';
      const quando = m.timestamp ? `[${m.timestamp}] ` : '';
      return `${quando}${quem}${tipo}: ${m.content}`;
    })
    .join('\n');
}

function montarUserPrompt(historicoFormatado) {
  return (
    'Exemplo de um relatório bem preenchido (apenas para calibrar tom e nível de detalhe, ' +
    'NÃO copie os dados):\n\n' +
    JSON.stringify(EXEMPLO_FEWSHOT, null, 2) +
    '\n\n---\n\nConversa real a ser analisada (ordem cronológica):\n\n' +
    historicoFormatado +
    '\n\n---\n\nGere agora o relatório em JSON estrito, seguindo o schema e as regras.'
  );
}

/** Extrai o primeiro objeto JSON de um texto (caso a LLM adicione texto ao redor). */
function extrairJson(texto) {
  const t = String(texto).trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    /* tenta extrair bloco */
  }
  // Remove cercas de código markdown, se houver.
  const semCerca = t.replace(/```json/gi, '').replace(/```/g, '');
  const inicio = semCerca.indexOf('{');
  const fim = semCerca.lastIndexOf('}');
  if (inicio !== -1 && fim !== -1 && fim > inicio) {
    const bloco = semCerca.slice(inicio, fim + 1);
    return JSON.parse(bloco);
  }
  throw new Error('A LLM não retornou um JSON válido.');
}

/** Garante que todos os campos existem e têm o tipo certo. */
function normalizarDados(dados) {
  const out = {};
  for (const campo of CAMPOS_TEXTO) {
    const v = dados[campo];
    out[campo] = typeof v === 'string' && v.trim() ? v.trim() : 'Não identificado na conversa';
  }
  for (const campo of CAMPOS_LISTA) {
    const v = dados[campo];
    if (Array.isArray(v) && v.length > 0) {
      out[campo] = v.map((x) => String(x).trim()).filter(Boolean);
      if (out[campo].length === 0) out[campo] = ['Não identificado na conversa'];
    } else {
      out[campo] = ['Não identificado na conversa'];
    }
  }
  return out;
}

// Ferramenta de saída estruturada: o Claude devolve o relatório já no schema,
// sem texto em volta (mais confiável que pedir JSON no texto).
const REPORT_TOOL = {
  name: 'gerar_relatorio',
  description: 'Registra o relatório de handoff de pré-vendas extraído da conversa.',
  input_schema: {
    type: 'object',
    properties: {
      lead: { type: 'string' },
      status: { type: 'string' },
      nicho: { type: 'string' },
      investimento: { type: 'string' },
      perfil_contexto: { type: 'array', items: { type: 'string' } },
      momento_atual: { type: 'array', items: { type: 'string' } },
      sinais_tracao: { type: 'array', items: { type: 'string' } },
      capacidade_decisao: { type: 'array', items: { type: 'string' } },
      agendamento_status: { type: 'array', items: { type: 'string' } },
      leitura_estrategica: { type: 'array', items: { type: 'string' } },
      closer_deve_bater: { type: 'array', items: { type: 'string' } },
      frase_impacto: { type: 'string' },
    },
    required: [
      'lead', 'status', 'nicho', 'investimento', 'perfil_contexto', 'momento_atual',
      'sinais_tracao', 'capacidade_decisao', 'agendamento_status', 'leitura_estrategica',
      'closer_deve_bater', 'frase_impacto',
    ],
  },
};

async function chamarAnthropic(userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY não configurada no .env.');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [REPORT_TOOL],
      tool_choice: { type: 'tool', name: 'gerar_relatorio' },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`Anthropic respondeu ${resp.status}: ${detalhe.slice(0, 300)}`);
  }

  const json = await resp.json();
  // A saída estruturada vem num bloco tool_use, com o objeto já pronto em .input.
  const toolUse = (json.content || []).find((b) => b.type === 'tool_use');
  if (toolUse && toolUse.input) return JSON.stringify(toolUse.input);
  // Fallback: texto puro (caso o modelo não use a ferramenta).
  const texto = (json.content || []).map((b) => b.text || '').join('').trim();
  if (!texto) throw new Error('Resposta vazia da Anthropic.');
  return texto;
}

async function chamarOllama(userPrompt) {
  const model = process.env.OLLAMA_MODEL || 'llama3.1';
  const url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');

  const resp = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`Ollama respondeu ${resp.status}: ${detalhe.slice(0, 300)}`);
  }

  const json = await resp.json();
  const texto = json.message?.content?.trim();
  if (!texto) throw new Error('Resposta vazia do Ollama.');
  return texto;
}

async function chamarLLM(userPrompt) {
  if (LLM_PROVIDER === 'ollama') return chamarOllama(userPrompt);
  if (LLM_PROVIDER === 'anthropic') return chamarAnthropic(userPrompt);
  throw new Error(`LLM_PROVIDER inválido: "${LLM_PROVIDER}" (use "anthropic" ou "ollama").`);
}

/** Normaliza uma mensagem recebida da extensão para o formato interno. */
function normalizarMensagem(m) {
  const from = m && m.from === 'eu' ? 'eu' : 'eles';
  const type = m && m.type === 'audio' ? 'audio' : 'texto';
  const content = m && typeof m.content === 'string' ? m.content.trim() : '';
  return { timestamp: m && m.timestamp ? m.timestamp : null, from, type, content };
}

/**
 * Gera o relatório de handoff a partir de uma conversa recebida diretamente
 * (raspada da tela do WhatsApp Web pela extensão).
 * @param {{mensagens: Array, nome?: string}} payload
 * @returns {Promise<{dados: object, arquivo: string}>}
 */
async function gerarReportDireto({ mensagens, nome } = {}) {
  const historico = (Array.isArray(mensagens) ? mensagens : [])
    .map(normalizarMensagem)
    .filter((m) => m.content);

  if (historico.length === 0) {
    throw new Error(
      'Nenhuma mensagem foi lida. Abra uma conversa no WhatsApp Web e tente novamente.'
    );
  }

  const historicoFormatado = montarHistoricoFormatado(historico);
  const userPrompt = montarUserPrompt(historicoFormatado);
  const dados = await processarComLLM(userPrompt, nome);

  const arquivo = await gerarDocx(dados, nome || dados.lead);
  return { dados, arquivo };
}

/** Roda o prompt na LLM, valida o JSON e devolve os dados normalizados. */
async function processarComLLM(userPrompt, nome) {
  const respostaBruta = await chamarLLM(userPrompt);

  let dados;
  try {
    dados = extrairJson(respostaBruta);
  } catch (err) {
    const trecho = String(respostaBruta).replace(/\s+/g, ' ').slice(0, 180);
    console.error('[report] resposta não-JSON da LLM:', respostaBruta);
    throw new Error(
      `Não foi possível interpretar a resposta da LLM como JSON: ${err.message} — a IA respondeu: "${trecho}…"`
    );
  }

  dados = normalizarDados(dados);

  // Se a LLM não achou o nome, usa o nome informado (contato/lead).
  if ((!dados.lead || dados.lead === 'Não identificado na conversa') && nome && nome.trim()) {
    dados.lead = nome.trim();
  }
  return dados;
}

module.exports = { gerarReportDireto };
