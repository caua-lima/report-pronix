'use strict';

require('dotenv').config();

const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const { appendMessage } = require('./store');
const { transcribeBuffer } = require('./transcribe');

const logger = pino({ level: 'warn' });

// Números monitorados (só DDI+DDD+número), normalizados para conter apenas dígitos.
const WATCHED = (process.env.WATCHED_CONTACTS || '')
  .split(',')
  .map((n) => n.replace(/[^0-9]/g, ''))
  .filter(Boolean);

function numeroDoJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function isMonitorado(jid) {
  const num = numeroDoJid(jid);
  return WATCHED.includes(num);
}

/** Extrai o texto de uma mensagem, se houver. */
function extrairTexto(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

function ehAudio(message) {
  return Boolean(message?.audioMessage);
}

async function iniciar() {
  if (WATCHED.length === 0) {
    console.warn(
      '⚠️  WATCHED_CONTACTS está vazio no .env — nenhuma conversa será salva. ' +
        'Preencha com os números dos leads (ex.: 5511999998888).'
    );
  }

  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, '..', 'auth')
  );

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Escaneie o QR code abaixo no WhatsApp (Aparelhos conectados):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp. Monitorando:', WATCHED.join(', ') || '(nenhum)');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = code !== DisconnectReason.loggedOut;
      console.log(
        `🔌 Conexão fechada (${code}).`,
        deveReconectar ? 'Reconectando...' : 'Deslogado — apague a pasta auth/ e reconecte.'
      );
      if (deveReconectar) iniciar().catch((e) => console.error(e));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us')) continue; // ignora grupos
        if (!isMonitorado(jid)) continue;

        const message = m.message;
        if (!message) continue;

        const fromMe = Boolean(m.key.fromMe);
        const from = fromMe ? 'eu' : 'eles';
        const timestamp = m.messageTimestamp
          ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString();

        if (ehAudio(message)) {
          console.log(`🎤 Áudio de ${numeroDoJid(jid)} — transcrevendo...`);
          try {
            const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const texto = await transcribeBuffer(buffer, '.ogg');
            appendMessage(jid, { timestamp, from, type: 'audio', content: texto || '[áudio sem fala reconhecível]' });
            console.log(`   ↳ "${(texto || '').slice(0, 60)}"`);
          } catch (err) {
            console.error(`   ✗ Falha na transcrição: ${err.message}`);
            appendMessage(jid, { timestamp, from, type: 'audio', content: '[falha ao transcrever áudio]' });
          }
          continue;
        }

        const texto = extrairTexto(message);
        if (texto) {
          appendMessage(jid, { timestamp, from, type: 'texto', content: texto });
          console.log(`💬 ${from} (${numeroDoJid(jid)}): ${texto.slice(0, 60)}`);
        }
      } catch (err) {
        console.error('Erro ao processar mensagem:', err.message);
      }
    }
  });
}

iniciar().catch((err) => {
  console.error('Erro fatal ao iniciar o bot:', err);
  process.exit(1);
});
