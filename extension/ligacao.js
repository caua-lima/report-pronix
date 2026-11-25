// Ligação no WhatsApp Web: o botão "Gravar ligação", a transcrição automática e a entrada da ligação no report.
//
// O inject.js (na página) acha a chamada, grava a voz do lead e a sua em partes de 3 minutos e manda cada parte
// para cá. Aqui cada parte vai para o servidor transcrever (com o tempo de cada trecho), as falas dos dois lados são
// intercaladas pelo tempo e a ligação fica guardada para a conversa em que você estava. No próximo report (ou
// resumo) desta conversa, as falas da ligação entram junto, marcadas como "[ligação]".
(function () {
  'use strict';
  if (window.__crLigacao) return;

  const GUARDAR_DIAS = 14;
  const MAX_LIGACOES = 40;
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  /** O nome da conversa aberta (o mesmo topo que o report usa). */
  function nomeDaConversa() {
    const h = document.querySelector('#main header');
    if (!h) return '';
    const t = h.querySelector('span[title]');
    const nome = (t && t.getAttribute('title')) || (h.innerText || '').split('\n').map((x) => x.trim()).find((x) => x && !/^clique|^click/i.test(x));
    return String(nome || '').trim();
  }

  // ---------------------------------------------------------------- guardar e ler
  const lerLigacoes = () => new Promise((r) => {
    try { chrome.storage.local.get({ ligacoes: [] }, (c) => r(Array.isArray(c.ligacoes) ? c.ligacoes : [])); } catch (_) { r([]); }
  });
  async function guardar(lig) {
    const corte = Date.now() - GUARDAR_DIAS * 86400000;
    const lista = (await lerLigacoes()).filter((x) => x.em >= corte && x.id !== lig.id);
    lista.push(lig);
    try { chrome.storage.local.set({ ligacoes: lista.slice(-MAX_LIGACOES) }); } catch (_) { /* sem storage */ }
  }

  /** As falas das ligações gravadas com este lead, no formato das mensagens do report. */
  async function mensagensDa(nome) {
    const alvo = norm(nome);
    if (!alvo) return [];
    const lista = (await lerLigacoes()).filter((x) => norm(x.nome) === alvo && Array.isArray(x.falas) && x.falas.length);
    const msgs = [];
    lista.sort((a, b) => a.em - b.em).forEach((lig) => {
      lig.falas.forEach((f) => msgs.push({
        from: f.quem === 'eu' ? 'eu' : 'lead',
        type: 'texto',
        content: '[ligação] ' + f.texto,
        timestamp: new Date(lig.em + Math.round(f.t * 1000)).toISOString(),
      }));
    });
    return msgs;
  }

  // ---------------------------------------------------------------- botão
  const ui = document.createElement('div');
  ui.id = 'cr-ligacao';
  ui.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;display:none;align-items:center;gap:8px;padding:8px 10px;border-radius:12px;background:#18171b;color:#fff;font:600 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:360px';
  const texto = document.createElement('span');
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.style.cssText = 'border:0;border-radius:8px;padding:6px 10px;font:700 13px system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;background:#ffb800;color:#18171b';
  const fechar = document.createElement('button');
  fechar.type = 'button';
  fechar.textContent = '×';
  fechar.title = 'Esconder';
  fechar.style.cssText = 'border:0;background:transparent;color:#bbb;font-size:16px;cursor:pointer;padding:0 2px';
  ui.append(texto, botao, fechar);
  const montar = () => { if (!ui.isConnected && document.body) document.body.appendChild(ui); };

  const cmd = (c) => window.postMessage({ __crLigacaoCmd: c }, '*');
  const estado = { chamada: false, gravando: false, inicio: 0, nome: '', falas: [], pendentes: 0, parou: false, partes: 0, erros: 0, id: '', relogio: null, finalizarTimer: null, resultado: null };
  const ouvintes = [];
  const mudou = () => ouvintes.forEach((f) => { try { f(); } catch (_) { /* ignora */ } });
  // O botão no cartão do lead (content.js desenha com este id): quando existe, ele mostra o estado e o aviso do canto some.
  const botaoDoCartao = () => document.getElementById('cr-ligacao-btn');

  /** Texto e cores do botão do cartão para o estado de agora. */
  function infoCartao() {
    if (estado.gravando) return { texto: `⏺ Parar gravação · ${mmss(Date.now() - estado.inicio)}`, cor: '#ff6f5c', borda: '#ff6f5c', titulo: 'Gravando a ligação (a sua voz e a do lead). Clique para parar; a transcrição começa sozinha.' };
    if (estado.parou || estado.pendentes > 0) return { texto: 'Transcrevendo a ligação…', cor: '#ffc233', borda: '#ffc233', titulo: 'As partes da ligação estão sendo transcritas.' };
    if (estado.resultado && Date.now() - estado.resultado.em < 10 * 60 * 1000) {
      return { texto: estado.resultado.ok ? `✓ Ligação transcrita (${estado.resultado.falas} falas)` : 'Ligação sem transcrição', cor: estado.resultado.ok ? '#3ddc84' : '#ff6f5c', borda: estado.resultado.ok ? '#3ddc84' : '#ff6f5c', titulo: estado.resultado.ok ? 'As falas da ligação entram no próximo report desta conversa. Clique para gravar outra.' : estado.resultado.msg };
    }
    if (estado.chamada) return { texto: '🎙 Gravar ligação', cor: '#3ddc84', borda: '#3ddc84', titulo: 'Ligação em andamento: grava a sua voz e a do lead e transcreve para o report.' };
    return { texto: '🎙 Gravar ligação', cor: '#a39e93', borda: '#55515b', titulo: 'Durante uma ligação no WhatsApp Web: grava a sua voz e a do lead e transcreve para o report.' };
  }
  /** O clique no botão do cartão (ou do painel lateral). */
  function alternar() {
    if (estado.gravando) return cmd('parar');
    if (estado.parou || estado.pendentes > 0) return;
    estado.nome = nomeDaConversa();
    estado.resultado = null;
    cmd('gravar');
  }

  function mostrar(msg, rotulo, acao, cor) {
    mudou();
    if (botaoDoCartao()) { esconder(); return; }
    montar();
    texto.textContent = msg;
    botao.style.display = rotulo ? '' : 'none';
    botao.textContent = rotulo || '';
    botao.style.background = cor || '#ffb800';
    botao.style.color = cor ? '#fff' : '#18171b';
    botao.onclick = acao || null;
    ui.style.display = 'flex';
  }
  function esconder() { ui.style.display = 'none'; }
  fechar.onclick = esconder;

  function telaParado() {
    mostrar('Ligação em andamento', '🎙 Gravar ligação', alternar);
  }
  function telaGravando() {
    mostrar(`⏺ Gravando ${mmss(Date.now() - estado.inicio)}${estado.nome ? ' · ' + estado.nome : ''}`, 'Parar', () => cmd('parar'), '#c2331f');
    const tic = () => {
      const b = botaoDoCartao();
      if (b) { b.textContent = infoCartao().texto; esconder(); return; }
      montar();
      texto.textContent = `⏺ Gravando ${mmss(Date.now() - estado.inicio)}${estado.nome ? ' · ' + estado.nome : ''}`;
      ui.style.display = 'flex';
    };
    clearInterval(estado.relogio);
    estado.relogio = setInterval(tic, 1000);
  }
  function telaTranscrevendo() {
    mostrar(`Transcrevendo a ligação… ${estado.pendentes ? `(${estado.pendentes} parte(s) na fila)` : ''}`, '', null);
  }

  // ---------------------------------------------------------------- transcrição
  function transcrever(parte) {
    estado.pendentes++;
    if (!estado.gravando) telaTranscrevendo();
    chrome.runtime.sendMessage({ action: 'transcreverLigacao', base64: parte.b64 }, (r) => {
      estado.pendentes--;
      if (r && r.ok) {
        (r.segmentos || []).forEach((s) => {
          const t = parte.inicioMs / 1000 + (Number(s.inicio) || 0);
          if (s.texto) estado.falas.push({ quem: parte.quem, t, texto: String(s.texto).trim() });
        });
      } else {
        estado.erros++;
      }
      if (estado.parou) agendarFim();
      else if (!estado.gravando) telaTranscrevendo();
    });
  }

  function agendarFim() {
    clearTimeout(estado.finalizarTimer);
    // as últimas partes chegam logo depois do "parou" (o gravador fecha o arquivo): espera elas e a fila zerar
    estado.finalizarTimer = setTimeout(() => {
      if (estado.pendentes > 0) return telaTranscrevendo();
      finalizar();
    }, 2500);
  }

  async function finalizar() {
    if (!estado.parou) return;
    estado.parou = false;
    const falas = estado.falas.slice().sort((a, b) => a.t - b.t);
    // falas seguidas do mesmo lado viram uma só
    const juntas = [];
    falas.forEach((f) => {
      const ult = juntas[juntas.length - 1];
      if (ult && ult.quem === f.quem && f.t - ult.fimT < 4) {
        ult.texto += ' ' + f.texto;
        ult.fimT = f.t;
      } else {
        juntas.push({ ...f, fimT: f.t });
      }
    });
    const nome = estado.nome || nomeDaConversa();
    estado.nome = ''; // a próxima ligação pega o nome da conversa em que ela começar
    if (!juntas.length) {
      estado.resultado = { ok: false, em: Date.now(), msg: estado.erros ? 'Não consegui transcrever a ligação. Confira a chave e a conexão.' : 'A ligação ficou sem fala reconhecida.' };
      mostrar(estado.erros ? 'Não consegui transcrever a ligação. Confira a chave e a conexão.' : 'A ligação ficou sem fala reconhecida.', '', null);
      return;
    }
    estado.resultado = { ok: true, em: Date.now(), falas: juntas.length };
    await guardar({ id: estado.id, nome, em: estado.inicio, duracaoMs: estado.duracaoMs || 0, falas: juntas.map(({ quem, t, texto: tx }) => ({ quem, t: Math.round(t * 10) / 10, texto: tx })) });
    mostrar(`Ligação transcrita: ${juntas.length} falas${nome ? ` com ${nome}` : ''}. Ela entra no próximo report desta conversa.${estado.erros ? ` (${estado.erros} parte(s) falharam)` : ''}`, 'OK', esconder);
  }

  // ---------------------------------------------------------------- eventos da página
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__crLigacao) return;
    const d = ev.data;
    if (d.evento === 'chamada') {
      estado.chamada = true;
      if (!estado.gravando) telaParado();
    } else if (d.evento === 'semChamada') {
      estado.chamada = false;
      mudou();
      if (!estado.gravando && !estado.pendentes && !estado.parou) esconder();
    } else if (d.evento === 'gravando') {
      Object.assign(estado, { gravando: true, parou: false, inicio: d.inicio, falas: [], pendentes: 0, partes: 0, erros: 0, id: 'lig-' + d.inicio });
      if (!estado.nome) estado.nome = nomeDaConversa();
      telaGravando();
      if (!d.temLead) mostrar('Gravando só o seu microfone: não achei a voz do lead nesta aba.', 'Parar', () => cmd('parar'), '#c2331f');
    } else if (d.evento === 'parte') {
      transcrever(d);
    } else if (d.evento === 'parou') {
      clearInterval(estado.relogio);
      estado.gravando = false;
      estado.parou = true;
      estado.duracaoMs = d.duracaoMs;
      telaTranscrevendo();
      agendarFim();
    } else if (d.evento === 'erro') {
      estado.resultado = { ok: false, em: Date.now(), msg: d.erro || 'Não consegui gravar.' };
      if (botaoDoCartao()) { mudou(); alert(d.erro || 'Não consegui gravar.'); return; }
      mostrar(d.erro || 'Não consegui gravar.', 'OK', esconder);
    }
  });

  window.__crLigacao = { mensagensDa, nomeDaConversa, infoCartao, alternar, aoMudar: (f) => ouvintes.push(f) };
})();
