# Auditoria PRONIX — status dos achados

Origem: `PRONIX_AUDITORIA_E_PROMPT_CLAUDE.md` (auditoria externa de 18/09/2026, feita só sobre o site público e o ZIP da extensão v1.4.3, **sem** acesso ao backend, prompt, banco, logs ou PDF).
Extensão publicada com estas correções: **1.5.1** (a 1.5.1 acrescenta só o diagnóstico de áudio do WhatsApp descrito no checklist).

Regra desta rodada: cada achado foi conferido no código atual antes de qualquer mudança, e nada foi dado como resolvido sem teste.
Legenda: **Corrigido** (mudança + teste) · **Mitigado** (o risco caiu, sobra um resíduo descrito) · **Não feito** (decisão explícita, com o motivo).

## Testes

`npm test` → 117 casos, sem rede, sem IA real, sem custo e sem tocar em `data/`.
As correções de extensão foram provadas contra os **scripts reais** em DOM simulado (jsdom), e o painel real também. No código anterior, os testes de comportamento novo falham (ex.: `ok`, `ok`, `ok` engolidos no Instagram); nos fluxos que já funcionavam, passam antes e depois.
Os testes já pegaram dois erros meus antes de irem para produção (variável que escondia outra no painel; conferência de citação que aceitava número trocado).

**O que os testes não provam:** o comportamento nos sites reais. O DOM simulado reproduz o que foi medido ao vivo (lista do Instagram virtualizada, ignorando `scrollTop`), mas WhatsApp Web e Instagram mudam de layout sem avisar. Antes de subir para a loja, gere 1 report em cada, com áudio.

