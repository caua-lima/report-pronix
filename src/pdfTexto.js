'use strict';
// O PDF do report anexado (painel lateral ou site) vira o handoff do CRM, que não aceita arquivo: vai o texto dele.
// A leitura é a de src/textoDoPdf.js — feita para o PDF que o próprio sistema gera, sem executar nada do arquivo.

const { textoDoPdf } = require('./textoDoPdf');

const LIMITE_BYTES = 6 * 1024 * 1024;

/** @param {string} base64 o PDF em base64 @returns {string} o texto do report, em linhas */
function textoDoReportPdf(base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('Anexe o PDF do report.');
  if (buf.length > LIMITE_BYTES) throw new Error('O PDF passa de 6 MB. Anexe o PDF do report (ele tem poucas páginas).');
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('Esse arquivo não é um PDF.');
  let texto = '';
  try {
    texto = String(textoDoPdf(buf) || '');
  } catch (_) {
    throw new Error('Não consegui ler esse PDF. Confira se é o PDF do report.');
  }
  // Rodapé de cada página ("PRONIX: Handoff de pré-vendas · SDR: … · 1/2") não é conteúdo.
  const limpo = texto
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^PRONIX:? Handoff de pr[ée]-vendas · /i.test(l))
    .join('\n')
    .trim();
  if (limpo.replace(/\s+/g, '').length < 40) throw new Error('Não achei o texto desse PDF (é uma imagem ou foi gerado fora do sistema?). Escreva o handoff no campo.');
  return limpo.slice(0, 8000);
}

module.exports = { textoDoReportPdf };
