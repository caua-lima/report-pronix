'use strict';
// "Sugerir motivo e anotação" do Desqualificar: lê a conversa que está na tela e escolhe um dos motivos de perda do
// CRM, com a anotação do que o lead disse. IA gratuita (Groq, a mesma do resumo rápido) — sem custo por uso.
// O caso mais comum ("não respondeu depois de N tentativas") nem chega aqui: a extensão resolve por regra, sem IA.

const { chatGroq } = require('./groq');
const { extrairJson } = require('./report');

const SYSTEM = [
  'Você ajuda um pré-vendedor (SDR) a dar perda num lead no CRM. Leia a conversa do WhatsApp e escolha UM motivo da',
  'lista, pelo id. Escreva a anotação da perda: 1 a 3 frases em português, entre 60 e 300 caracteres, só com o que',
  'aparece na conversa — o que o lead disse ou o fato de ele não responder. Não invente nada que não esteja na conversa.',
  'Responda só JSON: {"motivoId": "...", "nota": "...", "porque": "frase curta dizendo por que esse motivo"}.',
].join(' ');

/**
 * @param {{mensagens: Array<{from: string, content: string, timestamp?: string}>, motivos: Array<{id, nome, tipo}>}} p
 * @returns {Promise<{motivoId: string, nota: string, porque: string}>}
 */
async function sugerir({ mensagens, motivos }) {
  const lista = (Array.isArray(motivos) ? motivos : []).filter((m) => m && m.id && m.nome).slice(0, 60);
  if (!lista.length) throw new Error('O CRM não tem motivos de perda para escolher.');
  const conversa = (Array.isArray(mensagens) ? mensagens : [])
    .slice(-60)
    .map((m) => {
      const quando = m && m.timestamp ? ` [${String(m.timestamp).slice(0, 16).replace('T', ' ')}]` : '';
      const texto = String((m && m.content) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      return texto ? `${m.from === 'eu' ? 'SDR' : 'Lead'}${quando}: ${texto}` : '';
    })
    .filter(Boolean)
    .join('\n');
  if (!conversa) throw new Error('Não há mensagens na tela para ler. Role a conversa até as últimas mensagens.');
  const user =
    `MOTIVOS:\n${lista.map((m) => `- ${m.id}: ${m.nome}${m.tipo === 'desqualificacao' ? ' (desqualificação: o lead não atende aos requisitos)' : ''}`).join('\n')}` +
    `\n\nCONVERSA (a mais antiga primeiro):\n${conversa}`;
  const j = extrairJson(await chatGroq({ system: SYSTEM, user, modelo: process.env.GROQ_COACH_MODEL, maxTokens: 400 }));
  const motivo = lista.find((m) => String(m.id) === String(j && j.motivoId));
  if (!motivo) throw new Error('A IA não escolheu um motivo da lista. Escolha à mão.');
  return {
    motivoId: String(motivo.id),
    nota: String((j && j.nota) || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    porque: String((j && j.porque) || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  };
}

module.exports = { sugerir };
