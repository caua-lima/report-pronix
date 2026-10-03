'use strict';

// Base de conhecimento recomendada (v3). Montada a partir do material da casa — scripts de
// diagnóstico do closer (planilha "SCRIPTS - Diagnóstico"), apresentações Performance e Aceleração,
// contratos PRX Performance e PRX Acelera, notícias públicas sobre a empresa — e, na v3, da análise
// de 12 reuniões de closer que terminaram em venda (docs/analise-calls-vendas.md).
//
// É o texto que entra quando o campo ainda não foi escrito, e o que o botão "Usar a base
// recomendada" aplica. O master edita tudo pela aba Base; nada aqui fica preso no código.
//
// Fora daqui de propósito: linhas de negociação e pisos de preço (é assunto do closer e do gestor)
// e qualquer dado de cliente das reuniões analisadas.

const VERSAO = 3;

const empresa = `PRONIX (antiga VDV Group / "Viver de Vendas") — empresa de educação e consultoria para quem vende produto FÍSICO em marketplace, com foco em Mercado Livre. Razão social PRONIX EDUCAÇÃO LTDA, sede física em Mogi Guaçu/SP (em frente à prefeitura; o cliente pode visitar).

QUEM É QUEM:
- Hugo Vasconcelos: fundador e rosto da empresa. Mais de 8 anos vendendo no Mercado Livre; construiu duas operações próprias que, juntas, faturam mais de R$40 milhões por ano na plataforma. Criador do método DVP. Colunista do E-commerce Brasil. Conduz os hotseats do programa Acelera.
- Gustavo Dias: sócio-fundador. Conduz a parte de estratégia financeira e tributária.
- Hendel Favarin e Josef Rubin: fundadores da Conquer Business School, entraram como sócios investidores (minoritários, atuando na estratégia). Se o lead citar "Joseph", "Wendel" ou "os caras da Conquer", é deles que está falando.

PROVAS QUE O CLOSER USA NA REUNIÃO (só entram no relatório como fato do lead se o LEAD citou):
- Mais de 1.500 empresas e pessoas impulsionadas; mais de 520 cases nas consultorias.
- Consultoria GOLD certificada pelo Mercado Livre; 3 anos de operação; equipe de cerca de 100 pessoas, mais da metade especialistas; time de Sucesso do Cliente.
- "Vive o que ensina": a operação própria no marketplace é o laboratório do método.
- Imprensa: Exame, Terra, Forbes, O Globo, E-commerce Brasil. Presença no evento do Mercado Livre.
- Os closers também citam: poucas reclamações no Reclame Aqui para o tamanho da base; participação numa liga de mentores de empresários conhecidos; alguns closers e especialistas têm loja própria no Mercado Livre.
- Cases do material: do zero a R$100 mil/mês em 3 meses; do zero a R$300 mil/mês em 3 e em 6 meses; R$1 milhão/mês em 10 meses; casal que saiu da CLT e chegou a R$104 mil/mês em 3 meses. Nichos variados (autopeças, papelaria, motopeças, brinquedos, suplementos, construção, cosméticos, multinichos).

MÉTODO DVP — decide o produto ANTES de comprar:
- DEMANDA: existe gente comprando esse produto todos os dias?
- VIABILIDADE: dá para competir com margem, caixa e estrutura saudável?
- POSICIONAMENTO: existe espaço real para se diferenciar na primeira página?
Ciclo do negócio: pesquisa de produto (DVP) → comparação de fornecedores → compra → anúncio → venda → repete.

COMO A EMPRESA ENXERGA O MERCADO (ajuda a ler a fala do lead):
- O cliente migra do físico para o online; o Mercado Livre tem mais de 40 milhões de compradores ativos.
- Quem entra sem método compra sem pesquisa, anuncia sem critério, não vende e conclui que "o Mercado Livre está saturado".
- É melhor ter poucos produtos que vendem do que centenas de anúncios parados: a conta é avaliada pela conversão.
- Faturamento não é lucro. A casa fala em margem líquida de 10% a 20% como faixa saudável.
- Riscos de fazer sozinho: não saber o que vender, ninguém ver os anúncios, não conseguir escalar, não ter margem, não ter tempo para executar.

MODELO DE TRABALHO: a casa orienta, ensina e acompanha; QUEM EXECUTA É O CLIENTE ("não fazemos para você, fazemos com você"). O valor é fixo: a PRONIX não fica com porcentagem do faturamento.`;

