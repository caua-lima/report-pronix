# Checklist — o que falta para terminar

Atualizado em 18/09/2026, com a extensão **1.5.0** e todo o trabalho da auditoria feito e testado (117 testes).
Detalhes técnicos em [`auditoria-pronix.md`](auditoria-pronix.md) e [`plano-implementacao.md`](plano-implementacao.md).

## A. Feito

- [x] Achados A01–A21 tratados (status de cada um em `auditoria-pronix.md`)
- [x] Prompt v2, conferência de citações sem IA, cache de transcrição, baseline no painel
- [x] Extensão 1.5.0 empacotada (`C:\Users\caual\Downloads\PRONIX-extensao-loja.zip`)
- [x] 117 testes automáticos (`npm test`), sem rede e sem custo
- [x] Merge local na `main`

## B. Com você (nada disso eu consigo fazer daqui)

- [ ] `git push origin main` (sobe servidor, painel, documentação e o zip de download do painel)
- [ ] Conferir na Vercel que o deploy terminou e abrir o painel (aba **Reports gerados**: deve aparecer a linha "No período: …% da entrada veio do cache…")
- [ ] Carregar a extensão 1.5.0 e testar **antes de enviar à loja**:
  - [ ] WhatsApp: gerar 1 report com áudio. Conferir "N áudio(s) transcrito(s)"
  - [ ] WhatsApp: gerar de novo a mesma conversa → deve aparecer **Abrir o existente** / **Gerar de novo**
  - [ ] WhatsApp: abrir outra conversa no meio da leitura → deve avisar "A conversa mudou…" e não gerar
  - [ ] Instagram: gerar 1 report numa conversa longa (e, se der, com áudio). Se faltar mensagem, mandar as linhas `[CR-instagram v1.5.0]` do console (F12)
  - [ ] Ouvir um áudio normalmente depois do report (o som tem que funcionar)
- [ ] Enviar `PRONIX-extensao-loja.zip` (1.5.0) à Chrome Web Store
  - [ ] A permissão de hosts diminuiu (só `report-closer.vercel.app`): a loja pode pedir uma justificativa curta
  - [ ] Conferir a declaração de privacidade da loja com a política nova
- [ ] Confirmar `GROQ_API_KEY` na Vercel e testar 1 print (aba manual) e 1 print bem comprido
- [ ] Mandar a lista limpa de closers (nome completo + e-mail) para cadastrar todos de uma vez

## C. Se algo do teste acima falhar

- Instagram lendo menos mensagens: mandar as linhas do console. É o ponto mais sensível a mudança de layout.
- Extensão dando "servidor inválido": conferir a URL no popup (só `https://…` ou `http://localhost`).
- Um report que sempre aborta com "A conversa mudou": mandar um print do console; a trava é conservadora no Instagram (só o endereço) e no WhatsApp (id da conversa).

## D. Ainda não feito (de propósito)

- [ ] Status por campo (confirmado/inferido) e origem por mensagem: precisa de rodada supervisionada com a API real (ver plano)
- [ ] Avaliar modelo mais barato: depois de algumas semanas de baseline no painel
- [ ] Integração com o RD Station CRM (adiada por você)
- [ ] "IA que aprende" perfil de lead × closer (adiada por você)
- [ ] Fases 2–9 da spec grande
