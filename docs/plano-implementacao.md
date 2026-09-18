# Plano de implementação — pós-auditoria

Ver o status de cada achado em [`auditoria-pronix.md`](auditoria-pronix.md).
Princípio: mudanças pequenas, uma por commit, cada uma com teste e fácil de reverter. Nada de reescrever o que funciona.

## Feito nesta rodada (Etapa 1 — integridade e segurança do cliente)

A01 (parcial), A02, A08, A09 (texto), A12, A13 (parcial), A17, A20 + `npm test`.
Extensão sobe para **1.4.4** (precisa enviar o zip à Chrome Web Store); o resto é servidor/site (`git push`).

## Etapa 2 — Confiabilidade da captura (próxima)

| Item | Ideia | Como provar |
|---|---|---|
| A03 trava de conversa | Ler a identidade da conversa (nome/cabeçalho e, no WhatsApp, o chat aberto) no início e a cada passo; se mudar, abortar com aviso claro e **não** enviar nada | Teste com DOM simulado trocando o cabeçalho no meio |
| A04 `captureQuality` | Enviar `{audios, transcritos, mensagens, incompleto}` ao servidor; o PDF/painel marcam "captura parcial" quando faltar áudio | Teste no `background.js` + servidor |
| A06 áudio | Aceitar só formatos reconhecidos (ou desconhecido com mais evidência); nome do arquivo pelo tipo real | Fixtures binárias sintéticas |
| A01 completo | Amarrar o blob à mensagem (duração/posição), não só ao tempo | Mock com dois áudios quase simultâneos |
| A05 dedup | Chave incluindo remetente e posição; nunca descartar repetição legítima | Fixtures de conversas com "ok", "ok", "ok" |

Risco: tudo aqui mexe na leitura que acabou de funcionar (Instagram v1.4.3). Só entra com fixtures sintéticas e teste manual em conversa própria.

## Etapa 3 — Persistência e concorrência

- A09 completo: rota para o SDR abrir **o próprio** report existente (`existente.id`) sem chamar a IA. Decisão necessária: SDR pode ver PDFs só dos seus reports?
- A15: enviar só o campo alterado e uma versão (`updatedAt`) para detectar conflito.
- A10/A11: `ultimoReport` por usuário/servidor e limpeza ao trocar de chave.
- A16: carregar cada aba de admin sob demanda.
- A21: ledger de consumo separado dos reports (excluir report não apaga o gasto). Mantém "resultado em branco = sem venda".

## Etapa 4 — Qualidade do report

Só depois de existir uma suíte de 30–50 conversas sintéticas com resultado esperado:
- campos com status (confirmado/inferido/não informado/conflitante) e `sourceMessageIds`;
- regras comerciais (faturamento ≠ lucro, pergunta do SDR ≠ afirmação do lead, correção do lead prevalece, citação bate com a fonte, proteção contra instrução dentro da conversa);
- manter o tom **só positivo** e a regra de decisor "fechado", já definidos pelo dono.

## Etapa 5 — Custos (com medição)

1. Medir baseline (custo por report, tokens de entrada/saída, % de cache) a partir dos dados que já são registrados.
2. Reabrir report existente (A09) — elimina o maior desperdício sem risco.
3. Cache de transcrição por hash da mídia.
4. Só então avaliar modelo mais barato, com a suíte da Etapa 4. Nenhuma economia é prometida antes do baseline.

## Etapa 6 — UX e segurança restantes

- A13 completo: estreitar `host_permissions` ao domínio de produção (decisão: qual é o domínio definitivo?).
- A14: senha reserva de admin fora do `sessionStorage`; máscara de chaves na lista.
- A18: fatiar prints longos antes de reduzir.
- A19: timeouts e limites de payload.
- Varredura completa dos `innerHTML` do dashboard (A12 restante).

## Decisões que dependem do dono da ferramenta

1. Domínio de produção definitivo (para estreitar `host_permissions`).
2. SDR pode reabrir os próprios PDFs?
3. Política de retenção de PDFs (hoje ficam até o admin excluir; a privacidade descreve isso).
