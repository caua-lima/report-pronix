'use strict';
// Validador de áudio dos content scripts (A06): reconhece os formatos de voz, descarta imagem/PDF/texto.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ler = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
function extrair(rel, inicio, fim) {
  const src = ler(rel);
  const i = src.indexOf(inicio);
  const f = src.indexOf(fim, i);
  assert.ok(i !== -1 && f !== -1, `marcadores não encontrados em ${rel}`);
  return new Function(src.slice(i, f) + '; return ehAudioBuffer;')();
}

const validadores = {
  'extension/content.js': extrair('extension/content.js', 'function ehAudioBuffer(buf) {', '// Força o WhatsApp'),
  'extension/content-instagram.js': extrair('extension/content-instagram.js', 'function ehAudioBuffer(buf) {', '// Fila de blobs'),
};

const buf = (cabecalho, tamanho = 3000, preenchimento = 7) => {
  const b = new Uint8Array(tamanho).fill(preenchimento);
  cabecalho.forEach((v, i) => { b[i] = typeof v === 'string' ? v.charCodeAt(0) : v; });
  return b.buffer;
};
const ascii = (s) => [...s];

for (const [arquivo, ehAudioBuffer] of Object.entries(validadores)) {
  test(`${arquivo}: aceita os formatos de áudio conhecidos`, () => {
    assert.equal(ehAudioBuffer(buf(ascii('OggS'))), true, 'ogg/opus (voz do WhatsApp)');
    assert.equal(ehAudioBuffer(buf([0, 0, 0, 0x20, ...ascii('ftypM4A ')])), true, 'm4a/mp4 (Instagram)');
    assert.equal(ehAudioBuffer(buf([0x1a, 0x45, 0xdf, 0xa3])), true, 'webm');
    assert.equal(ehAudioBuffer(buf(ascii('#!AMR\n'))), true, 'amr');
    assert.equal(ehAudioBuffer(buf(ascii('ID3'))), true, 'mp3 com tag');
    assert.equal(ehAudioBuffer(buf(ascii('fLaC'))), true, 'flac');
    assert.equal(ehAudioBuffer(buf([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])), true, 'wav');
    assert.equal(ehAudioBuffer(buf([0xff, 0xfb])), true, 'frame mp3');
  });

  test(`${arquivo}: rejeita imagem, PDF, HTML/JSON e arquivos pequenos demais`, () => {
    assert.equal(ehAudioBuffer(buf([0xff, 0xd8, 0xff])), false, 'jpeg');
    assert.equal(ehAudioBuffer(buf([0x89, ...ascii('PNG')])), false, 'png');
    assert.equal(ehAudioBuffer(buf(ascii('GIF89a'))), false, 'gif');
    assert.equal(ehAudioBuffer(buf(ascii('%PDF-1.7'))), false, 'pdf');
    assert.equal(ehAudioBuffer(buf([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')])), false, 'webp');
    assert.equal(ehAudioBuffer(buf(ascii('<!DOCTYPE html><html>'), 3000, 0x20)), false, 'HTML de erro do CDN');
    assert.equal(ehAudioBuffer(buf(ascii('{"error":"forbidden"}'), 3000, 0x20)), false, 'JSON de erro');
    assert.equal(ehAudioBuffer(buf(ascii('OggS'), 500)), false, 'pequeno demais');
    assert.equal(ehAudioBuffer(null), false);
  });

  test(`${arquivo}: formato desconhecido só passa se for binário de tamanho plausível (como antes)`, () => {
    assert.equal(ehAudioBuffer(buf([0x00, 0x01, 0x02], 3000, 0x90)), true);
    assert.equal(ehAudioBuffer(buf([0x00, 0x01, 0x02], 1000, 0x90)), false, 'curto demais');
    assert.equal(ehAudioBuffer(buf([0x00, 0x01, 0x02], 9_000_000, 0x90)), false, 'grande demais');
  });
}