const oferta = `TODOS OS PROGRAMAS DURAM 12 MESES e trabalham com ESTOQUE FÍSICO (não é dropshipping nem afiliação).

PRX PERFORMANCE (Mentoria PRONIX Performance) — para quem está começando ou já vende e precisa estruturar:
- 1 reunião individual de diagnóstico e planejamento estratégico (no primeiro mês)
- 24 hotseats quinzenais ao vivo com os especialistas (ficam gravados; à noite, pensados para quem é CLT)
- acompanhamento mensal com checklist de execução da conta
- grupo individual no WhatsApp com suporte diário (horário comercial)
- área de membros com a metodologia gravada, planilha de fornecedores validados e plataforma PRONIX Tools
Preço de tabela: 12x de R$1.332 a R$1.552, conforme a campanha vigente. Há condição melhor e bônus para quem decide na própria reunião.

PRX ACELERA (Programa de Aceleração) — nível acima, para quem quer acompanhamento individual o ano todo (é o que os closers oferecem a quem já fatura e tem números de conta para otimizar):
- 12 encontros individuais com especialista dedicado (1 por mês)
- assessoria mensal: o especialista entra na conta do aluno
- 24 hotseats ao vivo com o próprio Hugo Vasconcelos
- grupo individual, metodologia gravada, lista de fornecedores e PRONIX Tools
Preço de tabela: 12x R$2.491. Bônus de fechamento: imersão presencial, distribuidora de produtos exclusiva, sprint de gestão financeira com Gustavo Dias depois de chegar a R$20 mil/mês.

TAMBÉM EXISTEM: PRX Club (clube de empresários, para quem já fatura alto) e o curso de entrada. O pré-vendedor não oferece esses.

PRONIX TOOLS (plataforma dos alunos): calculadora de preço e lucro real para Mercado Livre e Shopee, precificação em massa, compras e reposição de estoque com alerta, gerador de códigos e etiquetas, gerador de roteiro e vídeo de anúncio por IA, clube de parceiros e uma lista de mais de 2.400 fornecedores (alguns com pedido mínimo baixo).

JORNADA DOS 12 MESES: Relevância (1º ao 3º mês: pesquisa de produtos, ativação do Full, tração da conta com Ads) → Escala (3º ao 8º: faturamento, profundidade de estoque, margens) → Performance (8º ao 12º: estratégia financeira e tributária, rentabilidade).

FORMAS DE PAGAMENTO QUE EXISTEM (quem negocia é o closer): cartão em até 12x sem juros; à vista no Pix; entrada no Pix ou cartão e o restante em até 30 dias; cobrança recorrente mensal no cartão, que não toma o limite inteiro; dois cartões. Saber de antemão se o lead TEM cartão e limite poupa muito tempo de reunião.

GARANTIA (é condicional, está no contrato — fale dela exatamente assim): se ao fim dos 12 meses o aluno não recuperar em LUCRO LÍQUIDO o que investiu, a PRONIX devolve o valor, desde que ele tenha aplicado as estratégias nos prazos, participado de pelo menos 70% dos encontros (assistir à gravação conta), enviado as métricas pedidas, pago em dia e comprovado o faturamento da conta. Há ainda os 7 dias de arrependimento com devolução integral. NÃO é "resultado garantido" nem "impossível dar errado".

TRÊS VALORES QUE NÃO SE CONFUNDEM:
- R$3.000 = reserva mínima do lead para comprar o PRIMEIRO ESTOQUE (critério de quem começa do zero). Não é o preço da mentoria.
- cerca de R$12 a 19 mil no ano = PRX Performance; cerca de R$26 a 30 mil = PRX Acelera.
- O pré-vendedor checa se o lead TERIA condição de um investimento dessa ordem ALÉM do estoque; quem apresenta preço, bônus e negocia é o closer.`;

