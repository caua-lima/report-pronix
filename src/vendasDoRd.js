'use strict';

// Traz do RD as vendas de um closer em que o usuário foi o SDR, direto do card — para quem gerou o report
// em outro sistema (ou nem gerou). Para cada card ganho no período, do closer escolhido e com o campo
// "SDR" do card com o nome do usuário:
//  - se o usuário já tem um report desse lead, completa o que estiver vazio (closer, resultado, ticket,
//    produto, data) — o que foi marcado à mão nunca é trocado;
//  - se não tem, cria o report (origem "rd", sem PDF e sem leitura da IA) com a venda: closer, ticket,
//    produto e data.
// Só leitura no RD. Os cards são filtrados aqui, e não só pelo RD: filtro que o RD ignorasse não traria venda
// de outra pessoa.

const crm = require('./crm');
const stats = require('./stats');
const closers = require('./closers');
const closerAuto = require('./closerAuto');
const { produtoPeloNome } = require('./vendasRd');

const MAX_PAGINAS = 8;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idDe = (d) => String((d && (d.id || d._id)) || '');
const lista = (r, ...chaves) => (Array.isArray(r) ? r : chaves.map((k) => r && r[k]).find(Array.isArray) || []);

const palavrasBatem = (nome, alvo) => {
  const p = new Set(norm(nome).split(' ').filter(Boolean));
  const a = norm(alvo).split(' ').filter(Boolean);
  return a.length > 0 && a.every((x) => p.has(x));
};

/** O campo "SDR" do card diz o usuário? (o nome inteiro ou o primeiro nome) */
function sdrDoCard(deal, usuario) {
  const campo = (Array.isArray(deal.deal_custom_fields) ? deal.deal_custom_fields : [])
    .find((c) => norm(c && c.custom_field && c.custom_field.label) === 'sdr');
  const valor = norm(campo && campo.value);
  if (!valor) return null; // sem o campo preenchido: não dá para afirmar
  const primeiro = norm(usuario.nome).split(' ')[0];
  return valor === norm(usuario.nome) || valor === primeiro || valor.split(' ')[0] === primeiro;
}

/** O lead do card: o contato dele, ou o nome do card sem o prefixo ("PRXC | Fulano"). */
function leadDoCard(deal) {
  const c = (deal.contacts || [])[0];
  const doContato = c && String(c.name || '').trim();
  return (doContato || String(deal.name || '').replace(/^[^|]*\|\s*/, '')).trim().slice(0, 120);
}

/**
 * @param {{usuario: {id, nome}, desde: string, closer: string}} pedido  desde = AAAA-MM-DD
 * @returns {Promise<{vistos: number, criados: number, completados: number, jaEstavam: number, semSdr: number, deOutroSdr: number, paginas: number, truncado: boolean}>}
 */
async function trazer({ usuario, desde, closer }) {
  if (!crm.configurado()) throw new Error('O RD Station não está configurado no servidor.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(desde || ''))) throw new Error('Informe a data de início (AAAA-MM-DD).');
  const nomeCloser = String(closer || '').trim();
  if (!nomeCloser) throw new Error('Informe o closer (ex.: Paulo Henrique).');
  const hoje = stats.emDiaLocal(new Date().toISOString());

  const rdUsers = await crm.usuariosRd().catch(() => []);
  const closerRd = rdUsers.find((u) => palavrasBatem(u.nome, nomeCloser));
  const cadastro = closerAuto.acharCloser(await closers.listar(), nomeCloser);

  const saida = { vistos: 0, criados: 0, completados: 0, jaEstavam: 0, semSdr: 0, deOutroSdr: 0, paginas: 0, truncado: false };
  const meus = (await stats.listar({})).filter((r) => r.usuarioId === usuario.id);
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const r = await crm.rd('/deals', {
      win: 'true', closed_at: 'true', closed_at_period: 'true', start_date: desde, end_date: hoje, limit: 200, page: pagina,
      ...(closerRd ? { user_id: String(closerRd.id) } : {}),
    });
    saida.paginas = pagina;
    const deals = lista(r, 'deals');
    for (const d of deals) {
      const dia = d.closed_at ? stats.emDiaLocal(d.closed_at) : '';
      if (d.win !== true || !dia || dia < desde || dia > hoje) continue;
      if (!palavrasBatem((d.user && d.user.name) || '', nomeCloser)) continue;
      saida.vistos++;
      const doSdr = sdrDoCard(d, usuario);
      if (doSdr === null) { saida.semSdr++; continue; }
      if (!doSdr) { saida.deOutroSdr++; continue; }

      const dealId = idDe(d);
      const contato = (d.contacts || [])[0] || {};
      const lead = leadDoCard(d);
      const email = String(((contato.emails || [])[0] || {}).email || '').toLowerCase();
      const telefone = String(((contato.phones || [])[0] || {}).phone || '').replace(/\D/g, '');
      const produto = produtoPeloNome((d.deal_products || []).map((p) => (p && (p.name || (p.product && p.product.name))) || ''));
      const venda = {
        closerId: cadastro ? cadastro.id : '', closerNome: cadastro ? cadastro.nome : nomeCloser, resultado: 'venda_call',
        ticket: Number(d.amount_total) || 0, produto, dataFechamento: dia, vendidoNoRd: d.closed_at,
      };

      const existente = meus.find((x) => x.rdDealId === dealId || x.id === 'rd' + dealId ||
        (x.rdContatoId && x.rdContatoId === idDe(contato)) ||
        (norm(x.lead) && norm(x.lead) === norm(lead) && x.dia <= dia && (Date.parse(dia) - Date.parse(x.dia)) / 86400000 <= 45));
      if (existente) {
        const campos = { rdDealId: dealId, vendidoNoRd: existente.vendidoNoRd || venda.vendidoNoRd };
        if (!existente.closerId && venda.closerId) Object.assign(campos, { closerId: venda.closerId, closerNome: venda.closerNome, closerOrigem: 'rd' });
        if (!existente.resultado || existente.resultado === 'em_followup' || existente.resultadoOrigem === 'rd') Object.assign(campos, { resultado: venda.resultado, resultadoOrigem: 'rd' });
        if (!existente.ticket && venda.ticket) campos.ticket = venda.ticket;
        if (!existente.produto && venda.produto) campos.produto = venda.produto;
        if (!existente.dataFechamento) campos.dataFechamento = venda.dataFechamento;
        const mudou = existente.rdDealId !== dealId || !existente.vendidoNoRd || Object.keys(campos).length > 2;
        if (mudou) {
          await stats.atualizarResultado(existente.id, campos);
          saida.completados++;
        } else {
          saida.jaEstavam++;
        }
        continue;
      }
      const novo = await stats.importar({
        origem: 'rd', id: 'rd' + dealId, quando: d.closed_at, usuarioId: usuario.id, usuarioNome: usuario.nome, lead, contato: lead,
        ...venda, leadEmail: email, telefone, rdDealId: dealId, rdContatoId: idDe(contato), rdSituacao: 'Vendido no RD (trazido direto do card)',
      });
      meus.push(novo);
      saida.criados++;
    }
    if (!(r && r.has_more) && deals.length < 200) break;
    if (pagina === MAX_PAGINAS) saida.truncado = true;
  }
  return saida;
}

module.exports = { trazer, sdrDoCard, leadDoCard };
