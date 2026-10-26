// Painel lateral do Chrome: mostra o lead da conversa aberta no WhatsApp Web (o content.js publica o estado do
// cartão; o service worker guarda em chrome.storage.session, um por aba). O painel acompanha a aba ativa da própria
// janela. Busca, "Tentar de novo", "Atualizar" e os cliques nas etiquetas voltam para essa aba.
(function () {
  'use strict';
  const painel = globalThis.__pnxPainel;
  if (!painel) return;
  let tabId = null; // a aba do WhatsApp deste painel (null: ainda não se sabe — vale o último lead de qualquer aba)
  let ultimo = null;
  const chaveDaAba = () => (tabId != null ? 'painelLead:' + tabId : 'painelLead');

  const paraAba = (msg) =>
    new Promise((res) => {
      const alvo = tabId != null ? tabId : ultimo && ultimo.tabId;
      if (alvo == null) return res({ ok: false });
      try {
        chrome.tabs.sendMessage(alvo, msg, (r) => res(chrome.runtime.lastError || !r ? { ok: false } : r));
      } catch (_) {
        res({ ok: false });
      }
    });

  const acoes = {
    // Botões que escrevem no CRM (duplicado, reunião realizada): o service worker leva ao servidor com a chave.
    servidor: (caminho, corpo) => new Promise((res) => chrome.runtime.sendMessage({ action: 'crmPainel', caminho, corpo }, (r) => res(chrome.runtime.lastError ? { ok: false, erro: 'A extensão não respondeu. Tente de novo.' } : r))),
    consultar: (busca) => { paraAba({ action: 'painelConsultar', busca: busca || {} }); },
    // Etiquetas e botões do cartão (Qualificado, + Recontato, Desqualificar, resumo...): quem faz é a aba do WhatsApp.
    cartao: (lead, acao) => paraAba({ action: 'painelCartao', lead, acao }),
    // "Atualizar": a aba lê de novo a conversa aberta e busca o lead no CRM. Sem resposta: a aba precisa recarregar.
    atualizar: async () => {
      const r = await paraAba({ action: 'painelAtualizar' });
      if (!r || !r.ok) return { ok: false, erro: 'A aba do WhatsApp não respondeu. Recarregue o WhatsApp (F5) e clique em Atualizar de novo.' };
      return r;
    },
  };

  function mostrar(v) {
    ultimo = v || null;
    const e = v && v.estado;
    painel.atualizar(e && e.tipo ? e : { tipo: 'sem-conversa' }, acoes);
  }
  function ler() {
    try {
      chrome.storage.session.get(chaveDaAba(), (c) => mostrar(c && c[chaveDaAba()]));
    } catch (_) {
      mostrar(null);
    }
  }
  function acharAba(depois) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (abas) => {
        const a = (abas || [])[0];
        if (a && String(a.url || '').startsWith('https://web.whatsapp.com/')) tabId = a.id;
        depois();
      });
    } catch (_) {
      depois();
    }
  }
  try {
    chrome.storage.onChanged.addListener((mud, area) => {
      if (area !== 'session') return;
      const k = chaveDaAba();
      if (mud[k]) mostrar(mud[k].newValue);
    });
    // Trocou de aba nesta janela (outra aba do WhatsApp): passa a mostrar o lead dela.
    if (chrome.tabs && chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(() => acharAba(ler));
    }
  } catch (_) {
    /* sem a API: fica com o que já leu */
  }
  acharAba(ler);
})();
