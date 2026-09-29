# Checklist — o que falta para terminar

Atualizado em 28/09/2026, com a extensão **1.5.3** e todo o trabalho da auditoria feito e testado (117 testes).
Detalhes técnicos em [`auditoria-pronix.md`](auditoria-pronix.md) e [`plano-implementacao.md`](plano-implementacao.md).

## A. Feito

- [x] Achados A01–A21 tratados (status de cada um em `auditoria-pronix.md`)
- [x] Prompt v2, conferência de citações sem IA, cache de transcrição, baseline no painel
- [x] Extensão 1.5.3 empacotada (`C:\Users\caual\Downloads\PRONIX-extensao-loja.zip`)
- [x] 117 testes automáticos (`npm test`), sem rede e sem custo
- [x] Merge local na `main`

## Novo em 29/09: report mais rico (extensão 1.7.0 + servidor)

- [x] Nível de consciência do lead (selo só de "consciente da solução" para cima), sinais de compra e "Como foi a conversa" com os nomes, no PDF, no popup e no painel (editáveis).
- [x] Prompt v3 (a mesma conversa pode ser gerada de novo com o prompt novo).
- [ ] **Você:** depois do push, gerar 2 ou 3 reports de conversas reais e conferir se o "Como foi a conversa" e o nível de consciência batem com o que aconteceu

## Novo em 29/09: ficha do lead do RD Station no WhatsApp (extensão 1.6.1 + servidor)

- [x] 1.6.1: cartão ao lado do painel da extensão oficial do RD (não por cima); número do lead lido do link do botão de WhatsApp do card no RD; busca começa pelo formato do card, "(11) 96763-6300".

- [x] Cartão no WhatsApp Web com etapa, funil, responsável, respostas do formulário, campos e anotações do RD Station CRM; busca por telefone (vários formatos, confere os 8 últimos dígitos), por nome (lista quando há mais de um) e manual no cartão.
- [x] Liga/desliga no popup; minimizar e fechar por conversa.
- [x] Teste do admin no painel (aba Extensão) mostrando os formatos de telefone tentados.
- [ ] **Você:** criar a variável `RDSTATION_CRM_TOKEN` na Vercel (token de um usuário do CRM que vê todas as negociações) e fazer redeploy
- [ ] **Você:** no painel → Extensão → Ficha do lead → **Testar** com o telefone de um lead que está no RD (ex.: o do print)
- [ ] **Você:** enviar a extensão 1.7.0 à Chrome Web Store e abrir a conversa desse lead no WhatsApp

## Novo em 28/09 (extensão 1.5.3 + servidor)

- [x] **Reports do dia (.zip para o líder):** aba no site para todo usuário e botão no popup; só o último report de cada lead (dá para ajustar na lista). Admin: opção "só o último" no .zip da aba Arquivos, marcada por padrão.
- [x] Leitura do Instagram: conversa curta (sem rolagem) não dava "Não achei a conversa"; histórico que demora a carregar não corta o começo; remetente de mensagem sua comprida.
- [x] Leitura do WhatsApp: remetente pela posição da bolha quando os sinais somem (o `data-id` já perdeu o `true_/false_`).
- [x] Aviso final com "X suas · Y do lead" e alerta quando um lado vem zerado; painel marca "remetente a conferir".
- [x] Popup: a validação da chave não apaga mais a mensagem de "Gerar"/".zip" clicados logo ao abrir.

Para testar a 1.5.3 (além da lista abaixo):
- [ ] Gerar 2 reports do mesmo lead e baixar o .zip (popup e site): deve vir só o último
- [ ] Conferir no aviso final se "X suas · Y do lead" bate com a conversa
- [ ] Instagram: uma conversa curta (3–4 mensagens) e uma bem longa

## B. Com você (nada disso eu consigo fazer daqui)

