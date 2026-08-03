'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { slugify } = require('./generateDoc');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Cores PRONIX: preto + dourado.
const OURO = '#ffc400';
const OURO_ESC = '#a67c00'; // dourado legível sobre fundo claro
const PRETO = '#121214';
const CLARO = '#faf9f5';
const BORDA = '#e6e2d6';
const TEXTO = '#1f2937';
const MARGIN = 46;

// Raio da marca PRONIX (espaço 0..30).
const RAIO = [
  [18.2, 2.5], [8.5, 16.8], [14.2, 16.8], [11.6, 27.5], [21.5, 12.6], [15.8, 12.6],
];
function desenharRaio(doc, x, y, tam, cor) {
  const s = tam / 30;
  doc.save().fillColor(cor);
  RAIO.forEach(([px, py], i) => {
    const X = x + px * s;
    const Y = y + py * s;
    if (i === 0) doc.moveTo(X, Y);
    else doc.lineTo(X, Y);
  });
  doc.closePath().fill();
  doc.restore();
}

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

// Marcador em dourado + texto escuro (padrão PRONIX).
function bullet(doc, marcador, texto, x, largura) {
  const y = doc.y;
  const wMarc = 18;
  doc.font('Helvetica-Bold').fillColor(OURO_ESC).text(marcador, x, y, { width: wMarc });
  doc.font('Helvetica').fillColor('#1f2937').text(texto, x + wMarc, y, {
    width: largura - wMarc,
    paragraphGap: 2,
  });
}

// Quem gerou vem da chave usada (dados.sdr). SDR_NAME é só o padrão de quem roda local.
const nomeSdr = (dados) => (dados && dados.sdr) || process.env.SDR_NAME || 'Cauã Lima';

function render(doc, dados) {
  const company = process.env.COMPANY_NAME || 'PRONIX';
  const sdr = nomeSdr(dados);
  const dataStr = new Date().toLocaleDateString('pt-BR');
  const larg = doc.page.width - MARGIN * 2;

  // ---- Cabeçalho (faixa preta + raio dourado) ----
  doc.save().rect(0, 0, doc.page.width, 84).fill(PRETO).restore();
  desenharRaio(doc, MARGIN, 26, 32, OURO);
  const tx = MARGIN + 42;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('HANDOFF DE PRÉ-VENDAS', tx, 24);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(OURO).text(company, tx, 48, { continued: true })
    .font('Helvetica').fontSize(10.5).fillColor('#c9ced6').text(`     SDR: ${sdr}     ·     ${dataStr}`);
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
    // faixa dourada na lateral esquerda (marca)
    doc.save().rect(MARGIN + 1, y0 + 1, 4, alturaCartao - 2).fill(OURO).restore();
    let y = y0 + pad;
    linhas.forEach(([rot, val], i) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PRETO).text(String(rot), MARGIN + pad + 4, y, { width: wLabel });
      doc.font('Helvetica').fontSize(10).fillColor(TEXTO).text(String(val), MARGIN + pad + wLabel + 14, y, { width: wVal });
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
    doc.save().moveTo(MARGIN, ly).lineTo(MARGIN + 44, ly).lineWidth(2).strokeColor(OURO).stroke().restore();
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
    doc.save().moveTo(MARGIN, ly).lineTo(MARGIN + 44, ly).lineWidth(2).strokeColor(OURO).stroke().restore();
    doc.moveDown(0.55);
    dados.citacoes.forEach((c) => {
      novaPaginaSePreciso(doc, 30);
      const y0 = doc.y;
      doc.font('Helvetica-Oblique').fontSize(10.5).fillColor('#334155')
        .text(`“${c}”`, MARGIN + 14, y0, { width: larg - 14, paragraphGap: 5 });
      doc.save().rect(MARGIN, y0, 3, doc.y - y0 - 5).fill(OURO).restore();
    });
    doc.moveDown(0.4);
  }

  // ---- Frase de impacto (caixa preta com texto dourado = marca PRONIX) ----
  if (dados.frase_impacto) {
    novaPaginaSePreciso(doc, 80);
    doc.moveDown(0.2);
    const y0 = doc.y;
    doc.font('Helvetica-Oblique').fontSize(11.5);
    const wTxt = larg - 30;
    const h = doc.heightOfString(`“${dados.frase_impacto}”`, { width: wTxt });
    doc.save().roundedRect(MARGIN, y0, larg, h + 24, 9).fill(PRETO).restore();
    doc.save().rect(MARGIN + 1, y0 + 1, 4, h + 22).fill(OURO).restore();
    doc.font('Helvetica-Oblique').fontSize(11.5).fillColor(OURO)
      .text(`“${dados.frase_impacto}”`, MARGIN + 15, y0 + 12, { width: wTxt });
    doc.y = y0 + h + 24;
  }

  // ---- Abertura sugerida (fala pronta) — POR ÚLTIMO: é o que o closer usa ao vivo ----
  if (dados.abertura) {
    doc.moveDown(0.5);
    const pad = 12;
    const wTxt = larg - pad * 2 - 4;
    doc.font('Helvetica-Bold').fontSize(8.5);
    const hRot = doc.heightOfString('COMO INICIAR A REUNIÃO', { width: wTxt });
    doc.font('Helvetica-Oblique').fontSize(10.5);
    const hTxt = doc.heightOfString(`“${dados.abertura}”`, { width: wTxt, lineGap: 1.5 });
    const alturaCartao = pad * 2 + hRot + 6 + hTxt;
    novaPaginaSePreciso(doc, alturaCartao + 12);
    const y0 = doc.y;
    doc.save().roundedRect(MARGIN, y0, larg, alturaCartao, 9).fillAndStroke(CLARO, BORDA).restore();
    doc.save().rect(MARGIN + 1, y0 + 1, 4, alturaCartao - 2).fill(OURO).restore();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(OURO_ESC)
      .text('COMO INICIAR A REUNIÃO', MARGIN + pad + 4, y0 + pad, { width: wTxt, characterSpacing: 0.5 });
    doc.font('Helvetica-Oblique').fontSize(10.5).fillColor('#1f2937')
      .text(`“${dados.abertura}”`, MARGIN + pad + 4, doc.y + 6, { width: wTxt, lineGap: 1.5 });
    doc.y = y0 + alturaCartao + 16;
    doc.x = MARGIN;
  }
}

