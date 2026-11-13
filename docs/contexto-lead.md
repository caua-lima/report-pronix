# Contexto do lead - Report PRONIX

A aba **Pesquisar contexto do lead** prepara buscas públicas por nome, e-mail, empresa e cidade. Os links abrem no buscador apenas após o clique. O usuário pesquisa, confere a identidade e registra as fontes; o aplicativo não consulta bases de enriquecimento nem importa resultados automaticamente.

## Fluxo

1. Informe nome e, quando disponíveis, e-mail, empresa e cidade.
2. Prepare as pesquisas e abra os links relevantes.
3. Registre a URL, a data da consulta e os fatos observados. Marque a identidade somente depois de conferir se é o mesmo lead ou a empresa informada.
4. Escreva sua visão estratégica, gancho, perguntas e lacunas. Não transforme cargo, empresa ou presença pública em comprovação de orçamento ou decisão de compra.
5. Visualize, revise e baixe o PDF separado. Alterar o conteúdo invalida a revisão anterior.

## Custos e limites

- Sem nova assinatura, API paga, chave de fornecedor ou chamada de IA.
- O PDF usa a dependência PDFKit já presente no projeto. A renderização usa a infraestrutura existente; continua sujeita às cotas e eventuais custos do plano de hospedagem. Não existe promessa de infraestrutura ilimitada gratuita.
- Não promete encontrar o LinkedIn pelo e-mail. E-mails pessoais podem não ter resultados públicos.
- Não há importação automática de páginas, scraping, consulta de dados privados ou validação automática de identidade.
- Até 12 fontes, com limites explícitos de tamanho por campo; rejeita excesso em vez de truncar conteúdo silenciosamente.
- Fontes não confirmadas são sinalizadas na prévia e no PDF.

## Dados e separação

Os campos ficam somente na memória da página e são perdidos ao recarregar. Ao abrir uma busca, seus termos são enviados ao buscador. Ao baixar, o contexto é enviado ao próprio servidor autenticado apenas para renderizar o PDF; não há persistência, cache, envio ao closer, anexo ao report ou entrada no ZIP dos reports.

Rota: `POST /api/contexto-lead/pdf`, com a chave de acesso existente no painel. Não usa senha administrativa como substituto da identidade do usuário. Para usar, configure sua chave na aba Gerar report.

## Validação

`node --test tests/contexto-lead.test.js` verifica consultas, fontes, limites, revisão, PDF longo e formulário. Exemplo visual do PDF usa dados fictícios. Nenhuma alteração é necessária no banco, nas variáveis de ambiente ou na extensão.