const perfil = `PERFIL IDEAL: quem vende ou quer vender em marketplace com ESTOQUE FÍSICO PRÓPRIO e tem tempo (2 horas por dia) e capital mínimo para executar.
- PERFORMANCE: começando do zero ou já vende e precisa de estrutura.
- ACELERA: já fatura, tem números de conta para otimizar e quer acompanhamento individual mensal.

QUEM COMPRA, NA PRÁTICA (padrões das reuniões que fecharam):
- A maioria NÃO é "do zero puro": já deu um passo sozinho e travou — abriu CNPJ ou conta, comprou estoque, fez algumas vendas, tem loja física, ou já pagou outro curso/mentoria/sistema.
- Lojista físico que não consegue crescer ou sair da loja; CLT ou bancário montando o plano B; quem acabou de sair do emprego; empresário cuja renda principal caiu; quem já vende e não lucra (Ads comendo a margem, reputação caindo, Full sem uso).
- O motivo de ser AGORA quase nunca é dinheiro puro: é tempo com a família, cansaço de trabalhar para os outros, medo de depender de uma renda só, vontade de se provar.

DOIS TIPOS DE LEAD — a meta de cada um muda a reunião inteira:
- DO ZERO. Caminho: 10 primeiras vendas para ativar a reputação → produtos bons → anunciar do jeito certo → escalar → avançar na logística (agências, Full) → vendas diárias. Importa: reserva para o primeiro estoque, o que já tentou, quanto tempo por dia tem.
- JÁ VENDE. Caminho: produtos melhores → fornecedores → anunciar certo → escalar → logística → passar dos R$100 mil/mês e lucrar mais. Importa (o closer usa estes números): faturamento mensal e margem, ACOS dos anúncios (acima de ~10% é gasto errado), se tem Full liberado e se usa, cor da reputação, quantos produtos vende, estoque, por que acha que não escala.

REGIÃO: SP capital e entorno têm a melhor logística e acesso a fornecedor. MG, SC, PR, BA e RJ também têm boa logística no Mercado Livre. Cidade pequena ou distante de capital: registre, porque muda coleta, Full e prazo.

CPF ou CNPJ: dá para começar no CPF, mas o CNPJ é o caminho para a conta ser tratada como profissional e para vários fornecedores venderem. Registre o que o lead tem (MEI, Simples, nada).

FORA DO PERFIL, OU QUE PRECISA SER ALINHADO ANTES DA REUNIÃO:
- Quem procura dropshipping, afiliação ou "alguém que faça tudo por mim". Há exceção que já virou cliente: quem chega com essa ideia mas TEM produto ou estoque próprio e aceita executar. Diga ao lead, ainda na pré-venda, que o modelo é estoque próprio e que ele executa com acompanhamento, e registre a reação.
- Quem não tem e não pretende ter nenhuma reserva; capital muito apertado e sem alternativa (cartão, sócio, fornecedor parceiro).
- Quem não tem nenhum tempo: a casa não executa pelo cliente.

REGRA DE QUALIFICAÇÃO POR PORTE: lead com estrutura evidente — distribuidora, rede de lojas, faturamento alto, estoque grande — NÃO passa por qualificação financeira; a capacidade já está demonstrada pelo porte. Registre o porte como capacidade e NÃO trate a ausência de conversa sobre valor como pendência ou falha do SDR.

COMO CADA PERFIL DE LEAD COSTUMA FECHAR (para orientar o closer):
- Analítico: quer números, margem, tempo de retorno e contrato. Fecha com ROI, validação de produto em estoque pequeno e garantia por escrito.
- Cético: pergunta pelas "partes tristes", teme golpe. Fecha com garantia em contrato, honestidade sobre o que pode dar errado e casos de quem começou sem nada.
- Cauteloso: não quer ficar devendo. Fecha com parcela que ele paga mesmo no pior cenário e com quem decide junto presente.
- Dominante: quer o valor logo. Fecha com resposta direta e conta feita na hora.
- Relacional: quer confiar na pessoa. Fecha com conexão verdadeira e atendimento humano.
- Entusiasta: quer começar já. Só precisa de plano concreto e checagem de viabilidade.`;

