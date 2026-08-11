// Content script — lê a conversa aberta no Instagram Direct.
// Roda no contexto da página www.instagram.com/direct/*.
//
// FASE 1 (texto só): sem captura de áudio ainda — mensagens de voz do Direct
// não são lidas nesta versão (decisão explícita, ver conversa que mapeou o
// DOM). O sinal de quem enviou cada mensagem foi descoberto testando ao vivo
// numa conversa real (ver git log) — pode precisar de ajuste se o Instagram
// mudar a estrutura (o CSS deles é atômico/hasheado e muda com frequência,
// mesmo risco já documentado no README para o WhatsApp).

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const logI = (...a) => console.log('[CR-instagram]', ...a);

  // Texto de mensagem: candidato bruto. Também casa com nome do contato no
  // cabeçalho e outros textos da tela — por isso NUNCA usamos isto direto no
  // document inteiro; sempre escopado pelo root encontrado em acharRoot().
  const SELETOR_TEXTO = 'div[dir="auto"].html-div';

  /** Sobe os pais até achar o elemento que realmente rola (mesmo truque do content.js do WhatsApp). */
  function acharScroller(el) {
    let n = el ? el.parentElement : null;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 20) {
        return n;
      }
      n = n.parentElement;
    }
    return null;
  }

  /**
   * Acha o container real da conversa: pega todos os candidatos a mensagem na
   * página inteira, agrupa por qual scroller cada um pertence, e usa o
   * scroller com MAIS candidatos — a lista de conversas (sidebar) e o nome no
   * cabeçalho não ficam dentro do mesmo scroller que o corpo da conversa,
   * então essa contagem naturalmente filtra eles fora sem precisar de um
   * seletor fixo (que o Instagram trocaria a qualquer atualização).
   */
  function acharRoot() {
    const candidatos = [...document.querySelectorAll(SELETOR_TEXTO)];
    const contagem = new Map(); // scroller -> quantidade
    candidatos.forEach((el) => {
      const s = acharScroller(el);
      if (s) contagem.set(s, (contagem.get(s) || 0) + 1);
    });
    let melhor = null;
    let max = 0;
    for (const [scroller, n] of contagem) {
      if (n > max) {
        max = n;
        melhor = scroller;
      }
    }
    return melhor; // null se não achou nenhuma mensagem ainda (conversa vazia ou não carregou)
  }

  /**
   * Quem enviou: sobe os pais a partir do texto e procura o ancestral com
   * flex-direction: row-reverse — é assim que o Instagram empurra a bolha
   * pra direita nas mensagens ENVIADAS por quem está logado. Confirmado
   * comparando mensagens reais enviadas vs. recebidas na mesma conversa.
   * Fallback: se não achar o CSS (Instagram pode trocar a técnica), compara
   * a posição horizontal do texto com o meio do container.
   */
  function ehDeMim(el, root) {
    let n = el;
    for (let i = 0; i < 12 && n && n !== root; i++) {
      const dir = getComputedStyle(n).flexDirection;
      if (dir === 'row-reverse') return true;
      if (dir === 'row' && n !== el) {
        // "row" normal no mesmo nível estrutural onde o enviado tem "row-reverse"
        // é um sinal de recebida — mas só decide se ainda não achamos nada melhor.
      }
      n = n.parentElement;
    }
    // Fallback por posição: enviada fica na metade direita do container.
    if (root) {
      const rEl = el.getBoundingClientRect();
      const rRoot = root.getBoundingClientRect();
      const meio = rRoot.left + rRoot.width / 2;
      return rEl.left > meio;
    }
    return false;
  }

  function extrairMensagem(el, root) {
    const texto = (el.textContent || '').trim();
    if (!texto) return null;
    return { from: ehDeMim(el, root) ? 'eu' : 'eles', type: 'texto', content: texto, timestamp: null };
  }

  // O cabeçalho mostra o nome do contato, às vezes junto com status
  // ("Ativo(a) agora", "Ativo(a) há 5 min") — filtra pra não virar o nome.
  const STATUS_CONTATO_IG =
    /^(ativo|online|digitando|visto por [úu]ltimo|[úu]ltima vez|active|typing|last (active|seen))/i;

  function nomeDoContato() {
    const header = document.querySelector('header') || document.body;
    const candidatos = [];
    header.querySelectorAll('span, h1, h2, a').forEach((s) => {
      const t = (s.textContent || '').trim();
      if (t) candidatos.push(t);
    });
    for (const c of candidatos) {
      if (!c || c.length > 60 || STATUS_CONTATO_IG.test(c)) continue;
      return c;
    }
    return '';
  }

  /**
   * Rola até o topo pra carregar o histórico (mesma lógica de espera do
   * WhatsApp: repete até a altura da lista parar de crescer).
   */
  async function carregarHistorico(scroller) {
    let alturaAnterior = -1;
    let estavel = 0;
    for (let i = 0; i < 150 && estavel < 3; i++) {
      scroller.scrollTop = 0;
      await sleep(450);
      const h = scroller.scrollHeight;
      if (h === alturaAnterior) estavel++;
      else {
        estavel = 0;
        alturaAnterior = h;
      }
    }
  }

  /**
   * Lê a conversa. Simplificação da Fase 1: uma leitura só depois de rolar
   * até o topo (sem o esquema de múltiplas passadas com Map por id que o
   * WhatsApp usa, porque o Instagram não expõe nenhum id estável na mensagem
   * — se isso perder mensagens em conversas muito longas por causa de
   * virtualização, é o próximo ajuste a fazer, testando ao vivo).
   */
  async function coletarConversa() {
    let root = acharRoot();
    if (!root) {
      // Conversa pode não ter renderizado nada ainda — dá uma chance.
      await sleep(800);
      root = acharRoot();
    }
    if (!root) {
      throw new Error('Não achei a conversa na tela. Abra uma conversa no Instagram Direct e tente de novo.');
    }

    await carregarHistorico(root);
    await sleep(300);

    const vistos = new Set(); // evita duplicar o mesmo texto+remetente lado a lado (re-render)
    const mensagens = [];
    [...root.querySelectorAll(SELETOR_TEXTO)].forEach((el) => {
      const reg = extrairMensagem(el, root);
      if (!reg) return;
      const chave = reg.from + '|' + reg.content;
      const anterior = mensagens[mensagens.length - 1];
      if (anterior && anterior.from === reg.from && anterior.content === reg.content) return; // duplicata consecutiva
      mensagens.push(reg);
      vistos.add(chave);
    });

    if (mensagens.length === 0) {
      throw new Error('Nenhuma mensagem lida. Role a conversa manualmente uma vez e tente de novo.');
    }

    logI(`${mensagens.length} mensagens lidas (Instagram Direct, texto só).`);
    return { mensagens, nome: nomeDoContato() };
  }

  // ---------------------------------------------------------------------------
  // Aviso fixo na tela (mesmo componente visual usado no WhatsApp)
  // ---------------------------------------------------------------------------
  const BADGE_ID = 'closer-report-badge';

  function badgeEl() {
    let el = document.getElementById(BADGE_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = BADGE_ID;
      el.style.cssText = [
        'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
        'max-width:320px', 'background:#16212e', 'color:#e6edf3',
        'border:1px solid #26333f', 'border-left:4px solid #ffc400',
        'border-radius:10px', 'padding:12px 14px', 'font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.4)', 'display:flex', 'gap:10px', 'align-items:flex-start',
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function mostrarBadge({ texto, cor = '#ffc400', loading = false, arquivo = null, arquivoBase64 = null }) {
    const el = badgeEl();
    el.style.borderLeftColor = cor;
    const spinner = loading
      ? '<span style="flex:none;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;display:inline-block;animation:crspin .8s linear infinite"></span>'
      : '<span style="flex:none;display:flex">' + "<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" style=\"vertical-align:-2px;flex:none\" fill=\"none\" stroke=\"#ffc400\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/></svg>" + '</span>';
    let acao = '';
    if (arquivoBase64) {
      const url = 'data:application/pdf;base64,' + arquivoBase64;
      acao =
        `<a href="${url}" download="${arquivo || 'report.pdf'}" style="display:inline-block;margin-top:8px;background:#ffc400;color:#121214;` +
        `font-weight:700;text-decoration:none;padding:6px 10px;border-radius:7px"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#121214" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg> Baixar PDF</a>`;
    }
    el.innerHTML =
      (document.getElementById('crspin-style') ? '' : '<style id="crspin-style">@keyframes crspin{to{transform:rotate(360deg)}}</style>') +
      spinner +
      `<div style="flex:1"><div>${texto}</div>${acao}</div>` +
      `<span id="cr-x" style="flex:none;cursor:pointer;color:#8b98a5;font-size:15px;line-height:1">×</span>`;
    const x = el.querySelector('#cr-x');
    if (x) x.onclick = () => el.remove();
  }

  // ---------------------------------------------------------------------------
  // Orquestração (mesmo contrato de mensagens do content.js do WhatsApp — o
  // popup e o background.js não precisam saber qual plataforma está aberta)
  // ---------------------------------------------------------------------------
  let jobEmAndamento = false;

  async function gerarReportEmBackground(server) {
    if (jobEmAndamento) {
      mostrarBadge({ texto: 'Já existe um report sendo gerado…', cor: '#f0ad4e', loading: true });
      return;
    }
    jobEmAndamento = true;
    try {
      mostrarBadge({ texto: '<b>Lendo a conversa…</b><br><u>Não troque de conversa agora</u>.', loading: true });
      const { mensagens, nome } = await coletarConversa();

      mostrarBadge({
        texto: `<b>Gerando report…</b> (${mensagens.length} mensagens)<br>` +
          '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#25d366" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> Já pode responder outras conversas.',
        loading: true,
      });

      const resp = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome }, resolve)
      );

      if (!resp || !resp.ok) {
        mostrarBadge({ texto: '' + ((resp && resp.erro) || 'Falha ao gerar o report.'), cor: '#ff6b6b' });
        jobEmAndamento = false;
        return;
      }

      if (resp.duplicado) {
        const quando = new Date(resp.existente.quando).toLocaleString('pt-BR');
        const confirmar = confirm(
          `Já existe um report igual pra ${resp.existente.lead || 'este contato'}, gerado em ${quando}.\n\n` +
            'Gerar de novo chama a IA outra vez (custo extra). Gerar mesmo assim?'
        );
        if (!confirmar) {
          mostrarBadge({ texto: 'Geração cancelada — já existe um report igual.', cor: '#f0ad4e' });
          jobEmAndamento = false;
          return;
        }
        const resp2 = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ action: 'reportFetch', server, mensagens, nome, forcarNovo: true }, resolve)
        );
        if (!resp2 || !resp2.ok) {
          mostrarBadge({ texto: '' + ((resp2 && resp2.erro) || 'Falha ao gerar o report.'), cor: '#ff6b6b' });
          jobEmAndamento = false;
          return;
        }
        return finalizar(resp2, nome, server);
      }

      finalizar(resp, nome, server);
    } catch (e) {
      mostrarBadge({ texto: '' + e.message, cor: '#ff6b6b' });
    } finally {
      jobEmAndamento = false;
    }
  }

  function finalizar(resp, nome, server) {
    chrome.storage.local.set({
      ultimoReport: { arquivo: resp.arquivo, dados: resp.dados, arquivoBase64: resp.arquivoBase64, nome, server, quando: Date.now() },
    });
    mostrarBadge({
      texto: `<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;flex:none" fill="none" stroke="#25d366" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></svg> <b>Report pronto!</b> (${nome || 'contato'})`,
      arquivo: resp.arquivo,
      arquivoBase64: resp.arquivoBase64,
    });
    jobEmAndamento = false;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'start') {
      gerarReportEmBackground(msg.server);
      sendResponse({ ok: true, iniciado: true });
      return false;
    }
    if (msg && msg.action === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
  });
})();