- [ ] `git push origin main` (sobe servidor, painel, documentação e o zip de download do painel)
- [ ] Conferir na Vercel que o deploy terminou e abrir o painel (aba **Reports gerados**: deve aparecer a linha "No período: …% da entrada veio do cache…")
- [ ] Carregar a extensão 1.5.3 e testar **antes de enviar à loja**:
  - [ ] WhatsApp: gerar 1 report com áudio. Conferir "N áudio(s) transcrito(s)"
  - [ ] WhatsApp: gerar de novo a mesma conversa → deve aparecer **Abrir o existente** / **Gerar de novo**
  - [ ] WhatsApp: abrir outra conversa no meio da leitura → deve avisar "A conversa mudou…" e não gerar
  - [ ] Instagram: gerar 1 report numa conversa longa (e, se der, com áudio). Se faltar mensagem, mandar as linhas `[CR-instagram v1.5.3]` do console (F12)
  - [ ] Ouvir um áudio normalmente depois do report (o som tem que funcionar)
- [ ] Enviar `PRONIX-extensao-loja.zip` (1.5.3) à Chrome Web Store
  - [ ] A permissão de hosts diminuiu (só `report-closer.vercel.app`): a loja pode pedir uma justificativa curta
  - [ ] Conferir a declaração de privacidade da loja com a política nova
- [ ] Confirmar `GROQ_API_KEY` na Vercel e testar 1 print (aba manual) e 1 print bem comprido
- [ ] Mandar a lista limpa de closers (nome completo + e-mail) para cadastrar todos de uma vez

## C. Se algo do teste acima falhar

- **Áudios do WhatsApp não transcritos (visto num teste real, versão 1.5.0):** o console mostrou vários `410` em `media-*.cdn.whatsapp.net/…mms-type=ptt` — é o próprio WhatsApp Web sem conseguir baixar o áudio (mídia expirada no servidor), e nenhum arquivo novo era criado ao clicar. A extensão não tem como contornar isso. A 1.5.1 passa a: (a) parar depois de uma passada quando **nada** é entregue (antes gastava minutos repescando), (b) explicar no aviso final e (c) registrar no console a linha `[CR-audio v1.5.1] fila anterior ao clique: N áudio(s) válido(s)…`, que separa "expirou" de "existia e a extensão não pegou". **Teste decisivo de 10 segundos:** na mesma conversa, clique no play de um desses áudios à mão; se ele não toca, é expiração. Se toca e a extensão continua falhando, me mande o log da 1.5.1.
- **1.5.2 (urgente):** a 1.5.0 só aceitava, da fila de arquivos de áudio, os criados **depois** do clique. Como não dá para provar que o WhatsApp nunca cria o arquivo antes do clique, a 1.5.2 devolve o plano B antigo: prioridade para o arquivo criado pelo clique (correto por construção) e, se nada novo aparecer em ~1s, usa os que já estavam na fila. Há teste para os dois caminhos.
- O `data-id` das mensagens do WhatsApp Web agora vem só com hexadecimais (sem `true_`/`false_` nem o id da conversa). A trava de conversa (A03) já cai para o nome do contato nesse caso; há teste cobrindo esse formato.

- Instagram lendo menos mensagens: mandar as linhas do console. É o ponto mais sensível a mudança de layout.
- Extensão dando "servidor inválido": conferir a URL no popup (só `https://…` ou `http://localhost`).
- Um report que sempre aborta com "A conversa mudou": mandar um print do console; a trava é conservadora no Instagram (só o endereço) e no WhatsApp (id da conversa).

## D. Ainda não feito (de propósito)

- [ ] Status por campo (confirmado/inferido) e origem por mensagem: precisa de rodada supervisionada com a API real (ver plano)
- [ ] Avaliar modelo mais barato: depois de algumas semanas de baseline no painel
- [ ] Integração com o RD Station CRM (adiada por você)
- [ ] "IA que aprende" perfil de lead × closer (adiada por você)
- [ ] Fases 2–9 da spec grande