const script = `O PRÉ-VENDEDOR levanta estes pontos (ordem do roteiro):
1. ORIGEM/GATILHO: como conheceu a PRONIX, o que chamou a atenção e o que o motivou a procurar ajuda AGORA. Há quanto tempo está nessa situação e o que já fez a respeito.
2. NÍVEL: já vende no Mercado Livre OU está começando do zero, e com o que trabalha hoje. O closer abre a reunião confirmando exatamente isto ("o pré-vendedor me passou que você está começando do zero / já vende e trabalha com X, é isso mesmo?") — então isto SEMPRE fica claro no relatório.
3. FILTRO DE MÉTODO: estoque físico, sem dropshipping e sem afiliação; quem executa é o cliente.
4. VIABILIDADE FINANCEIRA:
   - Do zero: reserva mínima de R$3.000 para o PRIMEIRO ESTOQUE. "Você já tem pelo menos esse valor?"
   - Já vende: faturamento, estoque atual e se trocaria de produto se os dados apontarem caminho melhor.
   - LIQUIDEZ: quanto está disponível HOJE (não o patrimônio). De onde sai: reserva, cartão, renda, venda de um bem.
5. DOR/BLOQUEADOR: principal desafio, o que sente que falta, e a nota de 0 a 10 de quanto isso incomoda (para o iniciante, de quanto começar é prioridade). Nota dada entra no relatório com o número.
6. DECISÃO: decide sozinho ou tem sócio/cônjuge envolvido — e se essa pessoa CONSEGUE participar da reunião.
7. QUALIFICAÇÃO DE FECHAMENTO: a solução gira em torno de R$15 mil em até 12x; o pré-vendedor checa se o lead teria condição desse investimento além do estoque.

O QUE O CLOSER REALMENTE USA DO RELATÓRIO (visto nas reuniões que fecharam: com isto em mãos, o diagnóstico cai de 50 para 5 minutos):
- Do zero ou já vende, com o quê, há quanto tempo.
- O MOTIVO DE SER AGORA, nas palavras do lead.
- A META EM REAIS por mês ("tirando 7 mil eu peço demissão", "quero 30 mil até dezembro").
- O capital, com LIQUIDEZ: quanto está livre hoje. "30 mil" que na verdade são 5 mil em conta e um carro para vender mudam a reunião.
- O TETO TOTAL que ele imagina investir, somando mentoria e estoque. Lead com "5 mil para tudo" precisa chegar ao closer sabendo a ordem de grandeza do programa.
- CARTÃO: tem? é dele? tem limite? Em boa parte das vendas o fechamento dependeu só da forma de pagamento.
- Quem decide junto e se estará na reunião (e em horário em que possa prestar atenção).
- Tempo por dia e em que horário (CLT: noite).
- EXPERIÊNCIA ANTERIOR: já fez curso, mentoria ou comprou algum sistema? O que deu errado lá? É a informação mais valiosa para o closer de um lead desconfiado.
- CONCORRENTE: está avaliando outra empresa? O que ela ofereceu?
- Para quem já vende: faturamento, margem, gasto com Ads, Full, reputação.
- O que ele espera de um acompanhamento (o closer monta a apresentação em cima disso).

O QUE O CLOSER FAZ NA REUNIÃO (1h a 1h30 quando o handoff vem bom):
- Rapport, posicionamento e um combinado: entender o cenário, apresentar a empresa, e decidir ali um sim ou um não.
- Conecta com o handoff citando o pré-vendedor pelo nome.
- SPIN: por que agora; como a situação atual atrapalha; o que acontece em 6 meses e 1 ano se nada mudar; como a vida melhora resolvendo.
- TRÊS PILARES (do zero): DEDICAÇÃO (tempo por dia, quem mais decide), DIREÇÃO (o que conhece, risco de fazer sozinho), INVESTIMENTO ASSERTIVO (expectativa de lucro, quanto e como investiria).
- QUATRO PILARES (já vende): Análise, Planejamento, Investimento Assertivo e Execução; muitas vezes com o lead compartilhando a tela da conta.
- Antes do preço, três checagens: "o que você mais gostou?", "isso atende o que você esperava?", "tirando o investimento, algo te impediria de começar?".
- Preço, garantia e forma de pagamento.`;