| ID | Sev. | Achado | Status | O que foi feito / evidência |
|---|---|---|---|---|
| A01 | P0 | Áudio de outra mensagem entrando por fallback da fila global | **Mitigado** | A fila global só aceita blobs criados **depois do clique** naquela mensagem; cada blob só é usado uma vez; a captura é sequencial. **Resíduo:** um blob lento da mensagem anterior que só chegue durante a próxima ainda poderia ser atribuído a ela (janela pequena). Amarrar por duração foi descartado: o relógio "0:12" e a hora "14:32" se confundem no DOM, e o erro derrubaria capturas que hoje funcionam. |
| A02 | P1 | Observer global muta todo `<audio>` para sempre | **Corrigido** | Só silencia durante a geração e devolve o estado original; pausa garantida (`try/finally`). |
| A03 | P0 | Sem trava de conversa; nome lido no fim | **Corrigido** | WhatsApp: id da conversa nos `data-id` (o predominante); Instagram: endereço `/direct/t/<id>`. Trocou de conversa durante a leitura → aborta e não gera nada. O nome do contato é o do **início** da leitura. Sem id no WhatsApp, cai no nome do cabeçalho, exigindo 3 leituras seguidas diferentes (para o cabeçalho piscando não derrubar um report bom). |
| A04 | P1 | Qualidade da captura não chega ao servidor | **Corrigido** | `captureQuality` (mensagens, áudios, transcritos) vai da extensão ao servidor, que **recalcula** "incompleta" e guarda. O painel marca *captura parcial* e mostra o total do período. |
| A05 | P1 | Dedup perde mensagens repetidas / ordem | **Corrigido** | Instagram: só descarta se for a mesma mensagem lida duas vezes (nó dentro do outro ou mesma posição); costura das janelas por identidade do nó antes do texto. WhatsApp: chave sem `data-id` inclui o remetente. Servidor: só o eco de texto **longo** cai; "ok", "sim" e "[áudio]" repetidos ficam. |
| A06 | P1 | Validador de áudio frouxo; nome fixo `audio.ogg` | **Corrigido** | Cliente: reconhece webm/amr e rejeita HTML/JSON de erro. Servidor: detecta o tipo real pelos bytes (rejeita imagem/PDF/HTML), envia a extensão certa ao Groq e limita o tamanho. |
| A07 | P1 | Aba manual sem controle de tarefas; áudio sem remetente | **Corrigido** | O botão de gerar trava enquanto lê áudio/print; o áudio entra como `LEAD (áudio):` ou `VENDEDOR (áudio):` (seletor). Continua indo para o fim da caixa, e a tela avisa. |
| A08 | P1 | Botão reativa com a 2ª requisição pendente | **Corrigido** | Estado `gerandoAgora` + contador de tarefas; clique duplo faz uma requisição só. |
| A09 | P1 | Duplicado não deixa abrir o existente | **Corrigido** | Aviso com **Abrir o existente** (sem IA), **Gerar de novo** e **Cancelar**, na extensão e no painel. `GET /api/reports/:id/pdf`: o SDR só abre o **próprio** (admin abre qualquer um; de outra pessoa responde 404). |
| A10 | P1 | Edições não persistem | **Corrigido** | Popup grava a edição (sem sobrescrever um report novo que chegou); painel guarda rascunho em `sessionStorage` (some ao fechar a aba, amarrado à chave). |
| A11 | P1 | Último report global, antes de validar a chave | **Corrigido** | O popup só mostra o último report de quem está logado naquela chave **e** servidor (impressão digital da chave, nunca a chave); trocar de chave apaga o anterior. |
| A12 | P0 | Texto externo em `innerHTML` | **Corrigido** | Status (extensão e painel) e badges em texto puro/escapados; varredura de todos os `innerHTML` do painel: ids e datas em atributos agora escapados, o resto é numérico ou formatado por função. Teste com nome `<img onerror>` vindo do servidor. |
| A13 | P1 | Permissões amplas; `msg.server` aceito | **Corrigido** | `host_permissions` só do servidor de produção (o servidor manda CORS aberto, então a extensão não precisa de permissão ampla); o background ignora o endereço da mensagem, só aceita https/localhost e só mensagens da própria extensão. |
| A14 | P1 | Chaves e senha reserva expostas | **Mitigado** | Senha reserva só em memória (valor antigo do `sessionStorage` é apagado); chaves mascaradas na lista (clicar mostra; "Copiar chave" copia a inteira). **Resíduo:** a chave do SDR continua em `localStorage` do painel — é o que permite usar sem digitar a cada vez; a alternativa (sessão com cookie) é uma mudança de arquitetura. |
| A15 | P1 | Salvar resultado sobrescreve tudo | **Corrigido** | PATCH só do campo mexido + `versao`; o servidor recusa com 409 se outra pessoa alterou; fila por linha; cliente antigo (manda tudo) continua funcionando. |
| A16 | P2 | Todas as abas de admin carregam tudo | **Corrigido** | Cada aba carrega só o que é dela. |
| A17 | P2 | Estimativa de custo desatualizada | **Corrigido** | Recalcula depois de áudio/print e só a resposta mais recente vale. |
| A18 | P2 | Print comprido fica ilegível | **Corrigido** | Página longa (largura final < 600px ao reduzir) é fatiada com sobreposição e o texto é costurado sem repetir linhas; print de celular normal continua só reduzido (não mudou). |
| A19 | P2 | Sem timeouts; PDF em base64 guardado | **Corrigido** | Tempo limite claro em extensão, painel, Anthropic e Groq; o PDF não é mais guardado no storage da extensão. Os payloads continuam base64 (é o formato do transporte JSON). |
| A20 | P1 | Política de privacidade contradiz o produto | **Corrigido** | Cita Instagram, PDF guardado (só admin), rolagem/áudio no mudo, prints/áudios do painel e o cache de transcrição de 24h. |
| A21 | P1 | Excluir report some com o gasto | **Corrigido** | Registro de consumo separado: o painel mostra "consumo real" incluindo reports excluídos. **Mantido:** resultado em branco = sem venda (regra do dono). |

## Recomendações da auditoria que entraram (além dos achados)

- Prompt `v2`: conversa entre marcas + regras contra instrução escondida, correção posterior prevalece, faturamento ≠ lucro, citação literal.
- **Citações conferidas sem IA** (`src/citacoes.js`): fala inventada ou com número trocado sai do report.
- **Suíte sintética**: 36 casos em `tests/qualidade.test.js`.
- **Cache de transcrição** por hash do áudio (24h, desligável).
- **Baseline no painel**: % da entrada vinda do cache, capturas parciais, citações removidas.

## O que NÃO foi feito, e por quê

1. **Status por campo (confirmado/inferido/não informado/conflitante) e `sourceMessageIds`.** Muda o contrato com a IA (numerar as mensagens no prompt) e o formato do PDF. Sem chamadas pagas de verdade não dá para saber se o modelo passa a copiar o número da mensagem dentro das citações (o que faria a conferência apagar citações boas). É o único item da auditoria que ficou de fora de propósito: precisa de uma rodada supervisionada com a API real.
2. **Avaliar modelo mais barato.** Só faz sentido com a base de avaliação acima e com o baseline já rodando no painel por algumas semanas.
3. **Auditoria do backend, prompt, banco e PDF pelo auditor externo** (ele não teve acesso). Esta rodada revisou o código do repositório, mas isso não substitui uma revisão independente.
