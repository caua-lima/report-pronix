'use strict';
const PDFDocument = require('pdfkit');
const { normalizar } = require('../public/js/contexto-lead-model');

function gerarContextoPdf(input, autor = '') {
  const d = normalizar(input, true);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 58, left: 48, right: 48 }, bufferPages: true, info: { Title: `Contexto do lead - ${d.nome}`, Author: 'Report PRONIX' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    // Fontes padrão suportam português; remove símbolos que não existem em WinAnsi.
    const clean = (s) => String(s || '').replace(/[\u{1F000}-\u{1FFFF}]/gu, '').replace(/[\u2010-\u2015]/g, '-');
    const body = (s) => doc.font('Helvetica').fontSize(10.5).fillColor('#33343A').text(clean(s), { lineGap: 4, paragraphGap: 6 });
    const section = (title) => {
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor('#8B6100').text(title, { paragraphGap: 9 });
    };
    doc.rect(0, 0, doc.page.width, 8).fill('#E8AD18');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#8B6100').text('PRONIX / PESQUISA DE CONTEXTO');
    doc.moveDown(0.6).fontSize(26).fillColor('#19191E').text(clean(d.nome));
    doc.moveDown(0.5);
    body([d.empresa, d.cidade, d.email].filter(Boolean).join(' | ') || 'Dados adicionais não informados.');
    doc.fontSize(8.5).fillColor('#66666D').text(`Preparado em ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${autor ? ' por ' + clean(autor) : ''}. Documento separado do report de handoff.`);
    section('01 / Contexto informado');
    body(d.resumo || 'Não informado.');
    section('02 / Fontes e evidências públicas');
    body(d.fontes.length ? `${d.fontes.length} fonte(s) registrada(s). A confirmação de identidade é uma revisão manual; não equivale a uma validação independente.` : 'Nenhuma fonte pública registrada. Este documento contém apenas o contexto e as observações informados pelo responsável.');
    d.fontes.forEach((f, i) => {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor('#19191E').text(`Fonte ${i + 1} / ${f.confirmada ? 'Identidade conferida pelo responsável' : 'Identidade NÃO confirmada'}`);
      body(`Consultada em: ${f.data.split('-').reverse().join('/')}`);
      doc.fontSize(9).fillColor('#765400').text(clean(f.url), { link: f.url, underline: true, lineGap: 2 });
      doc.moveDown(0.5);
      body(f.nota);
    });
    section('03 / Minha visão estratégica');
    body(d.visao || 'Não registrada.');
    section('04 / Como explorar na reunião');
    body(d.gancho || 'Ainda não definido.');
    section('05 / Perguntas para aprofundar');
    body(d.perguntas || 'Confirmar com o lead se os dados profissionais encontrados estão atuais e correspondem à sua atuação.');
    section('06 / Lacunas e pontos a confirmar');
    body(d.lacunas || 'Orçamento, intenção de compra e poder de decisão devem ser confirmados na conversa. Não são comprovados por cargo, empresa ou presença online.');
    if (d.fontes.some((f) => !f.confirmada)) body('Há fontes com identidade não confirmada. Não atribuir essas informações ao lead antes de conferir.');
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor('#77777D').text(`PRONIX | Contexto revisado pelo responsável | ${i + 1} / ${range.count}`, 48, doc.page.height - 38, { lineBreak: false });
    }
    doc.end();
  });
}
module.exports = { gerarContextoPdf };
