'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { slugify } = require('./generateDoc');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const VERDE = '#0f9d76';
const VERDE_ESC = '#0b3b2e';
const CLARO = '#f4f7fb';
const BORDA = '#e3e8ef';
const TEXTO = '#1f2937';
const MARGIN = 46;

function semEmoji(t) {
  return String(t || '')
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}]/gu,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function timestampArquivo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function novaPaginaSePreciso(doc, alturaNecessaria) {
  if (doc.y + alturaNecessaria > doc.page.height - MARGIN) doc.addPage();
}

function bullet(doc, marcador, texto, x, largura) {
  const y = doc.y;
  const wMarc = 18;
  doc.text(marcador, x, y, { width: wMarc });
  doc.text(texto, x + wMarc, y, { width: largura - wMarc, paragraphGap: 2 });
}

function render(doc, dados) {
  const company = process.env.COMPANY_NAME || 'PRONIX';
  const sdr = process.env.SDR_NAME || 'Cauã Lima';
  const dataStr = new Date().toLocaleDateString('pt-BR');
  const larg = doc.page.width - MARGIN * 2;

  // ---- Cabeçalho (faixa + logo) ----
  doc.save().rect(0, 0, doc.page.width, 84).fill(VERDE).restore();
  // Marca: linha de crescimento (logo)
  const lx = MARGIN;
  const ly = 26;
  doc.save();
  doc.lineWidth(2.4).strokeColor('#ffffff').lineJoin('round').lineCap('round')
    .moveTo(lx, ly + 22).lineTo(lx + 9, ly + 7).lineTo(lx + 16, ly + 15).lineTo(lx + 27, ly + 1).stroke();
  doc.circle(lx + 27, ly + 1, 2.3).fill('#ffffff');
  doc.restore();
  const tx = MARGIN + 42;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('HANDOFF DE PRÉ-VENDAS', tx, 24);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#eafff6').text(company, tx, 48, { continued: true })
    .font('Helvetica').fontSize(10.5).fillColor('#d6f2e6').text(`     SDR: ${sdr}     ·     ${dataStr}`);
  doc.y = 104;
  doc.x = MARGIN;

  // ---- Cartão de resumo ----
  const linhas = [];
  if (dados.lead) linhas.push(['Lead', dados.lead]);
  (dados.resumo || []).forEach((r) => linhas.push([r.rotulo, r.valor]));
  if (linhas.length) {
    const pad = 13;
    const wLabel = 130;
    const wVal = larg - pad * 2 - wLabel - 10;
    const alturas = linhas.map(([rot, val]) => {
      doc.font('Helvetica-Bold').fontSize(10);
      const hL = doc.heightOfString(String(rot), { width: wLabel });
      doc.font('Helvetica').fontSize(10);
      const hV = doc.heightOfString(String(val), { width: wVal });
      return Math.max(hL, hV);
    });
    const alturaCartao = pad * 2 + alturas.reduce((s, h) => s + h + 7, 0) - 7;
    novaPaginaSePreciso(doc, alturaCartao + 10);
    const y0 = doc.y;
    doc.save().roundedRect(MARGIN, y0, larg, alturaCartao, 9).fillAndStroke(CLARO, BORDA).restore();
    let y = y0 + pad;
    linhas.forEach(([rot, val], i) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(VERDE_ESC).text(String(rot), MARGIN + pad, y, { width: wLabel });
      doc.font('Helvetica').fontSize(10).fillColor(TEXTO).text(String(val), MARGIN + pad + wLabel + 10, y, { width: wVal });
      y += alturas[i] + 7;
    });
    doc.y = y0 + alturaCartao + 16;
    doc.x = MARGIN;
  }

  // ---- Seções ----
  (dados.secoes || []).forEach((secao) => {
    novaPaginaSePreciso(doc, 60);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#0f172a').text(semEmoji(secao.titulo), MARGIN, doc.y);
    const ly = doc.y + 1.5;
    doc.save().moveTo(MARGIN, ly).lineTo(MARGIN + 44, ly).lineWidth(2).strokeColor(VERDE).stroke().restore();
    doc.moveDown(0.55);
    doc.font('Helvetica').fontSize(10.5).fillColor('#111827');
    (secao.itens || []).forEach((item, i) => {
      novaPaginaSePreciso(doc, 26);
      bullet(doc, secao.numerada ? `${i + 1}.` : '•', String(item), MARGIN, larg);
      doc.moveDown(0.18);
    });
    doc.moveDown(0.7);
  });

  // ---- Nas palavras do lead (citações) ----
  if (Array.isArray(dados.citacoes) && dados.citacoes.length) {
    novaPaginaSePreciso(doc, 60);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#0f172a').text('Nas palavras do lead', MARGIN, doc.y);
    const ly = doc.y + 1.5;
    doc.save().moveTo(MARGIN, ly).lineTo(MARGIN + 44, ly).lineWidth(2).strokeColor(VERDE).stroke().restore();
    doc.moveDown(0.55);
    dados.citacoes.forEach((c) => {
      novaPaginaSePreciso(doc, 30);
      const y0 = doc.y;
      doc.font('Helvetica-Oblique').fontSize(10.5).fillColor('#334155')
        .text(`“${c}”`, MARGIN + 14, y0, { width: larg - 14, paragraphGap: 5 });
      doc.save().rect(MARGIN, y0, 3, doc.y - y0 - 5).fill(VERDE).restore();
    });
    doc.moveDown(0.4);
  }

  // ---- Frase de impacto ----
  if (dados.frase_impacto) {
    novaPaginaSePreciso(doc, 70);
    doc.moveDown(0.2);
    const y0 = doc.y;
    doc.font('Helvetica-Oblique').fontSize(11.5).fillColor(VERDE_ESC);
    const wTxt = larg - 26;
    const h = doc.heightOfString(`“${dados.frase_impacto}”`, { width: wTxt });
    doc.save().roundedRect(MARGIN, y0, larg, h + 20, 9).fillAndStroke('#e7f6f1', '#bfe6d7').restore();
    doc.fillColor(VERDE_ESC).text(`“${dados.frase_impacto}”`, MARGIN + 13, y0 + 10, { width: wTxt });
    doc.y = y0 + h + 20;
  }
}

function gerarPdfBuffer(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
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

async function gerarPdf(dados, jid) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const buffer = await gerarPdfBuffer(dados);
  const nome = `relatorio_${slugify(dados.lead || jid)}_${timestampArquivo()}.pdf`;
  const caminho = path.join(OUTPUT_DIR, nome);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}

module.exports = { gerarPdf, gerarPdfBuffer };
