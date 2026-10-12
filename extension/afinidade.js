// "Analisar Match com o closer" — o bloco que entra no aviso "Report pronto!" quando o report foi
// pedido por esse botão do popup: pede a análise ao servidor e mostra a nota de 0 a 10, o veredito
// e o botão do segundo PDF. Carregado antes do content script do WhatsApp e do Instagram (o mesmo
// código para os dois); expõe globalThis.__crAfinidade.
(function () {
  'use strict';
  if (globalThis.__crAfinidade) return;

  const ID = 'cr-afinidade';
  const TITULO = 'font-family:Bahnschrift,DIN Alternate,Roboto Condensed,Arial Narrow,sans-serif';
  const COR = { alta: '#3ddc84', media: '#ffc233', baixa: '#ff6f5c' };
  const ROTULO = { alta: 'alto', media: 'médio', baixa: 'baixo' };
  // A conversa já foi inteira para o report; para a afinidade basta o trecho final (o servidor enxuga de novo).
  const MAX_MENSAGENS = 150;

  function elem(tag, estilo, texto) {
    const e = document.createElement(tag);
    if (estilo) e.style.cssText = estilo;
    if (texto != null) e.textContent = texto; // sempre texto: nada que vem do servidor vira HTML
    return e;
  }

  function pedir(pedido) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(pedido, (r) => resolve(chrome.runtime.lastError ? null : r));
      } catch (_) {
        resolve(null); // extensão recarregada no meio do caminho
      }
    });
  }

  function desenharResultado(caixa, closer, r) {
    const a = r.afinidade;
    const cor = COR[a.faixa] || COR.media;
    caixa.textContent = '';
    const topo = elem('div', 'display:flex;align-items:baseline;gap:6px;flex-wrap:wrap');
    topo.appendChild(elem('span', `font-size:26px;font-weight:700;line-height:1;color:${cor};${TITULO}`, String(a.nota)));
    topo.appendChild(elem('span', `font-size:12px;color:#a39e93;${TITULO}`, '/10'));
    topo.appendChild(elem('span', 'font-weight:700', 'Match com ' + (closer.apelido || a.apelido || a.closerNome)));
    topo.appendChild(elem('span', `font-size:10.5px;color:${cor};text-transform:uppercase;letter-spacing:.1em;${TITULO}`, ROTULO[a.faixa] || ''));
    caixa.appendChild(topo);
    if (a.veredito) caixa.appendChild(elem('div', 'margin-top:4px', a.veredito));
    // O porquê da nota, para ler ali mesmo (o PDF traz tudo).
    (a.motivos || []).slice(0, 3).forEach((m, i) => {
      caixa.appendChild(elem('div', 'margin-top:' + (i ? 2 : 6) + 'px;font-size:12px;padding-left:10px;text-indent:-10px', '• ' + m));
    });
    if (a.atencao && a.atencao[0]) caixa.appendChild(elem('div', 'margin-top:4px;font-size:12px;color:#a39e93', 'Atenção: ' + a.atencao[0]));
    const base = a.base || {};
    if (base.casos) {
      const calls = `${base.casos} calls dele analisadas, ${base.casosVendas || 0} vendas`;
      caixa.appendChild(elem('div', `margin-top:6px;font-size:10.5px;color:#a39e93;letter-spacing:.04em;${TITULO}`, 'Base: ' + calls + (base.reunioes ? ` · ${base.reunioes} reuniões com resultado` : '')));
    }
    if (r.arquivoBase64) {
      const link = elem('a', 'display:inline-block;margin-top:8px;background:#ffc233;color:#18171b;font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px', 'Baixar análise (PDF)');
      link.href = 'data:application/pdf;base64,' + r.arquivoBase64;
      link.download = r.arquivo || 'match.pdf';
      caixa.appendChild(link);
    }
  }

  /**
   * @param {{aviso: Element, closer: {id: string, apelido?: string, nome?: string}, resp?: {id?: string, dados?: object},
   *   mensagens?: object[], nome?: string}} o
   */
  function anexar(o) {
    const aviso = o && o.aviso;
    const closer = o && o.closer;
    if (!aviso || !closer || !closer.id) return null;
    const antigo = aviso.querySelector('#' + ID);
    if (antigo) antigo.remove();
    const alvo = aviso.querySelector('div[style*="flex:1"]') || aviso;
    const caixa = elem('div', 'margin-top:10px;padding-top:8px;border-top:1px solid #3a373f');
    caixa.id = ID;
    alvo.appendChild(caixa);
    const apelido = closer.apelido || closer.nome || 'closer';

    const rodar = async () => {
      caixa.textContent = '';
      caixa.appendChild(elem('div', 'color:#a39e93', `Analisando o match com ${apelido}…`));
      const r = await pedir({
        action: 'afinidade',
        closerId: closer.id,
        reportId: (o.resp && o.resp.id) || '',
        dados: (o.resp && o.resp.dados) || null,
        mensagens: (o.mensagens || []).slice(-MAX_MENSAGENS),
        nome: o.nome || '',
      });
      if (r && r.ok && r.afinidade) return desenharResultado(caixa, closer, r);
      caixa.textContent = '';
      caixa.appendChild(elem('div', 'color:#ff6f5c', (r && r.erro) || `Não consegui analisar o match com ${apelido}.`));
      const de_novo = elem('button', 'cursor:pointer;border:0;border-radius:6px;margin-top:6px;padding:5px 9px;font-weight:600;font-size:12px;background:#3a373f;color:#f3efe6;font-family:inherit', 'Tentar de novo');
      de_novo.type = 'button';
      de_novo.addEventListener('click', rodar);
      caixa.appendChild(de_novo);
    };
    rodar();
    return caixa;
  }

  globalThis.__crAfinidade = { anexar, ID };
})();
