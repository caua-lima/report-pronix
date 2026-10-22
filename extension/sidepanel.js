// Painel lateral do Chrome: mostra o lead da conversa aberta no WhatsApp Web (o content.js publica o estado
// do cartão; o service worker guarda em chrome.storage.session). Busca e "Tentar de novo" voltam para a aba.
(function () {
  'use strict';
  const painel = globalThis.__pnxPainel;
  if (!painel) return;
  let tabId = null;
  function mostrar(v) {
    tabId = v && v.tabId != null ? v.tabId : null;
    const e = v && v.estado;
    painel.atualizar(e && e.tipo ? e : { tipo: 'sem-conversa' }, {
      consultar: (busca) => {
        if (tabId == null) return;
        chrome.tabs.sendMessage(tabId, { action: 'painelConsultar', busca: busca || {} }, () => void chrome.runtime.lastError);
      },
    });
  }
  try {
    chrome.storage.session.get('painelLead', (c) => mostrar(c && c.painelLead));
    chrome.storage.onChanged.addListener((mud, area) => {
      if (area === 'session' && mud.painelLead) mostrar(mud.painelLead.newValue);
    });
  } catch (_) {
    mostrar(null);
  }
})();
