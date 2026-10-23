// Painel lateral do CRM no WhatsApp Web — como o da extensão do RD Station: uma coluna fixa à direita com o
// lead da conversa aberta, as negociações dele (um clique abre o card no CRM), o que ele respondeu, a reunião
// e as últimas anotações. O WhatsApp fica mais estreito para o painel caber (não cobre a conversa); recolhido,
// vira uma aba na borda e o WhatsApp volta à largura toda. Carregado antes do content.js, que o alimenta com o
// mesmo estado do cartão do lead — nenhuma consulta a mais ao servidor. Texto do CRM nunca vira HTML.

(function (raiz) {
  'use strict';

  const ID = 'pronix-painel-lateral';
  const ABA_ID = 'pronix-painel-aba';
  const CSS_ID = 'pronix-painel-encaixe';
  const LARGURA = 320;
  // Dentro do painel lateral do Chrome (sidepanel.html): a página inteira é o painel.
  const PAGINA = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-pnx-pagina');
  const OURO = '#ffc233';
  const FONTE_TITULO = 'Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif';

  const estado = { aberto: true, ultimo: null, acoes: {}, form: null, chaveLead: '' };
  try {
    chrome.storage.local.get({ painelLateralAberto: true }, (c) => {
      estado.aberto = !c || c.painelLateralAberto !== false;
      if (estado.ultimo) desenhar();
    });
  } catch (_) {
    /* sem storage: fica aberto */
  }

  function el(tag, estilo, ...filhos) {
    const e = document.createElement(tag);
    if (estilo) e.style.cssText = estilo;
    filhos.flat().forEach((f) => {
      if (f == null || f === false || f === '') return;
      e.appendChild(typeof f === 'string' ? document.createTextNode(f) : f);
    });
    return e;
  }

  /** Abre (ou devolve) o espaço do painel: o WhatsApp inteiro (#app) fica mais estreito, como fazia o do RD. */
  function encaixar(sim) {
    if (PAGINA) return;
    let st = document.getElementById(CSS_ID);
    if (!sim) {
      if (st) st.remove();
      return;
    }
    if (!st) {
      st = document.createElement('style');
      st.id = CSS_ID;
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = `#app{position:fixed!important;top:0!important;left:0!important;bottom:0!important;right:${LARGURA}px!important;width:auto!important;height:auto!important}`;
  }

  function guardarAberto() {
    try {
      chrome.storage.local.set({ painelLateralAberto: estado.aberto });
    } catch (_) {
      /* ok */
    }
  }

  const reais = (v) => (Number(v) > 0 ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : '');
  const linkSeguro = (u) => (/^https:\/\/(crm\.rdstation\.com|crm\.pronixhub\.com\.br)\//.test(String(u || '')) ? String(u) : '');

  function titulo(texto) {
    return el('div', `font-size:10.5px;color:#a39e93;font-weight:600;letter-spacing:.12em;text-transform:uppercase;font-family:${FONTE_TITULO};margin:16px 0 8px`, texto);
  }

  function situacao(c) {
    if (c.ganha) return el('span', 'font-size:10.5px;font-weight:700;color:#0d2a17;background:#3ddc84;border-radius:999px;padding:2px 8px', 'Ganha');
    if (c.perdida) return el('span', 'font-size:10.5px;font-weight:700;color:#2a0d09;background:#ff6f5c;border-radius:999px;padding:2px 8px', 'Perdida');
    return el('span', 'font-size:10.5px;font-weight:700;color:#0d1730;background:#8aa9ff;border-radius:999px;padding:2px 8px', 'Em andamento');
  }

  /** Uma negociação: o card inteiro é o link para ela no CRM. */
  function itemNegociacao(c, crmNome) {
    const url = linkSeguro(c.url);
    const corpo = [
      el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px',
        el('div', 'font-weight:700;color:#f3efe6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0', c.nome || 'Negociação'),
        situacao(c)),
      el('div', 'color:#f3efe6;margin-top:4px', [c.funil, c.etapa].filter(Boolean).join(' › ')),
      el('div', 'color:#a39e93;font-size:11.5px;margin-top:3px', [c.responsavel, reais(c.valor), c.criadaEm && 'criada ' + String(c.criadaEm).slice(0, 10)].filter(Boolean).join(' · ')),
      c.perdida && c.motivoPerda ? el('div', 'color:#ff9d8f;font-size:11.5px;margin-top:3px', 'Motivo: ' + c.motivoPerda) : null,
      url ? el('div', `color:${OURO};font-weight:600;font-size:12px;margin-top:6px`, `Abrir no ${crmNome} ↗`) : null,
    ];
    const estilo = `display:block;text-decoration:none;margin:0 0 8px;padding:10px 11px;border-radius:10px;background:#211f24;border:1px solid ${c.escolhida ? OURO : '#3a373f'};cursor:${url ? 'pointer' : 'default'}`;
    const item = url ? el('a', estilo, corpo) : el('div', estilo, corpo);
    if (url) {
      item.href = url;
      item.target = '_blank';
      item.rel = 'noopener noreferrer';
      item.title = `Abrir esta negociação no ${crmNome}`;
    }
    item.setAttribute('data-pnx-deal', String(c.id || ''));
    return item;
  }


  // ---------------------------------------------------------------- botões que escrevem no CRM
  // Só para quem o master liberou (o mesmo acesso do Desqualificar). Nada é feito sem confirmar aqui.
  const dataDe = (s) => {
    const t = String(s || '');
    const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return (m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}`) : Date.parse(t)) || 0;
  };
  /** Com mais de um card em aberto, o que fica é o mais novo (empate: o escolhido); os outros são os duplicados. */
  function cardQueFica(negs) {
    const abertas = negs.filter((c) => c.aberta);
    if (!abertas.length) return null;
    return abertas.slice().sort((a, b) => dataDe(b.criadaEm) - dataDe(a.criadaEm) || (b.escolhida ? 1 : 0) - (a.escolhida ? 1 : 0))[0];
  }
  function botaoAcao(texto, cor, aoClicar) {
    const b = el('button', `cursor:pointer;border:1px solid ${cor};border-radius:7px;padding:6px 9px;background:transparent;color:${cor};font-weight:700;font-size:11.5px;font-family:inherit`, texto);
    b.type = 'button';
    b.addEventListener('click', aoClicar);
    return b;
  }
  function chamarServidor(caminho, corpo) {
    return Promise.resolve()
      .then(() => estado.acoes.servidor(caminho, corpo))
      .catch((e) => ({ ok: false, erro: String((e && e.message) || e) }));
  }
  function mudarForm(f) {
    estado.form = f;
    desenhar();
  }
  const aindaAberto = (dealId) => estado.form && estado.form.dealId === dealId;

  /** alvo: 'realizada' (reunião realizada) ou 'qualificado' (qualificou e confirmou a reunião, que ainda não aconteceu). */
  async function abrirPlano(c, d, alvo = 'realizada') {
    mudarForm({ dealId: c.id, tipo: alvo, fase: 'carregando' });
    const r = await chamarServidor('/api/crm/realizada/plano', { busca: d.busca || {}, dealId: c.id, closerNome: (d.reuniao && d.reuniao.closer) || '', alvo });
    if (!aindaAberto(c.id) || estado.form.tipo !== alvo) return;
    if (!r || !r.ok) return mudarForm({ dealId: c.id, tipo: alvo, fase: 'erro', erro: (r && r.erro) || 'Não consegui montar o caminho no CRM.' });
    const doReport = r.handoff && r.handoff.doReport;
    mudarForm({ dealId: c.id, tipo: alvo, fase: 'plano', plano: r, closerId: r.closerSugerido || '', texto: (doReport && doReport.texto) || '', complemento: '' });
  }

  async function confirmarRealizada(form, c, d) {
    if (form.fase === 'enviando') return;
    mudarForm({ ...form, fase: 'enviando', erro: '' });
    const r = await chamarServidor('/api/crm/realizada', {
      busca: d.busca || {}, dealId: c.id, assinatura: form.plano.assinatura, closerId: form.closerId, handoff: form.texto || '', complemento: form.complemento || '', closerNome: (d.reuniao && d.reuniao.closer) || '', alvo: form.tipo,
    });
    if (!aindaAberto(c.id)) return;
    if (!r || !r.ok) return mudarForm({ ...form, fase: 'plano', erro: (r && r.erro) || 'O CRM não aceitou.' });
    mudarForm({ dealId: c.id, tipo: form.tipo, fase: 'feito', texto: 'Pronto no CRM: ' + (r.feitos || []).join(' › ') });
    if (estado.acoes.consultar) estado.acoes.consultar(d.busca || {});
  }

  async function confirmarDuplicado(form, c, d, fica) {
    if (form.fase === 'enviando') return;
    mudarForm({ ...form, fase: 'enviando', erro: '' });
    const r = await chamarServidor('/api/crm/duplicado', { busca: d.busca || {}, dealId: c.id, manterId: fica.id });
    if (!aindaAberto(c.id)) return;
    if (!r || !r.ok) return mudarForm({ ...form, fase: 'confirmar', erro: (r && r.erro) || 'O CRM não aceitou.' });
    mudarForm({ dealId: c.id, tipo: 'dup', fase: 'feito', texto: `Perdido como duplicado (motivo: ${r.motivo || 'duplicidade'}).` });
    if (estado.acoes.consultar) estado.acoes.consultar(d.busca || {});
  }

  function caixaDoForm(form, c, d, fica) {
    const box = el('div', 'flex-basis:100%;padding:9px 10px;border-radius:9px;background:#121113;border:1px solid #3a373f;font-size:12px');
    box.setAttribute('data-pnx-form', form.tipo);
    const cancelar = () => botaoAcao('Cancelar', '#a39e93', () => mudarForm(null));
    if (form.fase === 'feito') {
      box.appendChild(el('div', 'color:#3ddc84;font-weight:600', form.texto));
      return box;
    }
    if (form.tipo === 'dup') {
      box.appendChild(el('div', '', `Dar perda neste card como duplicado? O lead continua em "${fica.nome || 'outro card'}" (${[fica.funil, fica.etapa].filter(Boolean).join(' › ')}).`));
      if (form.erro) box.appendChild(el('div', 'color:#ff6f5c;margin-top:6px', form.erro));
      const ok = botaoAcao(form.fase === 'enviando' ? 'Marcando…' : 'Confirmar perda', '#ff6f5c', () => confirmarDuplicado(form, c, d, fica));
      ok.setAttribute('data-pnx-confirmar', 'dup');
      box.appendChild(el('div', 'display:flex;gap:6px;margin-top:8px', ok, cancelar()));
      return box;
    }
    if (form.fase === 'carregando') {
      box.appendChild(el('div', 'color:#a39e93', 'Montando o caminho no CRM…'));
      return box;
    }
    if (form.fase === 'erro') {
      box.appendChild(el('div', 'color:#ff6f5c', form.erro));
      box.appendChild(el('div', 'margin-top:8px', cancelar()));
      return box;
    }
    const p = form.plano;
    const comCloser = form.tipo === 'realizada' || p.precisaCloser;
    box.appendChild(el('div', 'font-weight:700;color:#f3efe6;margin-bottom:6px', (form.tipo === 'qualificado' ? 'Qualificado' : 'Reunião realizada') + ' — o card vai passar por:'));
    const lista = el('ol', 'margin:0 0 8px;padding-left:18px');
    (p.passos || []).forEach((s) => {
      const extra = [s.exigeCloser ? 'define o closer' : '', s.amostras ? `${s.vistos} de ${s.amostras} cards passaram aqui` : ''].filter(Boolean).join(' · ');
      lista.appendChild(el('li', 'margin-bottom:3px',
        el('span', 'color:#f3efe6', (s.tipo === 'funil' ? `Funil ${s.funilNome} › ` : '') + s.etapaNome),
        extra ? el('span', 'color:#a39e93', ' (' + extra + ')') : null));
    });
    box.appendChild(lista);

    if (comCloser) {
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;background:#211f24;color:#f3efe6;border:1px solid #3a373f;border-radius:7px;padding:6px;font-size:12px;font-family:inherit';
    sel.setAttribute('data-pnx-closer', '1');
    [{ id: '', nome: 'Escolha o closer…' }].concat(p.closers || []).forEach((x) => {
      const o = document.createElement('option');
      o.value = x.id;
      o.textContent = x.nome;
      if (x.id === form.closerId) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { form.closerId = sel.value; desenhar(); });
    box.appendChild(el('div', 'color:#a39e93;margin:4px 0 3px', 'Closer'));
    box.appendChild(sel);

    const h = p.handoff || {};
    const campo = (rotulo, valor, dica, aoMudar, attr, altura) => {
      box.appendChild(el('div', 'color:#a39e93;margin:8px 0 3px', rotulo));
      const ta = document.createElement('textarea');
      ta.style.cssText = `width:100%;box-sizing:border-box;min-height:${altura}px;background:#211f24;color:#f3efe6;border:1px solid #3a373f;border-radius:7px;padding:6px;font:12px/1.4 inherit;resize:vertical`;
      ta.value = valor || '';
      ta.placeholder = dica;
      ta.setAttribute(attr, '1');
      ta.addEventListener('input', () => aoMudar(ta.value));
      ta.addEventListener('keydown', (ev) => ev.stopPropagation());
      box.appendChild(ta);
    };
    if (h.noCrm) {
      box.appendChild(el('div', 'color:#3ddc84;margin-top:8px', 'Handoff: já está no card ✓'));
    } else {
      const deOnde = h.doReport ? `Handoff — o report de ${h.doReport.quando || 'hoje'}${h.doReport.sdr ? ' (' + h.doReport.sdr + ')' : ''} (pode editar)` : 'Handoff para o closer (sem report deste lead: escreva aqui)';
      campo(deOnde, form.texto, 'O que o closer precisa saber do lead.', (v) => { form.texto = v; }, 'data-pnx-handoff', h.doReport ? 140 : 80);
    }
    campo(h.noCrm ? 'Informações da ligação (vão como anotação no card)' : 'Informações da ligação (complementam o handoff)', form.complemento,
      'Começou no WhatsApp e seguiu na ligação? O que o lead contou na ligação.', (v) => { form.complemento = v; }, 'data-pnx-complemento', 60);
    }
    if ((p.faltando || []).length) box.appendChild(el('div', 'color:#ff6f5c;margin-top:8px', 'O token do CRM não tem permissão para: ' + p.faltando.join(' e ') + '. Peça ao administrador do CRM.'));
    if (form.erro) box.appendChild(el('div', 'color:#ff6f5c;margin-top:8px', form.erro));
    const pode = !(p.faltando || []).length && (!comCloser || Boolean(form.closerId)) && form.fase !== 'enviando';
    const ok = botaoAcao(form.fase === 'enviando' ? 'Movendo no CRM…' : 'Confirmar e mover', pode ? OURO : '#5b5760', () => { if (pode) confirmarRealizada(form, c, d); });
    ok.setAttribute('data-pnx-confirmar', form.tipo);
    if (!pode) ok.title = form.closerId ? '' : 'Escolha o closer';
    box.appendChild(el('div', 'display:flex;gap:6px;margin-top:10px', ok, cancelar()));
    return box;
  }

  function acoesDoCard(c, d, fica) {
    if (!d.podeEscrever || !estado.acoes.servidor) return null;
    const form = estado.form && estado.form.dealId === c.id ? estado.form : null;
    const caixa = el('div', 'margin:-2px 0 10px;display:flex;flex-wrap:wrap;gap:6px');
    if (form && (form.fase === 'feito' || (c.aberta && fica))) {
      caixa.appendChild(caixaDoForm(form, c, d, fica));
      return caixa;
    }
    if (!c.aberta || !fica) return null;
    const abertas = (d.ficha.negociacoes || []).filter((x) => x.aberta);
    if (abertas.length >= 2 && c.id !== fica.id) {
      const b = botaoAcao('Perder como duplicado', '#ff6f5c', () => mudarForm({ dealId: c.id, tipo: 'dup', fase: 'confirmar' }));
      b.setAttribute('data-pnx-duplicado', c.id);
      caixa.appendChild(b);
    }
    if (c.id === fica.id) {
      // Qualificado: o lead qualificou e confirmou a reunião — vai para a etapa de qualificado do funil (ou a de agendada).
      const q = botaoAcao('Qualificado ✓', '#3ddc84', () => abrirPlano(c, d, 'qualificado'));
      q.setAttribute('data-pnx-qualificado', c.id);
      caixa.appendChild(q);
      const b = botaoAcao('Reunião realizada →', OURO, () => abrirPlano(c, d, 'realizada'));
      b.setAttribute('data-pnx-realizada', c.id);
      caixa.appendChild(b);
    }
    return caixa.childNodes.length ? caixa : null;
  }

  /** O link do card à vista, com "Copiar link" (para colar no Pronix Calendar ao criar a reunião). */
  function linhaDoLink(url) {
    const campo = el('input', 'flex:1;min-width:0;background:#121113;border:1px solid #3a373f;border-radius:7px;color:#f3efe6;padding:7px 9px;font-size:11.5px;font-family:inherit');
    campo.readOnly = true;
    campo.value = url;
    campo.setAttribute('data-pnx-link', '1');
    campo.addEventListener('focus', () => campo.select());
    const botao = el('button', `cursor:pointer;border:1px solid ${OURO};border-radius:7px;padding:7px 10px;background:transparent;color:${OURO};font-weight:700;font-size:11.5px;font-family:inherit;white-space:nowrap`, 'Copiar link');
    botao.type = 'button';
    botao.setAttribute('data-pnx-copiar', '1');
    const avisar = (texto) => {
      botao.textContent = texto;
      setTimeout(() => { botao.textContent = 'Copiar link'; }, 1800);
    };
    const copiarNaMao = () => {
      campo.focus();
      campo.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {
        ok = false;
      }
      avisar(ok ? 'Copiado ✓' : 'Ctrl+C');
    };
    botao.addEventListener('click', () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(() => avisar('Copiado ✓'), copiarNaMao);
          return;
        }
      } catch (_) {
        /* cai no jeito antigo */
      }
      copiarNaMao();
    });
    return el('div', 'display:flex;gap:6px;margin-top:8px', campo, botao);
  }

  function corpoDoLead(d) {
    const f = d.ficha;
    const crmNome = f.crmNome || 'CRM';
    const partes = [];
    partes.push(el('div', 'font-size:17px;font-weight:700;color:#f3efe6;margin-top:2px;word-break:break-word', f.nome || 'Lead'));
    const contatos = [].concat(f.telefones || [], f.emails || []).filter(Boolean);
    if (contatos.length) partes.push(el('div', 'color:#a39e93;font-size:12px;margin-top:3px;word-break:break-word', contatos.join(' · ')));

    const escolhida = (f.negociacoes || []).find((c) => c.escolhida);
    const urlPrincipal = linkSeguro((escolhida && escolhida.url) || (f.negociacao && f.negociacao.url));
    if (urlPrincipal) {
      const b = el('a', `display:block;text-align:center;margin-top:12px;padding:9px 10px;border-radius:9px;background:${OURO};color:#18171b;font-weight:700;text-decoration:none`, `Abrir o card no ${crmNome} ↗`);
      b.href = urlPrincipal;
      b.target = '_blank';
      b.rel = 'noopener noreferrer';
      b.setAttribute('data-pnx-abrir', '1');
      partes.push(b);
      partes.push(linhaDoLink(urlPrincipal));
    }

    if (d.reuniao && d.reuniao.quando) {
      partes.push(titulo('Reunião'));
      partes.push(el('div', 'padding:9px 11px;border-radius:10px;background:#211f24;border:1px solid #3a373f',
        el('div', 'font-weight:700;color:#f3efe6', 'Agendada: ' + String(d.reuniao.quando).replace('T', ' às ')),
        d.reuniao.closer ? el('div', 'color:#a39e93;font-size:12px;margin-top:2px', 'Com ' + d.reuniao.closer) : null));
    }

    const negs = f.negociacoes || [];
    partes.push(titulo(`Negociações (${negs.length})`));
    if (!negs.length) partes.push(el('div', 'color:#a39e93', 'Este contato não tem negociação no CRM.'));
    const fica = cardQueFica(negs);
    negs.forEach((c) => {
      partes.push(itemNegociacao(c, crmNome));
      const acoes = acoesDoCard(c, d, fica);
      if (acoes) partes.push(acoes);
    });

    const respostas = [].concat((f.formulario && f.formulario.campos) || [], f.campos || []).filter((c) => c && c.rotulo && c.valor);
    if (respostas.length) {
      partes.push(titulo('O que respondeu'));
      partes.push(el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:6px',
        respostas.map((c) => el('div', 'padding:7px 9px;border-radius:8px;background:#211f24;border:1px solid #3a373f;min-width:0',
          el('div', 'font-size:10.5px;color:#a39e93;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', c.rotulo),
          el('div', 'font-weight:600;color:#f3efe6;word-break:break-word;font-size:12px', c.valor)))));
    }

    if ((f.anotacoes || []).length) {
      partes.push(titulo('Últimas anotações'));
      f.anotacoes.forEach((a) => partes.push(el('div', 'margin-bottom:8px',
        el('div', 'font-size:11px;color:#a39e93', [a.autor, a.quando].filter(Boolean).join(' · ')),
        el('div', 'white-space:pre-wrap;word-break:break-word;color:#f3efe6;font-size:12px', a.texto))));
    }
    return partes;
  }

  function corpoDoEstado(d) {
    if (!d || d.tipo === 'sem-conversa') return [el('div', 'color:#a39e93;margin-top:12px', 'Abra uma conversa para ver o lead no CRM.')];
    if (d.tipo === 'carregando') return [el('div', 'color:#a39e93;margin-top:12px', 'Buscando no CRM…')];
    if (d.tipo === 'erro') {
      const b = el('button', `margin-top:10px;cursor:pointer;border:0;border-radius:7px;padding:7px 10px;background:#3a373f;color:#f3efe6;font-weight:600;font-family:inherit`, 'Tentar de novo');
      b.type = 'button';
      b.addEventListener('click', () => estado.acoes.consultar && estado.acoes.consultar(d.busca));
      return [el('div', 'color:#ff6f5c;margin-top:12px', d.erro || 'Não consegui consultar o CRM.'), b];
    }
    if (d.tipo === 'candidatos') {
      return [el('div', 'color:#a39e93;margin:12px 0 8px', 'Mais de um contato com esse nome. Qual é?')].concat(
        (d.candidatos || []).map((c) => {
          const b = el('button', 'display:block;width:100%;text-align:left;margin:0 0 6px;cursor:pointer;border:1px solid #3a373f;border-radius:8px;padding:8px 10px;background:#211f24;color:#f3efe6;font-family:inherit', [c.nome, c.telefone].filter(Boolean).join(' · '));
          b.type = 'button';
          b.addEventListener('click', () => estado.acoes.consultar && estado.acoes.consultar({ contatoId: c.id }));
          return b;
        })
      );
    }
    if (d.tipo === 'ok' && d.ficha) return corpoDoLead(d);
    // não encontrado: busca pelo telefone ou nome
    const input = el('input', 'flex:1;min-width:0;background:#121113;border:1px solid #3a373f;border-radius:7px;color:#f3efe6;padding:7px 9px;font-size:12px;font-family:inherit');
    input.placeholder = 'Telefone ou nome no CRM';
    const buscar = () => {
      const v = input.value.trim();
      if (!v || !estado.acoes.consultar) return;
      const dig = v.replace(/\D/g, '');
      estado.acoes.consultar(dig.length >= 8 && !/[a-zA-ZÀ-ÿ]/.test(v) ? { telefone: dig } : { nome: v });
    };
    input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') buscar(); });
    const b = el('button', `cursor:pointer;border:0;border-radius:7px;padding:7px 10px;background:${OURO};color:#18171b;font-weight:700;font-family:inherit`, 'Buscar');
    b.type = 'button';
    b.addEventListener('click', buscar);
    return [el('div', 'color:#a39e93;margin:12px 0 8px', 'Não achei este lead no CRM. Busque pelo telefone ou nome:'), el('div', 'display:flex;gap:6px', input, b)];
  }

  function desenhar() {
    const d = estado.ultimo;
    let painel = document.getElementById(ID);
    let aba = document.getElementById(ABA_ID);
    if (!estado.aberto && !PAGINA) {
      if (painel) painel.remove();
      encaixar(false);
      if (!aba) {
        aba = el('button', `position:fixed;right:0;top:120px;z-index:2147483645;cursor:pointer;border:1px solid #3a373f;border-right:0;border-radius:10px 0 0 10px;background:#1a191c;color:${OURO};padding:12px 6px;font:700 11px ${FONTE_TITULO};letter-spacing:.12em;writing-mode:vertical-rl;box-shadow:0 8px 24px rgba(0,0,0,.4)`, 'PRONIX CRM');
        aba.id = ABA_ID;
        aba.type = 'button';
        aba.title = 'Abrir o painel do CRM';
        aba.addEventListener('click', () => { estado.aberto = true; guardarAberto(); desenhar(); });
        document.body.appendChild(aba);
      }
      return;
    }
    if (aba) aba.remove();
    encaixar(true);
    if (!painel) {
      painel = el('aside', [
        ...(PAGINA ? ['min-height:100vh'] : ['position:fixed', 'top:0', 'right:0', 'bottom:0', `width:${LARGURA}px`, 'z-index:2147483645']),
        'box-sizing:border-box',
        'background:#1a191c', 'color:#f3efe6', 'border-left:1px solid #3a373f', 'overflow:auto', 'padding:14px 14px 24px',
        'font:13px/1.45 Segoe UI Variable Text,Segoe UI,system-ui,-apple-system,Roboto,sans-serif',
      ].join(';'));
      painel.id = ID;
      painel.setAttribute('aria-label', 'Painel do CRM');
      document.body.appendChild(painel);
    }
    const rolagem = painel.scrollTop;
    painel.textContent = '';
    const recolher = el('button', 'cursor:pointer;border:0;border-radius:7px;padding:4px 9px;background:#3a373f;color:#f3efe6;font-weight:700;font-family:inherit', '»');
    recolher.type = 'button';
    recolher.title = 'Recolher o painel (o WhatsApp volta à largura toda)';
    recolher.addEventListener('click', () => { estado.aberto = false; guardarAberto(); desenhar(); });
    const crmNome = (d && d.ficha && d.ficha.crmNome) || 'CRM';
    painel.appendChild(el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:3px solid ' + OURO + ';padding-bottom:9px',
      el('div', `font:700 12px ${FONTE_TITULO};letter-spacing:.14em;color:${OURO}`, crmNome.toUpperCase()), PAGINA ? null : recolher));
    corpoDoEstado(d).forEach((p) => painel.appendChild(p));
    painel.scrollTop = rolagem;
  }

  /** O content.js chama a cada mudança do cartão do lead (mesmo estado: carregando, ok, erro, não achado...). */
  function atualizar(dados, acoes) {
    if (acoes) estado.acoes = acoes;
    // Outro lead na tela: o que estava aberto (confirmação, plano) era do anterior.
    const b = (dados && dados.busca) || {};
    const chave = dados ? JSON.stringify([b.telefone || '', b.nome || '', b.contatoId || '']) : '';
    if (chave !== estado.chaveLead) {
      estado.form = null;
      estado.chaveLead = chave;
    }
    // O cartão se redesenha a cada resumo com o MESMO estado: aí o painel fica como está (e na mesma rolagem).
    if (dados && dados === estado.ultimo && (document.getElementById(ID) || document.getElementById(ABA_ID))) return;
    estado.ultimo = dados || null;
    desenhar();
  }

  /** Sem CRM para este usuário (ou extensão desligada): o painel some e o WhatsApp volta à largura toda. */
  function remover() {
    estado.ultimo = null;
    const p = document.getElementById(ID);
    if (p) p.remove();
    const a = document.getElementById(ABA_ID);
    if (a) a.remove();
    encaixar(false);
  }

  raiz.__pnxPainel = { atualizar, remover, LARGURA, ID, ABA_ID, PAGINA };
})(typeof globalThis !== 'undefined' ? globalThis : window);
