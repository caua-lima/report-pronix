'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { slugify } = require('./generateDoc');
const { infoDoNivel, mostrarConsciencia, mostrarBarra, tituloDoMomento, NIVEIS } = require('./consciencia');
const { doresVisiveis } = require('./dores');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Sistema visual do Report PRONIX no papel: tinta, âmbar e marca-texto (o mesmo do painel e da extensão).
const OURO = '#ffb800';
const OURO_ESC = '#8a5d00'; // âmbar legível sobre fundo claro
const MARCA = '#ffdf8a'; // o risco de marca-texto atrás dos títulos
const PRETO = '#18171b';
const CLARO = '#f7f2e7';
const BORDA = '#e2dbc9';
const TEXTO = '#2b2925';
const VERDE = '#1fbf5c';
const MARGIN = 46;

/** A marca: folha de relatório com o selo de "pronto", no quadrado âmbar (desenhada num espaço 0..128). */
function desenharMarca(doc, x, y, tam) {
  const s = tam / 128;
  const p = (px, py) => [x + px * s, y + py * s];
  doc.save();
  doc.roundedRect(x, y, tam, tam, 28 * s).fill(OURO);
  doc.polygon(p(34, 22), p(72, 22), p(92, 42), p(92, 106), p(34, 106)).fill(PRETO);
  doc.polygon(p(72, 22), p(92, 42), p(72, 42)).fill('#45424b');
  doc.lineWidth(7 * s).lineCap('round').strokeColor(OURO);
  [[46, 56, 80], [46, 72, 74], [46, 88, 62]].forEach(([x0, yy, x1]) => {
    doc.moveTo(...p(x0, yy)).lineTo(...p(x1, yy)).stroke();
  });
  doc.circle(...p(92, 96), 26 * s).fill(OURO);
  doc.circle(...p(92, 96), 21 * s).fill(VERDE);
  doc.lineJoin('round').strokeColor('#ffffff')
    .moveTo(...p(81, 97)).lineTo(...p(89, 105)).lineTo(...p(103, 88)).stroke();
  doc.restore();
}

/** Título de seção com o marca-texto atrás (ocupa a mesma altura do título sublinhado de antes). */
function tituloSecao(doc, texto) {
  doc.font('Helvetica-Bold').fontSize(12.5);
  const y = doc.y;
  const w = Math.min(doc.widthOfString(texto), doc.page.width - MARGIN * 2);
  doc.save().rect(MARGIN - 2, y + 6, w + 4, 7).fill(MARCA).restore();
  doc.fillColor(PRETO).text(texto, MARGIN, y);
  doc.moveDown(0.55);
}

