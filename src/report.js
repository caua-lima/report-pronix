'use strict';

require('dotenv').config();

const { gerarDocx } = require('./generateDoc');

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// Exemplo de um bom relatório — apenas referência de qualidade/estrutura.
// A estrutura NÃO é fixa: a IA adapta seções e linhas do resumo à conversa.
const EXEMPLO_FEWSHOT = {
  lead: 'Vitor da Silva',
  resumo: [
    { rotulo: 'Status', valor: 'Loja física + e-commerce' },
    { rotulo: 'Nicho', valor: 'Moto peças' },
    { rotulo: 'Investimento', valor: 'Mais de R$5.000' },
  ],
  secoes: [
    {
      titulo: '👤 Perfil & Contexto',
      numerada: false,
      itens: [
        'Vitor está saindo do CLT com o objetivo de ganhar qualidade de vida.',
        'Já vende no Mercado Livre há 15 dias e está estruturando o e-commerce.',
        'Tem uma loja física com a irmã, com divisão 50/50 nas decisões de investimento.',
      ],
    },
    {
      titulo: '📈 Sinais de Tração',
      numerada: false,
      itens: [
        'Em 15 dias no Mercado Livre já realizou 104 vendas.',
        'Já superou a barreira de começar e está validando produto na prática.',
      ],
    },
    {
      titulo: '💰 Capacidade & Decisão',
      numerada: false,
      itens: [
        'Há cerca de R$10 mil em estoque hoje e a intenção é usar metade no projeto.',
        'Decisão compartilhada com a irmã, mas ele está à frente do movimento digital.',
      ],
    },
    {
      titulo: '✅ O que o closer deve bater',
      numerada: true,
      itens: [
        'Validar a tração inicial de 104 vendas em 15 dias.',
        'Mostrar como usar a loja física para sustentar a operação digital.',
        'Conectar a operação atual ao objetivo de sair do CLT com qualidade de vida.',
      ],
    },
  ],
  frase_impacto:
    'Ele já vendeu muito rápido no começo; agora a reunião precisa mostrar como transformar tração em estrutura para ele sair do CLT com segurança.',
};

const SYSTEM_PROMPT = `Você é um assistente de pré-vendas que lê a conversa entre um vendedor e um lead e monta um relatório de handoff para o closer.

OBJETIVO: montar o MELHOR relatório possível com as informações que a conversa REALMENTE tem — não é um formulário fixo.

REGRAS:
- Use SOMENTE informações que apareceram na conversa. NÃO invente números, datas, nomes ou fatos.
- Inclua apenas o que tem base na conversa. Se algo não foi falado, simplesmente NÃO crie a seção/linha para isso — nunca escreva "não identificado" nem force campos vazios.
- Escolha as seções e os rótulos do resumo que fizerem sentido para ESTE lead. Use o exemplo como referência de qualidade, mas adapte livremente: remova o que não se aplica e crie seções novas se a conversa pedir.
- Se a conversa for curta ou tiver pouca informação, faça um relatório mais curto — tudo bem.
- Linguagem direta e comercial, sem enrolação. Bullets curtos.
- Preencha pela ferramenta "gerar_relatorio":
  - "lead": nome do lead (ou "" se não souber).
  - "resumo": linhas curtas rótulo/valor para o topo (ex.: Status, Nicho, Investimento) — só as embasadas na conversa.
  - "secoes": as seções do corpo; cada uma com "titulo" (começando com um emoji) e "itens" (bullets). Use "numerada": true nas seções de passos/ações.
  - "frase_impacto": uma frase única de fechamento (ou "" se não fizer sentido).`;

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

