'use strict';

require('dotenv').config();

const { gerarPdf } = require('./generatePdf');

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// Exemplo de um bom relatório — apenas referência de qualidade/estrutura.
// A estrutura NÃO é fixa: a IA adapta seções e linhas do resumo à conversa.
const EXEMPLO_FEWSHOT = {
  lead: 'Vitor da Silva',
  resumo: [
    { rotulo: 'Status', valor: 'Loja física + e-commerce' },
    { rotulo: 'Nicho', valor: 'Moto peças' },
    { rotulo: 'Investimento', valor: 'Cerca de R$5.000 (metade do estoque de R$10 mil)' },
    { rotulo: 'Decisor(es)', valor: 'Vitor decide o digital; investimento dividido 50/50 com a irmã' },
    { rotulo: 'Prioridade', valor: 'Alta — quer sair do CLT e já está vendendo' },
  ],
  secoes: [
    {
      titulo: '👤 Perfil & momento',
      numerada: false,
      itens: [
        'Sai do CLT buscando qualidade de vida; toca uma loja física de moto peças com a irmã.',
        'Há 15 dias começou no Mercado Livre e já fez 104 vendas — validou produto, sem estrutura ainda.',
        'Ainda sem Full liberado; trocando o CNAE do ME.',
      ],
    },
    {
      titulo: '🎯 Dor & objetivo',
      numerada: false,
      itens: [
        'Vende no impulso e no improviso; quer previsibilidade para escalar sem depender de correria.',
        'Objetivo final: sair do CLT com renda estável do digital.',
      ],
    },
    {
      titulo: '⚠️ Objeções & riscos',
      numerada: false,
      itens: ['Investimento dividido com a irmã pode travar decisão rápida se ela não estiver alinhada.'],
    },
    {
      titulo: '✅ O que o closer deve bater',
      numerada: true,
      itens: [
        'Ancorar na tração (104 vendas/15 dias) para mostrar que só falta estrutura, não capacidade.',
        'Desenhar o caminho de Full + catálogo como ponte para previsibilidade.',
        'Trazer a irmã para a decisão ou confirmar alçada dele para fechar sozinho.',
      ],
    },
  ],
  citacoes: [
    'Em 15 dias já fiz 104 vendas, tá saindo mais rápido do que eu imaginava.',
    'Eu quero mesmo é sair do CLT e ter qualidade de vida.',
  ],
  frase_impacto:
    'Ele já vendeu muito rápido no começo; agora a reunião precisa mostrar como transformar tração em estrutura para ele sair do CLT com segurança.',
};

const SYSTEM_PROMPT = `Você é um assistente de pré-vendas que lê a conversa entre um vendedor e um lead e monta um relatório de handoff DENSO e ÚTIL para o closer conduzir a reunião. Cabe em ~1 página.

REGRAS DE QUALIDADE (as mais importantes):
- SEM REDUNDÂNCIA: cada informação aparece UMA única vez. Não repita no corpo o que já está no resumo. Crie APENAS UMA seção de ações ("O que o closer deve bater") — proibido ter "pontos de atenção" + "o que bater" dizendo a mesma coisa. Não crie seção que só reafirme o resumo.
- DENSIDADE: todo bullet carrega um fato concreto ou insight acionável (número, nome, prazo, objeção, objetivo, gatilho de compra). Corte frases genéricas, óbvias ou de enrolação.
- SUBSTÂNCIA, não o meio: reporte O QUE foi dito. NUNCA escreva "respondeu por áudio", "conteúdo não detalhado", nem comente o formato/medium da mensagem.
- FIDELIDADE: use SOMENTE o que apareceu na conversa. NÃO invente números, nomes, datas ou fatos.

COBERTURA MÍNIMA (sempre clara, de preferência no resumo): 💰 Investimento, 🧑‍⚖️ Decisor(es), 🔥 Prioridade/urgência. Se algum não foi dito, escreva "a confirmar na reunião" — só esses três podem receber isso; os demais campos, se não há info, simplesmente omita.

ESTRUTURA SUGERIDA (enxuta — junte/remova conforme o caso; poucas e densas > muitas e vazias):
- resumo (tabela topo): Lead, Status/nicho, Investimento, Decisor(es), Prioridade, e Fonte/origem ou Agendamento quando relevante.
- Perfil & momento — quem é, o que faz, situação atual do negócio.
- Dor & objetivo — o que quer resolver e aonde quer chegar.
- Qualificação — SÓ se houver contexto além do resumo (nuance sobre investimento/decisor/urgência); senão, não crie.
- Objeções & riscos — o que pode travar a venda (só se houver).
- O que o closer deve bater — ações concretas para a call (numerada). ÚNICA seção de ação.

Preencha pela ferramenta "gerar_relatorio":
- "lead": nome do lead (ou "").
- "resumo": linhas rótulo/valor; sempre Investimento, Decisor(es) e Prioridade + Status/nicho e o que fizer sentido.
- "secoes": título com um emoji + itens (bullets densos). "numerada": true só na seção de ações.
- "citacoes": 1 a 4 FALAS EXATAS/verbatim do LEAD (copiadas literalmente das linhas do LEAD, inclusive áudios) que sejam fortes: dor, sinal de compra, objeção, objetivo. Sem paráfrase, sem falas do vendedor; [] se não houver.
- "frase_impacto": uma frase única e afiada de fechamento (pode parafrasear).`;

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

  out.citacoes = Array.isArray(dados.citacoes)
    ? dados.citacoes.map((x) => String(x).trim().replace(/^["“”']+|["“”']+$/g, '').trim()).filter(Boolean)
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
      citacoes: {
        type: 'array',
        description: 'Falas EXATAS (verbatim) do LEAD, fortes/úteis para o closer. Sem paráfrase.',
        items: { type: 'string' },
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
  const arquivo = await gerarPdf(dados, payload.nome || dados.lead);
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
  const arquivo = await gerarPdf(dados, payload.nome || dados.lead);
  return { dados, arquivo };
}

module.exports = { gerarReportDireto, gerarReportDeTexto, dadosDireto, dadosDeTexto };
