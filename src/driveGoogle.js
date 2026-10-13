'use strict';

// Leitura do Google Drive (só leitura): lista os documentos de uma pasta e baixa o texto deles. É por
// aqui que as transcrições novas das calls de um closer chegam ao sistema (src/transcricoes.js).
// Usa a mesma conexão do Google Agenda (src/agendaGoogle.js), com a permissão drive.readonly — quem
// conectou antes de ela existir precisa conectar de novo. Nada é escrito, movido ou apagado no Drive.
//
// A pasta costuma ter UMA SUBPASTA POR CALL ("2026-10-09 09h46 · nome do lead", com a gravação e o
// documento dentro), e são centenas. Por isso a busca: (1) lista as subpastas, (2) descarta as que têm
// no nome uma data anterior ao corte, (3) procura os documentos nas que sobraram, várias por consulta.

const agendaGoogle = require('./agendaGoogle');

const API = 'https://www.googleapis.com/drive/v3';
const DOC = 'application/vnd.google-apps.document';
const PASTA = 'application/vnd.google-apps.folder';
const MAX_PAGINAS = 6; // por consulta: 6 mil subpastas, 1.200 documentos
const POR_CONSULTA = 20; // pastas procuradas de uma vez ('a' in parents or 'b' in parents ...)
const MAX_PASTAS = 400; // pastas em que se procuram documentos a cada leitura (as mais novas)
const MAX_AGRUPADORAS = 40; // pastas sem data no nome em que se desce mais um nível
const FOLGA_DIAS = 2; // a pasta pode levar a data da véspera do documento (fuso, call que virou a noite)

/** Link da pasta (ou o próprio id) -> id. '' se não parecer uma pasta do Drive. */
function idDaPasta(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,80})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,80})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,80}$/.test(s) ? s : '';
}

/** A data com que o nome da pasta começa ("2026-10-09 09h46 · ..." ou "09-10-2026 ..."): AAAA-MM-DD, ou ''. */
function dataDoNome(nome) {
  const s = String(nome || '').trim();
  const iso = /^(\d{4})[-._/](\d{2})[-._/](\d{2})(?!\d)/.exec(s);
  const br = iso ? null : /^(\d{2})[-._/](\d{2})[-._/](\d{4})(?!\d)/.exec(s);
  const [a, m, d] = iso ? [iso[1], iso[2], iso[3]] : br ? [br[3], br[2], br[1]] : [];
  return a && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? `${a}-${m}-${d}` : '';
}

/** AAAA-MM-DD, `dias` antes. */
function diasAntes(data, dias) {
  const t = Date.parse(String(data) + 'T12:00:00Z');
  return Number.isFinite(t) ? new Date(t - dias * 86400000).toISOString().slice(0, 10) : '';
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

/** O que há dentro de uma ou várias pastas (os mais novos primeiro), `POR_CONSULTA` pastas por consulta. */
async function filhos(pastas, filtro, { porPagina = 200 } = {}) {
  const ids = [].concat(pastas).filter((id) => /^[A-Za-z0-9_-]{4,120}$/.test(String(id || '')));
  const todos = [];
  for (let i = 0; i < ids.length; i += POR_CONSULTA) {
    const onde = ids.slice(i, i + POR_CONSULTA).map((id) => `'${id}' in parents`).join(' or ');
    let pagina = '';
    for (let p = 0; p < MAX_PAGINAS; p++) {
      const r = await pedir('/files', {
        q: `(${onde}) and trashed = false and ${filtro}`,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime)',
        orderBy: 'createdTime desc', pageSize: String(porPagina), supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        ...(pagina ? { pageToken: pagina } : {}),
      });
      todos.push(...(Array.isArray(r.files) ? r.files : []));
      pagina = r.nextPageToken || '';
      if (!pagina) break;
    }
  }
  return todos;
}