/** Faixa âmbar no topo de um cartão arredondado (recortada pelo próprio canto do cartão). */
function faixaNoTopo(doc, y0, larg, altura) {
  doc.save();
  doc.roundedRect(MARGIN, y0, larg, altura, 9).clip();
  doc.rect(MARGIN, y0, larg, 3.5).fill(OURO);
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
  doc.font('Helvetica').fillColor(TEXTO).text(texto, x + wMarc, y, {
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

  // ---- Cabeçalho (faixa de tinta, a marca e um fio de âmbar fechando a faixa) ----
  doc.save().rect(0, 0, doc.page.width, 84).fill(PRETO).restore();
  doc.save().rect(0, 81, doc.page.width, 3).fill(OURO).restore();
  desenharMarca(doc, MARGIN, 22, 38);
  const tx = MARGIN + 50;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('HANDOFF DE PRÉ-VENDAS', tx, 24);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(OURO).text(company, tx, 48, { continued: true })
    .font('Helvetica').fontSize(10.5).fillColor('#d5d0c5').text(`     SDR: ${sdr}     ·     ${dataStr}`);
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
    faixaNoTopo(doc, y0, larg, alturaCartao);
    let y = y0 + pad;
    linhas.forEach(([rot, val], i) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PRETO).text(String(rot), MARGIN + pad + 4, y, { width: wLabel });
      doc.font('Helvetica').fontSize(10).fillColor(TEXTO).text(String(val), MARGIN + pad + wLabel + 14, y, { width: wVal });
      y += alturas[i] + 7;
    });
    doc.y = y0 + alturaCartao + 16;
    doc.x = MARGIN;
  }


  // ---- Temperatura do lead: dores, momento do lead (o selo do nível de consciência) e sinais de compra ----
  // O selo aparece sempre que há leitura: título escrito para o lead, a fala dele e o porquê. A barra de
  // degraus só entra quando o nível é bom.
  const verConsciencia = mostrarConsciencia(dados.consciencia);
  const verBarra = mostrarBarra(dados.consciencia);
  const tituloMomento = verConsciencia ? tituloDoMomento(dados.consciencia, dados.lead) : '';
  const falaMomento = verConsciencia && dados.consciencia.fala ? `“${semEmoji(dados.consciencia.fala)}”` : '';
  const sinais = (dados.sinais_compra || []).filter(Boolean);
  // Termômetro de dores: só dor de fato (intensidade 3 ou mais). É o motivo da compra, então abre o cartão.
  const dores = doresVisiveis(dados.dores);
  const corDaDor = (n) => (n >= 5 ? '#ff5f45' : n === 4 ? '#ff9a3d' : OURO);
  const W_TERMO = 5 * 15 + 4 * 3; // cinco degraus de 15 com 3 de vão
  if (verConsciencia || sinais.length || dores.length) {
    const pad = 13;
    const xIn = MARGIN + pad + 4;
    const wTxt = larg - pad * 2 - 4;
    const info = infoDoNivel(dados.consciencia);
    const porque = verConsciencia ? String(dados.consciencia.porque || '') : '';

    // Mede antes de desenhar (o cartão tem fundo).
    let h = pad;
    const wDor = wTxt - W_TERMO - 14;
    const medidasDores = dores.map((d) => {
      doc.font('Helvetica-Bold').fontSize(10.5);
      const hDor = Math.max(doc.heightOfString(d.dor, { width: wDor }), 9);
      doc.font('Helvetica').fontSize(9.5);
      const hPq = d.porque ? doc.heightOfString(d.porque, { width: wTxt }) + 2 : 0;
      return { hDor, hPq };
    });
    if (dores.length) {
      h += 14; // rótulo
      medidasDores.forEach((m) => { h += m.hDor + m.hPq + 7; });
      if (verConsciencia) h += 6;
    }
    if (verConsciencia) {
      h += 12 + (verBarra ? 16 : 2); // rótulo + barra
      doc.font('Helvetica-Bold').fontSize(12);
      h += doc.heightOfString(tituloMomento, { width: wTxt }) + 2;
      if (falaMomento) {
        doc.font('Helvetica-Oblique').fontSize(10);
        h += doc.heightOfString(falaMomento, { width: wTxt }) + 3;
      }
      if (porque) {
        doc.font('Helvetica').fontSize(10);
        h += doc.heightOfString(porque, { width: wTxt }) + 4;
      }
    }
    if (sinais.length) {
      h += (verConsciencia || dores.length ? 10 : 0) + 14;
      doc.font('Helvetica').fontSize(10);
      sinais.forEach((s) => { h += doc.heightOfString(String(s), { width: wTxt - 16 }) + 4; });
    }
    h += pad - 4;

    novaPaginaSePreciso(doc, h + 12);
    const y0 = doc.y;
    doc.save().roundedRect(MARGIN, y0, larg, h, 9).fill(PRETO).restore();
    faixaNoTopo(doc, y0, larg, h);
    let y = y0 + pad;

    if (dores.length) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(OURO)
        .text('TERMÔMETRO DE DORES', xIn, y, { width: wTxt, characterSpacing: 0.5 });
      y += 14;
      dores.forEach((d, i) => {
        const m = medidasDores[i];
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#ffffff').text(d.dor, xIn, y, { width: wDor });
        // O termômetro: cinco degraus, acesos até a intensidade; quanto mais dói, mais quente a cor.
        const xT = xIn + wTxt - W_TERMO;
        for (let k = 0; k < 5; k++) {
          doc.save().roundedRect(xT + k * 18, y + 3, 15, 6, 3).fill(k < d.intensidade ? corDaDor(d.intensidade) : '#45424b').restore();
        }
        y += m.hDor;
        if (d.porque) {
          doc.font('Helvetica').fontSize(9.5).fillColor('#d5d0c5').text(d.porque, xIn, y + 1, { width: wTxt });
          y += m.hPq;
        }
        y += 7;
      });
      if (verConsciencia) y += 6;
    }

    if (verConsciencia) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(OURO)
        .text('MOMENTO DO LEAD', xIn, y, { width: wTxt, characterSpacing: 0.5 });
      y += 12;
      if (verBarra) {
        // Barra de 5 degraus: acende até o nível do lead.
        const gap = 4;
        const wSeg = (Math.min(wTxt, 260) - gap * (NIVEIS.length - 1)) / NIVEIS.length;
        NIVEIS.forEach((n, i) => {
          const cor = n.numero <= info.numero ? OURO : '#45424b';
          doc.save().roundedRect(xIn + i * (wSeg + gap), y + 2, wSeg, 6, 3).fill(cor).restore();
        });
        y += 16;
      } else {
        y += 2;
      }
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text(tituloMomento, xIn, y, { width: wTxt });
      y = doc.y + 2;
      if (falaMomento) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(OURO).text(falaMomento, xIn, y, { width: wTxt });
        y = doc.y + 3;
      }
      if (porque) {
        doc.font('Helvetica').fontSize(10).fillColor('#d5d0c5').text(porque, xIn, y, { width: wTxt });
        y = doc.y + 4;
      }
    }
    if (sinais.length) {
      if (verConsciencia || dores.length) y += 10;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(OURO)
        .text('SINAIS DE COMPRA', xIn, y, { width: wTxt, characterSpacing: 0.5 });
      y += 14;
      sinais.forEach((s) => {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(OURO).text('+', xIn, y, { width: 12 });
        doc.font('Helvetica').fontSize(10).fillColor('#ffffff').text(String(s), xIn + 16, y, { width: wTxt - 16 });
        y = doc.y + 4;
      });
    }
    doc.y = y0 + h + 16;
    doc.x = MARGIN;
  }

  // ---- Como foi a conversa (o desenrolar, com os nomes) ----
  const conversa = (dados.conversa || []).filter(Boolean);
  if (conversa.length) {
    novaPaginaSePreciso(doc, 60);
    tituloSecao(doc, 'Como foi a conversa');
    doc.font('Helvetica').fontSize(10.5).fillColor(TEXTO);
    conversa.forEach((item) => {
      novaPaginaSePreciso(doc, 26);
      bullet(doc, '•', semEmoji(item), MARGIN, larg);
      doc.moveDown(0.18);
    });
    doc.moveDown(0.7);
  }

  // ---- Seções ----
  (dados.secoes || []).forEach((secao) => {
    novaPaginaSePreciso(doc, 60);
    tituloSecao(doc, semEmoji(secao.titulo));
    doc.font('Helvetica').fontSize(10.5).fillColor(TEXTO);
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
    tituloSecao(doc, 'Nas palavras do lead');
    dados.citacoes.forEach((c) => {
      novaPaginaSePreciso(doc, 30);
      const y0 = doc.y;
      doc.font('Helvetica-Oblique').fontSize(10.5).fillColor('#4d4a45')
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
    faixaNoTopo(doc, y0, larg, h + 24);
    doc.font('Helvetica-Oblique').fontSize(11.5).fillColor(OURO)
      .text(`“${dados.frase_impacto}”`, MARGIN + 15, y0 + 12, { width: wTxt });
    doc.y = y0 + h + 24;
  }

  // ---- Abertura sugerida (fala pronta) — POR ÚLTIMO: é o que o closer usa ao vivo ----
  if (dados.abertura) {
    doc.moveDown(0.5);
    const pad = 12;
    const wTxt = larg - pad * 2 - 4;

    // Pontos-chave (Investimento/Motivação/Decisor) logo abaixo da fala: entre uma
    // call e outra o closer bate o olho só neste card e já tem o essencial, sem
    // rolar até a tabela do topo. São os mesmos 3 campos que o resumo já garante
    // preenchidos — não chama a IA de novo, é só reaproveitar o que já veio.
    const normalizado = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const rotulosChave = ['investimento', 'motiva', 'decisor'];
    const pontosChave = rotulosChave
      .map((alvo) => (dados.resumo || []).find((r) => normalizado(r.rotulo).includes(alvo)))
      .filter(Boolean);

    doc.font('Helvetica-Bold').fontSize(8.5);
    const hRot = doc.heightOfString('COMO INICIAR A REUNIÃO', { width: wTxt });
    doc.font('Helvetica-Oblique').fontSize(10.5);
    const hTxt = doc.heightOfString(`“${dados.abertura}”`, { width: wTxt, lineGap: 1.5 });

    doc.font('Helvetica').fontSize(8.5);
    let hChave = 0;
    if (pontosChave.length) {
      hChave = 14; // divisor + respiro
      pontosChave.forEach((p) => {
        hChave += doc.heightOfString(`${p.rotulo}: ${p.valor}`, { width: wTxt, lineGap: 1 }) + 4;
      });
    }

    const alturaCartao = pad * 2 + hRot + 6 + hTxt + hChave;
    novaPaginaSePreciso(doc, alturaCartao + 12);
    const y0 = doc.y;
    doc.save().roundedRect(MARGIN, y0, larg, alturaCartao, 9).fillAndStroke(CLARO, BORDA).restore();
    faixaNoTopo(doc, y0, larg, alturaCartao);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(OURO_ESC)
      .text('COMO INICIAR A REUNIÃO', MARGIN + pad + 4, y0 + pad, { width: wTxt, characterSpacing: 0.5 });
    doc.font('Helvetica-Oblique').fontSize(10.5).fillColor(TEXTO)
      .text(`“${dados.abertura}”`, MARGIN + pad + 4, doc.y + 6, { width: wTxt, lineGap: 1.5 });

    if (pontosChave.length) {
      doc.moveDown(0.35);
      const lyChave = doc.y;
      doc.save().moveTo(MARGIN + pad + 4, lyChave).lineTo(MARGIN + pad + 44, lyChave)
        .lineWidth(1).strokeColor(BORDA).stroke().restore();
      doc.moveDown(0.3);
      pontosChave.forEach((p) => {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(OURO_ESC)
          .text(`${p.rotulo}: `, MARGIN + pad + 4, doc.y, { continued: true, width: wTxt });
        doc.font('Helvetica').fontSize(8.5).fillColor('#4d4a45').text(p.valor, { width: wTxt, lineGap: 1 });
        doc.moveDown(0.15);
      });
    }

    doc.y = y0 + alturaCartao + 16;
    doc.x = MARGIN;
  }
}

const MAX_PAGINAS = 2;

// Cortes progressivos para caber no limite, do menos essencial para o mais.
// O RESUMO (a qualificação) nunca é tocado — é o motivo do relatório existir.
const CORTES = [
  (d) => { d.conversa = (d.conversa || []).slice(0, 4); },
  (d) => { d.secoes = (d.secoes || []).map((s) => ({ ...s, itens: (s.itens || []).slice(0, 3) })); },
  (d) => { d.citacoes = (d.citacoes || []).slice(0, 2); },
  (d) => { d.dores = (d.dores || []).slice(0, 2); },
  (d) => { d.conversa = (d.conversa || []).slice(0, 3); d.sinais_compra = (d.sinais_compra || []).slice(0, 3); },
  (d) => { d.secoes = (d.secoes || []).map((s) => ({ ...s, itens: (s.itens || []).slice(0, 2) })); },
  (d) => { d.conversa = (d.conversa || []).slice(0, 2); d.sinais_compra = (d.sinais_compra || []).slice(0, 2); },
  (d) => { d.secoes = (d.secoes || []).slice(0, 3); },
  // As falas do lead são o que mais anima o closer: ficam até quase o fim, e uma sobrevive sempre que couber.
  (d) => { d.citacoes = (d.citacoes || []).slice(0, 1); },
  (d) => { d.secoes = (d.secoes || []).slice(0, 2); },
  (d) => { d.dores = (d.dores || []).slice(0, 1); },
  (d) => { d.citacoes = []; },
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
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, compress: process.env.PDF_SEM_COMPRESSAO !== '1' });
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
        doc.font('Helvetica').fontSize(8).fillColor('#8f8a7f').text(
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

// "visual": o desenho da casa, para os outros PDFs (ver src/afinidadePdf.js) saírem iguais.
module.exports = {
  gerarPdf, gerarPdfBuffer, renderizarPdf,
  visual: { desenharMarca, tituloSecao, faixaNoTopo, bullet, novaPaginaSePreciso, semEmoji, OURO, OURO_ESC, MARCA, PRETO, CLARO, BORDA, TEXTO, VERDE, MARGIN },
};
