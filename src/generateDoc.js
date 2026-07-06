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

// Ordem e rótulo/ícone de cada seção (chave do schema -> título com ícone).
const SECOES = [
  { chave: 'perfil_contexto', titulo: '👤 PERFIL & CONTEXTO', numerada: false },
  { chave: 'momento_atual', titulo: '📍 MOMENTO ATUAL', numerada: false },
  { chave: 'sinais_tracao', titulo: '📈 SINAIS DE TRAÇÃO', numerada: false },
  { chave: 'capacidade_decisao', titulo: '💰 CAPACIDADE & DECISÃO', numerada: false },
  { chave: 'agendamento_status', titulo: '📅 AGENDAMENTO & STATUS', numerada: false },
  { chave: 'leitura_estrategica', titulo: '🎯 LEITURA ESTRATÉGICA', numerada: false },
  { chave: 'closer_deve_bater', titulo: '✅ O QUE O CLOSER DEVE BATER', numerada: true },
];

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

/**
 * Gera o .docx de handoff.
 * @param {object} dados objeto no schema do relatório
 * @param {string} jid usado como fallback no nome do arquivo
 * @returns {Promise<string>} caminho absoluto do arquivo gerado
 */
async function gerarDocx(dados, jid) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const company = process.env.COMPANY_NAME || 'Empresa';

  const children = [];

  // Título (heading 1, negrito)
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({ text: `📋 HANDOFF DE PRÉ-VENDAS – ${company}`, bold: true }),
      ],
    })
  );
  children.push(new Paragraph({ text: '' }));

  // Tabela 4 linhas fixas
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        ...bordaSimples(),
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
      },
      rows: [
        linhaTabela('Lead', dados.lead),
        linhaTabela('Status', dados.status),
        linhaTabela('Nicho', dados.nicho),
        linhaTabela('Investimento', dados.investimento),
      ],
    })
  );
  children.push(new Paragraph({ text: '' }));

  // Seções com bullets / lista numerada
  for (const secao of SECOES) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: secao.titulo, bold: true })],
      })
    );
    const itens = Array.isArray(dados[secao.chave]) ? dados[secao.chave] : [];
    itens.forEach((item, i) => {
      if (secao.numerada) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `${i + 1}. ${item}` })],
            spacing: { after: 40 },
          })
        );
      } else {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: item })],
          })
        );
      }
    });
    children.push(new Paragraph({ text: '' }));
  }

  // Frase de impacto (parágrafo único, itálico, entre aspas)
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: '💬 FRASE DE IMPACTO', bold: true })],
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({ text: `"${dados.frase_impacto}"`, italics: true }),
      ],
    })
  );

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const nome = `relatorio_${slugify(dados.lead || jid)}_${timestampArquivo()}.docx`;
  const caminho = path.join(OUTPUT_DIR, nome);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(caminho, buffer);
  return caminho;
}

module.exports = { gerarDocx, slugify };
