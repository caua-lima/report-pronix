/* Pesquisa assistida: consultas só saem do navegador quando o usuário abre um link. */
(function () {
  'use strict';
  const root = document.getElementById('aba-contexto');
  const form = root.querySelector('form');
  const model = window.ContextoLeadModel;
  const sources = root.querySelector('[data-fontes]');
  const links = root.querySelector('[data-pesquisas]');
  const status = root.querySelector('[role=status]');
  const reviewed = form.elements.revisado;
  const download = root.querySelector('[data-pdf]');
  const preview = root.querySelector('[data-previa]');
  let pending = false;
  function message(s, error = false) { status.textContent = s; status.style.color = error ? 'var(--danger)' : ''; }
  function invalidate() { reviewed.checked = false; download.disabled = true; preview.replaceChildren(); }
  function read() {
    const d = {};
    for (const key of Object.keys(model.campos)) d[key] = form.elements[key].value;
    d.revisado = reviewed.checked;
    d.fontes = [...sources.querySelectorAll('fieldset')].map((f) => ({
      url: f.querySelector('[data-url]').value,
      nota: f.querySelector('[data-nota]').value,
      data: f.querySelector('[data-data]').value,
      confirmada: f.querySelector('[data-confirmada]').checked,
    }));
    return d;
  }
  function addSource() {
    if (sources.children.length >= 12) { message('Limite de 12 fontes por contexto.', true); return; }
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'ctx-fonte';
    fieldset.innerHTML = '<legend>Fonte pública</legend><label>URL da página<input data-url type="url" maxlength="1500" placeholder="https://..." required></label><label>Data da consulta<input data-data type="date" required></label><label>O que a fonte informa<textarea data-nota rows="4" maxlength="4000" required placeholder="Registre fatos relevantes, cargo, atuação e evidências. Indique a data das informações quando disponível."></textarea></label><label class="ctx-check"><input data-confirmada type="checkbox"> Conferi que a fonte corresponde a este lead ou à empresa informada.</label><button type="button" class="btn sec" data-remover>Remover fonte</button>';
    fieldset.querySelector('[data-data]').value = new Date().toISOString().slice(0, 10);
    fieldset.querySelector('[data-data]').max = new Date().toISOString().slice(0, 10);
    fieldset.querySelector('[data-remover]').addEventListener('click', () => { fieldset.remove(); invalidate(); });
    sources.append(fieldset);
    invalidate();
    fieldset.querySelector('input').focus();
  }
  root.querySelector('[data-adicionar]').addEventListener('click', addSource);
  form.addEventListener('input', (e) => {
    if (e.target === reviewed) { download.disabled = !reviewed.checked || pending; return; }
    invalidate();
    if (['nome', 'email', 'empresa', 'cidade'].includes(e.target.name)) links.replaceChildren();
  });
  root.querySelector('[data-buscar]').addEventListener('click', () => {
    try {
      // As fontes podem estar em edição: pesquisa só precisa dos identificadores.
      const d = read();
      d.fontes = [];
      const queries = model.pesquisas(d);
      links.replaceChildren();
      for (const q of queries) {
        const a = document.createElement('a');
        a.className = 'btn sec'; a.textContent = q.titulo; a.href = q.url;
        a.target = '_blank'; a.rel = 'noopener noreferrer'; a.referrerPolicy = 'no-referrer';
        links.append(a);
      }
      message('Buscas preparadas. Abra uma opção, confira os resultados e registre abaixo as fontes úteis. Nenhuma consulta foi executada automaticamente.');
    } catch (e) { message(e.message, true); }
  });
  root.querySelector('[data-visualizar]').addEventListener('click', () => {
    try {
      const d = model.normalizar(read());
      preview.replaceChildren();
      const add = (title, text) => {
        const h = document.createElement('h3'); h.textContent = title;
        const p = document.createElement('p'); p.textContent = text; p.style.whiteSpace = 'pre-wrap';
        preview.append(h, p);
      };
      add(d.nome, [d.email, d.empresa, d.cidade].filter(Boolean).join(' | '));
      add('Contexto informado', d.resumo || 'Não informado.');
      add('Fontes e evidências', d.fontes.length ? `${d.fontes.length} fonte(s) registrada(s).` : 'Nenhuma fonte pública registrada.');
      d.fontes.forEach((f, i) => add(`Fonte ${i + 1} - ${f.confirmada ? 'Identidade conferida pelo responsável' : 'Identidade NÃO confirmada'}`, `${f.url}\nConsultada em ${f.data}\n${f.nota}`));
      add('Minha visão estratégica', d.visao || 'Não registrada.');
      add('Como explorar na reunião', d.gancho || 'Ainda não definido.');
      add('Perguntas para aprofundar', d.perguntas || 'Confirmar com o lead se os dados profissionais encontrados estão atuais e correspondem à sua atuação.');
      add('Lacunas e pontos a confirmar', d.lacunas || 'Orçamento, intenção de compra e poder de decisão devem ser confirmados na conversa. Não são comprovados por cargo, empresa ou presença online.');
      if (d.fontes.some((f) => !f.confirmada)) add('Atenção', 'Há fontes com identidade não confirmada. Não atribuir essas informações ao lead antes de conferir.');
      preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
      message('Prévia pronta. Revise o conteúdo e marque a confirmação para baixar.');
    } catch (e) { message(e.message, true); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending) return;
    try {
      const d = model.normalizar(read(), true);
      pending = true; download.disabled = true; message('Preparando PDF separado...');
      const result = await api('POST', '/api/contexto-lead/pdf', d);
      const bytes = Uint8Array.from(atob(result.arquivoBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.download = result.arquivo;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      message('PDF baixado. Você decide se quer enviá-lo ao closer.');
    } catch (err) { message(err.message, true); }
    finally { pending = false; download.disabled = !reviewed.checked; }
  });
  root.querySelector('[data-limpar]').addEventListener('click', () => {
    if (!window.confirm('Limpar os campos e iniciar o contexto de outro lead?')) return;
    form.reset(); sources.replaceChildren(); links.replaceChildren(); invalidate(); message('Contexto limpo.');
  });
})();
