'use strict';

require('dotenv').config();

const { gerarPdf } = require('./generatePdf');

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// DOIS exemplos, de propósito com formatos diferentes: um exemplo só ensinaria a IA
// a copiar aquele formato. Lado a lado, eles ensinam que o relatório se molda à conversa
// — rótulos, seções e o que entra mudam conforme o que o lead falou.
const EXEMPLO_PEQUENO = {
  lead: 'Vitor da Silva',
  resumo: [
    { rotulo: 'Status', valor: 'Loja física de moto peças, começando no digital' },
    { rotulo: 'Investimento', valor: 'A partir de R$3.000 — respondeu "OK" ao valor mínimo proposto pelo vendedor' },
    { rotulo: 'Motivação', valor: 'Sair do CLT e ter renda previsível; já vende, quer estrutura para escalar' },
    { rotulo: 'Decisor(es)', valor: 'Decide sozinho (não mencionou outra pessoa)' },
  ],
  secoes: [
    {
      titulo: '👤 Perfil & momento',
      numerada: false,
      itens: [
        'Toca uma loja física de moto peças; começou no Mercado Livre há 15 dias.',
        'Já fez 104 vendas nesses 15 dias — validou produto, mas ainda sem estrutura.',
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
      titulo: '✅ O que o closer deve bater',
      numerada: true,
      itens: [
        'Ancorar na tração (104 vendas/15 dias) para mostrar que só falta estrutura, não capacidade.',
        'Desenhar o caminho de Full + catálogo como ponte para previsibilidade.',
        'Como ele já confirmou o investimento e decide sozinho, mirar direto no plano de execução.',
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

// Mesmo trabalho, conversa diferente: aqui o INVESTIMENTO aparece como faturamento e
// estoque (o lead demonstrou capacidade sem falar em "investir"), a MOTIVAÇÃO é escoar
// o estoque parado, e o DECISOR não vai participar. As três obrigatórias continuam lá,
// só com rótulos e valores tirados desta conversa.
const EXEMPLO_GRANDE = {
  lead: 'Márcia Gonçalves',
  resumo: [
    { rotulo: 'Negócio', valor: 'Distribuidora de cosméticos, 12 funcionários, só atacado' },
    { rotulo: 'Investimento', valor: 'Fatura R$2M/mês; R$100 mil de estoque parado — capacidade sobra' },
    { rotulo: 'Motivação', valor: 'Escoar o estoque de giro lento sem queimar preço no atacado' },
    { rotulo: 'Decisor(es)', valor: 'Decide com o sócio Rogério — Rogério NÃO participa da reunião' },
    { rotulo: 'Urgência', valor: '"Preciso começar no Mercado Livre" — canal já decidido internamente' },
  ],
  secoes: [
    {
      titulo: '👤 Perfil & momento',
      numerada: false,
      itens: [
        'Distribuidora consolidada no atacado; nunca vendeu direto ao consumidor.',
        'Abriu a conversa já decidida pelo Mercado Livre, para escoar o giro lento sem queimar preço no atacado.',
      ],
    },
    {
      titulo: '⚠️ Objeções & riscos',
      numerada: false,
      itens: [
        'Rogério aprova o investimento e não estará na call: risco de travar depois da reunião.',
        'Teme conflito de canal — cliente do atacado ver o preço no varejo.',
      ],
    },
    {
      titulo: '✅ O que o closer deve bater',
      numerada: true,
      itens: [
        'Tratar o canal como decidido: ela não precisa ser convencida do ML, e sim do como.',
        'Resolver o conflito de canal (linha e precificação separadas) antes de falar de preço.',
        'Combinar como levar o Rogério: material para ele ou segunda call com os dois.',
      ],
    },
  ],
  citacoes: [
    'Preciso começar no Mercado Livre, isso aí já tá decidido.',
    'Tenho uns 100 mil parados em produto que não gira, isso me incomoda todo mês.',
  ],
  frase_impacto:
    'Ela não precisa ser vendida no canal — precisa de um caminho que não brigue com o atacado e que o sócio aprove sem estar na sala.',
};

const SYSTEM_PROMPT = `Você é um assistente de pré-vendas que lê a conversa entre um vendedor e um lead e monta o relatório de handoff que o closer vai usar para conduzir a reunião. CABE EM 1 PÁGINA.

O RELATÓRIO SAI DA CONVERSA — não existe modelo fixo:
- Os rótulos do resumo e os títulos das seções nascem do que foi dito, não de uma lista pronta. Se o lead falou de faturamento, o rótulo é "Faturamento". Se falou de estoque, é "Estoque". Se falou de verba mensal, é "Verba". Se falou de quantos pedidos manda por dia, é isso.
- Assunto que não apareceu na conversa NÃO vira linha do relatório. Nada de campo vazio, "não informado" ou "não mencionado" — apenas omita (as duas exceções estão abaixo).
- Reporte o que o lead disse, na medida em que ele disse. Não traduza a fala dele para uma escala ou categoria que ele não usou.

QUALIFICAÇÃO MÍNIMA — estas TRÊS linhas SEMPRE aparecem no resumo, preenchidas com o que a conversa deu. É PROIBIDO escrever "a confirmar" nelas. O SDR já qualifica isso na conversa, então a informação ESTÁ lá — sua obrigação é achar, inclusive em respostas curtas ("ok", "sim", "fechado"). Se você escreveu "a confirmar" em uma destas três, você leu errado: volte e releia a conversa inteira.

1. INVESTIMENTO — o poder de investir do lead.
   - CONFIRMAÇÃO CONTA: se o vendedor propôs um valor e o lead concordou — "ok", "consigo", "fechado", "dá sim", "tenho", "pode ser", "tranquilo", "beleza", "isso" — então ESSE valor está confirmado. Ex.: VENDEDOR "o investimento é no mínimo R$3 mil, consegue?" + LEAD "OK" → Investimento: "A partir de R$3.000 — lead confirmou". NUNCA "a confirmar": ele acabou de confirmar.
   - Se o lead expressou capacidade de outro jeito (faturamento, estoque, verba, porte, nº de funcionários), use isso — quem fatura R$2M/mês ou tem R$100 mil de estoque já demonstrou poder de investimento. O rótulo pode virar "Faturamento", "Estoque" etc., mas a linha de capacidade financeira SEMPRE existe.
   - Só não invente um número que ninguém disse. Mas se houve qualquer sinal — valor aceito, faixa, faturamento, porte — ele vira a linha.

2. MOTIVAÇÃO — por que o lead quer isso: a dor ou o objetivo que o move (sair do CLT, escalar, escoar estoque parado, ter previsibilidade, parar de depender de indicação...). Sempre há um motivo na conversa; tire da fala dele.

3. DECISOR(ES) — quem bate o martelo. Se o lead NÃO disse explicitamente, o padrão é que quem está conversando é o decisor — assuma isso e escreva "Decide sozinho (não mencionou outra pessoa)". Se ficou claro que precisa de um terceiro (sócio, cônjuge) OU que o decisor NÃO estará na reunião, isso é OBRIGATÓRIO reportar — muda a call inteira.

URGÊNCIA (opcional, é a única que pode não existir): entra só se o lead demonstrou, nas palavras dele. "Preciso começar no Mercado Livre" já é urgência verbalizada — reporte o que ele disse. Sem sinal nenhum, não crie a linha e não peça para confirmar.

REGRAS DE QUALIDADE:
- SEM REDUNDÂNCIA: cada informação aparece UMA vez. Não repita no corpo o que está no resumo. UMA única seção de ação — proibido "pontos de atenção" + "o que bater" dizendo o mesmo.
- DENSIDADE: todo bullet carrega um fato concreto ou algo acionável (número, nome, prazo, objeção, objetivo, gatilho). Corte o genérico e o óbvio.
- SUBSTÂNCIA, não o meio: reporte O QUE foi dito. NUNCA escreva "respondeu por áudio" ou "conteúdo não detalhado".
- FIDELIDADE: use SOMENTE o que apareceu na conversa. NÃO invente números, nomes, datas ou fatos.

TAMANHO (é um handoff, não um dossiê): resumo com 4 a 7 linhas; no máximo 4 seções; no máximo 4 bullets por seção, cada um de 1 a 2 linhas. Conversa curta gera relatório curto — 2 seções bastam. Não encha para parecer completo.

Preencha pela ferramenta "gerar_relatorio":
- "lead": SÓ o nome do lead, como ele aparece na conversa (ou ""). Sem parênteses, sem comentário, sem "a confirmar" — este campo vira o título e o nome do arquivo.
- "resumo": linhas rótulo/valor tiradas da conversa, SEMPRE com Investimento, Motivação e Decisor(es) preenchidos (nunca "a confirmar"), mais o que fizer sentido (status/nicho, urgência quando houver).
- "secoes": título com um emoji + bullets densos. As seções que fizerem sentido para ESTA conversa (perfil/momento, dor/objetivo, objeções/riscos, o que o closer deve bater...). "numerada": true só na de ação.
- "citacoes": 1 a 3 FALAS EXATAS/verbatim do LEAD (copiadas literalmente das linhas do LEAD, inclusive áudios): dor, sinal de compra, objeção, objetivo. Sem paráfrase, sem falas do vendedor; [] se não houver.
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
    'Dois relatórios bem feitos, de conversas diferentes. Servem para calibrar tom e ' +
    'densidade — NÃO copie os dados nem a estrutura. Repare que os rótulos do resumo e ' +
    'as seções MUDAM de um para o outro, porque cada conversa pediu uma coisa: o formato ' +
    'do seu relatório tem que sair da conversa que você recebeu.\n\n' +
    'EXEMPLO A (lead pequeno, começando, falou em investir):\n' +
    JSON.stringify(EXEMPLO_PEQUENO, null, 2) +
    '\n\nEXEMPLO B (operação grande, capacidade aparece como faturamento/estoque, ' +
    'urgência veio da fala dele, decisor não participa):\n' +
    JSON.stringify(EXEMPLO_GRANDE, null, 2) +
    '\n\n---\n\nConversa real a ser analisada (ordem cronológica):\n\n' +
    historicoFormatado +
    '\n\n---\n\nGere agora o relatório desta conversa, com os rótulos e as seções que ELA pede.'
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
      lead: {
        type: 'string',
        description:
          'Só o nome do lead, ou "" se não souber. Vira o título e o nome do arquivo: sem parênteses, comentários ou "a confirmar".',
      },
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
  // usage é o que a Anthropic cobra: é daqui que sai o custo do report.
  const uso = {
    modelo: json.model || model,
    entrada: (json.usage && json.usage.input_tokens) || 0,
    saida: (json.usage && json.usage.output_tokens) || 0,
  };
  // A saída estruturada vem num bloco tool_use, com o objeto já pronto em .input.
  const toolUse = (json.content || []).find((b) => b.type === 'tool_use');
  if (toolUse && toolUse.input) return { texto: JSON.stringify(toolUse.input), uso };
  // Fallback: texto puro (caso o modelo não use a ferramenta).
  const texto = (json.content || []).map((b) => b.text || '').join('').trim();
  if (!texto) throw new Error('Resposta vazia da Anthropic.');
  return { texto, uso };
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
  // Ollama roda na sua máquina: sem custo por token.
  return { texto, uso: { modelo: `ollama/${model}`, entrada: 0, saida: 0 } };
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
  const { texto: respostaBruta, uso } = await chamarLLM(userPrompt);

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
  // O servidor registra o consumo e tira este campo antes de devolver o report.
  dados.uso = uso;
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
