'use strict';

// Base de conhecimento recomendada (v2). Montada a partir do material da casa — scripts de
// diagnóstico do closer (planilha "SCRIPTS - Diagnóstico"), apresentações Performance e Aceleração,
// contratos PRX Performance e PRX Acelera — e das notícias públicas sobre a empresa.
//
// É o texto que entra quando o campo ainda não foi escrito, e o que o botão "Usar a base
// recomendada" aplica. O master edita tudo pela aba Base; nada aqui fica preso no código.
//
// Fora daqui de propósito: linhas de negociação e "última linha" de preço (é assunto do closer e
// do gestor, não precisa estar no prompt de todo report).

const VERSAO = 2;

const empresa = `PRONIX (antiga VDV Group / "Viver de Vendas") — empresa de educação e consultoria para quem vende produto FÍSICO em marketplace, com foco em Mercado Livre. Razão social PRONIX EDUCAÇÃO LTDA, sede física em Mogi Guaçu/SP.

QUEM É QUEM:
- Hugo Vasconcelos: fundador e rosto da empresa. Mais de 8 anos vendendo no Mercado Livre; construiu duas operações próprias que, juntas, faturam mais de R$40 milhões por ano na plataforma. Criador do método DVP. Colunista do E-commerce Brasil. Conduz os hotseats do programa Acelera.
- Gustavo Dias: sócio-fundador. Conduz a sprint de gestão financeira do Acelera.
- Hendel Favarin e Josef Rubin: fundadores da Conquer Business School, entraram como sócios investidores (minoritários, atuando na estratégia). Se o lead citar "Joseph" ou "os caras da Conquer", é deles que está falando.

PROVAS QUE O CLOSER USA (só entram no relatório como fato do lead se o LEAD citou):
- Mais de 1.500 empresas e pessoas impulsionadas; mais de 520 cases nas consultorias.
- Consultoria GOLD certificada pelo Mercado Livre; 3 anos de operação; mais de 80 colaboradores; time de especialistas e time de Sucesso do Cliente.
- A operação própria no marketplace é o laboratório do método: "ensina o que vive".
- Imprensa: Exame, Terra, Forbes, O Globo, E-commerce Brasil.
- Cases do material: do zero a R$100 mil/mês em 3 meses; do zero a R$300 mil/mês em 3 e em 6 meses; R$1 milhão/mês em 10 meses; casal que saiu da CLT e chegou a R$104 mil/mês em 3 meses. Nichos variados (papelaria, motopeças, brinquedos, suplementos, construção, infantil, multinichos).

MÉTODO DVP — decide o produto ANTES de comprar:
- DEMANDA: existe gente comprando esse produto todos os dias?
- VIABILIDADE: dá para competir com margem, caixa e estrutura saudável?
- POSICIONAMENTO: existe espaço real para se diferenciar na primeira página?
Ciclo do negócio: pesquisa de produto (DVP) → comparação de fornecedores → compra → anúncio → venda → repete.

COMO A EMPRESA ENXERGA O MERCADO (ajuda a ler a fala do lead):
- O cliente migra do físico para o online; o Mercado Livre tem mais de 40 milhões de compradores ativos.
- Quem entra sem método compra sem pesquisa, anuncia sem critério, não vende e conclui que "o Mercado Livre está saturado".
- Riscos de fazer sozinho: não saber o que vender, ninguém ver os anúncios, não conseguir escalar, não ter margem, não ter tempo para executar.`;

