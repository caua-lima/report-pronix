'use strict';

// PDF do handoff editorial (schemaVersion 2, auditoria de 04/11/2026). Relatório editorial, não painel decorativo:
// papel, texto escuro e âmbar discreto. Ordem: identidade + tese → leitura do SDR → oportunidade → panorama →
// condução → abertura → contexto/evidências → como foi a conversa.
//
// Regras de desenho:
// - O nome do lead é a âncora (24 pt); "Handoff de pré-vendas" é subtítulo discreto.
// - Um único destaque: a leitura do SDR (fundo muito leve + filete âmbar). Sem caixas pretas, sem frase de impacto,
//   sem marca-texto em todo título, sem termômetros.
// - Corpo 11 pt regular; títulos 13.5 pt; nada relevante abaixo de 9.5 pt. Itálico só em fala curta do lead.
// - Paginação protege título + primeiro parágrafo; bloco longo continua na página seguinte. Nada é cortado.
// - Fontes padrão do PDF (Helvetica): o texto continua extraível (src/textoDoPdf.js, texto do CRM e importações).

const MARGEM = 49; // ~17 mm
const PAPEL_LEVE = '#fbf6ea';
const TINTA = '#18171b';
const TEXTO = '#2b2925';
const SUAVE = '#5f5a52';
const FIO = '#e2dbc9';
const OURO = '#ffb800';
const OURO_ESC = '#8a5d00';

const CORPO = 11;
const TITULO = 13.5;

function largura(doc) {
  return doc.page.width - MARGEM * 2;
}
function limiteY(doc) {
  return doc.page.height - doc.page.margins.bottom;
}
function cabe(doc, altura) {
  return doc.y + altura <= limiteY(doc);
}
function garantir(doc, altura) {
  if (!cabe(doc, altura)) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
}

function alturaTexto(doc, texto, { fonte = 'Helvetica', tam = CORPO, w, gap = 2 } = {}) {
  doc.font(fonte).fontSize(tam);
  return doc.heightOfString(String(texto || ''), { width: w || largura(doc), lineGap: gap });
}

/** Título de seção com o primeiro trecho junto: nunca fica sozinho no pé da página. */
function tituloSecao(doc, titulo, alturaPrimeiro = 30) {
  const hT = alturaTexto(doc, titulo, { fonte: 'Helvetica-Bold', tam: TITULO });
  garantir(doc, hT + 8 + Math.min(alturaPrimeiro, (limiteY(doc) - doc.page.margins.top) * 0.6));
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(TITULO).fillColor(TINTA).text(titulo, MARGEM, doc.y, { width: largura(doc) });
  doc.moveDown(0.25);
}

function paragrafo(doc, texto, { tam = CORPO, cor = TEXTO, fonte = 'Helvetica', x = MARGEM, w, gap = 2, depois = 0.35 } = {}) {
  doc.font(fonte).fontSize(tam).fillColor(cor).text(String(texto), x, doc.y, { width: w || largura(doc) - (x - MARGEM), lineGap: gap });
  doc.moveDown(depois);
}

/** Item com marcador e texto rico: "negrito." + "normal" no mesmo parágrafo. */
function item(doc, { marcador = '•', forte = '', normal = '', x = MARGEM, w, tam = CORPO }) {
  const larg = (w || largura(doc)) - 16;
  const h = alturaTexto(doc, `${forte} ${normal}`, { tam, w: larg });
  garantir(doc, Math.min(h, 60) + 4);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(tam).fillColor(OURO_ESC).text(marcador, x, y, { width: 14 });
  if (forte) {
    doc.font('Helvetica-Bold').fontSize(tam).fillColor(TINTA).text(forte + (normal ? ' ' : ''), x + 16, y, { width: larg, lineGap: 2, continued: !!normal });
    if (normal) doc.font('Helvetica').fillColor(TEXTO).text(normal, { width: larg, lineGap: 2 });
  } else {
    doc.font('Helvetica').fontSize(tam).fillColor(TEXTO).text(normal, x + 16, y, { width: larg, lineGap: 2 });
  }
  doc.moveDown(0.3);
}

