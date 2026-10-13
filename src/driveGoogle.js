'use strict';

// Leitura do Google Drive (só leitura): lista os documentos de uma pasta e baixa o texto deles. É por
// aqui que as transcrições novas das calls de um closer chegam ao sistema (src/transcricoes.js).
// Usa a mesma conexão do Google Agenda (src/agendaGoogle.js), com a permissão drive.readonly — quem
// conectou antes de ela existir precisa conectar de novo. Nada é escrito, movido ou apagado no Drive.

const agendaGoogle = require('./agendaGoogle');

const API = 'https://www.googleapis.com/drive/v3';
const DOC = 'application/vnd.google-apps.document';
const PASTA = 'application/vnd.google-apps.folder';
const MAX_PAGINAS = 6; // 600 arquivos por pasta a cada leitura
const MAX_SUBPASTAS = 12;

/** Link da pasta (ou o próprio id) -> id. '' se não parecer uma pasta do Drive. */
function idDaPasta(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,80})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,80})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,80}$/.test(s) ? s : '';
}

/** O que o Google respondeu de errado, em português e dizendo o que fazer. */
function erroDoDrive(status, corpo) {
  const e = (corpo && corpo.error) || {};
  const razoes = [].concat((e.errors || []).map((x) => x && x.reason), (e.details || []).map((x) => x && x.reason), [e.status]).filter(Boolean).join(' ');
  if (status === 401) return 'O Google recusou a conexão. Conecte de novo no painel (aba Extensão → Google Agenda).';
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient.*scope/i.test(razoes + ' ' + (e.message || ''))) {
    return 'A conexão com o Google ainda não tem permissão para ler o Drive. No painel, aba Extensão → Google Agenda → "Conectar de novo", e aceite a leitura do Drive.';
  }
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(razoes) || /has not been used in project|is disabled/i.test(e.message || '')) {
    return 'A API do Google Drive não está ativada no projeto do Google Cloud. Ative "Google Drive API" em console.cloud.google.com (APIs e serviços → Biblioteca) e tente de novo.';
  }
  if (status === 404) return 'Não achei a pasta no Drive: confira o link e se a conta conectada tem acesso a ela.';
  if (status === 403) return 'O Google não deixou ler esta pasta: a conta conectada precisa ter acesso a ela.';
  if (status === 429) return 'O Google limitou as consultas ao Drive. Tente de novo em alguns minutos.';
  return `O Google Drive respondeu ${status}.`;
}

/** Uma chamada ao Drive. `comoTexto` devolve o corpo como texto (é o conteúdo do documento). */
async function pedir(caminho, params, { comoTexto = false } = {}) {
  const token = await agendaGoogle.tokenDeAcesso();
  if (!token) throw new Error('O Google não está conectado. Conecte no painel (aba Extensão → Google Agenda).');
  let r;
  try {
    r = await fetch(`${API}${caminho}?${new URLSearchParams(params)}`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(Number(process.env.DRIVE_TIMEOUT_MS) || 20000),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('O Google Drive demorou para responder.');
    throw new Error('Não consegui falar com o Google Drive.');
  }
  if (!r.ok) throw new Error(erroDoDrive(r.status, await r.json().catch(() => ({}))));
  return comoTexto ? r.text() : r.json().catch(() => ({}));
}

async function filhos(pastaId, filtro) {
  const todos = [];
  let pagina = '';
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const r = await pedir('/files', {
      q: `'${pastaId}' in parents and trashed = false and ${filtro}`,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime)',
      orderBy: 'createdTime', pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      ...(pagina ? { pageToken: pagina } : {}),
    });
    todos.push(...(Array.isArray(r.files) ? r.files : []));
    pagina = r.nextPageToken || '';
    if (!pagina) break;
  }
  return todos;
}

/**
 * Os documentos de texto da pasta e das subpastas dela (um nível), criados a partir de `desde`
 * (AAAA-MM-DD), do mais antigo para o mais novo. Vídeo, planilha e o resto ficam de fora.
 * @returns {Promise<{id: string, nome: string, tipo: string, criadoEm: string}[]>}
 */
async function listar(pasta, { desde } = {}) {
  const id = idDaPasta(pasta);
  if (!id) throw new Error('O link da pasta do Drive não é válido.');
  const data = /^\d{4}-\d{2}-\d{2}$/.test(String(desde || '')) ? ` and createdTime >= '${desde}T00:00:00'` : '';
  const documentos = `(mimeType = '${DOC}' or mimeType = 'text/plain')${data}`;
  const lista = await filhos(id, documentos);
  const subpastas = (await filhos(id, `mimeType = '${PASTA}'`)).slice(0, MAX_SUBPASTAS);
  for (const sub of subpastas) lista.push(...(await filhos(sub.id, documentos)));
  const vistos = new Set();
  return lista
    .filter((f) => f && f.id && !vistos.has(f.id) && vistos.add(f.id))
    .map((f) => ({ id: String(f.id), nome: String(f.name || ''), tipo: String(f.mimeType || ''), criadoEm: String(f.createdTime || '') }))
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
}

/** O texto de um documento: Google Docs é exportado como texto puro; arquivo .txt é baixado como está. */
async function texto(arquivo) {
  const id = encodeURIComponent(arquivo.id);
  const t = arquivo.tipo === DOC
    ? await pedir(`/files/${id}/export`, { mimeType: 'text/plain' }, { comoTexto: true })
    : await pedir(`/files/${id}`, { alt: 'media', supportsAllDrives: 'true' }, { comoTexto: true });
  return String(t || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

module.exports = { idDaPasta, listar, texto, erroDoDrive, DOC };