const oferta = `TODOS OS PROGRAMAS DURAM 12 MESES e trabalham com ESTOQUE FÍSICO (não é dropshipping nem afiliação).

PRX PERFORMANCE (Mentoria PRONIX Performance) — para quem está começando ou já vende e precisa estruturar:
- 1 reunião individual de diagnóstico e planejamento estratégico (no primeiro mês)
- 24 hotseats quinzenais ao vivo com os especialistas
- acompanhamento mensal com checklist de execução da conta
- grupo individual no WhatsApp com suporte diário (horário comercial)
- área de membros com a metodologia gravada, planilha de fornecedores validados e plataforma PRONIX Tools
Preço de tabela: 12x R$1.332. Fechando na própria reunião (plano de facilidade): 12x R$997 + bônus (1 mentoria individual extra, plataforma Performance Connect, clube de parceiros, ingresso para a imersão presencial de 2 dias com o Hugo).

PRX ACELERA (Programa de Aceleração) — nível acima, para quem quer acompanhamento individual o ano todo:
- 12 encontros individuais com especialista dedicado (1 por mês)
- assessoria mensal: o especialista entra na conta do aluno
- 24 hotseats ao vivo com o próprio Hugo Vasconcelos
- grupo individual, metodologia gravada, lista de fornecedores e PRONIX Tools
Preço de tabela: 12x R$2.491. Fechando na reunião: 12x R$2.158 + bônus (imersão presencial, acesso à distribuidora de produtos exclusiva, sprint de gestão financeira com Gustavo Dias depois de chegar a R$20 mil/mês).

TAMBÉM EXISTEM: PRX Club (clube de empresários, topo da escada, dezenas de milhares de reais) e o curso de entrada (VDV Start). O pré-vendedor não oferece esses.

PRONIX TOOLS (plataforma dos alunos): calculadora de preço e lucro para Mercado Livre e Shopee, precificação em massa, compras e reposição de estoque, gerador de códigos e etiquetas, clube de parceiros e uma lista de mais de 2.400 fornecedores em vários estados e segmentos.

JORNADA DOS 12 MESES: Relevância (1º ao 3º mês: pesquisa de produtos, ativação do Full, tração da conta com Ads) → Escala (3º ao 8º: faturamento, profundidade de estoque, margens) → Performance (8º ao 12º: estratégia financeira e tributária, rentabilidade). O material fala em margens líquidas de 10% a 20%.

GARANTIA (é condicional, está no contrato): se em 12 meses o aluno não recuperar em LUCRO LÍQUIDO o que investiu, a PRONIX devolve o valor — desde que ele tenha aplicado as estratégias nos prazos, participado de pelo menos 70% dos encontros, enviado as métricas pedidas, pago em dia e comprovado o faturamento da conta. No Acelera pelo plano de facilidade, além de devolver, a PRONIX paga um pix de R$3.000. Há ainda os 7 dias de arrependimento com devolução integral.

TRÊS VALORES QUE NÃO SE CONFUNDEM:
- R$3.000 = reserva mínima do lead para comprar o PRIMEIRO ESTOQUE (critério de quem começa do zero). Não é o preço da mentoria.
- cerca de R$12 a 16 mil (12x) = PRX Performance; cerca de R$26 a 30 mil (12x) = PRX Acelera.
- O pré-vendedor checa se o lead TERIA condição de um investimento dessa ordem; quem apresenta preço, bônus e negocia é o closer.`;

const perfil = `PERFIL IDEAL: quem vende ou quer vender em marketplace com ESTOQUE FÍSICO PRÓPRIO e tem tempo e capital mínimo para executar.
- PERFORMANCE: começando do zero ou já vende e precisa de estrutura.
- ACELERA: quer acompanhamento individual mensal, tem mais capital ou operação que busca escala, fornecedores e gestão financeira.

DOIS TIPOS DE LEAD — a meta de cada um muda a reunião inteira:
- DO ZERO. Caminho: fazer as 10 primeiras vendas para ativar a reputação da conta → escolher produtos bons → anunciar do jeito certo → escalar esses itens → avançar na malha logística (agências, Full) → vendas diárias. Sinais que importam: tem reserva para o primeiro estoque? entende o mínimo do mercado? tem algum planejamento? já tentou antes e perdeu tempo ou dinheiro? quanto tempo por dia consegue dedicar?
- JÁ VENDE. Caminho: escolher produtos melhores → ter fornecedores → anunciar certo → escalar → avançar na logística → passar da barreira dos R$100 mil/mês e lucrar mais. Sinais que importam: quanto fatura hoje e a meta, o que vende, há quanto tempo, se o Mercado Livre é a renda principal, se usa Ads (ACOS acima de 10% é sinal de ajuste) e Full, quanto tem de estoque, por que acha que ainda não escalou, se aceita trocar de produto quando os dados mostram caminho melhor.

REGIÃO: SP capital e entorno têm a melhor logística e acesso a fornecedor (ponto forte para o closer). MG, SC, PR, BA e RJ também têm boa logística no Mercado Livre. Fora desses estados o closer costuma trabalhar outros canais junto (Shopee, Amazon) — vale registrar o estado do lead.

CPF ou CNPJ: dá para começar no CPF, mas o CNPJ é o caminho para a conta ser tratada como profissional e para vários fornecedores venderem. Se o lead falou disso, registre.

FORA DO PERFIL (o closer precisa saber antes da reunião): quem procura dropshipping ou afiliação; quem não tem e não pretende ter nenhuma reserva para o primeiro estoque; quem está com o capital muito apertado e sem alternativa (sócio, fornecedor parceiro, crédito).

REGRA DE QUALIFICAÇÃO POR PORTE: lead com estrutura evidente — distribuidora, rede de lojas, faturamento alto, estoque grande — NÃO passa por qualificação financeira; a capacidade já está demonstrada pelo porte. Registre o porte como capacidade e NÃO trate a ausência de conversa sobre valor como pendência ou falha do SDR. Não faz sentido perguntar de reserva de R$3 mil a quem fatura milhões.`;