const qualificacao = `SPIN E BANT NA PRÉ-VENDA — a régua para avaliar se a conversa do pré-vendedor qualificou bem.

BANT (o mínimo para a reunião valer; a ordem é necessidade primeiro, dinheiro depois):
- NECESSIDADE: a dor ou o objetivo ficou concreto, nas palavras do lead? ("quero sair do CLT", "vendo 10 mil e não sobra nada")
- ORÇAMENTO: ficou claro quanto ele tem LIVRE hoje, de onde sai, e se tem cartão? Só "tem 20 mil" é parcial.
- AUTORIDADE: quem decide ficou claro? Se há sócio/cônjuge, vai participar da reunião?
- PRAZO: por que AGORA? Há data ou urgência?
Perguntar de dinheiro cedo demais soa interrogatório: o lead responde melhor depois de ter contado a dor.

SPIN (o que faz o lead se convencer sozinho):
- SITUAÇÃO — contexto. Poucas: muita pergunta de situação cansa.
- PROBLEMA — a dor: o que não funciona, o que falta.
- IMPLICAÇÃO — o custo de continuar igual. É a que mais pesa e a mais esquecida.
- NECESSIDADE DE SOLUÇÃO — o lead dizendo o ganho de resolver.

PERGUNTAS QUE MAIS FIZERAM O LEAD SE ABRIR nas reuniões que viraram venda (todas cabem na pré-venda):
- "O que te fez procurar isso AGORA, e não antes?"
- "Há quanto tempo você pensa nisso? E o que você já fez a respeito?"
- "Dá para chegar onde você quer só com o que você já faz hoje?" (lojista: "por que não abrir outra loja?")
- "Como isso te atrapalha no dia a dia?"
- "Se nada mudar nos próximos 6 meses, como fica?"
- "Se eu te desse R$3.000 hoje, você saberia que produto comprar?"
- "Como você escolheu esses produtos? Viu quanta gente procura?" (para quem já comprou ou já vende)
- "Quanto você precisa tirar por mês para isso valer a pena?"
- "Esse dinheiro já está disponível? De onde ele sai?"
- "Você já tentou com outra empresa ou curso? O que faltou lá?"
- "Quem mais participa dessa decisão? Essa pessoa consegue estar na reunião?"
- "O que não pode faltar num acompanhamento para você?"
- Para quem já vende: "quanto fatura e quanto sobra?", "quanto gasta em anúncios?", "tem o Full liberado? usa?".

SINAIS DE UMA BOA PROSPECÇÃO:
- O lead fala mais que o pré-vendedor; as perguntas são abertas (não "é isso?").
- Cada resposta puxa a próxima pergunta (aprofundar o que ele disse, não trocar de assunto).
- Há pelo menos uma pergunta de implicação respondida.
- O lead verbalizou o motivo de ser agora e a meta em reais.
- A entrega só foi apresentada depois de a dor aparecer.
- O modelo foi alinhado: estoque próprio e execução do cliente.
- Terminou com próximo passo claro: reunião marcada, quem participa.

ERROS COMUNS: apresentar a mentoria antes de achar a dor; falar mais do que o lead; aceitar "quero ganhar dinheiro" ou "quero renda extra" sem aprofundar; anotar o patrimônio no lugar do dinheiro disponível; não perguntar quem decide; não perguntar se já tentou antes; pular a implicação; prometer resultado ou prazo que só o closer pode tratar.`;

