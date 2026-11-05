'use strict';
// Oito handoffs SINTÉTICOS no formato editorial (schemaVersion 2), revisados à mão para servir de régua de
// desenho e de fidelidade. Pessoas, números e conversas são inventados. O caso "geraldo" é do mesmo TIPO do
// exemplo da auditoria de 04/11/2026 (quem já produz e quer um canal online), com nome e dados inventados.

const visaoSdr = require('../../src/visaoSdr');

const base = (extra) => ({ schemaVersion: 2, sdr: 'Cauã Lima', promptVersao: 'v11', templateVersao: 'editorial-1', ...extra });

const FIXTURES = {
  iniciante: base({
    lead: 'Patrícia Moura',
    negocio: 'Professora, começando do zero no Mercado Livre; ainda não abriu CNPJ',
    tese: { titulo: 'Quer começar com segurança e já separou a reserva', texto: 'Patrícia quer uma segunda renda vendendo utilidades domésticas e disse que separou R$ 3 mil para o primeiro estoque. A reunião avança mostrando o passo a passo das 10 primeiras vendas.' },
    oportunidade: [
      { fato: 'Disse que separou R$ 3 mil para o primeiro estoque', relevancia: 'Já pensou no começo prático; o foco pode ser como usar bem essa reserva.', origem: 'lead' },
      { fato: 'Perguntou "quanto tempo por dia eu preciso?"', relevancia: 'Mostra que quer encaixar na rotina; vale mostrar a rotina de 2 horas.', origem: 'lead' },
    ],
    panorama: {
      objetivo: { valor: 'Ter uma segunda renda ao lado do salário de professora', status: 'declarado' },
      capital_operacao: { valor: 'R$ 3 mil separados para o primeiro estoque', status: 'declarado' },
      capacidade_acompanhamento: { valor: 'Vale alinhar a condição para o acompanhamento, além da reserva do estoque', status: 'a_alinhar' },
      decisao: { valor: 'Vale confirmar quem participa da decisão (não falou de outra pessoa)', status: 'a_alinhar' },
    },
    conducao: [
      { etapa: 'Conectar', acao: 'Retomar a ideia de utilidades domésticas e perguntar por que escolheu esse nicho.', objetivo: 'Ela se sentir ouvida e começar pelo que já pensou.' },
      { etapa: 'Aprofundar', acao: 'Entender quanto tempo ela tem por dia e o que a impede de começar sozinha.', pergunta: 'O que te fez procurar ajuda em vez de começar sozinha?', objetivo: 'Dar peso ao motivo de buscar acompanhamento.' },
      { etapa: 'Avançar', acao: 'Mostrar o caminho das 10 primeiras vendas com os R$ 3 mil e alinhar a condição do acompanhamento.', objetivo: 'Decisão ou próximo passo com data.' },
    ],
    abertura: 'Patrícia, o Cauã me contou que você quer começar a vender utilidades domésticas no Mercado Livre e que já separou uma reserva para o primeiro estoque. Me conta o que te fez escolher esse caminho agora?',
    citacoes: ['quanto tempo por dia eu preciso?'],
    contexto: [],
    conversa: ['Patrícia chegou pelo formulário dizendo que quer uma renda extra.', 'Cauã perguntou o nicho; ela contou que pensa em utilidades domésticas.', 'Ao falar de estoque, Patrícia disse que separou R$ 3 mil.'],
  }),

  faturamento_sem_verba: base({
    lead: 'Rogério Antunes',
    negocio: 'Loja física de autopeças há 12 anos; vende pouco no Mercado Livre',
    tese: { titulo: 'Operação madura que ainda não usa o online', texto: 'Rogério fatura bem na loja física e vende pouco no Mercado Livre. A oportunidade é mostrar como levar o catálogo que já gira para o online, sem tratar o faturamento da loja como verba disponível.' },
    oportunidade: [
      { fato: 'Loja física de autopeças há 12 anos', relevancia: 'Conhece produto e fornecedor; a conversa pode ir direto à operação online.', origem: 'lead' },
      { fato: 'Disse que o Mercado Livre "vende pouco, umas 20 por mês"', relevancia: 'Já testou o canal: o ganho está em anunciar e precificar do jeito certo.', origem: 'lead' },
    ],
    panorama: {
      objetivo: { valor: 'Fazer o online virar um canal de verdade, não um complemento', status: 'declarado' },
      capital_operacao: { valor: 'Contou que a loja fatura cerca de R$ 80 mil por mês; faturamento não é verba livre — vale alinhar quanto pode ir para o canal novo', status: 'a_alinhar' },
      capacidade_acompanhamento: { valor: 'Não falou de investimento no acompanhamento; vale alinhar na reunião', status: 'a_alinhar' },
      timing: { valor: 'Disse que quer resolver "este semestre"', status: 'declarado' },
    },
    conducao: [
      { etapa: 'Conectar', acao: 'Abrir pelas 20 vendas por mês e perguntar quais produtos saem mais no online.', objetivo: 'Partir do que ele já testou.' },
      { etapa: 'Aprofundar', acao: 'Explorar quanto do estoque da loja poderia girar no online e o que acontece se o canal continuar pequeno.', pergunta: 'Quanto da loja você gostaria que viesse do online daqui a seis meses?', objetivo: 'Transformar o objetivo em número dele.' },
      { etapa: 'Avançar', acao: 'Apresentar o caminho de catálogo e alinhar quanto ele destina ao canal novo e ao acompanhamento.', objetivo: 'Clareza de verba e próximo passo.' },
    ],
    abertura: 'Rogério, o Cauã me contou da sua loja de autopeças e que o Mercado Livre ainda vende pouco perto do que a loja faz. Quais produtos saem melhor hoje no online?',
    citacoes: ['vende pouco, umas 20 por mês'],
    contexto: [],
    conversa: ['Rogério disse que tem a loja há 12 anos.', 'Cauã perguntou do online; Rogério contou que vende umas 20 por mês.'],
  }),

  outro_decisor: base({
    lead: 'Fernanda Lopes',
    negocio: 'Vende cosméticos no Mercado Livre há 2 anos, cerca de R$ 30 mil por mês',
    tese: { titulo: 'Já vende e quer escalar com o sócio junto', texto: 'Fernanda vende há dois anos e quer passar de R$ 30 mil por mês. A reunião avança mostrando o plano de escala de um jeito que o sócio, que decide junto, consiga avaliar.' },
    visaoSdr: visaoSdr.montar({ texto: 'Ela tá decidida, mas o Bruno (sócio) é quem segura o dinheiro. Na ligação ela disse que ele quer ver número antes de tudo.\nChamaria o Bruno pra call ou mandaria um resumo com a conta.', sintese: [], autor: 'Cauã Lima' }),
    oportunidade: [
      { fato: 'Vende cerca de R$ 30 mil por mês há 2 anos', relevancia: 'Operação validada: a conversa é sobre escala, não sobre começar.', origem: 'lead' },
      { fato: 'O sócio Bruno quer ver números antes de decidir', relevancia: 'Levar a conta pronta ajuda a decisão sem perder ritmo.', origem: 'leitura_sdr' },
    ],
    panorama: {
      objetivo: { valor: 'Passar de R$ 30 mil para R$ 60 mil por mês', status: 'declarado' },
      decisao: { valor: 'Decide junto com o sócio Bruno, que cuida do financeiro; vale alinhar se ele entra na call', status: 'declarado' },
      capacidade_acompanhamento: { valor: 'Quem libera o investimento é o Bruno', status: 'leitura_sdr' },
      combinado: { valor: 'Reunião marcada; ela vai tentar levar o Bruno', status: 'declarado' },
    },
    conducao: [
      { etapa: 'Conectar', acao: 'Abrir pelos dois anos de operação e pelos R$ 30 mil, perguntando o que mais trava o crescimento hoje.', objetivo: 'Ela nomear o gargalo.' },
      { etapa: 'Aprofundar', acao: 'Montar com ela a conta de R$ 30 mil para R$ 60 mil: margem, anúncios e estoque.', pergunta: 'Quanto sobra hoje de cada R$ 100 vendidos?', objetivo: 'Ter os números que o Bruno vai pedir.' },
      { etapa: 'Avançar', acao: 'Combinar como o Bruno recebe a conta: na call ou num resumo com os números.', objetivo: 'Decisão encaminhada com quem libera o investimento.' },
    ],
    abertura: 'Fernanda, o Cauã me contou que você já vende cosméticos há dois anos e quer dobrar o faturamento. Antes de te mostrar o plano, o que mais trava esse crescimento hoje?',
    citacoes: ['quero chegar nos 60 mil esse ano'],
    contexto: [],
    conversa: ['Fernanda contou que vende cosméticos há dois anos.', 'Cauã perguntou o objetivo; ela disse que quer chegar nos R$ 60 mil.', 'Ao falar de decisão, Fernanda disse que decide junto com o sócio.'],
  }),

  verba_estoque: base({
    lead: 'Juliano Prado',
    negocio: 'Marceneiro, quer vender peças de madeira no online',
    tese: { titulo: 'Produto próprio e reserva para começar', texto: 'Juliano produz peças de madeira e tem R$ 4 mil reservados para material e estoque. A oportunidade é transformar a produção em catálogo online; o investimento no acompanhamento é outra conversa.' },
    oportunidade: [{ fato: 'Produz as próprias peças de madeira', relevancia: 'Controla custo e qualidade; vale explorar quais peças viram produto de catálogo.', origem: 'lead' }],
    panorama: {
      capital_operacao: { valor: 'R$ 4 mil reservados para material e estoque (disse que é para isso)', status: 'declarado' },
      capacidade_acompanhamento: { valor: 'Os R$ 4 mil são do estoque; vale alinhar a condição para o acompanhamento separadamente', status: 'a_alinhar' },
      decisao: { valor: 'Disse que decide sozinho', status: 'declarado' },
    },
    conducao: [
      { etapa: 'Conectar', acao: 'Pedir que ele mostre as peças que mais vende hoje, fora do online.', objetivo: 'Partir do repertório dele.' },
      { etapa: 'Aprofundar', acao: 'Entender a capacidade de produção por semana e o custo de cada peça.', objetivo: 'Saber se a produção acompanha a demanda online.' },
      { etapa: 'Avançar', acao: 'Mostrar como os R$ 4 mil viram o primeiro catálogo e alinhar, à parte, a condição do acompanhamento.', objetivo: 'Não misturar verba de estoque com a decisão do acompanhamento.' },
    ],
    abertura: 'Juliano, o Cauã me contou que você produz peças de madeira e quer levar isso para o online. Quais peças saem melhor hoje?',
    citacoes: [],
    contexto: [],
    conversa: ['Juliano contou que é marceneiro.', 'Ao falar de dinheiro, disse que tem R$ 4 mil para material e estoque.'],
  }),

  visao_divergente: base({
    lead: 'Camila Rocha',
    negocio: 'Revende roupas no Instagram e quer ir para o Mercado Livre',
    tese: { titulo: 'Já vende roupa e quer um canal com mais alcance', texto: 'Camila revende roupas pelo Instagram e quer o alcance do Mercado Livre. A reunião avança pelo que ela já sabe vender; o valor disponível precisa ser alinhado, porque a conversa e a ligação deram números diferentes.' },
    visaoSdr: visaoSdr.montar({ texto: 'Na ligação ela falou em 20 mil guardados. No chat tinha falado 5 mil. Acho que os 20 mil são da família, vale perguntar com jeito.', sintese: [], autor: 'Cauã Lima' }),
    oportunidade: [{ fato: 'Vende roupas pelo Instagram há 1 ano', relevancia: 'Conhece giro e tamanho; o ganho está no canal com mais procura.', origem: 'lead' }],
    panorama: {
      capital_operacao: { valor: 'No chat citou R$ 4 mil; na ligação, R$ 20 mil — vale alinhar quanto é dela e para quê', status: 'a_alinhar' },
      objetivo: { valor: 'Vender para fora da cidade', status: 'declarado' },
    },
    conducao: [
      { etapa: 'Conectar', acao: 'Abrir pelo que mais vende no Instagram.', objetivo: 'Começar pelo que ela domina.' },
      { etapa: 'Aprofundar', acao: 'Perguntar com cuidado quanto pretende colocar no começo e de onde vem esse valor.', pergunta: 'Quanto você pensa em separar para o primeiro estoque no Mercado Livre?', objetivo: 'Resolver a diferença entre R$ 4 mil e R$ 20 mil.' },
      { etapa: 'Avançar', acao: 'Com o valor claro, mostrar o caminho do primeiro catálogo.', objetivo: 'Próximo passo com base real.' },
    ],
    abertura: 'Camila, o Cauã me contou que você já vende roupas pelo Instagram e quer chegar em mais gente pelo Mercado Livre. O que mais sai hoje na sua loja?',
    citacoes: [],
    contexto: ['Versões diferentes do valor: R$ 4 mil no chat e R$ 20 mil na ligação (leitura do SDR). Vale alinhar antes de falar de investimento.'],
    conversa: ['Camila disse que vende roupas pelo Instagram.', 'Ao ser perguntada sobre reserva, citou R$ 4 mil.'],
  }),

  correcao: base({
    lead: 'Anderson',
    negocio: 'Vende eletrônicos no Mercado Livre há 8 meses',
    tese: { titulo: 'Já vende e quer margem melhor', texto: 'Anderson vende eletrônicos há oito meses e sente que trabalha muito para lucrar pouco. A reunião avança pela conta da margem.' },
    oportunidade: [{ fato: 'Disse que "vende bem, mas sobra pouco"', relevancia: 'Dor clara de margem: o plano de anúncios e preço conversa direto com isso.', origem: 'lead' }],
    panorama: {
      capital_operacao: { valor: 'Corrigiu o valor: R$ 2 mil (antes tinha dito R$ 20 mil)', status: 'declarado' },
      objetivo: { valor: 'Lucrar mais com o que já vende', status: 'declarado' },
    },
    conducao: [
      { etapa: 'Conectar', acao: 'Abrir pelos 8 meses de venda e pelo produto que mais sai.', objetivo: 'Reconhecer a experiência.' },
      { etapa: 'Aprofundar', acao: 'Montar a conta de margem de um produto com ele, incluindo anúncios.', objetivo: 'Mostrar onde a margem se perde.' },
      { etapa: 'Avançar', acao: 'Mostrar o ajuste de anúncios e preço e alinhar o próximo passo com os R$ 2 mil em mente.', objetivo: 'Plano compatível com o valor real.' },
    ],
    abertura: 'Anderson, o Cauã me contou que você já vende eletrônicos há oito meses e quer que sobre mais no fim do mês. Qual produto mais sai hoje?',
    citacoes: ['vende bem, mas sobra pouco'],
    contexto: ['O valor foi corrigido pelo próprio lead na conversa (de R$ 20 mil para R$ 2 mil).'],
    conversa: ['Anderson contou que vende eletrônicos há 8 meses.', 'Disse ter R$ 20 mil e logo corrigiu para R$ 2 mil.'],
  }),

  curta: base({
    lead: 'Jô',
    negocio: 'Quer começar a vender online',
    tese: { titulo: 'Interesse inicial em vender online', texto: 'A conversa foi curta: Jô quer começar a vender online e aceitou a reunião. A call é o momento de entender o cenário dela.' },
    oportunidade: [],
    panorama: { combinado: { valor: 'Aceitou a reunião', status: 'declarado' } },
    conducao: [
      { etapa: 'Conectar', acao: 'Perguntar o que a fez se interessar em vender online agora.', objetivo: 'Entender o motivo.' },
      { etapa: 'Aprofundar', acao: 'Entender o que ela já tem: produto, tempo e reserva.', objetivo: 'Ter o cenário que a conversa não deu.' },
      { etapa: 'Avançar', acao: 'Com o cenário claro, mostrar o caminho que se encaixa nele.', objetivo: 'Próximo passo realista.' },
    ],
    abertura: 'Jô, o Cauã me disse que você quer começar a vender online. Me conta o que te fez pensar nisso agora?',
    citacoes: [],
    contexto: [],
    conversa: [],
  }),

  geraldo: base({
    lead: 'Geraldo',
    negocio: 'Experiência com marcenaria e solda; quer vender no Mercado Livre',
    tese: { titulo: 'Experiência produtiva para explorar um novo canal de vendas', texto: 'Geraldo quer transformar sua experiência com marcenaria e solda em uma nova fonte de renda no Mercado Livre. O ponto de partida é concreto: já conhece a produção e identificou uma possibilidade de aproveitar material disponível.' },
    visaoSdr: visaoSdr.montar({ texto: 'Ele parece que quer mais segurança de como começar do que uma aula de ferramenta, já sabe produzir.', sintese: ['Ele parece que quer mais segurança de como começar do que uma aula de ferramenta: já sabe produzir.'], autor: 'Cauã Lima' }),
    oportunidade: [
      { fato: 'Experiência com marcenaria e solda', relevancia: 'Já domina a produção; a conversa pode ir para produto e execução.', origem: 'lead' },
      { fato: 'Possibilidade de aproveitar material disponível', relevancia: 'Hipótese de eficiência a avaliar com custo e reposição — não é margem garantida.', origem: 'lead' },
    ],
    panorama: {
      objetivo: { valor: 'Criar uma nova fonte de renda com vendas online', status: 'declarado' },
      capital_operacao: { valor: 'R$ 4 mil mencionados; vale esclarecer o destino antes de associar o valor ao estoque ou ao acompanhamento', status: 'a_alinhar' },
      decisao: { valor: 'Relatou autonomia para investir; a irmã é sócia — vale alinhar como ela participa da execução e da decisão', status: 'declarado' },
    },
    conducao: [
      { etapa: 'Conectar', acao: 'Explorar quais peças ele já produz bem e qual imagina transformar em produto para o online.', objetivo: 'Reconhecer o repertório e tornar a conversa concreta.' },
      { etapa: 'Aprofundar', acao: 'Entender como pretende organizar a produção e o uso dos R$ 4 mil; distinguir material ocasional de uma operação que possa repor produtos e crescer.', objetivo: 'Viabilidade com base real.' },
      { etapa: 'Avançar', acao: 'Relacionar a necessidade identificada ao acompanhamento da PRONIX e combinar o próximo passo, esclarecendo o envolvimento da sócia.', objetivo: 'Decisão encaminhada com quem participa.' },
    ],
    abertura: 'Geraldo, o Cauã me contou que você quer levar sua experiência com marcenaria e solda para o Mercado Livre e criar uma nova fonte de renda. Qual produto você imagina começar vendendo — e o que gostaria de entender hoje para dar esse primeiro passo?',
    citacoes: [],
    contexto: [],
    conversa: [],
  }),
};

// Estresse de desenho: nome longo, textos longos, muitos itens de contexto e leitura com nove pontos.
FIXTURES.longo = base({
  ...FIXTURES.outro_decisor,
  lead: 'Maria Aparecida dos Santos Albuquerque de Vasconcelos Ferreira',
  visaoSdr: visaoSdr.montar({
    texto: Array.from({ length: 9 }, (_, i) => `Ponto ${i + 1} da minha leitura: ela demonstrou com detalhes como a operação funciona hoje e o que espera de um acompanhamento próximo nos próximos meses.`).join('\n'),
    sintese: [],
    autor: 'Cauã Lima',
  }),
  contexto: Array.from({ length: 4 }, (_, i) => `Contexto ${i + 1}: histórico relevante descrito com bastante texto para testar a quebra de linha e a paginação do documento sem cortar nada no meio do caminho.`),
  conversa: Array.from({ length: 6 }, (_, i) => `Frase ${i + 1} do desenrolar da conversa, com nomes e fatos, longa o suficiente para ocupar duas linhas no PDF e forçar a paginação.`),
});

module.exports = { FIXTURES };
