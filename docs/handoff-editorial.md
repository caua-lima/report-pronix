# Handoff editorial — o que mudou (auditoria de 04/11/2026)

Origem: `REPORT_PRONIX_AUDITORIA_E_PROMPT.md` (auditoria externa sobre o commit `b6c938a`). Branch:
`handoff-estrategico`. **Nada foi publicado:** sem push, sem deploy na Vercel, sem nova versão na loja.

Objetivo: o report vende a oportunidade para o closer **com fundamento** — ele termina a leitura interessado,
preparado e com um caminho específico, e nenhum fato é inflado. A leitura do SDR orienta a estratégia e tem lugar
nobre.

## 1. Diagnóstico conferido no código (os 14 itens da auditoria)

| # | Achado | Confirmado? | O que foi feito | Prova |
|---|---|---|---|---|
| 1 | Prompt v10 mandava assumir "decide sozinho", tratar empresa como capacidade e proibia "a confirmar" | Sim | Prompt v11: silêncio ≠ decide sozinho; empresa/faturamento/profissão não provam verba; incerteza vira "vale alinhar" | `handoff-editorial.test.js` (regras presentes e as antigas ausentes) |
| 2 | Verba de estoque × investimento na mentoria numa linha só | Sim | Panorama separa `capital_operacao` e `capacidade_acompanhamento`; regra "dois destinos de dinheiro" no prompt | fixture `verba_estoque`, exemplos do prompt |
| 3 | Citação aceitava sentido invertido ("Eu tenho dinheiro" × "Eu NÃO tenho") | Sim (reproduzido) | Citação literal: trecho contínuo; "..." não pula negação, condição nem número; modo manual só valida contra falas do lead | `qualidade.test.js`, `fidelidade.test.js` |
| 4 | Filtro "desanimador" descartava dor ("cansado de depender de indicação") | Sim (reproduzido) | Vitrine só recusa o que empurra a decisão para trás (caro, vou pensar, golpe, sem dinheiro para pagar); dor fica | `qualidade.test.js` |
| 5 | Visão anexada depois da estratégia | Sim | Leitura entra no prompt principal em `<leitura_sdr>` e orienta tese, condução e abertura | `handoff-editorial.test.js` |
| 6 | Revisão da visão aceitava R$ 5 mil → R$ 50 mil; limite de 8 tópicos cortava | Sim (reproduzido) | Original imutável; síntese só se preservar valores, negações e nomes; sem limite de tópicos; texto acima de 3000 caracteres recusado com aviso | `visao-sdr.test.js` |
| 7 | Visão era "1ª seção" mas aparecia depois de outros blocos no PDF | Sim | Bloco próprio logo depois da tese, com o único destaque visual | teste de ordem no PDF |
| 8 | Site (`/api/report-texto`) e Instagram sem a visão | Sim | Mesmo contrato no site, WhatsApp e Instagram; mesma regra de quem pode (o servidor libera) | `painel.test.js`, `extensao-dom.test.js` |
| 9 | Abertura repetia Investimento/Motivação/Decisor; frase de impacto em caixa preta | Sim | Formato novo sem frase de impacto e sem ficha embaixo da abertura | teste "cada valor do panorama aparece uma vez" |
| 10 | `CORTES`/`enxugar` apagava conteúdo para caber em 2 páginas | Sim | Removido. O PDF ganha página; nada some | `report-rico.test.js` (testes de 2 páginas trocados por "nada some") |
| 11 | Corte de conversa longa mantinha a pergunta e apagava o "Não." | Sim (reproduzido) | Pergunta + resposta andam juntas; correção leva o que foi corrigido | `fidelidade.test.js` |
| 12 | Muitas escalas competindo (consciência, perfil, termômetro) | Sim | Continuam sendo geradas para a gestão, mas saem do PDF do closer; no painel ficam recolhidas | testes do PDF editorial |
| 13 | `docs/design.md` e testes travavam o visual antigo | Sim | Documento atualizado; testes de integridade mantidos, testes de "caber em 2 páginas" trocados | este commit |
| 14 | Segunda geração por "poucas seções" e consumo só da última | Sim | Nova tentativa só com o núcleo vazio; consumo somado (`tentativas`) | `handoff-editorial.test.js` |
| 15 | Trava liberada por quem não a pegou | Sim (estático) | Token por requisição; só o dono solta (GET+DEL atômico no Redis) | `fidelidade.test.js` |

## 2. O formato novo (`schemaVersion: 2`)

