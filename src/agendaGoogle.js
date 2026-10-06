'use strict';

// Reunião do lead no Google Agenda: o agendamento automático cai na agenda do closer, e as agendas
// dos closers estão compartilhadas com a conta do master. O servidor lê (só lê) essas agendas e
// procura o evento em que o e-mail do lead é convidado — é de lá que sai o "Agendado: hoje às 14:00
// com Fulano" do cartão, sem depender do que foi escrito na conversa.
//
// Credenciais só no servidor: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (variáveis de ambiente) e o
// token de renovação da conta conectada (GOOGLE_REFRESH_TOKEN, ou guardado no banco pelo botão
// "Conectar Google Agenda" do painel). Nada disso vai para a extensão nem para log.

const crypto = require('crypto');
const db = require('./db');

const CHAVE_DB = 'google_agenda'; // { refreshToken, conectadoEm, por }
const ESCOPO = 'https://www.googleapis.com/auth/calendar.readonly';
const TZ = process.env.TZ_RELATORIO || 'America/Sao_Paulo';
const MAX_AGENDAS = 40;
const DIAS_ATRAS = 3; // reunião que já passou ainda aparece como "estava agendado"
const DIAS_FRENTE = 45;

const clienteId = () => String(process.env.GOOGLE_CLIENT_ID || '').trim();
const clienteSegredo = () => String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
/** As credenciais do aplicativo do Google estão no servidor? (sem elas não dá nem para conectar) */
const configurado = () => Boolean(clienteId() && clienteSegredo());

const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function guardado() {
  const j = await db.getJson(CHAVE_DB, null).catch(() => null);
  return j && typeof j === 'object' ? j : null;
}
async function refreshToken() {
  const doAmbiente = String(process.env.GOOGLE_REFRESH_TOKEN || '').trim();
  if (doAmbiente) return doAmbiente;
  const g = await guardado();
  return (g && g.refreshToken) || '';
}