function fio(doc) {
  const y = doc.y + 2;
  doc.save().moveTo(MARGEM, y).lineTo(doc.page.width - MARGEM, y).lineWidth(0.6).strokeColor(FIO).stroke().restore();
  doc.y = y + 6;
}

// ---------------------------------------------------------------- blocos

function cabecalho(doc, v, { sdr, data, desenharMarca }) {
  const w = largura(doc);
  // Faixa de marca discreta: o logotipo pequeno, o tipo de documento e quem gerou.
  desenharMarca(doc, MARGEM, 30, 20);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TINTA).text(process.env.COMPANY_NAME || 'PRONIX', MARGEM + 28, 33, { continued: true })
    .font('Helvetica').fillColor(SUAVE).text('   ·   Handoff de pré-vendas');
  doc.font('Helvetica').fontSize(9.5).fillColor(SUAVE).text(`SDR: ${sdr}   ·   ${data}`, MARGEM, 33, { width: w, align: 'right' });
  doc.save().rect(MARGEM, 58, 36, 2.5).fill(OURO).restore();
  doc.y = 72;
  // O nome do lead é a âncora.
  doc.font('Helvetica-Bold').fontSize(24).fillColor(TINTA).text(v.lead || 'Lead', MARGEM, doc.y, { width: w });
  if (v.negocio) {
    doc.moveDown(0.15);
    paragrafo(doc, v.negocio, { tam: 11.5, cor: SUAVE, depois: 0.2 });
  }
  // Ficha: dados sem IA (datas da conversa, profissão do formulário), em duas colunas curtas.
  if (v.ficha && v.ficha.length) {
    doc.moveDown(0.2);
    const col = (w - 16) / 2;
    for (let i = 0; i < v.ficha.length; i += 2) {
      const y = doc.y;
      let maxY = y;
      [v.ficha[i], v.ficha[i + 1]].forEach((r, k) => {
        if (!r) return;
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(SUAVE).text(`${r.rotulo}: `, MARGEM + k * (col + 16), y, { width: col, continued: true })
          .font('Helvetica').fillColor(TEXTO).text(r.valor);
        maxY = Math.max(maxY, doc.y);
      });
      doc.y = maxY + 2;
    }
  }
  doc.moveDown(0.4);
}

function blocoTese(doc, v) {
  if (!v.tese || (!v.tese.titulo && !v.tese.texto)) return;
  if (v.tese.titulo) {
    garantir(doc, 50);
    doc.font('Helvetica-Bold').fontSize(15).fillColor(TINTA).text(v.tese.titulo, MARGEM, doc.y, { width: largura(doc) });
    doc.moveDown(0.25);
  }
  if (v.tese.texto) paragrafo(doc, v.tese.texto, { tam: 11.5, gap: 2.5 });
}

