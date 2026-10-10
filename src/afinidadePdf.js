'use strict';

// PDF "Afinidade com o closer": a nota de 0 a 10 de um lead para um closer, com os motivos, os
// pontos de atenção e como conduzir a call. É o segundo documento que sai junto do handoff quando
// o pré-vendedor clica em "Esse lead é bom para o <closer>?". Montado aqui no servidor: sem custo.

const PDFDocument = require('pdfkit');
const { visual } = require('./generatePdf');

const { desenharMarca, tituloSecao, faixaNoTopo, bullet, novaPaginaSePreciso, semEmoji, OURO, OURO_ESC, PRETO, CLARO, BORDA, TEXTO, VERDE, MARGIN } = visual;
const VERMELHO = '#d9553f';
const corDaNota = (faixa) => (faixa === 'alta' ? VERDE : faixa === 'baixa' ? VERMELHO : OURO);
const rotuloDaFaixa = (faixa) => (faixa === 'alta' ? 'AFINIDADE ALTA' : faixa === 'baixa' ? 'AFINIDADE BAIXA' : 'AFINIDADE MÉDIA');
const dataBr = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString('pt-BR') : '';
};

function render(doc, { afinidade: a, lead, sdr }) {
  const company = process.env.COMPANY_NAME || 'PRONIX';
  const larg = doc.page.width - MARGIN * 2;
  const cor = corDaNota(a.faixa);

  // ---- Cabeçalho (o mesmo do handoff) ----
  doc.save().rect(0, 0, doc.page.width, 84).fill(PRETO).restore();
  doc.save().rect(0, 81, doc.page.width, 3).fill(OURO).restore();
  desenharMarca(doc, MARGIN, 22, 38);
  const tx = MARGIN + 50;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('AFINIDADE COM O CLOSER', tx, 24);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(OURO).text(company, tx, 48, { continued: true })
    .font('Helvetica').fontSize(10.5).fillColor('#d5d0c5').text(`     SDR: ${sdr || ''}     ·     ${new Date().toLocaleDateString('pt-BR')}`);
  doc.y = 104;
  doc.x = MARGIN;

  // ---- A nota: cartão de tinta, número grande à esquerda, quem e o veredito à direita ----
  const pad = 16;
  const wNota = 96;
  const xTxt = MARGIN + pad + wNota + 14;
  const wTxt = larg - pad * 2 - wNota - 14;
  const veredito = semEmoji(a.veredito);
  doc.font('Helvetica').fontSize(10.5);
  const hVer = veredito ? doc.heightOfString(veredito, { width: wTxt, lineGap: 1 }) : 0;
  const h = Math.max(104, pad + 12 + 20 + 16 + 14 + hVer + pad);
  const y0 = doc.y;
  doc.save().roundedRect(MARGIN, y0, larg, h, 9).fill(PRETO).restore();
  faixaNoTopo(doc, y0, larg, h);

  doc.font('Helvetica-Bold').fontSize(54).fillColor(cor).text(String(a.nota), MARGIN + pad, y0 + pad + 6, { width: wNota - 26, align: 'right', lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#a39e93').text('/10', MARGIN + pad + wNota - 24, y0 + pad + 40, { lineBreak: false });

  let y = y0 + pad;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(cor).text(rotuloDaFaixa(a.faixa), xTxt, y, { width: wTxt, characterSpacing: 0.5 });
  y += 13;
  const quem = `${semEmoji(lead) || 'Lead'}  ×  ${semEmoji(a.closerNome)}`;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(quem, xTxt, y, { width: wTxt, lineBreak: false, ellipsis: true });
  y += 21;
  // Barra de 10 degraus: acende até a nota.
  const gap = 3;
  const wSeg = (Math.min(wTxt, 300) - gap * 9) / 10;
  for (let i = 0; i < 10; i++) {
    doc.save().roundedRect(xTxt + i * (wSeg + gap), y, wSeg, 6, 3).fill(i < a.nota ? cor : '#45424b').restore();
  }
  y += 16;
  if (veredito) doc.font('Helvetica').fontSize(10.5).fillColor('#f3efe6').text(veredito, xTxt, y, { width: wTxt, lineGap: 1 });
  doc.y = y0 + h + 14;
  doc.x = MARGIN;

  // ---- Quem decide ----
  if (a.composicao) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(OURO_ESC).text('QUEM DECIDE: ', MARGIN, doc.y, { continued: true, characterSpacing: 0.4 })
      .font('Helvetica').fillColor(TEXTO).text(semEmoji(a.composicao), { characterSpacing: 0 });
    doc.moveDown(0.8);
  }

  const secao = (titulo, itens, numerada) => {
    const limpos = (itens || []).map(semEmoji).filter(Boolean);
    if (!limpos.length) return;
    novaPaginaSePreciso(doc, 60);
    tituloSecao(doc, titulo);
    doc.font('Helvetica').fontSize(10.5).fillColor(TEXTO);
    limpos.forEach((item, i) => {
      novaPaginaSePreciso(doc, 26);
      bullet(doc, numerada ? `${i + 1}.` : '•', item, MARGIN, larg);
      doc.moveDown(0.18);
    });
    doc.moveDown(0.7);
  };
  secao('Por que essa nota', a.motivos, false);
  secao('Pontos de atenção', a.atencao, false);
  secao('Como conduzir a call', a.comoConduzir, true);
  secao('Confirmar antes da call', a.faltaSaber, false);

  // ---- Em que a nota se apoia (para o leitor saber o peso dela) ----
  const b = a.base || {};
  const apoio = [
    b.inteligenciaEm ? `inteligência do closer atualizada em ${dataBr(b.inteligenciaEm)}` : 'inteligência do closer',
    b.reunioes ? `histórico de ${b.vendas} venda(s) em ${b.reunioes} reunião(ões)` : 'ainda sem histórico de resultados deste closer',
  ].join('  ·  ');
  const nota = `Base da análise: ${apoio}. É uma leitura de apoio feita por IA: use para se preparar, não como sentença.`;
  doc.font('Helvetica').fontSize(8.5);
  const hNota = doc.heightOfString(nota, { width: larg - 24, lineGap: 1 }) + 18;
  novaPaginaSePreciso(doc, hNota + 8);
  const yN = doc.y;
  doc.save().roundedRect(MARGIN, yN, larg, hNota, 7).fillAndStroke(CLARO, BORDA).restore();
  doc.font('Helvetica').fontSize(8.5).fillColor('#4d4a45').text(nota, MARGIN + 12, yN + 9, { width: larg - 24, lineGap: 1 });
  doc.y = yN + hNota + 10;
}

/** @returns {Promise<Buffer>} */
function gerarAfinidadePdfBuffer({ afinidade, lead, sdr }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, compress: process.env.PDF_SEM_COMPRESSAO !== '1' });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      render(doc, { afinidade, lead, sdr });

      const company = process.env.COMPANY_NAME || 'PRONIX';
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        // Rodapé abaixo da margem: zera a margem durante a escrita para o pdfkit não abrir página nova.
        const margemBaixo = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const yRod = doc.page.height - 34;
        doc.save().moveTo(MARGIN, yRod).lineTo(doc.page.width - MARGIN, yRod).lineWidth(1.5).strokeColor(OURO).stroke().restore();
        doc.font('Helvetica-Bold').fontSize(8).fillColor(PRETO).text(company, MARGIN, yRod + 7, { width: doc.page.width - MARGIN * 2, align: 'left', lineBreak: false });
        doc.font('Helvetica').fontSize(8).fillColor('#8f8a7f').text(
          `Afinidade com o closer  ·  uso interno do pré-vendedor  ·  ${i + 1}/${range.count}`,
          MARGIN, yRod + 7, { width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false }
        );
        doc.page.margins.bottom = margemBaixo;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Afinidade_PH_Nome-do-Lead_10-10-2026.pdf */
function nomeDoArquivo(afinidade, lead) {
  const limpar = (s, n) =>
    String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 ]+/g, ' ')
      .trim().split(/\s+/).slice(0, n).join('-').slice(0, 40);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Afinidade_${limpar(afinidade.apelido || afinidade.closerNome, 2) || 'Closer'}_${limpar(lead, 3) || 'Lead'}_${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}.pdf`;
}

module.exports = { gerarAfinidadePdfBuffer, nomeDoArquivo };
