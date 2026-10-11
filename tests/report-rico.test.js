'use strict';
// Report enriquecido: nível de consciência (só quando é bom), "Como foi a conversa" e sinais de compra.
// Sem IA real: normalização da resposta, desenho no PDF (lido de volta como texto) e limite de 2 páginas.
process.env.PDF_SEM_COMPRESSAO = '1'; // PDF sem compressão: dá para ler o texto nos testes

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarDados } = require('../src/report');
const { normalizarConsciencia, mostrarConsciencia, chaveDoNivel } = require('../src/consciencia');
const { gerarPdfBuffer } = require('../src/generatePdf');

/** Texto de um PDF do pdfkit sem compressão: junta os trechos em hex de cada TJ (WinAnsi ~ latin1). */
function textoDoPdf(buf) {
  const s = buf.toString('latin1');
  const linhas = [];
  for (const m of s.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    const hex = [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]).join('');
    linhas.push(Buffer.from(hex, 'hex').toString('latin1'));
  }
  return linhas.join('\n');
}
const paginas = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

const BASE = {
  lead: 'Marcos Pereira',
  sdr: 'Cauã Lima',
  resumo: [
    { rotulo: 'Investimento', valor: 'Mais de R$5.000' },
    { rotulo: 'Motivação', valor: 'Segunda fonte de renda online' },
    { rotulo: 'Decisor(es)', valor: 'Decide sozinho (não mencionou outra pessoa)' },
  ],
  secoes: [
    { titulo: 'Perfil e momento', numerada: false, itens: ['Loja física há 8 anos.'] },
    { titulo: 'O que o closer deve bater', numerada: true, itens: ['Fechar na call.'] },
  ],
  citacoes: ['Quero começar a vender no Mercado Livre'],
  abertura: 'Marcos, tudo bem? O Cauã me passou aqui o seu momento. É isso mesmo?',
  frase_impacto: 'Só falta o caminho.',
  consciencia: { nivel: 'produto', porque: 'Perguntou como funciona o acompanhamento e topou a reunião na hora.' },
  sinais_compra: ['Confirmou o investimento sem pedir desconto', 'Perguntou quando pode começar'],
  conversa: [
    'Cauã abriu perguntando sobre a loja; Marcos contou que vende peças de moto há 8 anos.',
    'Cauã explicou que a entrega é montar a conta no Mercado Livre com acompanhamento semanal; Marcos disse que era o que faltava.',
  ],
};

// ---------------------------------------------------------------- normalização da resposta da IA
test('consciência: aceita o nível com ou sem acento e rejeita o que não é da escala', () => {
  assert.equal(chaveDoNivel('Solução'), 'solucao');
  assert.equal(chaveDoNivel('PRONTO'), 'pronto');
  assert.equal(chaveDoNivel('quente'), null);
  assert.deepEqual(normalizarConsciencia({ nivel: 'Produto', porque: '  entende a entrega  ' }), { nivel: 'produto', porque: 'entende a entrega' });
  assert.equal(normalizarConsciencia({ nivel: 'muito alto', porque: 'x' }), null);
  assert.equal(normalizarConsciencia('produto'), null);
  assert.equal(normalizarConsciencia(null), null);
});

test('consciência só aparece quando é boa: de "consciente da solução" para cima', () => {
  assert.equal(mostrarConsciencia({ nivel: 'inconsciente' }), false);
  assert.equal(mostrarConsciencia({ nivel: 'problema' }), false);
  assert.equal(mostrarConsciencia({ nivel: 'solucao' }), true);
  assert.equal(mostrarConsciencia({ nivel: 'produto' }), true);
  assert.equal(mostrarConsciencia({ nivel: 'pronto' }), true);
  assert.equal(mostrarConsciencia(null), false);
});

