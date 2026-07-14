'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { slugify } = require('./generateDoc');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const VERDE = '#0f9d76';
const CINZA = '#334155';
const CLARO = '#eef2f7';

// Remove emojis (as fontes padrão do PDF não os renderizam).
function semEmoji(texto) {
  return String(texto || '')
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu,
      ''
    )
    .trim();
}

function timestampArquivo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function render(doc, dados) {
  const company = process.env.COMPANY_NAME || 'Empresa';
  const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Título
  doc.font('Helvetica-Bold').fontSize(17).fillColor(VERDE)
    .text('HANDOFF DE PRÉ-VENDAS', { continued: false });
  doc.font('Helvetica').fontSize(11).fillColor(CINZA).text(company);
  doc.moveDown(0.8);

  // Resumo (Lead + linhas rótulo/valor) num bloco claro
  const linhas = [];
  if (dados.lead) linhas.push(['Lead', dados.lead]);
  (dados.resumo || []).forEach((r) => linhas.push([r.rotulo, r.valor]));
  if (linhas.length) {
    const topo = doc.y;
    doc.roundedRect(doc.x, topo, larguraUtil, 0, 8); // placeholder; desenhamos texto e depois a régua
    linhas.forEach(([rot, val]) => {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0b3b2e')
        .text(`${rot}:  `, { continued: true });
      doc.font('Helvetica').fillColor('#111827').text(val);
      doc.moveDown(0.15);
    });
    doc.moveDown(0.4);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor('#d7dee8').lineWidth(1).stroke();
    doc.moveDown(0.6);
  }

  // Seções
  (dados.secoes || []).forEach((secao) => {
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(VERDE).text(semEmoji(secao.titulo));
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10.5).fillColor('#111827');
    (secao.itens || []).forEach((item, i) => {
      const marcador = secao.numerada ? `${i + 1}.  ` : '•  ';
      doc.text(marcador + item, { paragraphGap: 3, indent: 6, align: 'left' });
    });
    doc.moveDown(0.6);
  });

  // Nas palavras do lead (citações exatas, entre aspas)
  if (Array.isArray(dados.citacoes) && dados.citacoes.length) {
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(VERDE).text('Nas palavras do lead');
    doc.moveDown(0.2);
    dados.citacoes.forEach((c) => {
      doc.font('Helvetica-Oblique').fontSize(10.5).fillColor('#0b3b2e')
        .text(`“${c}”`, { indent: 6, paragraphGap: 3 });
    });
    doc.moveDown(0.6);
  }

  // Frase de impacto
  if (dados.frase_impacto) {
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(VERDE).text('Frase de impacto');
    doc.moveDown(0.2);
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#111827')
      .text(`“${dados.frase_impacto}”`);
  }
}

async function gerarPdfBuffer(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      render(doc, dados);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Gera o PDF em disco e retorna o caminho. */
async function gerarPdf(dados, jid) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const buffer = await gerarPdfBuffer(dados);
  const nome = `relatorio_${slugify(dados.lead || jid)}_${timestampArquivo()}.pdf`;
  const caminho = path.join(OUTPUT_DIR, nome);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}

module.exports = { gerarPdf, gerarPdfBuffer };
