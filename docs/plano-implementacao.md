# Plano de implementação — pós-auditoria

Status de cada achado em [`auditoria-pronix.md`](auditoria-pronix.md). Lista do que falta em [`checklist-pendencias.md`](checklist-pendencias.md).

Princípio: mudanças pequenas, cada uma com teste e fácil de reverter. Nada de reescrever o que funciona.

## Concluído

| Etapa | Itens | Onde subir |
|---|---|---|
| 1 — Integridade e segurança do cliente | A01 (parcial), A02, A08, A12, A13, A17, A20 | `git push` + extensão |
| 2 — Confiabilidade da captura | A03, A04, A05, A06, A01 (janela de tempo) | extensão 1.5.0 + servidor |
| 3 — Dados e concorrência | A09, A10, A11, A15, A16, A21 | extensão 1.5.0 + `git push` |
| 6 — UX e segurança restantes | A13, A14, A18, A19 e a varredura de `innerHTML` | extensão 1.5.0 + `git push` |
| 4 — Qualidade (parte segura) | prompt v2, conferência de citações, suíte sintética | `git push` |
| 5 — Custos (parte segura) | cache de transcrição, baseline no painel | `git push` |

Extensão: **1.5.1** (manifest, popup, background e os dois content scripts mudaram → precisa enviar o zip à Chrome Web Store).
Servidor/painel: só `git push origin main`.

## O que ainda pode ser feito (nada aqui bloqueia o uso)

### 1. Status por campo e origem das afirmações (Etapa 4, a parte de risco)
- **Ideia:** cada linha do resumo com `status` (confirmado, inferido, não informado, conflitante) e a lista de mensagens de onde veio.
- **Por que não entrou:** exige numerar as mensagens no prompt e mudar o schema da ferramenta e o PDF. Não há como validar se o modelo mantém o formato das citações sem chamadas pagas reais.
- **Como fazer com segurança:** rodada supervisionada, com uma conversa de teste sua e a API real, comparando o report antigo e o novo lado a lado. Só então ligar para todos.

### 2. Avaliar modelo mais barato (Etapa 5)
- Deixar o baseline do painel rodar 2–4 semanas (custo médio, % de cache, capturas parciais).
- Rodar o mesmo conjunto de conversas sintéticas (`tests/qualidade.test.js`) contra o modelo candidato e comparar. Não promete economia antes disso.

### 3. Melhorias pequenas (se o uso pedir)
- A01 por completo: amarrar o áudio à mensagem por um sinal confiável (hoje não existe um no DOM do WhatsApp/Instagram).
- Chave do SDR no painel fora do `localStorage` (exige sessão por cookie).
- Instagram: se o layout mudar, o primeiro sintoma é a leitura vir curta; o console mostra `[CR-instagram v1.5.1] passo N: janela X msg | +Y nova(s)`.

## Decisões que já foram tomadas (sem confirmar com você)

Você pediu para fazer tudo; onde a decisão era necessária, escolhi o mais seguro e deixei anotado:

1. **Domínio de produção:** `report-pronix.vercel.app` (é o que já está no popup e no README). Se houver outro domínio em uso, avise.
2. **SDR reabre os próprios PDFs:** sim, só os dele; o admin abre qualquer um; de outra pessoa responde "não encontrado".
3. **Retenção de PDFs:** sem prazo automático (ficam até o admin excluir), como já era, e descrito na política de privacidade.
4. **Cache de transcrição:** 24h, só o texto, chaveado por hash do áudio; descrito na política de privacidade. `TRANSCRIPTION_CACHE_TTL_SEG=0` desliga.
