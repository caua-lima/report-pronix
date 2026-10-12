'use strict';

// Diagnóstico das automações: confere, sem alterar nada, se está tudo no lugar para
//   - mover o card para "Respondeu" no RD quando o lead responde;
//   - pintar a reunião do lead no Google Agenda com a cor do pré-vendedor.
// Cada item diz se está ok e, quando não está, o que fazer. O último item de cada grupo é a prova
// de que funcionou de verdade: o último card movido e a última reunião pintada por este sistema.

const db = require('./db');
const crm = require('./crm');
const agendaGoogle = require('./agendaGoogle');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const dataHora = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { timeZone: process.env.TZ_RELATORIO || 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * @param {object|null} usuario quem pediu (null = entrou só com a senha do servidor)
 * @returns {Promise<{itens: object[], respondeu: object, cor: object}>}
 *   item = { grupo: 'respondeu'|'cor', nome, ok: true|false|null, detalhe, resolver }  (ok null = aviso, não impede)
 */
async function rodar(usuario) {
  const itens = [];
  const add = (grupo, nome, ok, detalhe, resolver) => itens.push({ grupo, nome, ok, detalhe: detalhe || '', resolver: ok === true ? '' : resolver || '' });
  const semChave = !usuario;

  // ---------------------------------------------------------------- mover para "Respondeu"
  const rdOk = crm.configurado();
  add('respondeu', 'Token do RD no servidor', rdOk, rdOk ? 'RDSTATION_CRM_TOKEN está configurado.' : 'Falta a variável RDSTATION_CRM_TOKEN.', 'Crie RDSTATION_CRM_TOKEN na Vercel e publique de novo.');
  if (rdOk) {
    try {
      const us = await crm.usuariosRd();
      add('respondeu', 'O RD aceita o token', us.length > 0, us.length ? `O RD respondeu (${us.length} usuário(s) na conta).` : 'O RD respondeu, mas sem nenhum usuário.', 'Confira se o token é de um usuário ativo do RD.');
    } catch (e) {
      add('respondeu', 'O RD aceita o token', false, e.message, 'Gere o token de novo no RD e atualize RDSTATION_CRM_TOKEN na Vercel.');
    }
    try {
      const alvo = norm(process.env.CRM_ETAPA_RESPONDEU || 'Respondeu');
      const com = (await crm.funis()).filter((f) => f.etapas.some((e) => norm(e.nome) === alvo));
      add('respondeu', 'Etapa "Respondeu" no funil', com.length > 0, com.length ? 'Funis com a etapa: ' + com.map((f) => f.nome).join(', ') + '.' : 'Nenhum funil tem uma etapa com esse nome.',
        'Se o time renomeou a etapa, crie CRM_ETAPA_RESPONDEU na Vercel com o nome novo.');
    } catch (e) {
      add('respondeu', 'Etapa "Respondeu" no funil', false, e.message, 'O RD não devolveu os funis: tente de novo em 1 minuto.');
    }
  }
  const escreve = crm.moverLigado();
  add('respondeu', 'Escrita no RD ligada', escreve, escreve ? 'O servidor pode mudar cards de etapa.' : 'A escrita está desligada (CRM_MOVER_ETAPA=0).', 'Apague CRM_MOVER_ETAPA (ou ponha 1) na Vercel e publique de novo.');
  if (semChave) {
    add('respondeu', 'Suas permissões', null, 'Você entrou só com a senha do servidor: não dá para conferir as permissões da sua chave.', 'Cole a sua chave em "Sua chave" e verifique de novo.');
  } else {
    add('respondeu', 'Sua Automação RD', Boolean(usuario.automacao), usuario.automacao ? 'Ligada para a sua chave.' : 'Desligada para a sua chave.', 'Acessos → clique no seu nome → marque "Automação RD".');
    add('respondeu', 'Seu Popup do lead', Boolean(usuario.fichaCrm), usuario.fichaCrm ? 'Ligado: é o cartão que dispara a automação ao abrir a conversa.' : 'Desligado: sem o cartão, a automação não roda.', 'Acessos → clique no seu nome → marque "Popup do lead".');
  }
  const movimentos = await db.range('crm_movimentos').catch(() => []);
  const ultimoMov = movimentos[movimentos.length - 1];
  add('respondeu', 'Último card movido de verdade', ultimoMov ? true : null,
    ultimoMov ? `${dataHora(ultimoMov.quando)}: de "${ultimoMov.de}" para "${ultimoMov.para}"${ultimoMov.por ? ', por ' + ultimoMov.por : ''}. (${movimentos.length} no registro.)`
      : 'Este sistema ainda não moveu nenhum card.',
    'A prova real: abra no WhatsApp, com a extensão deste sistema, a conversa de um lead que respondeu e cujo card está antes de "Respondeu". O cartão mostra "Movido para Respondeu no RD".');

  // ---------------------------------------------------------------- pintar a reunião na agenda
  let g = { configurado: false, conectado: false, agendas: [] };
  try {
    g = await agendaGoogle.status();
  } catch (e) {
    g.erro = e.message;
  }
  add('cor', 'Aplicativo do Google no servidor', Boolean(g.configurado), g.configurado ? 'GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET estão configurados.' : 'Faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.', 'Crie as duas variáveis na Vercel e publique de novo.');
  const conectado = Boolean(g.conectado) && !g.erro;
  add('cor', 'Conta do Google conectada', conectado, g.erro || (g.conectado ? 'Conectada' + (g.conectadoEm ? ' em ' + dataHora(g.conectadoEm) : '') + '.' : 'Nenhuma conta conectada.'), 'Extensão e integrações → Google Agenda → Conectar Google Agenda.');
  if (conectado) {
    add('cor', 'A conexão pode alterar eventos', g.alteraEventos === undefined ? null : g.alteraEventos,
      g.alteraEventos === true ? 'A permissão de editar eventos foi concedida.' : g.alteraEventos === false ? 'A conexão só LÊ as agendas: não consegue mudar a cor.' : 'Não deu para confirmar a permissão agora.',
      'Google Agenda → "Conectar de novo" e, na tela do Google, deixe marcada a permissão de ver e editar eventos.');
    const total = (g.agendas || []).length;
    const soVer = g.soLeitura || [];
    add('cor', 'Agendas que você pode editar', total === 0 ? false : soVer.length === total ? false : soVer.length ? null : true,
      total === 0 ? 'A conta conectada não enxerga nenhuma agenda.' : `${total} agenda(s) à vista` + (soVer.length ? `; só para VER (a cor não muda nelas): ${soVer.join(', ')}.` : ', todas editáveis.'),
      'O dono de cada agenda precisa compartilhar com você em "Fazer alterações nos eventos".');
  }
  if (semChave) {
    add('cor', 'Sua cor e permissões', null, 'Você entrou só com a senha do servidor: não dá para conferir a cor da sua chave.', 'Cole a sua chave em "Sua chave" e verifique de novo.');
  } else {
    const cor = agendaGoogle.corValida(usuario.corAgenda);
    add('cor', 'Sua cor na agenda', Boolean(cor), cor ? `${agendaGoogle.CORES[cor]} (cor ${cor}).` : 'Nenhuma cor escolhida ("Não pintar").', 'Acessos → clique no seu nome → Cor na agenda → Banana.');
    add('cor', 'Sua Automação RD', Boolean(usuario.automacao), usuario.automacao ? 'Ligada: a agenda é consultada ao abrir a conversa.' : 'Desligada: sem ela a agenda nem é consultada.', 'Acessos → clique no seu nome → marque "Automação RD".');
  }
  const p = g.ultimaPintura;
  const pintou = Boolean(p && p.resultado === 'pintado');
  const como = !p ? 'Este sistema ainda não tentou pintar nenhuma reunião.'
    : p.resultado === 'pintado' ? `${dataHora(p.em)}: pintou uma reunião na agenda ${p.agenda}.`
    : p.resultado === 'ja-tem-cor' ? `${dataHora(p.em)}: o evento (agenda ${p.agenda}) já tinha outra cor, então não troquei.`
    : p.resultado === 'sem-permissao' ? `${dataHora(p.em)}: o Google recusou (agenda ${p.agenda}): ` + (p.motivo === 'conexao' ? 'a conexão não pode alterar eventos.' : 'a sua conta só pode ver essa agenda.')
    : `${dataHora(p.em)}: o Google respondeu erro ${p.motivo || ''} (agenda ${p.agenda}).`;
  add('cor', 'Última reunião pintada de verdade', pintou ? true : p && p.resultado === 'sem-permissao' ? false : null, como,
    'A prova real: abra no WhatsApp a conversa de um lead com reunião FUTURA e ainda sem cor na agenda; depois verifique de novo aqui.');

  const resumo = (grupo, provado) => {
    const doGrupo = itens.filter((i) => i.grupo === grupo);
    return { pronto: !doGrupo.some((i) => i.ok === false), comprovado: provado, falhas: doGrupo.filter((i) => i.ok === false).length };
  };
  return { itens, respondeu: resumo('respondeu', Boolean(ultimoMov)), cor: resumo('cor', pintou) };
}

module.exports = { rodar };