/** Normaliza a saída flexível: valida resumo/seções e descarta vazios. */
function normalizarDados(dados) {
  const out = {};
  out.lead = typeof dados.lead === 'string' ? dados.lead.trim() : '';
  out.frase_impacto = typeof dados.frase_impacto === 'string' ? dados.frase_impacto.trim() : '';

  out.resumo = Array.isArray(dados.resumo)
    ? dados.resumo
        .filter(
          (r) =>
            r &&
            typeof r.rotulo === 'string' &&
            typeof r.valor === 'string' &&
            r.rotulo.trim() &&
            r.valor.trim()
        )
        .map((r) => ({ rotulo: r.rotulo.trim(), valor: r.valor.trim() }))
    : [];

  out.secoes = Array.isArray(dados.secoes)
    ? dados.secoes
        .map((s) => ({
          titulo: typeof s.titulo === 'string' ? s.titulo.trim() : '',
          numerada: !!s.numerada,
          itens: Array.isArray(s.itens) ? s.itens.map((x) => String(x).trim()).filter(Boolean) : [],
        }))
        .filter((s) => s.titulo && s.itens.length > 0)
    : [];

  return out;
}

// Ferramenta de saída estruturada: o Claude devolve o relatório já no schema,
// sem texto em volta (mais confiável que pedir JSON no texto).
const REPORT_TOOL = {
  name: 'gerar_relatorio',
  description: 'Monta o relatório de handoff com as informações disponíveis na conversa.',
  input_schema: {
    type: 'object',
    properties: {
      lead: { type: 'string', description: 'Nome do lead, ou "" se não souber.' },
      resumo: {
        type: 'array',
        description: 'Linhas rótulo/valor para o topo (só as embasadas na conversa).',
        items: {
          type: 'object',
          properties: {
            rotulo: { type: 'string' },
            valor: { type: 'string' },
          },
          required: ['rotulo', 'valor'],
        },
      },
      secoes: {
        type: 'array',
        description: 'Seções do corpo do relatório, na ordem em que devem aparecer.',
        items: {
          type: 'object',
          properties: {
            titulo: { type: 'string', description: 'Título da seção, começando com um emoji.' },
            itens: { type: 'array', items: { type: 'string' }, description: 'Bullets curtos.' },
            numerada: { type: 'boolean', description: 'true = lista numerada (passos/ações).' },
          },
          required: ['titulo', 'itens'],
        },
      },
      frase_impacto: { type: 'string' },
    },
    required: ['lead', 'resumo', 'secoes'],
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
async function dadosDireto({ mensagens, nome } = {}) {
  const historico = (Array.isArray(mensagens) ? mensagens : [])
    .map(normalizarMensagem)
    .filter((m) => m.content);

  if (historico.length === 0) {
    throw new Error(
      'Nenhuma mensagem foi lida. Abra uma conversa no WhatsApp Web e tente novamente.'
    );
  }

  const userPrompt = montarUserPrompt(montarHistoricoFormatado(historico));
  return processarComLLM(userPrompt, nome);
}

async function gerarReportDireto(payload = {}) {
  const dados = await dadosDireto(payload);
  const arquivo = await gerarDocx(dados, payload.nome || dados.lead);
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
  if (!dados.lead && nome && nome.trim()) {
    dados.lead = nome.trim();
  }
  return dados;
}

/**
 * Gera o relatório a partir da conversa colada como texto livre
 * (o usuário monta a conversa, incluindo áudios já transcritos por fora).
 * @param {{texto: string, nome?: string}} payload
 * @returns {Promise<{dados: object, arquivo: string}>}
 */
async function dadosDeTexto({ texto, nome } = {}) {
  const conteudo = typeof texto === 'string' ? texto.trim() : '';
  if (!conteudo) {
    throw new Error('Cole a conversa antes de gerar o report.');
  }
  const userPrompt = montarUserPrompt(conteudo);
  return processarComLLM(userPrompt, nome);
}

async function gerarReportDeTexto(payload = {}) {
  const dados = await dadosDeTexto(payload);
  const arquivo = await gerarDocx(dados, payload.nome || dados.lead);
  return { dados, arquivo };
}

module.exports = { gerarReportDireto, gerarReportDeTexto, dadosDireto, dadosDeTexto };
