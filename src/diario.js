'use strict';

// Reports do dia: quando o SDR gera mais de um report do mesmo lead (o áudio não veio, a IA leu
// algo errado...), o que vale é o ÚLTIMO. Este módulo decide, sem IA, quais reports entram no .zip
// que vai para o líder no fim do dia.
//
// "Mesmo lead" = mesmo contato no mesmo dia, do mesmo SDR. O contato é o nome (ou telefone) que a
// extensão leu no cabeçalho do WhatsApp/Instagram — é estável entre uma geração e outra, ao
// contrário do nome que a IA devolve (que pode vir "Marcos" numa e "Marcos Souza" na outra). Sem
// contato (report manual sem nome, ou reports antigos), usa o nome do lead do report.

// Cabeçalho que a extensão leu por engano (status, não nome) não pode juntar leads diferentes.
const STATUS_NAO_E_NOME =
  /^(online|offline|digitando|gravando|escrevendo|visto por [úu]ltimo|[úu]ltima vez|typing|recording|last seen|ativo|active|aguardando|carregando)/i;

/** Minúsculo, sem acento e sem pontuação: "Márcia  Gonçalves!" e "marcia goncalves" viram a mesma coisa. */
const normalizar = (s) =>
  String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Chave que identifica o lead de um report. Report sem nome nenhum nunca é agrupado com outro. */
function chaveDoLead(r) {
  const contato = String((r && r.contato) || '').trim();
  const valido = contato && !STATUS_NAO_E_NOME.test(contato) ? normalizar(contato) : '';
  const lead = normalizar(r && r.lead);
  const base = valido || lead;
  return base ? base : `sem-nome:${(r && r.id) || Math.random()}`;
}

/**
 * Marca, em cada grupo (SDR + dia + lead), qual report é o último (usar: true) e quais foram
 * substituídos por ele. Não muda a ordem de entrada nem os objetos originais.
 * @param {object[]} registros reports de src/stats.js (com id, quando, dia, usuarioId, lead, contato)
 * @returns {object[]} cópias com { usar, substituidoPor, geracoes, grupo }
 */
function marcarUltimos(registros) {
  const lista = Array.isArray(registros) ? registros : [];
  const grupos = new Map();
  const comGrupo = lista.map((r) => {
    const grupo = [r.usuarioId || r.usuarioNome || '', r.dia || String(r.quando || '').slice(0, 10), chaveDoLead(r)].join('|');
    const atual = grupos.get(grupo);
    // "Último" = o gerado mais tarde. Empate de horário: o que veio depois na lista (a lista é cronológica).
    if (!atual || String(r.quando || '') >= String(atual.quando || '')) grupos.set(grupo, r);
    return { r, grupo };
  });
  const contagem = new Map();
  comGrupo.forEach(({ grupo }) => contagem.set(grupo, (contagem.get(grupo) || 0) + 1));
  return comGrupo.map(({ r, grupo }) => {
    const ultimo = grupos.get(grupo);
    const usar = ultimo === r;
    return { ...r, grupo, usar, substituidoPor: usar ? null : ultimo.id, geracoes: contagem.get(grupo) };
  });
}

/** Nomes de arquivo únicos dentro do .zip: dois leads com o mesmo nome não podem se sobrescrever ao extrair. */
function nomesUnicos(nomes) {
  const usados = new Map();
  return nomes.map((nome) => {
    const n = String(nome || 'report.pdf');
    const chave = n.toLowerCase();
    const vezes = usados.get(chave) || 0;
    usados.set(chave, vezes + 1);
    if (!vezes) return n;
    const ponto = n.lastIndexOf('.');
    return ponto > 0 ? `${n.slice(0, ponto)} (${vezes + 1})${n.slice(ponto)}` : `${n} (${vezes + 1})`;
  });
}

/** Só letras/números sem acento, hífen e sublinhado: seguro para nome de arquivo e cabeçalho HTTP. */
const nomeAscii = (s, padrao = 'SDR') =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || padrao;

module.exports = { chaveDoLead, marcarUltimos, nomesUnicos, nomeAscii, normalizar };
