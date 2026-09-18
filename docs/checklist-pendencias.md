# Checklist — o que falta para terminar

Atualizado em 18/09/2026, depois do commit `6d3471c` (extensão 1.4.4, já na `main` e no `origin/main`).
Detalhes técnicos em [`auditoria-pronix.md`](auditoria-pronix.md) e [`plano-implementacao.md`](plano-implementacao.md).

## A. Já feito

- [x] Correções da auditoria da Etapa 1 (A01 parcial, A02, A08, A09 texto, A12, A13 parcial, A17, A20)
- [x] `npm test` (25 casos) e documentos da auditoria
- [x] Merge na `main` e `git push origin main`

## B. Com você (nada disso eu consigo fazer daqui)

Testes na prática, **antes** de mandar a extensão para a loja:

- [ ] Abrir `chrome://extensions`, carregar a pasta `extension/` (1.4.4) e atualizar a aba do WhatsApp (F5)
- [ ] **WhatsApp:** gerar 1 report com pelo menos 1 áudio. Conferir "N áudio(s) transcrito(s)" no aviso final
- [ ] **WhatsApp:** depois do report, ouvir um áudio normalmente. O som tem que funcionar (era o defeito do A02)
- [ ] **Instagram:** gerar 1 report numa conversa longa. Conferir se leu tudo. Se faltar mensagem, copiar as linhas `[CR-instagram v1.4.4]` do console (F12) e me mandar
- [ ] **Instagram, áudio:** gerar com 1 áudio e ver se transcreveu (linhas `[CR-ig-audio v1.4.4]`). Anotar se o áudio ficou marcado como "ouvido"
- [ ] **Site:** abrir `/privacidade.html` no site publicado e conferir o texto novo (a Vercel publica sozinha depois do push)

Publicação e configuração:

- [ ] Enviar `C:\Users\caual\Downloads\PRONIX-extensao-loja.zip` (1.4.4) à Chrome Web Store, só depois dos testes acima
- [ ] Na loja, conferir se a declaração de privacidade bate com a política nova (Instagram, PDF guardado, rolagem e áudio no mudo)
- [ ] Confirmar que `GROQ_API_KEY` está nas variáveis da Vercel e testar 1 print na aba manual (leitura de imagem)
- [ ] Mandar a lista limpa de closers (nome completo + e-mail) para cadastrar todos de uma vez. Não vou inventar nomes

Decisões que travam itens:

- [ ] Qual é o domínio definitivo de produção? (destrava estreitar `host_permissions`, A13)
- [ ] O SDR pode reabrir os próprios PDFs? (destrava "Abrir existente", A09)
- [ ] Por quanto tempo guardar os PDFs? Hoje ficam até o admin excluir

## C. Comigo (por etapa, na ordem recomendada)

Só começo a Etapa 2 depois do resultado dos testes do WhatsApp e do Instagram acima, para não empilhar mudança em cima de algo não validado.

**Etapa 2 — captura**
- [ ] A03: abortar se a conversa mudar no meio da leitura
- [ ] A04: enviar `captureQuality` (áudios achados e transcritos) e marcar "captura parcial" no report
- [ ] A06: aceitar só formatos de áudio reconhecidos; nome do arquivo pelo tipo real
- [ ] A01 completo: amarrar o áudio à mensagem (não só ao tempo)
- [ ] A05: parar de perder mensagens repetidas legítimas ("ok", "ok")

**Etapa 3 — dados e concorrência**
- [ ] A09 completo: "Abrir existente" sem chamar a IA
- [ ] A15: salvar só o campo alterado, com detecção de conflito
- [ ] A10/A11: último report por usuário; limpar ao trocar de chave
- [ ] A16: carregar cada aba de admin sob demanda
- [ ] A21: registro de consumo separado (excluir report não apaga o gasto)

**Etapa 6 — UX e segurança restantes**
- [ ] A13 completo: estreitar `host_permissions`
- [ ] A14: senha reserva de admin fora do `sessionStorage`; mascarar chaves na lista
- [ ] A18: fatiar prints longos em vez de reduzir
- [ ] A19: timeouts e limite de payload
- [ ] Varredura dos demais `innerHTML` do painel

**Etapas 4 e 5 — qualidade do report e custos (dependem de medir antes)**
- [ ] Medir o custo atual por report (baseline)
- [ ] Criar 30–50 conversas sintéticas com resultado esperado
- [ ] Campos com status (confirmado, inferido, não informado) e fonte
- [ ] Cache de transcrição por hash da mídia

## D. Adiado de propósito

- [ ] Integração com o RD Station CRM ("vamos deixar isso pra depois")
- [ ] "IA que aprende" qual perfil de lead fecha com qual closer (precisa de volume de resultados marcados)
- [ ] Fases 2–9 da spec grande (report estruturado, pré-visualização, redesenho do PDF, observabilidade)
