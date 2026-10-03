// Leitura do agendamento e do "lead respondeu" nas mensagens da conversa — sem IA e sem rede:
// roda no navegador, em cima do que já está na tela (o texto da conversa não sai daqui; só o dia
// e o horário achados vão para o servidor). Carregado antes do content.js; os testes usam direto no node.

(function (raiz) {
  'use strict';

  const semAcento = (s) =>
    String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const p2 = (n) => String(n).padStart(2, '0');

  const MESES = {
    janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, mar: 3, abril: 4, abr: 4, maio: 5, mai: 5, junho: 6, jun: 6,
    julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9, outubro: 10, out: 10, novembro: 11, nov: 11, dezembro: 12, dez: 12,
  };
  const RE_MES = Object.keys(MESES).sort((a, b) => b.length - a.length).join('|');
  const SEMANA = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

  // A mensagem fala de um compromisso marcado (e não de "2 horas por dia" ou "te chamo às 15h")?
  const RE_COMPROMISSO =
    /\b(?:re)?agend\w*|\bremar(?:c|qu)\w*|\bmarcad\w*|\bmarcamos\b|\bmarquei\b|\bmarcar\b|\breuniao\b|\bcall\b|\bchamada\b|\bvideochamada\b|\bconfirmad\w*|\bconfirmo\b|\bconfirmamos\b|\bcombinad\w*|\bdiagnostico\b|\bconsultoria\b|\bsessao\b|\bespecialista\b|\bconsultor\b|\bmeet\b|\bzoom\b|\bencontro\b|\bhorario\b|\bfic(?:a|ou|amos|aria)\s+(?:para|pra|pro)\b/;
  // "Agendado!", "Confirmado então": fecha o que foi combinado nas mensagens anteriores.
  const RE_CONFIRMA = /\b(?:re)?agendad\w*|\b(?:re)?marcad\w*|\bconfirmad\w*|\bcombinad\w*|\breservad\w*|\bfechado\b/;

  // "15h", "15h30", "15 horas", "15:30", "às 15", "3 da tarde" e "meio-dia".
  const RE_HORA =
    /\bmeio[- ]dia(\s+e\s+meia)?\b|\b(\d{1,2})\s?(?:horas?|hrs?|hs|h)(?![a-z])(?:\s?(\d{2})(?![\d\/]))?|\b(\d{1,2}):(\d{2})(?!\d)|\b(?:as|pras|das)\s+(\d{1,2})\b(?!\s?(?::\d|\/\d|\d|h(?![a-z])|hs\b|hrs?\b|horas?\b))|\b(\d{1,2})(?=\s+da\s+(?:manha|tarde|noite)\b)/g;
  const RE_COM_AS = /(?:\bas|\bpras|\bdas)\s*$/;
  // Só "da manhã/tarde/noite": "dia 10 de manhã" é o dia 10, não as 10 horas.
  const RE_PERIODO = /^\s*da\s+(manha|tarde|noite|madrugada)\b/;
  // "2 horas por dia", "1h de reunião": é duração, não horário.
  const RE_DURACAO = /^\s*(?:por\s+(?:dia|semana|mes)|ao\s+dia|de\s+(?:duracao|conversa|reuniao|call)|semanais|diarias)\b/;

  /** Frases do texto, com a posição de cada uma e se é pergunta ("3.000" e "15.30" não quebram a frase). */
  function frases(t) {
    const out = [];
    let ini = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      const fim = c === '\n' || c === '!' || c === '?' || (c === '.' && (i + 1 >= t.length || /\s/.test(t[i + 1])));
      if (!fim) continue;
      let j = i;
      while (j + 1 < t.length && /[.!?]/.test(t[j + 1])) j++;
      if (t.slice(ini, j + 1).trim()) out.push({ ini, fim: j + 1, pergunta: t.slice(i, j + 1).includes('?') });
      ini = j + 1;
      i = j;
    }
    if (t.slice(ini).trim()) out.push({ ini, fim: t.length, pergunta: false });
    return out;
  }

  /** Horários citados no texto (já sem acento e minúsculo): [{ pos, h, min }]. */
  function horarios(t) {
    const out = [];
    RE_HORA.lastIndex = 0;
    let m;
    while ((m = RE_HORA.exec(t))) {
      const depois = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
      if (m[0].startsWith('meio')) {
        out.push({ pos: m.index, h: 12, min: m[1] ? 30 : 0 });
        continue;
      }
      const solto = m[6] !== undefined || m[7] !== undefined; // "às 15" / "3 da tarde": sem "h" nem minutos
      let h = Number([m[2], m[4], m[6], m[7]].find((x) => x !== undefined));
      const min = Number(m[3] !== undefined ? m[3] : m[5] !== undefined ? m[5] : 0);
      if (h > 23 || min > 59 || RE_DURACAO.test(depois)) continue;
      const comAs = m[6] !== undefined || RE_COM_AS.test(t.slice(Math.max(0, m.index - 12), m.index));
      const periodo = (RE_PERIODO.exec(depois) || [])[1] || '';
      if ((periodo === 'tarde' || periodo === 'noite') && h < 12) h += 12;
      // "às 3" numa conversa de agendamento é da tarde: ninguém marca reunião às 3 da manhã.
      else if (!periodo && comAs && h >= 1 && h <= 6) h += 12;
      // Sem "às" e sem "da tarde", só vale o que tem cara de horário comercial ("15h"); "2h" solto é duração.
      const aceito = periodo ? true : solto ? h >= 7 && h <= 22 : comAs ? true : h >= 7;
      if (aceito) out.push({ pos: m.index, h, min });
    }
    return out;
  }

  const meiaNoite = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const maisDias = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const dataValida = (y, mes, dia) => {
    const d = new Date(y, mes - 1, dia);
    return d.getMonth() === mes - 1 && d.getDate() === dia ? d : null;
  };

  /** Dias citados no texto, resolvidos a partir da data da mensagem: [{ pos, peso, data }] (peso maior = mais explícito). */
  function dias(t, base) {
    const out = [];
    const hoje = meiaNoite(base);
    const comAno = (dia, mes, ano) => {
      if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;
      if (ano !== undefined) return dataValida(ano < 100 ? 2000 + ano : ano, mes, dia);
      // Sem ano: a próxima vez que essa data acontece (com folga para "foi dia 02/10").
      let d = dataValida(hoje.getFullYear(), mes, dia);
      if (d && d.getTime() < hoje.getTime() - 60 * 86400000) d = dataValida(hoje.getFullYear() + 1, mes, dia);
      return d;
    };
    let m;
    const reData = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d\/])/g;
    while ((m = reData.exec(t))) {
      const d = comAno(Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3]));
      if (d) out.push({ pos: m.index, peso: 4, data: d });
    }
    const reDeMes = new RegExp('\\b(\\d{1,2})\\s+de\\s+(' + RE_MES + ')\\b', 'g');
    while ((m = reDeMes.exec(t))) {
      const d = comAno(Number(m[1]), MESES[m[2]]);
      if (d) out.push({ pos: m.index, peso: 4, data: d });
    }
    const reDia = new RegExp('\\bdia\\s+(\\d{1,2})\\b(?!\\s*(?:\\/\\d|de\\s+(?:' + RE_MES + ')\\b))', 'g');
    while ((m = reDia.exec(t))) {
      const n = Number(m[1]);
      if (n < 1 || n > 31) continue;
      // "dia 15" = o próximo dia 15 (neste mês, ou no que vem se já passou).
      const d = dataValida(hoje.getFullYear(), hoje.getMonth() + 1, n);
      const escolhido = d && d.getTime() >= hoje.getTime() ? d : new Date(hoje.getFullYear(), hoje.getMonth() + 1, n);
      if (escolhido.getDate() === n) out.push({ pos: m.index, peso: 3, data: escolhido });
    }
    // "depois de amanhã" antes de "amanhã": o trecho é apagado para não contar duas vezes.
    let resto = t.replace(/\bdepois\s+de\s+amanha\b/g, (x, pos) => {
      out.push({ pos, peso: 2, data: maisDias(hoje, 2) });
      return ' '.repeat(x.length);
    });
    resto = resto.replace(/\bamanha\b/g, (x, pos) => {
      out.push({ pos, peso: 2, data: maisDias(hoje, 1) });
      return ' '.repeat(x.length);
    });
    const reHoje = /\bhoje\b/g;
    while ((m = reHoje.exec(resto))) out.push({ pos: m.index, peso: 2, data: hoje });
    // "segunda parcela", "quinta vez": aí não é dia da semana.
    const reSemana = /\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:[- ]feira)?\b(?!\s+(?:opcao|parcela|vez|etapa|parte|fase|pergunta|semana)\b)/g;
    while ((m = reSemana.exec(resto))) {
      const delta = (SEMANA[m[1]] - hoje.getDay() + 7) % 7 || 7;
      out.push({ pos: m.index, peso: 1, data: maisDias(hoje, delta) });
    }
    return out;
  }

  const formatar = (d, hora) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(hora.h)}:${p2(hora.min)}`;
  /** O dia mais explícito da lista; no empate, o mais perto de `pos` no texto. */
  const melhorDia = (lista, pos) =>
    lista.reduce((a, b) => (!a || b.peso > a.peso || (b.peso === a.peso && Math.abs(b.pos - pos) < Math.abs(a.pos - pos)) ? b : a), null);

  /**
   * Agendamento escrito num texto: o horário de uma frase com o dia mais explícito (da mesma frase, de
   * preferência). Afirmação vale mais que pergunta; oferta de opções ("15h ou 17h") não é agendamento.
   * @param {string} texto  @param {Date} base data da mensagem (para "amanhã", "quinta")
   * @returns {string} 'AAAA-MM-DDTHH:mm' no horário local, ou ''
   */
  function lerAgendamento(texto, base) {
    const t = semAcento(texto);
    if (!t || t.length > 4000 || !RE_COMPROMISSO.test(t)) return '';
    const fs = frases(t);
    const daFrase = (pos) => fs.findIndex((f) => pos >= f.ini && pos < f.fim);
    const hs = horarios(t).map((h) => ({ ...h, frase: daFrase(h.pos) }));
    const ds = dias(t, base).map((d) => ({ ...d, frase: daFrase(d.pos) }));
    if (!hs.length || !ds.length) return '';
    for (const pergunta of [false, true]) {
      // Da última frase para a primeira: "ficou para quinta às 15h" no fim vale mais que o que veio antes.
      for (let i = fs.length - 1; i >= 0; i--) {
        if (fs[i].pergunta !== pergunta) continue;
        const daqui = hs.filter((h) => h.frase === i);
        if (!daqui.length) continue;
        const distintos = new Set(daqui.map((h) => h.h * 60 + h.min));
        if (distintos.size > 1 && /\bou\b/.test(t.slice(fs[i].ini, fs[i].fim))) continue; // opções, não agendamento
        const hora = daqui[0];
        const dia = melhorDia(ds.filter((d) => d.frase === i), hora.pos) || melhorDia(ds, hora.pos);
        if (dia) return formatar(dia.data, hora);
      }
    }
    return '';
  }

  /**
   * "Tenho amanhã às 10h ou às 15h" → lead: "15h" → eu: "Agendado!": a mensagem que confirma não diz o
   * horário. O horário vem da resposta do lead; o dia, dela mesma ou das opções que eu dei logo antes.
   */
  function porEscolhaDoLead(lista, ts, i, agora) {
    let hora = null;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const m = lista[j];
      if (!m || typeof m.content !== 'string' || !m.content) continue;
      const t = semAcento(m.content);
      const base = ts[j] === null ? agora : new Date(ts[j]);
      if (m.from !== 'eu') {
        if (hora) continue;
        hora = horarios(t)[0] || null;
        const so = /^\s*(\d{1,2})\s*$/.exec(t); // respondeu só "15"
        if (!hora && so && Number(so[1]) >= 7 && Number(so[1]) <= 22) hora = { pos: 0, h: Number(so[1]), min: 0 };
        const dia = hora && melhorDia(dias(t, base), hora.pos);
        if (dia) return formatar(dia.data, hora);
        continue;
      }
      if (!hora) continue;
      const ds = dias(t, base);
      if (!ds.length) continue;
      if (new Set(ds.map((d) => d.data.getTime())).size === 1) return formatar(ds[0].data, hora);
      // Ofereci mais de um dia: vale o dia que está junto do horário que o lead escolheu.
      const iguais = horarios(t).filter((h) => h.h === hora.h && h.min === hora.min);
      if (iguais.length !== 1) return '';
      const antes = ds.filter((d) => d.pos < iguais[0].pos);
      const dia = antes.length ? antes.reduce((a, b) => (b.pos > a.pos ? b : a)) : melhorDia(ds, iguais[0].pos);
      return formatar(dia.data, hora);
    }
    return '';
  }

  const tsDe = (m) => {
    if (m && typeof m.ts === 'number' && Number.isFinite(m.ts)) return m.ts;
    const t = m && m.timestamp ? Date.parse(m.timestamp) : NaN;
    return Number.isFinite(t) ? t : null;
  };

  /**
   * O agendamento que vale na conversa: a ÚLTIMA mensagem minha que marca dia e horário (remarcou? vale o novo).
   * @param {{from: string, content: string, timestamp?: string, ts?: number}[]} mensagens em ordem
   * @returns {{quando: string, fonteTs: number} | null} fonteTs = horário da mensagem de onde saiu (0 = desconhecido)
   */
  function detectarAgendamento(mensagens, agora) {
    const lista = Array.isArray(mensagens) ? mensagens : [];
    const ref = agora || new Date();
    // Áudio transcrito não traz horário: herda o da mensagem anterior que tenha (ou o da seguinte).
    const ts = lista.map(tsDe);
    for (let i = 1; i < ts.length; i++) if (ts[i] === null) ts[i] = ts[i - 1];
    for (let i = ts.length - 2; i >= 0; i--) if (ts[i] === null) ts[i] = ts[i + 1];
    for (let i = lista.length - 1; i >= 0; i--) {
      const m = lista[i];
      if (!m || m.from !== 'eu' || typeof m.content !== 'string' || !m.content || m.content.startsWith('[áudio')) continue;
      const quando =
        lerAgendamento(m.content, ts[i] === null ? ref : new Date(ts[i])) ||
        (RE_CONFIRMA.test(semAcento(m.content)) ? porEscolhaDoLead(lista, ts, i, ref) : '');
      if (quando) return { quando, fonteTs: ts[i] === null ? 0 : ts[i] };
    }
    return null;
  }

  /** O lead respondeu? Existe mensagem dele DEPOIS de uma mensagem minha (texto, áudio ou mídia). */
  function leadRespondeu(mensagens) {
    let minha = false;
    for (const m of Array.isArray(mensagens) ? mensagens : []) {
      if (!m) continue;
      if (m.from === 'eu') minha = true;
      else if (minha) return true;
    }
    return false;
  }

  const DIA_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

  /** 'AAAA-MM-DDTHH:mm' -> { texto: 'qui, 09/10 às 15:00' | 'hoje às 15:00', passou } para o cartão. */
  function descrever(quando, agora) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(quando || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    if (isNaN(d)) return null;
    const ref = agora || new Date();
    const dif = Math.round((meiaNoite(d).getTime() - meiaNoite(ref).getTime()) / 86400000);
    const dia = dif === 0 ? 'hoje' : dif === 1 ? 'amanhã' : dif === -1 ? 'ontem' : `${DIA_CURTO[d.getDay()]}, ${m[3]}/${m[2]}`;
    return { texto: `${dia} às ${m[4]}:${m[5]}`, passou: d.getTime() < ref.getTime() };
  }

  const api = { lerAgendamento, detectarAgendamento, leadRespondeu, descrever };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.__crAgenda = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