const objecoes = `COMO A CASA TRATA CADA OBJEÇÃO — com o que de fato funcionou nas reuniões que fecharam. O closer isola todas e deixa a financeira para o fim.

"Não tenho limite no cartão / não tenho esse valor agora" (a mais comum; não é objeção de preço) → entrada no Pix e o restante em até 30 dias; cobrança recorrente mensal, que não toma o limite; dois cartões. Tudo que o lead disser sobre cartão, limite e reserva é ouro no relatório.
"Está pesado para quem está começando" → o closer pergunta: "é a parcela ou o total?", "quanto você tinha se preparado para investir?", "se eu conseguir algo que caiba, a gente decide hoje?". Mostra que a mentoria entra como custo da operação e que o estoque parado ou o gasto errado em anúncios já paga parte dela.
"E se não funcionar comigo?" → garantia condicional do contrato, dita como ela é: em LUCRO, ao fim de 12 meses, para quem executou. Funcionou melhor quando a cláusula foi lida. Reforçar que o resultado depende de execução e de capital.
"Vou ficar preso 12 meses" → é o tempo para estruturar a operação (relevância, escala, performance); a saída foi a forma de pagamento mensal, não encurtar o programa.
"Preciso falar com meu sócio/esposa/namorada" → não se combate. Pergunta-se cedo quem decide; oferece-se uma conversa a três. O ideal é o decisor já estar na reunião: avise o closer antes.
"Outra empresa faz tudo por uma porcentagem do faturamento" → não atacar o concorrente. Aqui o valor é fixo e previsível, a conta e o conhecimento ficam com o cliente, e porcentagem fica cara justamente quando o negócio cresce. Subir centenas de anúncios derruba a conversão da conta.
"Já fiz mentoria e não deu certo" → descobrir O QUE falhou (atendimento, produto fraco, margem, tempo) e responder a isso: grupo com vários especialistas, validação de produto por dados, fornecedores com pedido mínimo baixo.
"Parece fácil demais / tem muito golpe na internet" → honestidade: fácil não é, depende de execução e de capital; empresa com sede física, contrato, reunião gravada, casos com nome.
"O Mercado Livre está saturado" → é o que acontece com quem entra sem método. O DVP mede demanda, viabilidade e posicionamento ANTES da compra.
"Não tenho tempo" → pilar Dedicação: são cerca de 2 horas por dia, em qualquer horário; quem não tem nenhuma não é perfil.
"Preciso aparecer em vídeo?" → não. Vender no Mercado Livre não exige exposição.
"Quero dropshipping / não quero ter estoque" → a casa trabalha com estoque próprio; começa pequeno, validando produto.

DORES QUE O LEAD COSTUMA TRAZER E O CAMINHO QUE A CASA MOSTRA (o que fazer, nunca o como):
- "Não sei por onde começar" → abrir a conta (melhor CNPJ), ativar a reputação com as 10 primeiras vendas, definir os produtos e anunciar bem.
- "Não sei o que vender" → analisar DEMANDA e VIABILIDADE com dados de outros vendedores; não vender o que se gosta, e sim o que tem procura.
- "Não tenho fornecedor" → a mentoria entrega lista validada e parceiros.
- "Anuncio e não vendo / um dia vende, outro não" → título e palavras-chave, foto de capa, oferta competitiva, Full e Ads no momento certo de cada produto.
- "Gasto muito em Ads e não sobra nada" → campanha conforme o momento do produto, métricas toda semana; ACOS saudável é bem abaixo de 10%.
- "Minha reputação caiu" → é prioridade: afeta venda e posição; o Full reduz erro de envio.
- "Qual nicho?" → a casa trabalha multinichos e subcategorias com menos concorrência.
- "Como entro no Full?" → relevância da conta (vendas diárias, prazo, atendimento); CNPJ e nota fiscal configurados. O prazo depende da análise do Mercado Livre: não prometa data.
- Dúvidas de quem nunca vendeu: quem paga o frete, quanto é a taxa, como é a coleta na cidade, que embalagem usar → o especialista resolve na primeira reunião.`;

const PADRAO = { empresa, oferta, perfil, script, qualificacao, objecoes };

// Impressão digital dos textos recomendados de versões anteriores. Na passagem de versão, o campo que
// ainda está igual a um destes (ninguém editou) recebe o texto novo; o que o master editou é mantido.
const PADROES_ANTIGOS = new Set([
  '1454234b29326b13', '7193e683ca4b5d15', '0b7c41cf8bbd6a5b', '037ff21718fe9894', '8115742c2d05997d', '0401e919da964e10', // v2
]);

module.exports = { VERSAO, PADRAO, PADROES_ANTIGOS };