/** O destaque nobre: a leitura do SDR, com fundo leve e filete âmbar. Continua na próxima página se precisar. */
function blocoLeitura(doc, v) {
  if (!v.leitura || !v.leitura.itens.length) return;
  const w = largura(doc);
  const pad = 12;
  const xTxt = MARGEM + pad + 6;
  const wTxt = w - pad * 2 - 6;
  // Medidas com a MESMA altura de linha do desenho: o fundo termina onde o texto termina.
  doc.font('Helvetica').fontSize(CORPO);
  const respiro = doc.currentLineHeight(true) * 0.3;
  const alturas = v.leitura.itens.map((i) => alturaTexto(doc, i, { w: wTxt - 14 }) + respiro);
  doc.font('Helvetica-Bold').fontSize(TITULO);
  const hTitulo = alturaTexto(doc, v.leitura.titulo, { fonte: 'Helvetica-Bold', tam: TITULO, w: wTxt, gap: 0 }) + doc.currentLineHeight(true) * 0.3;
  const autoria = v.leitura.status === 'aprovada' ? 'Escrita e revisada pelo SDR.' : 'Escrita pelo SDR.';
  const hRodape = alturaTexto(doc, autoria, { tam: 9.5, w: wTxt, gap: 0 });
  const total = pad + hTitulo + alturas.reduce((s, h) => s + h, 0) + hRodape + pad;

  doc.moveDown(0.5);
  const espacoPagina = limiteY(doc) - doc.page.margins.top;
  garantir(doc, Math.min(total, espacoPagina));

  const fundo = (y0, y1) => {
    doc.save().rect(MARGEM, y0, w, y1 - y0).fill(PAPEL_LEVE).restore();
    doc.save().rect(MARGEM, y0, 3, y1 - y0).fill(OURO).restore();
  };
  // O fundo de cada página é desenhado antes do texto (o texto vem por cima) e vai até onde o conteúdo vai.
  let fimDoFundo = doc.y + Math.min(total, limiteY(doc) - doc.y);
  fundo(doc.y, fimDoFundo);
  doc.y += pad;
  doc.font('Helvetica-Bold').fontSize(TITULO).fillColor(TINTA).text(v.leitura.titulo, xTxt, doc.y, { width: wTxt });
  doc.moveDown(0.3);
  v.leitura.itens.forEach((it, i) => {
    if (!cabe(doc, Math.min(alturas[i], 40))) {
      doc.addPage();
      const yIni = doc.page.margins.top;
      const resto = pad + alturas.slice(i).reduce((s, h) => s + h, 0) + hRodape + pad;
      fimDoFundo = yIni + Math.min(resto, limiteY(doc) - yIni);
      fundo(yIni, fimDoFundo);
      doc.y = yIni + pad;
    }
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(CORPO).fillColor(OURO_ESC).text('•', xTxt, y, { width: 12 });
    doc.font('Helvetica').fontSize(CORPO).fillColor(TEXTO).text(it, xTxt + 14, y, { width: wTxt - 14, lineGap: 2 });
    doc.moveDown(0.3);
  });
  doc.font('Helvetica').fontSize(9.5).fillColor(SUAVE).text(autoria, xTxt, doc.y, { width: wTxt });
  // O próximo bloco começa depois do fundo (nunca dentro dele).
  doc.y = Math.max(doc.y + pad, fimDoFundo) + 4;
  doc.x = MARGEM;
}

function blocoOportunidade(doc, v) {
  if (!v.oportunidade.length) return;
  const primeiro = v.oportunidade[0];
  tituloSecao(doc, 'Oportunidade em foco', alturaTexto(doc, `${primeiro.fato} ${primeiro.relevancia}`));
  v.oportunidade.forEach((o) => {
    const fato = /[.!?]$/.test(o.fato) ? o.fato : o.fato + '.';
    const origem = o.origem === 'leitura_sdr' ? ' (leitura do SDR)' : '';
    item(doc, { forte: fato, normal: (o.relevancia || '') + origem });
  });
}

function blocoPanorama(doc, v) {
  if (!v.panorama.length) return;
  const w = largura(doc);
  const wRot = 150;
  const wVal = w - wRot - 10;
  const alturas = v.panorama.map((p) => Math.max(alturaTexto(doc, p.rotulo, { fonte: 'Helvetica-Bold', tam: 10, w: wRot }), alturaTexto(doc, p.valor, { w: wVal })));
  // Tabela curta fica inteira (título junto): só quebra se não couber nem numa página vazia.
  const total = alturas.reduce((s, h) => s + h + 12, 0);
  tituloSecao(doc, 'Panorama comercial', total <= (limiteY(doc) - doc.page.margins.top) * 0.6 ? total : 40);
  v.panorama.forEach((p, i) => {
    const h = alturas[i];
    garantir(doc, h + 8);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(SUAVE).text(p.rotulo, MARGEM, y + 1, { width: wRot });
    doc.font('Helvetica').fontSize(CORPO).fillColor(TEXTO).text(p.valor, MARGEM + wRot + 10, y, { width: wVal, lineGap: 2 });
    doc.y = y + h + 4;
    if (i < v.panorama.length - 1) fio(doc);
  });
  doc.moveDown(0.2);
}