/** Chamada ao Google com tempo máximo. Erro nunca carrega token nem a resposta crua. */
async function google(url, opcoes = {}) {
  let r;
  try {
    r = await fetch(url, { ...opcoes, signal: AbortSignal.timeout(Number(process.env.GOOGLE_TIMEOUT_MS) || 8000) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('O Google Agenda demorou para responder.');
    throw new Error('Não consegui falar com o Google Agenda.');
  }
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, corpo: j };
}

/** Endereço para o master autorizar a leitura das agendas (tela de consentimento do Google). */
function urlDeAutorizacao(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: clienteId(), redirect_uri: redirectUri, response_type: 'code', scope: ESCOPO,
    access_type: 'offline', prompt: 'consent', state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

/** Volta da tela do Google: troca o código pelo token de renovação e guarda. */
async function concluirConexao(code, redirectUri, por) {
  const r = await google('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clienteId(), client_secret: clienteSegredo(), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!r.ok || !r.corpo.refresh_token) {
    throw new Error('O Google não devolveu a autorização. Tente conectar de novo.');
  }
  await db.setJson(CHAVE_DB, { refreshToken: r.corpo.refresh_token, conectadoEm: new Date().toISOString(), por: String(por || '').slice(0, 80) });
  await db.cacheDel('google:token');
  await db.cacheDel('google:agendas');
}

async function desconectar() {
  await db.setJson(CHAVE_DB, {});
  await db.cacheDel('google:token');
  await db.cacheDel('google:agendas');
}

/** Token de acesso (vale ~1h): fica em cache para não renovar a cada conversa aberta. */
async function tokenDeAcesso() {
  const emCache = await db.cacheGet('google:token');
  if (emCache) return emCache;
  const rt = await refreshToken();
  if (!configurado() || !rt) return '';
  const r = await google('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clienteId(), client_secret: clienteSegredo(), refresh_token: rt, grant_type: 'refresh_token' }),
  });
  if (!r.ok || !r.corpo.access_token) {
    throw new Error('O Google recusou a conexão da agenda. Conecte de novo no painel (aba Extensão).');
  }
  await db.cacheSet('google:token', r.corpo.access_token, Math.max(60, (Number(r.corpo.expires_in) || 3600) - 300));
  return r.corpo.access_token;
}

async function api(caminho, params) {
  const token = await tokenDeAcesso();
  if (!token) return null;
  const r = await google(`https://www.googleapis.com/calendar/v3${caminho}?${new URLSearchParams(params)}`, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) {
    await db.cacheDel('google:token');
    throw new Error('O Google recusou a conexão da agenda. Conecte de novo no painel (aba Extensão).');
  }
  if (r.status === 404 || r.status === 403) return null; // agenda que deixou de ser compartilhada
  if (!r.ok) throw new Error(`O Google Agenda respondeu ${r.status}.`);
  return r.corpo;
}

/** Agendas que a conta conectada enxerga (as dos closers, compartilhadas), sem as de feriados. Cache de 1h. */
async function agendas() {
  const emCache = await db.cacheGet('google:agendas');
  if (emCache) {
    try {
      return JSON.parse(emCache);
    } catch (_) {
      /* refaz */
    }
  }
  const r = await api('/users/me/calendarList', { maxResults: '250', minAccessRole: 'reader' });
  const lista = ((r && r.items) || [])
    .filter((c) => c && c.id && !/#(holiday|contacts|weeknum)@/.test(c.id))
    .slice(0, MAX_AGENDAS)
    .map((c) => ({ id: c.id, nome: String(c.summaryOverride || c.summary || c.id), minha: Boolean(c.primary) }));
  if (lista.length) await db.cacheSet('google:agendas', JSON.stringify(lista), 3600);
  return lista;
}

/** Data e hora do evento no fuso do time, como 'AAAA-MM-DDTHH:mm' (o formato das etiquetas do cartão). */
function horaLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** O evento é deste lead? Pelo e-mail entre os convidados; sem e-mail, pelo nome inteiro no título. */
function ehDoLead(evento, emails, nome) {
  if (!evento || evento.status === 'cancelled' || !evento.start || !evento.start.dateTime) return false;
  const convidados = (evento.attendees || []).map((a) => String(a.email || '').toLowerCase());
  if (emails.some((e) => convidados.includes(e))) return true;
  const palavras = normalizar(nome).split(' ').filter((x) => x.length >= 2);
  if (palavras.length < 2) return false; // só o primeiro nome casaria com gente demais
  const titulo = ` ${normalizar(evento.summary)} `;
  return palavras.every((x) => titulo.includes(` ${x} `));
}

/**
 * A reunião do lead nas agendas: a próxima que ainda vai acontecer; não havendo, a mais recente que passou.
 * @param {{emails?: string[], nome?: string}} lead
 * @returns {Promise<{quando: string, closer: string, titulo: string} | null>} null = não conectado ou sem reunião
 */
async function reuniaoDoLead(lead = {}, agora = new Date()) {
  const emails = (Array.isArray(lead.emails) ? lead.emails : [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    .slice(0, 3);
  const nome = String(lead.nome || '').trim().slice(0, 80);
  const buscas = emails.length ? emails : normalizar(nome).split(' ').length >= 2 ? [nome] : [];
  if (!buscas.length || !configurado() || !(await refreshToken())) return null;

  const chave = 'google:reuniao:' + crypto.createHash('sha256').update(buscas.join('|').toLowerCase()).digest('hex').slice(0, 24);
  const emCache = await db.cacheGet(chave);
  if (emCache) {
    try {
      return JSON.parse(emCache).reuniao;
    } catch (_) {
      /* refaz */
    }
  }

  await tokenDeAcesso(); // conexão recusada aparece aqui, uma vez — não escondida em cada agenda
  const lista = await agendas();
  const timeMin = new Date(agora.getTime() - DIAS_ATRAS * 86400000).toISOString();
  const timeMax = new Date(agora.getTime() + DIAS_FRENTE * 86400000).toISOString();
  const achados = [];
  await Promise.all(
    lista.flatMap((ag) =>
      buscas.map(async (q) => {
        const r = await api(`/calendars/${encodeURIComponent(ag.id)}/events`, {
          q, timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '10',
        }).catch(() => null); // uma agenda fora do ar não derruba as outras
        ((r && r.items) || []).filter((e) => ehDoLead(e, emails, nome)).forEach((e) => achados.push({ e, ag }));
      })
    )
  );
  const comHora = achados
    .map(({ e, ag }) => ({ inicio: Date.parse(e.start.dateTime), e, ag }))
    .filter((x) => Number.isFinite(x.inicio));
  // Tolerância de 2h: a reunião que está acontecendo agora ainda é "a de hoje".
  const futuras = comHora.filter((x) => x.inicio >= agora.getTime() - 2 * 3600000).sort((a, b) => a.inicio - b.inicio);
  const passadas = comHora.filter((x) => x.inicio < agora.getTime() - 2 * 3600000).sort((a, b) => b.inicio - a.inicio);
  const escolhida = futuras[0] || passadas[0] || null;
  const reuniao = escolhida
    ? {
        quando: horaLocal(escolhida.e.start.dateTime),
        // A agenda é do closer: o nome dela é quem atende. Se o evento estiver na agenda do próprio master, fica sem closer.
        closer: escolhida.ag.minha ? '' : String(escolhida.ag.nome).slice(0, 60),
        titulo: String(escolhida.e.summary || '').slice(0, 120),
      }
    : null;
  await db.cacheSet(chave, JSON.stringify({ reuniao }), reuniao ? 600 : 180);
  return reuniao;
}

/** Para o painel: está configurado? conectado? quantas agendas enxerga? */
async function status() {
  const g = await guardado();
  const conectado = Boolean(await refreshToken());
  const saida = { configurado: configurado(), conectado, conectadoEm: (g && g.conectadoEm) || '', agendas: [] };
  if (saida.configurado && conectado) {
    try {
      saida.agendas = (await agendas()).map((a) => a.nome);
    } catch (e) {
      saida.erro = e.message;
    }
  }
  return saida;
}

module.exports = { configurado, urlDeAutorizacao, concluirConexao, desconectar, reuniaoDoLead, status, horaLocal, ehDoLead };
