'use strict';

// Texto de um PDF — feito para o PDF do handoff que o próprio sistema gera (src/generatePdf.js, fontes
// padrão do PDF). Serve para a análise de match quando a conversa com o lead foi por ligação: não há
// conversa escrita, só o report. Lê os blocos de texto das páginas, na ordem, e junta na mesma linha o
// que está na mesma altura (rótulo e valor do resumo). PDF escaneado (imagem) não tem texto: volta vazio.
// Nada do arquivo é executado: só os trechos de texto são decodificados.

const zlib = require('zlib');

// WinAnsiEncoding: de 0x80 a 0x9F não é latin1.
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
const MAX_STREAM = 20 * 1024 * 1024;

const deBytes = (bytes) => Array.from(bytes, (b) => CP1252[b] || String.fromCharCode(b)).join('');

function deHex(h) {
  const limpo = String(h).replace(/[^0-9A-Fa-f]/g, '');
  const bytes = [];
  for (let i = 0; i < limpo.length; i += 2) bytes.push(parseInt(limpo.slice(i, i + 2).padEnd(2, '0'), 16));
  return deBytes(bytes);
}

function deLiteral(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { bytes.push(s.charCodeAt(i) & 0xff); continue; }
    const n = s[++i];
    if (n === undefined) break;
    const simples = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (simples[n] !== undefined) bytes.push(simples[n]);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] || '')) oct += s[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if (n === '\r' || n === '\n') { if (n === '\r' && s[i + 1] === '\n') i++; } else bytes.push(n.charCodeAt(0) & 0xff);
  }
  return deBytes(bytes);
}

/** Os trechos de texto de um fluxo de conteúdo: [{ y, texto }] na ordem em que são desenhados. */
function trechos(conteudo) {
  const saida = [];
  const reBloco = /\bBT\b([\s\S]*?)\bET\b/g;
  let b;
  while ((b = reBloco.exec(conteudo))) {
    const corpo = b[1];
    const tm = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/.exec(corpo);
    let linha = '';
    const reOp = /\[((?:[^\]\\]|\\[\s\S])*)\]\s*TJ|(<[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\[\s\S])*\))\s*(?:Tj|')/g;
    let o;
    while ((o = reOp.exec(corpo))) {
      if (o[1] !== undefined) {
        // Dentro do TJ: textos e ajustes de posição; um recuo grande é um espaço entre palavras.
        const reItem = /<([0-9A-Fa-f\s]*)>|\(((?:[^()\\]|\\[\s\S])*)\)|(-?\d+(?:\.\d+)?)/g;
        let it;
        while ((it = reItem.exec(o[1]))) {
          if (it[1] !== undefined) linha += deHex(it[1]);
          else if (it[2] !== undefined) linha += deLiteral(it[2]);
          else if (Number(it[3]) < -250 && !/\s$/.test(linha)) linha += ' ';
        }
      } else linha += o[2][0] === '<' ? deHex(o[2].slice(1, -1)) : deLiteral(o[2].slice(1, -1));
    }
    if (linha.trim()) saida.push({ y: tm ? Number(tm[6]) : null, texto: linha.replace(/\s+/g, ' ').trim() });
  }
  return saida;
}

/** Junta na mesma linha o que está na mesma altura (rótulo e valor), e quebra a linha quando a altura muda. */
function emLinhas(lista) {
  const linhas = [];
  let yAnterior = null;
  for (const t of lista) {
    if (linhas.length && t.y !== null && yAnterior !== null && Math.abs(t.y - yAnterior) < 0.6) {
      const ultima = linhas[linhas.length - 1];
      linhas[linhas.length - 1] = ultima + (/[:·\-—]$/.test(ultima) ? ' ' : ': ') + t.texto;
    } else linhas.push(t.texto);
    yAnterior = t.y;
  }
  return linhas;
}

/**
 * O texto do PDF, página por página. '' se não houver texto (PDF escaneado) ou se o arquivo não for PDF.
 * @param {Buffer} buf
 */
function textoDoPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return '';
  const s = buf.toString('latin1');
  const paginas = [];
  let pos = 0;
  for (;;) {
    const i = s.indexOf('stream', pos);
    if (i < 0) break;
    pos = i + 6;
    if (s.startsWith('endstream', i - 3)) continue;
    let ini = i + 6;
    if (s[ini] === '\r') ini++;
    if (s[ini] !== '\n') continue;
    ini++;
    const fim = s.indexOf('endstream', ini);
    if (fim < 0) break;
    pos = fim + 9;
    const dic = s.slice(Math.max(0, s.lastIndexOf(' obj', i)), i);
    if (/\/Subtype\s*\/Image/.test(dic) || fim - ini > MAX_STREAM) continue;
    let dados = buf.subarray(ini, fim);
    if (/\/FlateDecode/.test(dic)) {
      let fimDados = dados.length;
      while (fimDados > 0 && (dados[fimDados - 1] === 10 || dados[fimDados - 1] === 13)) fimDados--;
      try {
        dados = zlib.inflateSync(dados.subarray(0, fimDados), { maxOutputLength: 64 * 1024 * 1024 });
      } catch (_e) {
        continue;
      }
    } else if (/\/Filter/.test(dic)) continue; // outro tipo de compressão: não é o PDF do handoff
    const conteudo = dados.toString('latin1');
    if (!/\bBT\b/.test(conteudo)) continue;
    const linhas = emLinhas(trechos(conteudo));
    if (linhas.length) paginas.push(linhas.join('\n'));
  }
  return paginas.join('\n\n').trim();
}

module.exports = { textoDoPdf };