/**
 * Os documentos de texto da pasta e das subpastas dela, criados a partir de `desde` (AAAA-MM-DD), do
 * mais antigo para o mais novo. Vídeo, planilha e o resto ficam de fora. Desce até dois níveis: a
 * subpasta de cada call e, quando a subpasta não tem data no nome (um agrupador, como "Google Meet"
 * ou "Outubro"), as subpastas dela.
 * @returns {Promise<{arquivos: {id: string, nome: string, tipo: string, criadoEm: string}[], subpastas: number}>}
 *   `subpastas` é quantas subpastas a pasta tem (para a tela explicar um "nada novo").
 */
async function procurar(pasta, { desde } = {}) {
  const id = idDaPasta(pasta);
  if (!id) throw new Error('O link da pasta do Drive não é válido.');
  const corte = /^\d{4}-\d{2}-\d{2}$/.test(String(desde || '')) ? String(desde) : '';
  const documentos = `(mimeType = '${DOC}' or mimeType = 'text/plain')` + (corte ? ` and createdTime >= '${corte}T00:00:00'` : '');
  const soPastas = `mimeType = '${PASTA}'`;

  const nivel1 = await filhos([id], soPastas, { porPagina: 1000 });
  const agrupadoras = nivel1.filter((p) => !dataDoNome(p.name)).slice(0, MAX_AGRUPADORAS);
  const nivel2 = agrupadoras.length ? await filhos(agrupadoras.map((p) => p.id), soPastas, { porPagina: 1000 }) : [];

  // Pasta com data no nome anterior ao corte é call antiga: não tem documento novo, nem se pergunta.
  const limite = corte ? diasAntes(corte, FOLGA_DIAS) : '';
  const quando = (p) => dataDoNome(p.name) || String(p.createdTime || '').slice(0, 10);
  const onde = nivel1.concat(nivel2)
    .filter((p) => p && p.id && !(limite && dataDoNome(p.name) && dataDoNome(p.name) < limite))
    .sort((a, b) => quando(b).localeCompare(quando(a)))
    .slice(0, MAX_PASTAS)
    .map((p) => p.id);

  const lista = await filhos([id].concat(onde), documentos);
  // Pasta que não mostra nada: pode ser que a conta conectada não a enxergue (a busca volta vazia, sem
  // erro). Pergunta pela pasta em si, que aí o Google responde 404 e a tela diz o que fazer.
  if (!lista.length && !nivel1.length) {
    const p = await pedir(`/files/${encodeURIComponent(id)}`, { fields: 'id, mimeType', supportsAllDrives: 'true' });
    if (p && p.mimeType && p.mimeType !== PASTA) throw new Error('O link salvo é de um arquivo, não de uma pasta do Drive. Cole o endereço da pasta (…/folders/…).');
  }
  const vistos = new Set();
  const arquivos = lista
    .filter((f) => f && f.id && !vistos.has(f.id) && vistos.add(f.id))
    .map((f) => ({ id: String(f.id), nome: String(f.name || ''), tipo: String(f.mimeType || ''), criadoEm: String(f.createdTime || '') }))
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  return { arquivos, subpastas: nivel1.length + nivel2.length };
}

/** Só os documentos (ver `procurar`). */
async function listar(pasta, opcoes) {
  return (await procurar(pasta, opcoes)).arquivos;
}

/** O texto de um documento: Google Docs é exportado como texto puro; arquivo .txt é baixado como está. */
async function texto(arquivo) {
  const id = encodeURIComponent(arquivo.id);
  const t = arquivo.tipo === DOC
    ? await pedir(`/files/${id}/export`, { mimeType: 'text/plain' }, { comoTexto: true })
    : await pedir(`/files/${id}`, { alt: 'media', supportsAllDrives: 'true' }, { comoTexto: true });
  return String(t || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

module.exports = { idDaPasta, dataDoNome, diasAntes, procurar, listar, texto, erroDoDrive, DOC };
