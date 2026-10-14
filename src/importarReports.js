'use strict';

// Reports que vieram do Report Closer (o sistema da empresa) para o Report PRONIX. Quem gerou o report
// só lá tem a venda só lá: os dois sistemas têm bancos separados. Lá, em Resultados → "Levar para o
// Report PRONIX", sai um arquivo .json com os reports (e o PDF de cada um); aqui ele é importado.
//
// Regras:
//  - entram só os reports do próprio usuário (o SDR que importa); os de outra pessoa ficam de fora;
//  - não duplica: o mesmo report importado duas vezes, ou o mesmo lead que já tem report aqui (gerado
//    nos dois sistemas, com até 3 dias de diferença), não entra de novo;
//  - o closer é achado pelo nome no cadastro daqui; o resultado, a venda e a leitura da IA vêm como estão;
//  - o PDF só é guardado se for mesmo um PDF.

const stats = require('./stats');
const closers = require('./closers');
const closerAuto = require('./closerAuto');
const pdfStorage = require('./pdfStorage');

const FORMATO = 'report-closer/1';
const MAX_POR_VEZ = 10;
const ID_OK = /^[A-Za-z0-9_-]{3,40}$/;
const QUANDO_OK = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const primeiroNome = (s) => semAcento(s).split(' ')[0] || '';

/** O mesmo lead em dois reports: mesmo nome (ou o mesmo telefone no contato) e até 3 dias de diferença. */
function mesmoLead(a, b) {
  const nome = (x) => semAcento(x.lead || x.contato);
  const tel = (x) => String(x.contato || '').replace(/\D/g, '');
  const iguais = (nome(a) && nome(a) === nome(b)) || (tel(a).length >= 8 && tel(a).slice(-8) === tel(b).slice(-8));
  if (!iguais) return false;
  const dias = Math.abs(Date.parse(a.quando) - Date.parse(b.quando)) / 86400000;
  return Number.isFinite(dias) && dias <= 3;
}

const ehPdf = (base64) => typeof base64 === 'string' && Buffer.from(base64.slice(0, 12), 'base64').toString('latin1').startsWith('%PDF');

/**
 * @param {object[]} lista  reports do arquivo exportado (no máximo MAX_POR_VEZ por chamada)
 * @param {{usuario: {id: string, nome: string}}} quem importa — vira o dono dos reports
 * @returns {Promise<{importados: number, jaEstavam: number, deOutroSdr: number, invalidos: number, comPdf: number}>}
 */
async function importar(lista, { usuario }) {
  const saida = { importados: 0, jaEstavam: 0, deOutroSdr: 0, invalidos: 0, comPdf: 0 };
  const existentes = await stats.listar({});
  const cadastrados = await closers.listar();
  for (const r of (Array.isArray(lista) ? lista : []).slice(0, MAX_POR_VEZ)) {
    if (!r || typeof r !== 'object' || !ID_OK.test(String(r.id || '')) || !QUANDO_OK.test(String(r.quando || '')) || !(r.lead || r.contato)) {
      saida.invalidos++;
      continue;
    }
    if (primeiroNome(r.usuarioNome) !== primeiroNome(usuario.nome)) {
      saida.deOutroSdr++;
      continue;
    }
    const id = 'rc' + r.id;
    if (existentes.some((x) => x.id === id || mesmoLead(x, r))) {
      saida.jaEstavam++;
      continue;
    }
    const closer = r.closerNome ? closerAuto.acharCloser(cadastrados, r.closerNome) : null;
    const novo = await stats.importar({ ...r, id, usuarioId: usuario.id, usuarioNome: usuario.nome, closerId: closer ? closer.id : '', closerNome: closer ? closer.nome : '' });
    existentes.push(novo);
    if (r.pdf && ehPdf(r.pdf.base64)) {
      await pdfStorage.salvar(id, r.pdf.base64, String(r.pdf.arquivo || '').replace(/[^\w .()-]+/g, '').slice(0, 120) || `Report_${id}.pdf`);
      saida.comPdf++;
    }
    saida.importados++;
  }
  return saida;
}

module.exports = { importar, mesmoLead, FORMATO, MAX_POR_VEZ };
