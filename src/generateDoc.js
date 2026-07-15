'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
} = require('docx');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

function slugify(texto) {
  return String(texto || 'lead')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'lead';
}

function timestampArquivo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}`
  );
}

function bordaSimples() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  return { top: b, bottom: b, left: b, right: b };
}

function celula(children, { negrito = false, largura } = {}) {
  return new TableCell({
    width: largura ? { size: largura, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [new TextRun({ text: children, bold: negrito })],
      }),
    ],
  });
}

function linhaTabela(rotulo, valor) {
  return new TableRow({
    children: [
      celula(rotulo, { negrito: true, largura: 30 }),
      celula(valor, { largura: 70 }),
    ],
  });
}

/** Monta o objeto Document (compartilhado por gerarDocx e gerarDocxBuffer). */
function montarDocumento(dados) {
  const company = process.env.COMPANY_NAME || 'PRONIX';
  const children = [];

  // Título (heading 1, negrito)
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `📋 HANDOFF DE PRÉ-VENDAS – ${company}`, bold: true })],
    })
  );
  children.push(new Paragraph({ text: '' }));

  // Tabela de resumo: linha "Lead" (se houver) + as linhas que a IA montou.
  const linhas = [];
  if (dados.lead) linhas.push(linhaTabela('Lead', dados.lead));
  (dados.resumo || []).forEach((r) => linhas.push(linhaTabela(r.rotulo, r.valor)));
  if (linhas.length > 0) {
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          ...bordaSimples(),
          insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
          insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
        },
        rows: linhas,
      })
    );
    children.push(new Paragraph({ text: '' }));
  }

  // Seções (títulos + bullets/lista numerada), na ordem que a IA definiu.
  (dados.secoes || []).forEach((secao) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: secao.titulo, bold: true })],
      })
    );
    (secao.itens || []).forEach((item, i) => {
      if (secao.numerada) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `${i + 1}. ${item}` })],
            spacing: { after: 40 },
          })
        );
      } else {
        children.push(
          new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: item })] })
        );
      }
    });
    children.push(new Paragraph({ text: '' }));
  });

  // Frase de impacto (opcional): itálico, entre aspas.
  if (dados.frase_impacto) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: '💬 FRASE DE IMPACTO', bold: true })],
      })
    );
    children.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: `"${dados.frase_impacto}"`, italics: true })],
      })
    );
  }

  return new Document({ sections: [{ properties: {}, children }] });
}

function nomeDocx(dados, jid) {
  return `relatorio_${slugify(dados.lead || jid)}_${timestampArquivo()}.docx`;
}

/**
 * Gera o .docx em disco (modo local). Retorna o caminho do arquivo.
 */
async function gerarDocx(dados, jid) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const doc = montarDocumento(dados);
  const nome = nomeDocx(dados, jid);
  const caminho = path.join(OUTPUT_DIR, nome);
  fs.writeFileSync(caminho, await Packer.toBuffer(doc));
  return caminho;
}

/**
 * Gera o .docx em memória (serverless/Vercel). Retorna { buffer, nome }.
 */
async function gerarDocxBuffer(dados, jid) {
  const doc = montarDocumento(dados);
  const buffer = await Packer.toBuffer(doc);
  return { buffer, nome: nomeDocx(dados, jid) };
}

module.exports = { gerarDocx, gerarDocxBuffer, slugify };