test('a resposta da IA é limpa: listas sem vazios e com teto; campos ausentes não quebram', () => {
  const d = normalizarDados({
    lead: 'X', resumo: [], secoes: [],
    consciencia: { nivel: 'Solução', porque: ' já busca estrutura ' },
    conversa: [' a ', '', null, 'b', 'c', 'd', 'e', 'f', 'g'],
    sinais_compra: ['s1', '  ', 's2'],
  });
  assert.deepEqual(d.consciencia, { nivel: 'solucao', porque: 'já busca estrutura' });
  assert.deepEqual(d.conversa, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(d.sinais_compra, ['s1', 's2']);

  const vazio = normalizarDados({ lead: 'X', resumo: [], secoes: [] });
  assert.equal(vazio.consciencia, null);
  assert.deepEqual(vazio.conversa, []);
  assert.deepEqual(vazio.sinais_compra, []);
});

// ---------------------------------------------------------------- PDF
test('PDF: nível de consciência, sinais de compra e "Como foi a conversa" aparecem, na ordem, logo depois do resumo', async () => {
  const buf = await gerarPdfBuffer(BASE);
  const t = textoDoPdf(buf);
  for (const trecho of ['NÍVEL DE CONSCIÊNCIA', 'Consciente da nossa entrega', 'topou a reunião na hora', 'SINAIS DE COMPRA',
    'Confirmou o investimento sem pedir desconto', 'Como foi a conversa', 'Cauã explicou que a entrega é montar a conta']) {
    assert.ok(t.includes(trecho), 'faltou no PDF: ' + trecho);
  }
  const pos = (x) => t.indexOf(x);
  assert.ok(pos('Mais de R$5.000') < pos('NÍVEL DE CONSCIÊNCIA'), 'resumo antes');
  assert.ok(pos('NÍVEL DE CONSCIÊNCIA') < pos('Como foi a conversa'));
  assert.ok(pos('Como foi a conversa') < pos('Perfil e momento'), 'o desenrolar vem antes da análise');
  assert.ok(paginas(buf) <= 2);
});

test('PDF: lead de consciência baixa não ganha selo (nada de "nível 2 de 5" desanimando o closer)', async () => {
  const buf = await gerarPdfBuffer({ ...BASE, consciencia: { nivel: 'problema', porque: 'ainda não sabe o que quer' } });
  const t = textoDoPdf(buf);
  assert.ok(!t.includes('NÍVEL DE CONSCIÊNCIA'));
  assert.ok(!t.includes('ainda não sabe o que quer'));
  assert.ok(t.includes('SINAIS DE COMPRA'), 'os sinais de compra continuam');
  assert.ok(t.includes('Como foi a conversa'));
});

test('PDF: sem consciência boa e sem sinais, o cartão escuro nem aparece', async () => {
  const t = textoDoPdf(await gerarPdfBuffer({ ...BASE, consciencia: null, sinais_compra: [] }));
  assert.ok(!t.includes('NÍVEL DE CONSCIÊNCIA') && !t.includes('SINAIS DE COMPRA'));
});

test('PDF: report antigo (sem os campos novos) sai igual a antes', async () => {
  const antigo = { ...BASE };
  delete antigo.consciencia;
  delete antigo.conversa;
  delete antigo.sinais_compra;
  const t = textoDoPdf(await gerarPdfBuffer(antigo));
  assert.ok(t.includes('Perfil e momento') && t.includes('COMO INICIAR A REUNIÃO'));
  assert.ok(!t.includes('Como foi a conversa'));
});

test('PDF: report enorme continua em até 2 páginas, sem perder o resumo nem a abertura', async () => {
  const longo = (n, base) => Array.from({ length: n }, (_, i) => `${base} ${i + 1}: ` + 'detalhe importante da conversa com o lead '.repeat(3));
  const grande = {
    ...BASE,
    resumo: BASE.resumo.concat([{ rotulo: 'Negócio', valor: 'Loja física' }, { rotulo: 'Urgência', valor: 'Outubro' }]),
    conversa: longo(5, 'Passo'),
    sinais_compra: longo(4, 'Sinal'),
    secoes: [
      { titulo: 'Perfil e momento', numerada: false, itens: longo(4, 'Perfil') },
      { titulo: 'Dor e objetivo', numerada: false, itens: longo(4, 'Dor') },
      { titulo: 'Como fechar essa call', numerada: false, itens: longo(4, 'Fechar') },
      { titulo: 'O que o closer deve bater', numerada: true, itens: longo(4, 'Bater') },
    ],
    citacoes: longo(3, 'Citação'),
  };
  const buf = await gerarPdfBuffer(grande);
  assert.ok(paginas(buf) <= 2, `saiu com ${paginas(buf)} páginas`);
  const t = textoDoPdf(buf);
  assert.ok(t.includes('Investimento') && t.includes('Decisor(es)'), 'o resumo nunca é cortado');
  assert.ok(t.includes('COMO INICIAR A REUNIÃO'), 'a abertura nunca é cortada');
  assert.ok(t.includes('Como foi a conversa'), 'a conversa encolhe, mas não some');
});

test('PDF apertado: as falas do lead não são as primeiras a cair — pelo menos uma fica', async () => {
  const frase = (n, t) => Array.from({ length: n }, (_, i) => `${t} ${i + 1} — ` + 'texto comprido para ocupar bastante espaço na página do relatório '.repeat(3));
  const cheio = {
    lead: 'Marcos Pereira', sdr: 'Cauã Lima',
    resumo: [{ rotulo: 'Investimento', valor: 'R$ 5 mil' }, { rotulo: 'Motivação', valor: 'Sair do CLT' }, { rotulo: 'Decisor(es)', valor: 'Decide sozinho' }],
    conversa: frase(6, 'Conversa'),
    sinais_compra: frase(4, 'Sinal'),
    secoes: [1, 2, 3, 4].map((i) => ({ titulo: 'Seção ' + i, itens: frase(5, 'Item') })),
    citacoes: ['Quero começar o quanto antes', 'O investimento eu tenho', 'Era exatamente isso que eu procurava'],
    frase_impacto: 'Lead decidido.', abertura: 'Marcos, o Cauã me passou o seu cenário.',
  };
  const buf = await gerarPdfBuffer(cheio);
  assert.ok(paginas(buf) <= 2, `continua em até 2 páginas (${paginas(buf)})`);
  assert.match(textoDoPdf(buf), /Nas palavras do lead/, 'a seção sobrevive ao aperto');
});

// ---------------------------------------------------------------- termômetro de dores
const { normalizarDores, doresVisiveis, rotuloDaIntensidade } = require('../src/dores');
const { SYSTEM_PROMPT } = require('../src/report');
const DORES = [
  { dor: 'Vende no improviso', intensidade: 3, porque: 'Disse que as vendas saem na correria.' },
  { dor: 'R$100 mil de estoque parado', intensidade: 5, porque: 'Contou do giro lento parado.' },
  { dor: 'Citada de passagem', intensidade: 2, porque: 'Só comentou uma vez.' },
];

test('dores: a resposta da IA é limpa — da mais forte para a mais fraca, no máximo 3, intensidade de 1 a 5', () => {
  const limpas = normalizarDores([
    ...DORES, { dor: '   ', intensidade: 4 }, { dor: 'Sem número', intensidade: 'muito' }, 'texto solto', null,
    { dor: '  Forte   demais ', intensidade: 9, porque: '  prova  ' },
  ]);
  assert.deepEqual(limpas.map((d) => [d.dor, d.intensidade]), [['R$100 mil de estoque parado', 5], ['Forte demais', 5], ['Vende no improviso', 3]]);
  assert.equal(limpas[1].porque, 'prova');
  assert.deepEqual(normalizarDores('não é lista'), []);
  assert.deepEqual(normalizarDores([{ dor: 'Fraquinha', intensidade: -3 }]), [{ dor: 'Fraquinha', intensidade: 1, porque: '' }]);
  // só dor de fato (3 ou mais) vai para o report
  assert.deepEqual(doresVisiveis(DORES).map((d) => d.intensidade), [5, 3]);
  assert.deepEqual(doresVisiveis([{ dor: 'Citada', intensidade: 2 }]), []);
  assert.equal(rotuloDaIntensidade(5), 'Dói agora');

  // entra na resposta normalizada do report; sem o campo, lista vazia (report antigo não quebra)
  const d = normalizarDados({ lead: 'X', resumo: [], secoes: [], dores: DORES });
  assert.equal(d.dores[0].dor, 'R$100 mil de estoque parado');
  assert.deepEqual(normalizarDados({ lead: 'X', resumo: [], secoes: [] }).dores, []);
});

test('PDF: o termômetro de dores abre o cartão do topo, só com dor de fato', async () => {
  const buf = await gerarPdfBuffer({ ...BASE, dores: DORES });
  const t = textoDoPdf(buf);
  for (const trecho of ['TERMÔMETRO DE DORES', 'R$100 mil de estoque parado', 'Contou do giro lento parado.', 'Vende no improviso']) {
    assert.ok(t.includes(trecho), 'faltou no PDF: ' + trecho);
  }
  assert.ok(!t.includes('Citada de passagem'), 'dor citada de passagem não vai para o closer');
  const pos = (x) => t.indexOf(x);
  assert.ok(pos('Mais de R$5.000') < pos('TERMÔMETRO DE DORES'), 'logo depois do resumo');
  assert.ok(pos('TERMÔMETRO DE DORES') < pos('NÍVEL DE CONSCIÊNCIA'), 'as dores vêm antes do nível de consciência');
  assert.ok(pos('R$100 mil de estoque parado') < pos('Vende no improviso'), 'a dor mais forte primeiro');
  assert.ok(pos('SINAIS DE COMPRA') < pos('Como foi a conversa'));
  assert.ok(paginas(buf) <= 2);
});

test('PDF: sem dor de fato o termômetro não aparece; só com dores, o cartão do topo aparece do mesmo jeito', async () => {
  const fracas = textoDoPdf(await gerarPdfBuffer({ ...BASE, dores: [{ dor: 'Citada de passagem', intensidade: 2, porque: 'x' }] }));
  assert.ok(!fracas.includes('TERMÔMETRO DE DORES'));
  assert.ok(fracas.includes('NÍVEL DE CONSCIÊNCIA'), 'o resto do cartão continua');
  const semCampo = textoDoPdf(await gerarPdfBuffer(BASE));
  assert.ok(!semCampo.includes('TERMÔMETRO DE DORES'), 'report antigo sai igual');

  const soDores = textoDoPdf(await gerarPdfBuffer({ ...BASE, consciencia: null, sinais_compra: [], dores: DORES }));
  assert.ok(soDores.includes('TERMÔMETRO DE DORES') && soDores.includes('R$100 mil de estoque parado'));
  assert.ok(!soDores.includes('NÍVEL DE CONSCIÊNCIA') && !soDores.includes('SINAIS DE COMPRA'));
});

test('PDF enorme com dores: continua em até 2 páginas e pelo menos uma dor fica', async () => {
  const longo = (n, base) => Array.from({ length: n }, (_, i) => `${base} ${i + 1}: ` + 'detalhe importante da conversa com o lead '.repeat(3));
  const buf = await gerarPdfBuffer({
    ...BASE,
    dores: [5, 4, 3].map((n) => ({ dor: 'Dor comprida que ocupa bastante espaço na linha do termômetro ' + n, intensidade: n, porque: 'prova longa da dor que o lead contou na conversa '.repeat(3) })),
    conversa: longo(6, 'Passo'),
    sinais_compra: longo(4, 'Sinal'),
    secoes: [1, 2, 3, 4].map((i) => ({ titulo: 'Seção ' + i, itens: longo(5, 'Item') })),
    citacoes: ['Quero começar o quanto antes', 'O investimento eu tenho'],
  });
  assert.ok(paginas(buf) <= 2, `saiu com ${paginas(buf)} páginas`);
  const t = textoDoPdf(buf);
  assert.ok(t.includes('TERMÔMETRO DE DORES') && t.includes('ocupa bastante'), 'a dor mais forte sobrevive ao aperto');
  assert.ok(t.includes('COMO INICIAR A REUNIÃO'));
});

test('o prompt pede as dores do LEAD com prova, e manda ficar com a intensidade menor na dúvida', () => {
  assert.match(SYSTEM_PROMPT, /TERMÔMETRO DE DORES \(campo "dores"\)/);
  assert.match(SYSTEM_PROMPT, /tiradas das falas do LEAD/);
  assert.match(SYSTEM_PROMPT, /NA DÚVIDA, a intensidade menor/);
  assert.match(SYSTEM_PROMPT, /Sem dor demonstrada, devolva \[\]/);
});
