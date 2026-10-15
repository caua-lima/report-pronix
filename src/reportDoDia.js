'use strict';

// "Report automático" do pré-vendedor: o fechamento do dia com o que dá para contar sozinho.
//  - Leads novos contatados / Respostas / Recontatos: a extensão olha as conversas que passam pela tela e
//    avisa, por conversa e por dia, três coisas — eu escrevi hoje, já havia mensagens de antes, o lead
//    escreveu hoje (e se já tinha escrito em algum dia anterior). Daí: novo = escrevi hoje e não havia nada
//    antes; recontato = escrevi hoje e já havia histórico (lead que parou ou nunca respondeu e eu chamo de
//    novo); resposta = a PRIMEIRA resposta do lead (ele escreveu hoje e nunca tinha escrito antes). Só conta o que passou pela tela (conversa que nunca foi
//    aberta não é vista). Do contato guarda-se só uma impressão (hash), nunca telefone nem nome.
//  - Desqualificados: as perdas do dia, por motivo, lidas do RD (cards do próprio usuário fechados hoje como
//    perdidos) e do registro do sistema (botão Desqualificar e limpeza do funil), sem contar duas vezes.
//  - O resto (automáticas, realizadas, agendas que caíram, no-show, observações) é digitado e fica salvo por dia.
// O texto sai no formato que o pré-vendedor manda no fim do dia.

const crypto = require('crypto');
const db = require('./db');
const crm = require('./crm');
const { emDiaLocal } = require('./stats');

const LIMITE_EVENTOS = 6000;
const CHAVE_LOG_PERDAS = 'rd_limpeza_log';
const MAX_PAGINAS_RD = 5;
const DIA_OK = /^\d{4}-\d{2}-\d{2}$/;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const idDe = (d) => String((d && (d.id || d._id)) || '');

const hoje = () => emDiaLocal(new Date().toISOString());
const diaValido = (d) => (DIA_OK.test(String(d || '')) ? String(d) : hoje());

// ---------------------------------------------------------------- contagem pelas conversas
/** Impressão da conversa: o telefone (8 últimos dígitos) ou, sem ele, o nome. Nada disso fica guardado. */
function impressaoDaConversa(usuarioId, { telefone, nome }) {
  const d = soDigitos(telefone);
  const base = d.length >= 8 ? 't' + d.slice(-8) : 'n' + norm(nome);
  if (base.length < 3) return '';
  return crypto.createHash('sha256').update(String(usuarioId) + '|' + base).digest('hex').slice(0, 12);
}

/** A extensão avisa o que viu numa conversa hoje. Cada aviso é um evento; a leitura junta os do mesmo contato. */
async function registrarAtividade({ usuarioId, telefone, nome, eu, antes, eles, elesAntes }) {
  const h = impressaoDaConversa(usuarioId, { telefone, nome });
  if (!h || !usuarioId) return false;
  const flags = { eu: eu === true, antes: antes === true, eles: eles === true, elesAntes: elesAntes === true };
  if (!flags.eu && !flags.eles) return false;
  await db.push(`atividade_${usuarioId}_${hoje()}`, { h, ...flags }, LIMITE_EVENTOS);
  return true;
}

/** { novos, respostas, recontatos, conversas } do dia: cada contato conta uma vez em cada coisa. */
async function contagemDoDia(usuarioId, dia) {
  const eventos = await db.range(`atividade_${usuarioId}_${dia}`);
  const porContato = new Map();
  for (const e of eventos) {
    if (!e || !e.h) continue;
    const c = porContato.get(e.h) || { eu: false, antes: false, eles: false, elesAntes: false };
    c.eu = c.eu || e.eu === true;
    c.antes = c.antes || e.antes === true; // viu histórico em algum momento: não é lead novo
    c.eles = c.eles || e.eles === true;
    c.elesAntes = c.elesAntes || e.elesAntes === true; // o lead já tinha escrito antes de hoje
    porContato.set(e.h, c);
  }
  const lista = [...porContato.values()];
  return {
    novos: lista.filter((c) => c.eu && !c.antes).length,
    recontatos: lista.filter((c) => c.eu && c.antes).length,
    // Resposta = a PRIMEIRA vez que o lead responde (é quando o card vai para "Respondeu" no RD): quem já tinha
    // escrito em outro dia e escreve de novo hoje não conta.
    respostas: lista.filter((c) => c.eles && !c.elesAntes).length,
    conversas: lista.length,
  };
}

// ---------------------------------------------------------------- desqualificados
const lista = (r, ...chaves) => (Array.isArray(r) ? r : chaves.map((k) => r && r[k]).find(Array.isArray) || []);

/** Os cards do usuário que o RD mostra como perdidos hoje: [{ id, motivo }]. */
async function perdasNoRd(usuario, dia) {
  const rdUsers = await crm.usuariosRd();
  const primeiro = norm(usuario.nome).split(' ')[0];
  const eu = rdUsers.find((u) => norm(u.nome) === norm(usuario.nome)) ||
    (rdUsers.filter((u) => norm(u.nome).split(' ')[0] === primeiro).length === 1 ? rdUsers.find((u) => norm(u.nome).split(' ')[0] === primeiro) : null);
  if (!eu) throw new Error('Não achei o seu usuário no RD.');
  const achadas = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS_RD; pagina++) {
    const r = await crm.rd('/deals', {
      win: 'false', user_id: String(eu.id), closed_at: 'true', closed_at_period: 'true', start_date: dia, end_date: dia, limit: 200, page: pagina,
    });
    const deals = lista(r, 'deals');
    for (const d of deals) {
      if (d.closed_at && emDiaLocal(d.closed_at) === dia && d.win === false) {
        achadas.push({ id: idDe(d), motivo: crm.consertarAcentos((d.deal_lost_reason && d.deal_lost_reason.name) || '') });
      }
    }
    if (!(r && r.has_more) && deals.length < 200) break;
  }
  return achadas;
}