```text
lead, negocio, ficha[{rotulo, valor}]           ← ficha = dados sem IA (datas da conversa, profissão do formulário)
tese { titulo, texto }
visaoSdr { original, sintese[], autor, atualizadoEm, statusRevisao: original | sintese_conferida | aprovada }
oportunidade[{ fato, relevancia, origem: lead | sdr | leitura_sdr }]   (até 3)
panorama { objetivo, capital_operacao, capacidade_acompanhamento, timing, decisao, combinado }
         cada um { valor, status: declarado | indicado | informado_sdr | leitura_sdr | a_alinhar }
conducao[{ etapa: Conectar | Aprofundar | Avançar, acao, objetivo, pergunta? }]   (exatamente 3)
abertura, contexto[], citacoes[] (0 a 2, literais), conversa[]
internos (fora do PDF): consciencia, perfil, dores, sinais_compra, analise
metadados: promptVersao (v11), templateVersao (editorial-1), reportId, revisao, edicaoHumana
```

- **Origem dos fatos:** o PDF mostra só o texto; a origem (dito pelo lead, deduzido, dito pelo SDR, leitura do SDR,
  a alinhar) aparece no painel.
- **Sem leitura escrita pelo SDR**, o servidor apaga qualquer item que a IA tenha atribuído a ela.
- **Leitura do SDR:** no PDF vai a síntese conferida ou aprovada; se a síntese mudar valor, negação ou nome, vai o
  texto original dele em tópicos. No painel dá para comparar com o original, aprovar, voltar ao original, desfazer
  e salvar. Nada aparece como "aprovada" sem ele aprovar.

## 3. Compatibilidade

- **Reports antigos** (sem `schemaVersion`): abrem como antes (mesmo desenho de PDF, sem cortes). A tela e o
  texto do CRM continuam funcionando. `vistaEditorial()` adapta um report antigo sem chamar IA.
- **Quem lê `resumo`/`secoes`** (texto do CRM antigo, afinidade/match, .docx): esses campos são derivados do
  formato novo a cada geração e revisão (`sincronizarLegado`).
- **Texto do CRM:** report novo usa a mesma ordem e os mesmos fatos do PDF (`textoEditorial`).
- **Extensão:** a 1.6.24 manda a leitura também no Instagram. Extensão antiga continua funcionando (o servidor
  aceita o pedido sem leitura).
- **Chave de "report igual":** a versão do prompt subiu (v10 → v11), então uma conversa já gerada no v10 gera de
  novo se pedir. Trocar só o desenho do PDF não exige IA.
- **Reabrir/revisar:** o report fica guardado 60 dias (`GET /api/reports/:id/dados`,
  `PUT /api/reports/:id/revisao`, com 409 se outra revisão foi salva antes).

## 4. Como voltar atrás

Tudo está em commits separados na branch `handoff-estrategico`. Para desfazer só o formato novo, reverta os commits
"Handoff editorial" e "Telas do handoff editorial"; o commit de "Fidelidade" (citação literal, corte de conversa,
trava) é independente e pode ficar. Reports gerados no formato novo antes de reverter abrem no desenho antigo, pelos
campos derivados (`resumo`/`secoes`), que guardam os mesmos fatos.

## 5. Testes

`npm test` → 677 testes, sem rede e sem IA real. Novos ou reescritos nesta rodada:
`tests/fidelidade.test.js`, `tests/handoff-editorial.test.js` (inclui as 8 fixtures + estresse),
`tests/visao-sdr.test.js`, partes de `tests/qualidade.test.js`, `tests/report-rico.test.js`, `tests/painel.test.js`
e `tests/extensao-dom.test.js`. Fixtures sintéticas em `tests/fixtures/handoffs.js`.

## 6. O que NÃO foi validado

- **Nenhuma chamada paga foi feita.** O prompt v11 foi testado com a IA simulada. Antes de usar com o time, gere
  2 ou 3 reports reais supervisionados (um com leitura, um sem, um curto) e compare com os antigos.
- **Custo:** não medido. Mudanças que reduzem chamadas (sem segunda geração por "poucas seções", sem chamada
  separada ao Groq para a visão) não foram quantificadas. Medido sem IA: o prefixo do sistema (prompt + playbook
  + exemplos) passou de 55.731 para 54.274 caracteres (cerca de 1,5 mil a menos); a saída da IA tem campos
  diferentes, e o tamanho dela não foi medido.
- **Avaliação com closers:** não feita. Sugestão: dar a 2 ou 3 closers pares de reports (antigo e novo) sem dizer
  qual é qual e perguntar clareza da oportunidade, utilidade da leitura do SDR, preparo para a call e confiança nos
  fatos. Conversão só depois, controlando origem, closer e produto.
- **Painel:** testado por função (jsdom), não por inspeção visual no navegador. O PDF foi inspecionado visualmente
  nas fixtures.
- **WhatsApp e Instagram reais:** a caixa da leitura foi testada em DOM simulado. Vale um teste em cada antes de
  distribuir a 1.6.24.