const script = `O PRÉ-VENDEDOR levanta estes pontos (ordem do roteiro):
1. ORIGEM/GATILHO: como conheceu a PRONIX, o que chamou a atenção e o que o motivou a procurar ajuda AGORA. Há quanto tempo está nessa situação e se houve um gatilho recente.
2. NÍVEL: já vende no Mercado Livre OU está começando do zero, e com o que trabalha hoje. O closer abre a reunião confirmando exatamente isto ("o pré-vendedor me passou que você está começando do zero / já vende e trabalha com X, é isso mesmo?") — então isto SEMPRE fica claro no relatório.
3. FILTRO DE MÉTODO: estoque físico, sem dropshipping e sem afiliação.
4. VIABILIDADE FINANCEIRA:
   - Do zero: reserva mínima de R$3.000 para o PRIMEIRO ESTOQUE. "Você já tem pelo menos esse valor?"
   - Já vende: quanto tem de estoque e se trocaria de produto se os dados apontarem caminho melhor.
   - LIQUIDEZ: o valor já está disponível? De onde viria (reserva, cartão, renda, empréstimo)?
5. DOR/BLOQUEADOR: principal desafio, o que sente que falta, e a nota de 0 a 10 de quanto isso incomoda (para o iniciante, de quanto começar é prioridade). Nota dada entra no relatório com o número.
6. DECISÃO: decide sozinho ou tem sócio/cônjuge/familiar envolvido — e se essa pessoa CONSEGUE participar da reunião.
7. QUALIFICAÇÃO DE FECHAMENTO: a solução gira em torno de R$15 mil em até 12x; o pré-vendedor checa se o lead teria condição desse investimento.

O QUE O CLOSER FAZ NA REUNIÃO (1h a 1h30) — quanto mais disto o relatório já trouxer, menos ele recomeça do zero:
- Abre com rapport, se posiciona e conecta com o handoff do pré-vendedor.
- SPIN: o que motivou buscar algo diferente AGORA; como a falta de dinheiro/tempo/liberdade atrapalha hoje; o que acontece em 6 meses e em 1 ano se nada mudar; como a vida melhora resolvendo. O lead precisa VERBALIZAR que tem de fazer algo diferente.
- Compra do modelo de negócio: por que o Mercado Livre resolve o desafio dele.
- TRÊS PILARES (lead do zero):
  1) DEDICAÇÃO — quanto tempo por dia tem para o negócio; quem mais participa ou pode vetar e o que essa pessoa acha.
  2) DIREÇÃO — o que conhece do mercado; o risco de perder tempo e dinheiro sozinho; se sente que precisa de ajuda.
  3) INVESTIMENTO ASSERTIVO — expectativa CONCRETA de lucro por mês (em 6 meses e em 1 ano), quanto faz sentido investir por mês e COMO investiria (reserva, cartão, renda, empréstimo).
- Lead que já vende: QUATRO PILARES — Análise (como escolhe produto), Planejamento, Investimento Assertivo e Execução.
- Venda da solução: o que ele espera de um acompanhamento profissional; se já falou com outra empresa e o que o impediu de fechar.
- Recapitula, faz o pacto de sim ou não, apresenta, checa comprometimento e só então fala de preço.

O QUE VALE OURO NO RELATÓRIO (o closer usa na hora): a fala do lead sobre o motivo de ser AGORA; há quanto tempo vive o incômodo; tempo disponível por dia; quem mais decide; o número de lucro que ele espera; de onde sairia o dinheiro; o que ele espera do acompanhamento; se já tentou com outra empresa.`;