/** As perdas que o sistema deu hoje (botão Desqualificar e limpeza do funil), sem as que foram desfeitas. */
async function perdasDoSistema(usuario, dia) {
  const log = await db.range(CHAVE_LOG_PERDAS);
  const vivas = new Map();
  for (const e of log) {
    if (!e || !e.dealId || emDiaLocal(e.em) !== dia) continue;
    if (e.usuarioId !== usuario.id && norm(e.por) !== norm(usuario.nome)) continue;
    if (e.desfeito) vivas.delete(e.dealId);
    else vivas.set(e.dealId, { id: e.dealId, motivo: String(e.motivo || '') });
  }
  return [...vivas.values()];
}

/**
 * Desqualificados do dia, por motivo: [{ motivo, qtd }] do maior para o menor, e de onde veio a conta.
 * Se o RD não responder, vale o registro do sistema e o aviso diz isso.
 */
async function desqualificadosDoDia(usuario, dia) {
  const sistema = await perdasDoSistema(usuario, dia);
  let rd = [];
  let aviso = '';
  if (crm.configurado()) {
    try {
      rd = await perdasNoRd(usuario, dia);
    } catch (e) {
      aviso = `Não consegui ler as perdas no RD (${e.message}); a conta usa só o que o sistema desqualificou.`;
    }
  } else {
    aviso = 'RD não configurado no servidor: a conta usa só o que o sistema desqualificou.';
  }
  const porId = new Map();
  sistema.forEach((p) => porId.set(p.id, p));
  rd.forEach((p) => porId.set(p.id, { id: p.id, motivo: p.motivo || (porId.get(p.id) && porId.get(p.id).motivo) || '' })); // o RD manda no motivo
  const soma = new Map();
  for (const p of porId.values()) {
    const motivo = p.motivo.replace(/\s*\(.*?\)\s*$/, '').trim() || 'Sem motivo informado';
    const k = norm(motivo);
    const atual = soma.get(k) || { motivo, qtd: 0 };
    atual.qtd++;
    soma.set(k, atual);
  }
  const motivos = [...soma.values()].sort((a, b) => b.qtd - a.qtd || a.motivo.localeCompare(b.motivo));
  return { motivos, total: porId.size, aviso };
}

// ---------------------------------------------------------------- o que é digitado
const CAMPOS_MANUAIS = ['automaticas', 'realizadas', 'agendasCaidas', 'noShow', 'extras'];
const chaveManual = (usuarioId, dia) => `report_dia_${usuarioId}_${dia}`;

function manualLimpo(m) {
  const x = m && typeof m === 'object' ? m : {};
  const numero = (v) => {
    const n = Math.floor(Number(String(v == null ? '' : v).trim()));
    return String(v == null ? '' : v).trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 9999 ? n : null;
  };
  const texto = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/g, '')).join('\n').trim().slice(0, n);
  return {
    automaticas: numero(x.automaticas), realizadas: numero(x.realizadas),
    agendasCaidas: texto(x.agendasCaidas, 4000), noShow: texto(x.noShow, 2000), extras: texto(x.extras, 2000),
  };
}

async function manualDoDia(usuarioId, dia) {
  return manualLimpo(await db.getJson(chaveManual(usuarioId, dia), null));
}

async function salvarManual(usuarioId, dia, manual) {
  const limpo = manualLimpo(manual);
  await db.setJson(chaveManual(usuarioId, dia), limpo);
  return limpo;
}

// ---------------------------------------------------------------- o texto
/** O fechamento no formato que o pré-vendedor manda. Só entra a seção que tem o que dizer. */
function montarTexto({ nome, dia, contagem, manual, desqualificados }) {
  const m = manual || manualLimpo(null);
  const [, mes, d] = String(dia).split('-');
  const l = [`REPORT ${nome} | ${d}/${mes}`, '', '', '---------------------------------- '];
  if (m.automaticas !== null) l.push(`Automáticas: ${m.automaticas}`);
  l.push(`Leads novos contatados: ${contagem.novos}`, `Respostas: ${contagem.respostas}`, `Recontatos: ${contagem.recontatos}`);
  if (m.realizadas !== null) l.push(`Realizadas: ${m.realizadas}`);
  if (m.agendasCaidas) l.push('', 'Agendas que caíram:', '', m.agendasCaidas);
  if (m.noShow) l.push('', 'NO SHOW: ', '', m.noShow);
  const motivos = (desqualificados && desqualificados.motivos) || [];
  if (motivos.length || m.extras) {
    l.push('', 'Desqualificados:');
    motivos.forEach((x) => l.push(`${x.qtd}x ${x.motivo}`));
    if (m.extras) l.push(m.extras);
  }
  return l.join('\n');
}

/** Tudo do dia para a tela: contagem, desqualificados, o que foi digitado e o texto pronto. */
async function montar(usuario, diaPedido) {
  const dia = diaValido(diaPedido);
  const [contagem, desqualificados, manual] = await Promise.all([
    contagemDoDia(usuario.id, dia), desqualificadosDoDia(usuario, dia), manualDoDia(usuario.id, dia),
  ]);
  return { dia, contagem, desqualificados, manual, texto: montarTexto({ nome: usuario.nome, dia, contagem, manual, desqualificados }) };
}

module.exports = { registrarAtividade, contagemDoDia, desqualificadosDoDia, manualDoDia, salvarManual, montarTexto, montar, impressaoDaConversa, manualLimpo, CAMPOS_MANUAIS };
