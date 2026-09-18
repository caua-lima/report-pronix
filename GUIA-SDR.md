# PRONIX · Closer Report — guia do SDR

Como instalar e usar a extensão que lê a conversa do WhatsApp (ou do Instagram Direct) e gera o report de handoff em PDF.

Você recebe duas coisas do admin: o arquivo **PRONIX-extensao.zip** e a **sua chave** (`pnx_...`).

---

## 1. Instalar (uma vez só)

1. Baixe o **PRONIX-extensao.zip** e descompacte (botão direito → **Extrair tudo**).
   Deixe a pasta num lugar definitivo, tipo `Documentos`. **Se você apagar ou mover essa pasta, a extensão para de funcionar.**
2. No navegador, abra `chrome://extensions` (no Brave: `brave://extensions`).
3. Ligue o **Modo do desenvolvedor** — o botão fica no canto superior direito.
4. Clique em **Carregar sem compactação** e selecione a pasta `extension` (a que tem o arquivo `manifest.json` dentro).
5. Opcional: clique no ícone de quebra-cabeça na barra do navegador e fixe a PRONIX, pra ficar sempre à mão.

## 2. Entrar (uma vez só)

1. Abra o [WhatsApp Web](https://web.whatsapp.com) (ou o [Instagram Direct](https://www.instagram.com/direct/inbox/), se você for social seller) e **atualize a página** (F5).
2. Clique no ícone da PRONIX (o raio dourado).
3. O **servidor já vem preenchido** — não mexa nele.
4. Cole a **sua chave** no campo de chave e clique em **Validar**.
5. Tem que aparecer o **seu nome**. Apareceu? Está pronto.

A chave é sua e individual: é ela que assina o seu nome no report. Não passe pra ninguém.

## 3. Gerar um report

1. Abra a conversa do lead no WhatsApp Web (ou no Instagram Direct).
2. Clique no ícone da PRONIX → **Gerar Report da conversa aberta**.
3. Vai aparecer um aviso na tela mostrando o andamento. Enquanto estiver **"Lendo a conversa…"**, **não troque de conversa** (ele está rolando e lendo a que está aberta). Quando o aviso virar **"Gerando report…"**, a leitura terminou e você já pode responder outros leads.
4. No fim aparece **✅ Report pronto!** com o botão de **baixar o PDF**.

No aviso final também vem quantos áudios ele transcreveu:

- `3 áudio(s) transcrito(s)` — pegou todos.
- `1 de 3 áudio(s) transcrito(s)` — os outros entraram no report como `[áudio]`. Avise o admin.

> **Áudio:** pra transcrever, ele precisa **tocar** cada áudio no mudo. Você não escuta nada, mas no Instagram isso pode marcar o áudio como "ouvido" pra quem mandou — se isso for um problema numa conversa específica, gere o report só depois de já ter ouvido os áudios normalmente.

> **Instagram Direct é recente:** se o report sair estranho (mensagem trocada de remetente, áudio faltando) me avisa com um print — o Instagram muda o layout com frequência e pode precisar de ajuste.

## No celular (WhatsApp Business do telefone)

A extensão só funciona no computador. Pra gerar report do que você atende pelo celular:

1. Tire **print** da conversa (pode ser mais de um, se for longa).
2. Abra o site da PRONIX no navegador do celular e cole a sua chave.
3. Toque em **"Ou cole um print da conversa"** e escolha os prints da galeria.
4. O texto da conversa aparece sozinho na caixa. Confira, ajuste se precisar, e toque em **Gerar Report**.

> Outra opção sem print: no WhatsApp, abra a conversa → menu (⋮) → **Exportar conversa** → **Sem mídia**. Aí é só colar o texto na caixa.

## O que ele faz

Lê a conversa inteira (inclusive as mensagens antigas), transcreve os áudios e monta o report em PDF, sempre com **investimento, decisores e prioridade**, mais as falas do lead entre aspas. O arquivo sai como `Report_NomeDoLead_Data.pdf`.

## Se der problema

| O que aparece | O que fazer |
| --- | --- |
| "Chave inválida ou ausente" | A chave foi colada errada ou tem espaço sobrando. Copie de novo e valide. Se insistir, peça outra ao admin. |
| "Nenhuma mensagem encontrada" | Abra a conversa do lead (a janela com as mensagens na tela) e atualize a página (F5). |
| O ícone não faz nada | Atualize a aba (F5). Ele só age em `web.whatsapp.com` e `instagram.com/direct`. |
| ⚠️ nos áudios | Chame o admin com um print.  |

> Abrir várias abas não atrapalha: gere o report na aba onde a conversa está aberta.
