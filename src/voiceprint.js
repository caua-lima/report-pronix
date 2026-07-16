'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const { dirUsuario } = require('./usuarios');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'voiceprint.py');
// Cada usuário tem a própria voz: data/usuarios/<id>/voiceprint.json
const storeDoUsuario = (userId) => path.join(dirUsuario(userId), 'voiceprint.json');
// Similaridade de cosseno acima disso = mesma pessoa (a sua voz).
const THRESHOLD = parseFloat(process.env.VOICE_THRESHOLD || '0.75');

/** Roda o script Python e devolve o embedding (array de números). */
function embedFile(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT, audioPath], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => reject(new Error(`Falha ao iniciar Python: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out.trim()));
        } catch (_) {
          reject(new Error(`Embedding inválido. ${err.trim()}`));
        }
      } else if (code === 4) {
        reject(new Error('resemblyzer não instalado (pip install resemblyzer).'));
      } else {
        reject(new Error(err.trim() || `voiceprint falhou (código ${code}).`));
      }
    });
  });
}

async function embedBuffer(buffer, ext = '.ogg') {
  const seguro = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.ogg';
  const tmp = path.join(
    os.tmpdir(),
    `voz-${Date.now()}-${Math.random().toString(36).slice(2)}${seguro}`
  );
  fs.writeFileSync(tmp, buffer);
  try {
    return await embedFile(tmp);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? dot / den : 0;
}

function salvarVoiceprint(userId, emb) {
  fs.writeFileSync(storeDoUsuario(userId), JSON.stringify({ emb, criadoEm: new Date().toISOString() }));
}

function carregarVoiceprint(userId) {
  try {
    const j = JSON.parse(fs.readFileSync(storeDoUsuario(userId), 'utf8'));
    return Array.isArray(j.emb) ? j.emb : null;
  } catch (_) {
    return null;
  }
}

function temVoiceprint(userId) {
  return !!carregarVoiceprint(userId);
}

function removerVoiceprint(userId) {
  try {
    fs.unlinkSync(storeDoUsuario(userId));
  } catch (_) {
    /* já não existe */
  }
}

/**
 * Classifica um áudio como 'EU' ou 'LEAD' comparando com a voz DO USUÁRIO.
 * @returns {Promise<{quem: 'EU'|'LEAD'|null, similaridade: number|null}>}
 */
async function classificar(userId, buffer, ext = '.ogg') {
  const vp = carregarVoiceprint(userId);
  if (!vp) return { quem: null, similaridade: null };
  const emb = await embedBuffer(buffer, ext);
  const sim = cosine(emb, vp);
  return { quem: sim >= THRESHOLD ? 'EU' : 'LEAD', similaridade: sim };
}

module.exports = {
  embedBuffer,
  salvarVoiceprint,
  carregarVoiceprint,
  temVoiceprint,
  removerVoiceprint,
  classificar,
  THRESHOLD,
};
