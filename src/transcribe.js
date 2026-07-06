'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const WHISPER_MODEL_SIZE = process.env.WHISPER_MODEL_SIZE || 'small';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'transcribe.py');

/**
 * Transcreve um arquivo de áudio local usando faster-whisper.
 * @param {string} audioPath caminho do arquivo de áudio
 * @returns {Promise<string>} texto transcrito (puro)
 */
function transcribeFile(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT, audioPath, WHISPER_MODEL_SIZE]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('error', (err) => {
      reject(new Error(`Falha ao iniciar Python (${PYTHON_BIN}): ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Transcrição falhou (código ${code}): ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Transcreve um buffer de áudio: grava em arquivo temporário, transcreve e limpa.
 * @param {Buffer} buffer
 * @param {string} [ext='.ogg']
 * @returns {Promise<string>}
 */
async function transcribeBuffer(buffer, ext = '.ogg') {
  const tmpPath = path.join(
    os.tmpdir(),
    `wa-audio-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  );
  fs.writeFileSync(tmpPath, buffer);
  try {
    return await transcribeFile(tmpPath);
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

module.exports = { transcribeFile, transcribeBuffer };
