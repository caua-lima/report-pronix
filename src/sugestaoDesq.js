'use strict';
// "Sugerir motivo e anotação" do Desqualificar: lê a conversa que está na tela e escolhe um dos motivos de perda do
// CRM, com a anotação do que o lead disse. IA gratuita (Groq, a mesma do resumo rápido) — sem custo por uso.
// O caso mais comum ("não respondeu depois de N tentativas") nem chega aqui: a extensão resolve por regra, sem IA.
//
// Assertivo (pedido do Cauã, 19/11/2026): a IA segue uma ordem de decisão fixa, nunca fica no "Outros" quando há um
// motivo específico, e a anotação traz a PROVA — a fala literal do lead com a data. Os fatos que dá para contar (última
// resposta do lead, quantas mensagens o SDR mandou depois sem resposta) o código calcula e entrega prontos: contar não
// é trabalho para a IA.

const { chatGroq } = require('./groq');
const { extrairJson } = require('./report');

const SYSTEM = `Você ajuda um pré-vendedor (SDR) a dar perda num lead no CRM. Leia a conversa do WhatsApp e escolha UM motivo da lista, pelo id. Seja ASSERTIVO: decida pelo fato mais forte da conversa, sem ficar em cima do muro.

ORDEM DE DECISÃO — percorra de cima para baixo e pare no PRIMEIRO caso que a conversa prova:
1. O lead DISSE que não quer / não tem interesse / desistiu / "não é pra mim".
2. Dinheiro: disse que não tem o valor, não pode investir agora, achou caro, está sem limite ou sem capital.
3. Fora do perfil: procurava outra coisa (emprego, curso grátis, serviço que não vendemos), não tem o requisito (idade, CNPJ, tempo, produto), ou só quer informação.
4. Já fechou com outra empresa / vai seguir sozinho / já tem mentoria.
5. Timing: disse que só pode depois (mês, data, "ano que vem", "depois do 13º").
6. Contato errado: número errado, não é a pessoa, não lembra do cadastro.
7. Sumiu: o lead parou de responder (use os FATOS: a última resposta dele e quantas mensagens o SDR mandou depois sem resposta).

REGRAS:
- Escolha o motivo da lista que nomeia ESSE caso. Motivo genérico ("Outros", "Sem resposta" quando ele respondeu) só se nenhum específico servir.
- Se o lead deu um motivo e DEPOIS sumiu, vale o motivo que ele deu (1 a 6), não o sumiço.
- "nota" (60 a 400 caracteres, português, direta): comece pelo fato ("Lead disse que não tem o valor para investir agora."), depois a PROVA entre aspas — a fala LITERAL do lead copiada da conversa, com a data entre parênteses —, e feche com a última interação (ex.: "Última resposta em 12/11; 3 mensagens do SDR depois, sem resposta."). Sem fala do lead que prove, use os FATOS. Nunca invente fala, número ou data.
- "porque": UMA frase curta citando a prova da escolha ("Disse 'agora não tenho esse dinheiro' em 12/11").
- "certeza": "alta" (o lead disse com todas as letras), "media" (dá para concluir pela conversa) ou "baixa" (pouca informação).

Responda só JSON: {"motivoId": "...", "nota": "...", "porque": "...", "certeza": "alta|media|baixa"}.`;

const dataBr = (ts) => {
  const d = ts ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: process.env.TZ_RELATORIO || 'America/Sao_Paulo' }) : '';
};

/** Fatos contados pelo código: última resposta do lead e o que o SDR mandou depois. */
function fatosDaConversa(msgs) {
  let ultimaDoLead = -1;
  msgs.forEach((m, i) => { if (m && m.from !== 'eu' && String(m.content || '').trim()) ultimaDoLead = i; });
  const doSdrDepois = msgs.slice(ultimaDoLead + 1).filter((m) => m && m.from === 'eu').length;
  const linhas = [];
  if (ultimaDoLead === -1) linhas.push('O lead nunca respondeu nesta conversa.');
  else {
    const quando = dataBr(msgs[ultimaDoLead].timestamp);
    linhas.push(`Última mensagem do lead${quando ? ` em ${quando}` : ''}: "${String(msgs[ultimaDoLead].content).replace(/\s+/g, ' ').trim().slice(0, 200)}".`);
  }
  linhas.push(`Mensagens do SDR depois da última resposta do lead, sem resposta: ${doSdrDepois}.`);
  return linhas.join('\n');
}

/**
 * @param {{mensagens: Array<{from: string, content: string, timestamp?: string}>, motivos: Array<{id, nome, tipo}>}} p
 * @returns {Promise<{motivoId: string, nota: string, porque: string, certeza: string}>}
 */
async function sugerir({ mensagens, motivos }) {
  const lista = (Array.isArray(motivos) ? motivos : []).filter((m) => m && m.id && m.nome).slice(0, 60);
  if (!lista.length) throw new Error('O CRM não tem motivos de perda para escolher.');
  const msgs = (Array.isArray(mensagens) ? mensagens : []).slice(-80);
  const conversa = msgs
    .map((m) => {
      const quando = m && m.timestamp ? ` [${dataBr(m.timestamp)} ${String(m.timestamp).slice(11, 16)}]` : '';
      const texto = String((m && m.content) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      return texto ? `${m.from === 'eu' ? 'SDR' : 'Lead'}${quando}: ${texto}` : '';
    })
    .filter(Boolean)
    .join('\n');
  if (!conversa) throw new Error('Não há mensagens na tela para ler. Role a conversa até as últimas mensagens.');
  const user =
    `MOTIVOS:\n${lista.map((m) => `- ${m.id}: ${m.nome}${m.tipo === 'desqualificacao' ? ' (desqualificação: o lead não atende aos requisitos)' : ''}`).join('\n')}` +
    `\n\nFATOS (contados pelo sistema, confiáveis):\n${fatosDaConversa(msgs)}` +
    `\n\nCONVERSA (a mais antiga primeiro):\n${conversa}`;
  const j = extrairJson(await chatGroq({ system: SYSTEM, user, modelo: process.env.GROQ_COACH_MODEL, maxTokens: 500 }));
  const motivo = lista.find((m) => String(m.id) === String(j && j.motivoId));
  if (!motivo) throw new Error('A IA não escolheu um motivo da lista. Escolha à mão.');
  const certeza = ['alta', 'media', 'baixa'].includes(String(j && j.certeza)) ? String(j.certeza) : '';
  const porque = String((j && j.porque) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    motivoId: String(motivo.id),
    nota: String((j && j.nota) || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    // a certeza vai junto do porquê, que a extensão já mostra (sem mudar a tela)
    porque: certeza ? `${porque}${porque ? ' ' : ''}(certeza ${certeza === 'media' ? 'média' : certeza})`.trim() : porque,
    certeza,
  };
}

module.exports = { sugerir, fatosDaConversa };
