'use strict';
// Gera os PDFs das fixtures sintéticas (tests/fixtures/handoffs.js) em output/fixtures, para inspeção visual.
// Sem rede e sem IA. Uso: node scripts/renderizar-fixtures.js
const fs = require('fs');
const path = require('path');
const { gerarPdfBuffer } = require('../src/generatePdf');
const handoff = require('../src/handoff');
const { textoDoPdf } = require('../src/textoDoPdf');
const { FIXTURES } = require('../tests/fixtures/handoffs');

(async () => {
  const dir = path.join(__dirname, '..', 'output', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  for (const [nome, d] of Object.entries(FIXTURES)) {
    const dados = handoff.sincronizarLegado(JSON.parse(JSON.stringify(d)));
    const buf = await gerarPdfBuffer(dados);
    fs.writeFileSync(path.join(dir, `${nome}.pdf`), buf);
    const paginas = (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    console.log(`${nome}.pdf  ${paginas} página(s)  ${textoDoPdf(buf).length} caracteres de texto`);
  }
})();