function blocoConducao(doc, v) {
  if (!v.conducao.length) return;
  const p0 = v.conducao[0];
  tituloSecao(doc, 'Condução da reunião', alturaTexto(doc, p0.acao) + 20);
  const w = largura(doc);
  v.conducao.forEach((p, i) => {
    const rotulo = p.etapa ? `${i + 1}. ${p.etapa}` : `${i + 1}.`;
    const h = alturaTexto(doc, p.acao, { w: w - 16 }) + (p.objetivo ? 16 : 0) + 18;
    garantir(doc, Math.min(h, 90));
    doc.font('Helvetica-Bold').fontSize(CORPO).fillColor(OURO_ESC).text(rotulo, MARGEM, doc.y, { width: w });
    doc.moveDown(0.1);
    paragrafo(doc, p.acao, { x: MARGEM + 16, depois: 0.1 });
    if (p.pergunta) paragrafo(doc, `Pergunta: ${p.pergunta}`, { x: MARGEM + 16, tam: 10.5, cor: TEXTO, depois: 0.1 });
    if (p.objetivo) paragrafo(doc, `Objetivo: ${p.objetivo}`, { x: MARGEM + 16, tam: 10, cor: SUAVE, depois: 0.45 });
    else doc.moveDown(0.35);
  });
}

function blocoAbertura(doc, v) {
  if (!v.abertura) return;
  tituloSecao(doc, 'Abertura sugerida', alturaTexto(doc, v.abertura) + 10);
  const w = largura(doc) - 14;
  const h = alturaTexto(doc, `“${v.abertura}”`, { w, gap: 2.5 });
  garantir(doc, Math.min(h, 120));
  const y = doc.y;
  doc.font('Helvetica').fontSize(CORPO).fillColor(TEXTO).text(`“${v.abertura}”`, MARGEM + 14, y, { width: w, lineGap: 2.5 });
  if (doc.y > y) doc.save().rect(MARGEM, y, 2, doc.y - y).fill(FIO).restore();
  doc.moveDown(0.4);
}

function blocoLista(doc, titulo, itens, { italico = false, aspas = false } = {}) {
  if (!itens || !itens.length) return;
  tituloSecao(doc, titulo, alturaTexto(doc, itens[0]));
  itens.forEach((t) => {
    if (italico) {
      const w = largura(doc) - 14;
      const texto = aspas ? `“${t}”` : t;
      garantir(doc, Math.min(alturaTexto(doc, texto, { fonte: 'Helvetica-Oblique', tam: 10.5, w }), 50) + 4);
      paragrafo(doc, texto, { fonte: 'Helvetica-Oblique', tam: 10.5, cor: SUAVE, x: MARGEM + 14, depois: 0.3 });
    } else item(doc, { normal: t, tam: 10.5 });
  });
}

/**
 * @param {PDFKit.PDFDocument} doc
 * @param {object} v a vista editorial (src/handoff.js → vistaEditorial)
 */
function renderEditorial(doc, v, { sdr = '', data = new Date().toLocaleDateString('pt-BR') } = {}) {
  const { visual } = require('./generatePdf'); // tardio: generatePdf também requer este módulo
  cabecalho(doc, v, { sdr, data, desenharMarca: visual.desenharMarca });
  blocoTese(doc, v);
  blocoLeitura(doc, v);
  blocoOportunidade(doc, v);
  blocoPanorama(doc, v);
  blocoConducao(doc, v);
  blocoAbertura(doc, v);
  blocoLista(doc, 'Contexto', v.contexto);
  blocoLista(doc, 'Nas palavras do lead', v.evidencias, { italico: true, aspas: true });
  blocoLista(doc, 'Como foi a conversa', v.conversa);
}

module.exports = { renderEditorial, MARGEM };