const MAX_PAGINAS = 2;

// Cortes progressivos para caber no limite, do menos essencial para o mais.
// O RESUMO (a qualificação) nunca é tocado — é o motivo do relatório existir.
const CORTES = [
  (d) => { d.citacoes = (d.citacoes || []).slice(0, 2); },
  (d) => { d.citacoes = (d.citacoes || []).slice(0, 1); },
  (d) => { d.secoes = (d.secoes || []).map((s) => ({ ...s, itens: (s.itens || []).slice(0, 3) })); },
  (d) => { d.citacoes = []; },
  (d) => { d.secoes = (d.secoes || []).map((s) => ({ ...s, itens: (s.itens || []).slice(0, 2) })); },
  (d) => { d.secoes = (d.secoes || []).slice(0, 3); },
  (d) => { d.secoes = (d.secoes || []).slice(0, 2); },
];

/** Aplica os cortes 0..n numa CÓPIA (a tela continua mostrando o relatório inteiro). */
function enxugar(dados, ate) {
  const d = JSON.parse(JSON.stringify(dados));
  for (let i = 0; i <= ate && i < CORTES.length; i++) CORTES[i](d);
  return d;
}

/**
 * Gera o PDF respeitando o teto de páginas. Renderiza, mede e, se passou,
 * enxuga o conteúdo menos essencial e tenta de novo (render em memória é barato).
 */
async function gerarPdfBuffer(dados) {
  let ultimo = await renderizarPdf(dados);
  for (let n = 0; ultimo.paginas > MAX_PAGINAS && n < CORTES.length; n++) {
    ultimo = await renderizarPdf(enxugar(dados, n));
  }
  return ultimo.buffer;
}

function renderizarPdf(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
      const chunks = [];
      let paginas = 0;
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), paginas }));
      doc.on('error', reject);

      render(doc, dados);

      // Rodapé com a marca em todas as páginas.
      const company = process.env.COMPANY_NAME || 'PRONIX';
      const sdr = nomeSdr(dados);
      const range = doc.bufferedPageRange();
      paginas = range.count;
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        // O rodapé fica abaixo da margem inferior. Para o pdfkit, escrever fora da
        // área útil significa "a página acabou" e ele cria outra — era daí que vinham
        // as páginas em branco. Zerar a margem durante a escrita evita isso.
        const margemBaixo = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        const yRod = doc.page.height - 34;
        doc.save().moveTo(MARGIN, yRod).lineTo(doc.page.width - MARGIN, yRod)
          .lineWidth(1.5).strokeColor(OURO).stroke().restore();
        doc.font('Helvetica-Bold').fontSize(8).fillColor(PRETO).text(
          `${company}`,
          MARGIN,
          yRod + 7,
          { width: doc.page.width - MARGIN * 2, align: 'left', lineBreak: false }
        );
        doc.font('Helvetica').fontSize(8).fillColor('#8b8b95').text(
          `Handoff de pré-vendas  ·  SDR: ${sdr}  ·  ${i + 1}/${range.count}`,
          MARGIN,
          yRod + 7,
          { width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false }
        );

        doc.page.margins.bottom = margemBaixo;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function gerarPdf(dados, jid) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const buffer = await gerarPdfBuffer(dados);
  const empresa = (process.env.COMPANY_NAME || 'PRONIX').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PRONIX';
  const nome = `${empresa}_relatorio_${slugify(dados.lead || jid)}_${timestampArquivo()}.pdf`;
  const caminho = path.join(OUTPUT_DIR, nome);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}

module.exports = { gerarPdf, gerarPdfBuffer };
