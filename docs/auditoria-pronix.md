# Auditoria PRONIX — status dos achados

Origem: `PRONIX_AUDITORIA_E_PROMPT_CLAUDE.md` (auditoria externa de 18/09/2026, feita só sobre o site público e o ZIP da extensão v1.4.3, **sem** acesso ao backend, prompt, banco, logs ou PDF).
Branch de trabalho: `auditoria-pronix`. Extensão publicada sai como **1.4.4**.

Regra desta rodada: cada achado foi conferido no código atual antes de qualquer mudança. Nada aqui foi assumido só porque o documento disse.
Legenda: **Corrigido** (mudança + teste) · **Parcial** (parte feita, parte pendente) · **Confirmado** (existe no código, ainda não corrigido) · **Não verificado** (não conferi nesta rodada).

Testes: `npm test` (`tests/auditoria.test.js`, 25 casos, sem rede/IA/navegador). Rodados contra o código anterior (HEAD `fb055cc`), 19 dos 25 falham — ou seja, detectam de fato os defeitos; os outros 6 são guardas de comportamento que não pode mudar (fluxo normal, erro, sem chave, duplicado repassado, manifesto).

| ID | Sev. | Achado | Status | Evidência / o que foi feito |
|---|---|---|---|---|
| A01 | P0 | Fallback da fila global de blobs pode atribuir o áudio de outra mensagem | **Parcial** | `content.js` `capturarBytes` e `content-instagram.js` `capturarAudio`: a fila global agora só aceita blobs com `ts` posterior ao clique (`b.ts < t0` é ignorado). Falta amarrar por id da mensagem/duração. Risco assumido: um blob que já existia antes do clique só é achado pelo `<audio>` da própria bolha (o caminho mais confiável), não mais "por sorte" pela fila. |
| A02 | P1 | `MutationObserver` global muta todo `<audio>` para sempre; pausa do Instagram pode ser pulada | **Corrigido** | O silenciamento só vale entre `capturaAtiva = true` e o `finally` do job; o estado original (`muted`/`volume`) é guardado e devolvido, pausando o que ficou tocando. `capturarAudio` (IG) virou wrapper com `try/finally` que sempre pausa. Efeito colateral bom: o SDR volta a ouvir áudios normalmente fora da geração. |
| A03 | P0 | Sem trava de identidade da conversa durante a coleta | **Confirmado** | Nome do contato só é lido no fim. Mitigação de texto: popup e `GUIA-SDR.md` agora dizem para **não trocar de conversa** até o report ficar pronto (antes o popup dizia que podia continuar respondendo). Correção real (abortar se o cabeçalho mudar) está no plano. |
| A04 | P1 | `stats` de áudio não chegam ao servidor (sem `captureQuality`) | **Confirmado** | `background.js` `reportFetch` só envia `mensagens`, `nome`, `forcarNovo`. |
| A05 | P1 | Dedup pode perder mensagens repetidas legítimas / ordem por primeira aparição | **Confirmado (parcial)** | Instagram `lerJanela` descarta texto idêntico consecutivo do mesmo remetente; `chaveMsg` não distingue áudios de mesma duração. Não mexi: exige fixtures reais sintéticas para não regredir a leitura que acabou de ser consertada (v1.4.3). |
| A06 | P1 | `ehAudioBuffer` aceita conteúdo desconhecido; nome fixo `audio.ogg` | **Confirmado** | `ehAudioBuffer` aceita 1,5 KB–8 MB desconhecido; `background.js` envia `nome: 'audio.ogg'` sempre. |
| A07 | P1 | Aba manual sem contador de tarefas; áudio entra no fim do texto | **Confirmado** | `appendConversa` anexa `(áudio): …` ao final, sem remetente/posição. |
| A08 | P1 | `return gerar(true)` dentro de `try/finally` reativa o botão com a 2ª requisição pendente | **Corrigido** | `dashboard.html`: `refazendo` mantém o botão travado até a 2ª geração terminar; clique duplo é ignorado. Teste reproduz o defeito no código antigo. |
| A09 | P1 | Fluxo de duplicado diz que o PDF anterior "não fica guardado" | **Parcial** | Texto corrigido (dashboard e WhatsApp): o PDF anterior fica arquivado com o admin. Falta a opção "Abrir existente": o servidor já devolve `existente.id`, mas o download hoje é só admin (`/api/admin/reports/:id/pdf`); precisa de rota para o próprio SDR (decisão de permissão). |
| A10 | P1 | Edições no popup/dashboard não são persistidas nem versionadas | **Confirmado** | `reportAtual` só em memória; popup guarda o último em `chrome.storage.local`. |
| A11 | P1 | `carregarUltimo()` mostra um único report global antes de validar a chave | **Confirmado** | `popup.js` `carregarUltimo` lê `ultimoReport` sem escopo por usuário/servidor. |
| A12 | P0 | Texto externo em `innerHTML` (status, badge, nome do contato, `download`) | **Corrigido** (sinks de status/badge) | `setStatus` (popup e dashboard) agora usa `textContent`; badges dos dois content scripts escapam nome, arquivo, URL e mensagens de erro (`escHtml`). Os demais `innerHTML` do dashboard (tabelas/admin) **não foram auditados** nesta rodada — já usam `esc()` nos pontos que vi, mas falta varredura completa. |
| A13 | P1 | `host_permissions` com `*.vercel.app`; background aceita `msg.server` | **Parcial** | O background **ignora** `msg.server`: usa só o servidor salvo pelo popup, e só `https` (ou `http://localhost`/`127.0.0.1`); caso contrário não envia a chave. O `host_permissions` continua `https://*.vercel.app/*`: estreitar exige confirmar o domínio de produção definitivo (mudar para um domínio errado quebraria a extensão de todos). |
| A14 | P1 | Chave em `localStorage`; senha reserva de admin em `sessionStorage`; lista mostra chaves inteiras | **Confirmado** | `dashboard.html` (`crChave`, `adminPass`). É decisão de produto (o SDR precisa da chave no navegador); a senha reserva de admin é o ponto mais sensível. |
| A15 | P1 | Salvar resultado envia a linha inteira a cada mudança (sem versão) | **Confirmado** | `salvarResultadoLinha` manda os 5 campos sempre; dois admins editando ao mesmo tempo se sobrescrevem. |
| A16 | P2 | Carrega tudo a cada aba de admin | **Confirmado** | `pedirAdmin` chama usuários/closers/stats/arquivos/base juntos. |
| A17 | P2 | Estimativa de custo não recalcula após áudio/print | **Corrigido** | `appendConversa` agenda a estimativa (mudar `.value` por código não dispara `input`). |
| A18 | P2 | `prepararImagem` limita o maior lado a 1600 px (print longo fica ilegível) | **Confirmado** | `dashboard.html` `prepararImagem(file, maxLado = 1600)`. Print 1080×10000 vira ~173×1600. Solução: fatiar em blocos antes de reduzir. |
| A19 | P2 | Payloads base64 grandes; `ultimoReport` guarda PDF em base64; sem timeout | **Não verificado** | Só o `ultimoReport` com `arquivoBase64` foi visto no código. |
| A20 | P1 | Política de privacidade contradiz o produto | **Corrigido** | `public/privacidade.html`: cita Instagram Direct, PDF guardado no servidor (só admin, apagado com o report), dados de closer/resultado/e-mail do lead, prints/áudios do site, e a rolagem + reprodução muda de áudios. Conferido no código que o texto bruto da conversa **não** é persistido (só metadados e o PDF). |
| A21 | P1 | Excluir report some com o gasto do dashboard; resultado em branco = "sem venda" | **Confirmado — não alterar** | O "em branco = sem venda" é regra explícita do dono da ferramenta. Registro de consumo independente da exclusão fica como sugestão no plano. |

## Do que a auditoria pede e ainda não entrou

- **Report estruturado** (status por campo: confirmado/inferido/não informado/conflitante; `sourceMessageIds`; briefing de 60 s). Muda schema do prompt e do PDF: exige suíte de avaliação com conversas sintéticas antes de tocar em produção.
- **Custos**: reabrir report existente, cache de transcrição por hash de mídia. Sem baseline medido, não prometemos % de economia.
- **Auditoria completa** de backend, prompt, banco e PDF (o auditor não teve acesso).
- Auditoria do Instagram com layout real (só há testes com DOM simulado; v1.4.3 ainda depende de confirmação ao vivo).

## Limites desta rodada

- Nenhum teste pago de IA, nenhuma conversa real, nenhum deploy/push/publicação. O comportamento no WhatsApp/Instagram reais **não foi validado no navegador**: as correções de extensão foram provadas por testes com objetos simulados e pela leitura do código. Recomenda-se um teste manual (gerar 1 report no WhatsApp e 1 no Instagram, com um áudio) antes de enviar o zip 1.4.4 à loja.
