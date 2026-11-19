# Auditoria — closers, faturamento e reuniões (19/11/2026)

Registro das alterações feitas no servidor `report-pronix.vercel.app` (dados, não código).
O código do servidor não está neste repositório; aqui fica o histórico do que foi mexido e por quê.

## 2026-11-19 — Diagnóstico: closers, faturamento e reuniões não batiam com o RD

Conta usada: master (Cauã Lima). Período analisado: reports de 13/10 a 19/11/2026 (95 reports).

Achados:
- Só 1 closer cadastrado na aba **Closers** (Paulo Henrique Pagoti). Todos os outros closers do RD
  apareciam como "este closer não está cadastrado em Closers (ou o nome não bate)".
- 70 de 95 reports sem closer; 9 das 14 vendas confirmadas no RD (~R$ 115 mil) sem closer.
- 11 de 16 reuniões realizadas no RD sem resultado marcado no Report PRONIX.
- 2 reports "Conta comercial" vinculados a um contato genérico (RD diz vendido pela Jenniffer;
  o sistema mostra em follow-up, closer Paulo, ticket 0).
- 7 leads não encontrados no RD por homônimos (falta telefone/e-mail).
- Aba "Resultados da reunião" abre por padrão em **Hoje** + **Só os meus**.

## 2026-11-19 — Cadastro dos closers do time (nomes iguais ao RD)

Aba **Closers** → Adicionar (`POST /api/admin/closers`), nome exatamente como o dono do card no RD:
Amarildo Queiroz, Giovane Ribeiro, Raphael Cassiano Ribeiro, André Granato Oliveira,
Daniel Camargo de Andrade, Gabrielle Machado, Jenniffer, Pedro Henrique Melo Palermo,
Pedro Henrique Pasin, Rôselaynne Lima Costa Cabral, Zayra Beatriz da Silva Lima.
(Paulo Henrique Pagoti já existia.)

## 2026-11-19 — Repuxada do RD de 01/10 a 19/11

`POST /api/master/vendas-rd?de=2026-10-01&ate=2026-11-19` em lotes de 10 até `restantes: 0`.
Resultado: reports sem closer caíram de 70 para 35 (os 35 restantes ainda não chegaram à reunião);
13 das 14 vendas com closer correto (a 14ª é da Lívia Moura, Inside - Vekta, outro time).
Meus closers passou a incluir André Granato Oliveira.
Restou fora: Igor Martins (não está na lista atual de closers).

## 2026-11-19 — Cadastro de Victoria e Washington

Nomes confirmados pelo Cauã na lista de usuários do RD: Victoria Pinheiro de Carvalho, Washington Gomes da Silva.
Total de closers cadastrados: 14.

## Pendente — nomes duplicados em "Meus closers"

O campo de closer do RD tem grafias diferentes para a mesma pessoa:
- "Pedro Pasin" (5 reuniões em nov) e "Pedro Henrique Pasin" (3)
- "Zayra" (2) e "Zayra Beatriz da Silva Lima" (2)

O campo "Apelido" do closer só muda o texto do botão "Analisar Match"; não junta nomes nos números.
Correção possível: padronizar os cards no RD, ou alterar o código do servidor (não disponível aqui).

## 2026-11-19 — Correção no código (branch `fix/closers-nome-oficial-rd`)

As duplicatas acima foram resolvidas no servidor, sem precisar mexer no RD:
- `src/timeComercial.js`: lista de closers do time com o nome oficial (igual ao usuário do RD) e as grafias
  alternativas (`outros`). Funções `closerDoTime()` e `nomeOficial()`.
- `src/painelClosers.js`: "Meus closers" e "Closers do time" somam pelo nome oficial (cache `closers5_`).
- `src/handoffsRealizadas.js` e `src/indicacaoCloser.js`: handoffs e "Qual closer para este lead?" pelo nome
  oficial (base `ic_base3`). Antes, Gabrielle, Jenniffer, Zayra e Pedro Henrique Pasin ficavam fora.
- Testes: `tests/handoffs-realizadas.test.js` cobre as grafias duplicadas. Closers: 24/24 passando.

Fora do time atual (não cadastrados de propósito): Igor Martins, Vitor Santos, Lívia Moura (Inside - Vekta).

## 2026-11-19 — No ar (merge direto na main, autorizado pelo Cauã)

- report-pronix: `main` em f771d84 (fast-forward da branch `fix/closers-nome-oficial-rd`).
- report-closer: `main` em 024cb74 (fast-forward da branch `fix/closer-nome-abreviado-rd`), mesma correção do `acharCloser`.
- Conferido no site após o deploy (Meus closers, time todo, novembro): uma linha por closer.
  Pedro Henrique Pasin 8 reuniões / 2 vendas (antes dividido em 3 + 5) e Zayra Beatriz da Silva Lima 4 reuniões
  (antes 2 + 2). Igor Martins agora aparece em "fora da tabela", por não estar no time atual.

## 2026-11-19 — Acesso da Juliana Ferreira (só os closers dela)

Pedido do Cauã: a Juliana vê apenas os closers dos leads dela.
- Código (main 3ca1ec1): nova aba liberável `meusclosers`. Quem não é master vê só a própria tabela; o servidor ignora
  pedido de outro SDR ou do time (`soOsMeus`). Testes: painel-closers e painel (113/113).
- Usuária criada: Juliana Ferreira, papel SDR, id d6649082abb1, com só a aba `meusclosers` liberada. Acesso por chave
  individual (o sistema não tem login com usuário e senha); a chave fica na aba Acessos e não foi registrada aqui.
- Conferido com a chave dela no site: /api/master/closers-do-sdr devolve só "Juliana Ferreira" mesmo pedindo
  `sdr=Cauã Lima` ou `sdr=time`; resultados, leads-respondeu, usuários e cadastro de closers → 401/403.
