/* Modelo compartilhado: nenhuma consulta externa, armazenamento ou chamada de IA. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ContextoLeadModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const campos = { nome: 180, email: 254, empresa: 240, cidade: 180, resumo: 4000, visao: 6000, gancho: 3000, perguntas: 4000, lacunas: 4000 };
  function texto(v, limite, campo) {
    if (v == null) return '';
    if (typeof v !== 'string' || v.length > limite) throw new Error(`Confira ${campo}: limite de ${limite} caracteres.`);
    return v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
  }
  function normalizar(input, revisar = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Preencha o contexto do lead.');
    const d = {};
    for (const [k, limite] of Object.entries(campos)) d[k] = texto(input[k], limite, k);
    if (!d.nome) throw new Error('Informe o nome do lead.');
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) throw new Error('Confira o e-mail informado.');
    const fontes = input.fontes || [];
    if (!Array.isArray(fontes) || fontes.length > 12) throw new Error('Use até 12 fontes por contexto.');
    d.fontes = fontes.map((f) => {
      if (!f || typeof f !== 'object') throw new Error('Fonte inválida.');
      const url = texto(f.url, 1500, 'URL da fonte');
      let u;
      try { u = new URL(url); } catch (_) { throw new Error('Informe uma URL completa para cada fonte (https://...).'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Use uma URL pública http ou https, sem credenciais.');
      const nota = texto(f.nota, 4000, 'informações da fonte');
      if (!nota) throw new Error('Registre o que encontrou em cada fonte.');
      const data = texto(f.data, 10, 'data da consulta');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(Date.parse(data)) || new Date(data).toISOString().slice(0, 10) !== data || data > new Date().toISOString().slice(0, 10)) throw new Error('Informe uma data de consulta válida, até hoje.');
      return { url: u.href, nota, data, confirmada: f.confirmada === true };
    });
    d.revisado = input.revisado === true;
    if (revisar && !d.revisado) throw new Error('Revise o conteúdo antes de baixar o PDF.');
    if (revisar && !d.fontes.length && !d.resumo && !d.visao) throw new Error('Adicione uma fonte, um contexto informado ou sua visão antes de gerar o PDF.');
    return d;
  }
  function pesquisas(input) {
    const d = normalizar(input);
    const literal = (s) => '"' + s.replace(/["\\]/g, ' ') + '"';
    const pessoa = [literal(d.nome), d.empresa && literal(d.empresa), d.cidade && literal(d.cidade)].filter(Boolean).join(' ');
    const lista = [{ titulo: 'LinkedIn pelo nome e contexto', consulta: 'site:linkedin.com/in/ ' + pessoa }, { titulo: 'Presença profissional pública', consulta: pessoa }];
    if (d.email) lista.push({ titulo: 'Menções públicas ao e-mail', consulta: literal(d.email) });
    if (d.empresa) lista.push({ titulo: 'Site e atuação da empresa', consulta: literal(d.empresa) + ' ' + d.cidade });
    return lista.map((p) => ({ ...p, url: 'https://www.google.com/search?q=' + encodeURIComponent(p.consulta) }));
  }
  return { campos, normalizar, pesquisas };
});
