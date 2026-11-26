'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pdf-'));
const pdfStorage = require('../src/pdfStorage');

test('PDF do mês fica até o fim do dia 5 do mês seguinte (horário de São Paulo)', () => {
  const ate = (q) => pdfStorage.expiraEm(new Date(q)).toISOString();
  assert.equal(ate('2026-11-26T15:00:00Z'), '2026-12-06T03:00:00.000Z');
  assert.equal(ate('2026-12-01T02:00:00Z'), '2026-12-06T03:00:00.000Z', '30/11 às 23h em SP ainda é novembro');
  assert.equal(ate('2026-12-10T12:00:00Z'), '2027-01-06T03:00:00.000Z', 'vira o ano');
});

test('PDF salvo é lido, some quando vence e pode ser apagado', async () => {
  assert.equal(await pdfStorage.salvar('a1', 'QUJD', 'a.pdf'), true);
  assert.equal((await pdfStorage.ler('a1')).base64, 'QUJD');
  await pdfStorage.remover('a1');
  assert.equal(await pdfStorage.ler('a1'), null);
  assert.equal(await pdfStorage.salvar('a2', 'QUJD', 'a.pdf', new Date('2020-01-10T12:00:00Z')), false);
  await pdfStorage.salvar('a3', 'QUJD', 'a.pdf');
  const real = Date.now;
  Date.now = () => real() + 70 * 86400000;
  try { assert.equal(await pdfStorage.ler('a3'), null); } finally { Date.now = real; }
});