const qualificacao = `SPIN E BANT NA PRÉ-VENDA — a régua para avaliar se a conversa do pré-vendedor qualificou bem.

BANT (o mínimo para a reunião valer; aqui a ordem é necessidade primeiro, dinheiro depois):
- NECESSIDADE: a dor ou o objetivo ficou concreto, nas palavras do lead? ("quero sair do CLT", "vendo R$20 mil e não passo disso")
- ORÇAMENTO: ficou claro que ele tem ou consegue o capital — reserva para o estoque e condição para o investimento? De onde sairia?
- AUTORIDADE: quem decide ficou claro? Se há sócio/cônjuge, vai participar da reunião?
- PRAZO: há urgência ou data ("quero começar este mês", "até o fim do ano")? Por que AGORA?
Perguntar de dinheiro cedo demais soa interrogatório: o lead responde melhor depois de ter contado a dor.

SPIN (o que faz o lead se convencer sozinho):
- SITUAÇÃO — contexto: "Você trabalha com o quê hoje?", "Já vende online ou está começando?", "Há quanto tempo?". Poucas: muita pergunta de situação cansa e não gera valor.
- PROBLEMA — a dor: "O que não está funcionando?", "O que te fez procurar isso agora?", "O que sente que falta?".
- IMPLICAÇÃO — o custo de continuar igual. É a que mais pesa e a mais esquecida: "Se nada mudar nos próximos 6 meses, como fica?", "Há quanto tempo isso te incomoda?", "Quanto isso te custa por mês?", "O que já tentou para resolver?".
- NECESSIDADE DE SOLUÇÃO — o lead dizendo o ganho: "Se você resolve isso, o que muda na sua vida?", "Por que agora é o melhor momento?", "Como você acha que vender no Mercado Livre ajuda nisso?".

SINAIS DE UMA BOA PROSPECÇÃO:
- O lead fala mais que o pré-vendedor; as perguntas são abertas (não "é isso?").
- Cada resposta puxa a próxima pergunta (aprofundar o que ele disse, não trocar de assunto).
- Há pelo menos uma pergunta de implicação respondida.
- O lead verbalizou o motivo de ser agora.
- A entrega só foi apresentada depois de a dor aparecer.
- Terminou com próximo passo claro: reunião marcada, quem participa, o que o lead deve levar.

ERROS COMUNS: apresentar a mentoria antes de achar a dor; falar mais do que o lead; aceitar "quero ganhar dinheiro" sem aprofundar; não perguntar quem decide; pergunta fechada no lugar da aberta; pular a implicação.`;

const objecoes = `COMO A CASA TRATA CADA OBJEÇÃO (o closer isola todas e deixa só a financeira para o fim; a negociação só começa depois disso):

"E se não funcionar comigo?" → garantia condicional do contrato: participou, aplicou o método e não recuperou em lucro o que investiu, recebe o valor de volta. Reforçar que o resultado depende de execução.
"Está caro" → ancorar no valor das entregas e no retorno dos cases; perguntar se o investimento faz sentido diante do retorno. Checagem: "tirando a parte financeira, você está fechado?".
"Vou pensar / preciso analisar" → é o que o pacto de sim ou não antecipa. O plano de facilidade (preço menor + bônus) vale para quem decide na reunião, porque entrar antes reduz o custo comercial e isso vira desconto.
"O Mercado Livre está saturado" → é o que acontece com quem entra sem método. O DVP mede demanda, viabilidade e posicionamento ANTES da compra.
"Preciso falar com meu sócio/esposa" → por isso o roteiro pede o decisor na reunião. Se ele não vai estar, o closer precisa saber antes: prepara um resumo ou já propõe a segunda conversa com os dois.
"Não tenho tempo" → pilar Dedicação: quantas horas por dia tem; o método usa IA e processo para "2 horas valerem por 8".
"Não tenho dinheiro agora" → separar o que é capital para estoque e o que é investimento na mentoria; mapear de onde pode vir (reserva, cartão, entrada + parcelas). Capital muito apertado e sem alternativa não é perfil.
Financeira na negociação → o closer decompõe: é o valor da parcela ou o limite do cartão? Consegue uma entrada? Qualquer coisa que o lead tenha dito sobre forma de pagamento, reserva ou limite é ouro no relatório.

DORES QUE O LEAD COSTUMA TRAZER E O CAMINHO QUE A CASA MOSTRA (o que fazer, nunca o como):
- "Não sei por onde começar" → abrir a conta (CPF ou CNPJ, melhor CNPJ), ativar a reputação com as 10 primeiras vendas, definir os produtos e anunciar bem.
- "Não sei o que vender" → analisar DEMANDA e VIABILIDADE com dados de outros vendedores, usando ferramenta de pesquisa de mercado.
- "Não tenho fornecedor" → há muito fornecedor acessível hoje; a mentoria entrega lista validada.
- "Não sei anunciar / não escalo" → título e palavras-chave, foto de capa, oferta competitiva, promoções, Full e Ads no momento certo de cada produto.
- "Qual nicho?" → a casa trabalha multinichos e subcategorias com menos concorrência; o padrão de análise é o mesmo.
- "Gasto muito em Ads" → campanha conforme o momento do produto, métricas revisadas toda semana; não precisa gastar muito no começo.
- "Como entro no Full / saio dos Correios?" → relevância da conta (vendas diárias, prazo, atendimento), pedir toda semana; CNPJ e emissor de nota configurados.`;

const PADRAO = { empresa, oferta, perfil, script, qualificacao, objecoes };

module.exports = { VERSAO, PADRAO };
