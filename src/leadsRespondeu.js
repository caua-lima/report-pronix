'use strict';

// Lista para recontato (.txt): os leads do mês (padrão: o atual) que estão na etapa "Respondeu" de
//  - Aplicação Direta: todos;
//  - SMQLs Automáticos: só os do SDR (o campo SDR do card é você).
// Cada linha: nome, telefone e a data em que se inscreveu (criação do card). Só leitura no CRM. Lê em partes (a Vercel
// corta em 60 s): o que não couber fica para a próxima rodada (pendentes) e o que já foi lido fica guardado.

const db = require('./db');
const crm = require('./crm');
const stats = require('./stats');
const { leadDoCard } = require('./vendasDoRd');

const ORCAMENTO_MS = () => Number(process.env.RESPONDEU_ORCAMENTO_MS) || 45000;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idDe = (d) => String((d && (d.id || d._id)) || '');
const ultimoDiaDoMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

/** "5511987654321" -> "(11) 98765-4321". */
function telefoneBonito(bruto) {
  let d = String(bruto || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

/** O funil pelo nome e a etapa "Respondeu" dele (pela categoria "resposta" ou pelo nome). */
function acharFunil(funis, re) {
  const f = funis.find((x) => re.test(norm(x.nome)));
  if (!f) return null;
  const etapa = f.etapas.find((e) => norm(e.nome) === 'respondeu') || f.etapas.find((e) => e.categoria === 'resposta');
  return etapa ? { funil: f, etapa } : null;
}

/** O telefone do contato do card: do próprio card, ou do detalhe do contato (guardado 1 dia). */
async function telefoneDoCard(d) {
  const c = (d.contacts || [])[0] || {};
  const direto = ((c.phones || [])[0] || {}).phone;
  if (direto) return String(direto);
  const id = idDe(c);
  if (!id) return '';
  const chave = 'respondeu_tel1_' + id;
  const g = await db.cacheGet(chave).catch(() => null);
  if (g !== null && g !== undefined) return g;
  const r = await crm.rd(`/contacts/${encodeURIComponent(id)}`).catch(() => null);
  const ct = r && (r.contact || r);
  const tel = String((((ct && ct.phones) || [])[0] || {}).phone || '');
  await db.cacheSet(chave, tel, 24 * 3600).catch(() => {});
  return tel;
}

/**
 * @param {{ usuario: {id, nome}, mes?: string }} p
 * @returns {Promise<{ mes, linhas: Array<{funil, nome, telefone, inscricao}>, texto, pendentes, avisos }>}
 */
async function gerar({ usuario, mes } = {}) {
  if (!crm.configurado()) throw new Error('O CRM não está configurado no servidor.');
  const prazoFinal = Date.now() + ORCAMENTO_MS();
  const hoje = stats.emDiaLocal(new Date().toISOString());
  const mesOk = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || '')) ? mes : hoje.slice(0, 7);
  const inicio = mesOk + '-01';
  const fim = ultimoDiaDoMes(mesOk) < hoje ? ultimoDiaDoMes(mesOk) : hoje;
  const funis = await crm.funis();
  const avisos = [];
  const aplicacao = acharFunil(funis, /aplicacao direta/);
  const smql = acharFunil(funis, /smql/);
  if (!aplicacao) avisos.push('Não achei o funil "Aplicação Direta" (com a etapa Respondeu) no CRM.');
  if (!smql) avisos.push('Não achei o funil "SMQLs Automáticos" (com a etapa Respondeu) no CRM.');
  const eu = smql ? await crm.usuarioDoCrm(usuario.nome).catch(() => null) : null;
  if (smql && !eu) avisos.push(`Não achei o usuário "${usuario.nome}" no CRM: os SMQLs ficaram de fora.`);

  const pedidos = [];
  if (aplicacao) pedidos.push({ rotulo: 'Aplicação Direta', alvo: aplicacao, filtro: {} });
  if (smql && eu) pedidos.push({ rotulo: 'SMQLs Automáticos', alvo: smql, filtro: { sdr_id: String(eu.id) } });
  const cards = [];
  for (const p of pedidos) {
    const chave = `respondeu_lista1_${p.alvo.funil.id}_${p.filtro.sdr_id || 'todos'}_${inicio}_${fim}`;
    let lista = null;
    const g = await db.cacheGet(chave).catch(() => null);
    if (g) { try { lista = JSON.parse(g); } catch (_) { lista = null; } }
    if (!lista) {
      const deals = await crm.listarNegociacoes(
        { deal_pipeline_id: p.alvo.funil.id, deal_stage_id: p.alvo.etapa.id, ...p.filtro, created_at_period: 'true', start_date: crm.instanteDoDia(inicio), end_date: crm.instanteDoDia(fim, true) },
        { timeoutMs: 25000 }
      );
      // confere aqui o que a lista diz (etapa, aberto e criado no mês) — o CRM pode ignorar algum filtro
      lista = deals
        .filter((d) => idDe(d.deal_stage) === p.alvo.etapa.id || norm(d.deal_stage && d.deal_stage.name) === norm(p.alvo.etapa.nome))
        .filter((d) => d.win !== true && d.win !== false && !d.closed_at)
        .filter((d) => { const c = d.created_at ? stats.emDiaLocal(d.created_at) : ''; return c >= inicio && c <= fim; })
        .map((d) => ({ id: idDe(d), name: d.name || '', created_at: d.created_at || '', contacts: d.contacts || [], updated_at: d.updated_at || '' }));
      await db.cacheSet(chave, JSON.stringify(lista), 10 * 60).catch(() => {});
    }
    lista.forEach((d) => cards.push({ ...d, rotulo: p.rotulo }));
  }

  // contato e telefone: o detalhe do card (guardado) quando a lista não traz o contato; depois o telefone do contato
  const linhas = [];
  let pendentes = 0;
  const vistos = new Set();
  for (const c of cards) {
    if (Date.now() > prazoFinal - 5000) { pendentes++; continue; }
    let d = c;
    if (!(c.contacts || []).length) {
      const det = await crm.detalhesDe([{ id: c.id, updated_at: c.updated_at }], { prazoMs: Math.max(1000, prazoFinal - 5000 - Date.now()) }).catch(() => []);
      if (det[0]) d = { ...c, ...det[0] };
      else { pendentes++; continue; }
    }
    const telefone = telefoneBonito(await telefoneDoCard(d));
    const nome = leadDoCard(d) || 'Lead';
    const chaveLead = telefone.replace(/\D/g, '').slice(-8) || norm(nome);
    if (vistos.has(chaveLead)) continue;
    vistos.add(chaveLead);
    linhas.push({ funil: c.rotulo, nome, telefone, inscricao: c.created_at ? stats.emDiaLocal(c.created_at).split('-').reverse().join('/') : '' });
  }
  linhas.sort((a, b) => a.funil.localeCompare(b.funil) || String(a.inscricao.split('/').reverse().join('')).localeCompare(String(b.inscricao.split('/').reverse().join(''))) || a.nome.localeCompare(b.nome, 'pt-BR'));
  const texto = linhas.map((l) => `${l.nome} - ${l.telefone || 'sem telefone no CRM'} - inscrito em ${l.inscricao || '?'}`).join('\r\n') + (linhas.length ? '\r\n' : '');
  return { mes: mesOk, inicio, fim, linhas, texto, pendentes, avisos };
}

module.exports = { gerar, telefoneBonito, acharFunil };
