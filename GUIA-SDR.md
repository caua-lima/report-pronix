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

**Já existe um report igual?** Se você gerar duas vezes a mesma conversa, o aviso oferece **Abrir o existente** (baixa o PDF que já foi gerado, sem custo) ou **Gerar de novo** (chama a IA outra vez e custa). Só abra de novo se a conversa mudou.

No aviso final vem **quantas mensagens são suas e quantas do lead** (ex.: `42 mensagens · 18 suas · 24 do lead`). Se aparecer **"Confira o report: nenhuma mensagem sua foi reconhecida"**, a leitura do remetente falhou: não mande esse report, copie o console (F12) e avise o admin.

No aviso final também vem quantos áudios ele transcreveu:

- `3 áudio(s) transcrito(s)` — pegou todos.
- `1 de 3 áudio(s) transcrito(s)` — os outros entraram no report como `[áudio]`. Avise o admin.

> **Áudio:** pra transcrever, ele precisa **tocar** cada áudio no mudo. Você não escuta nada, mas no Instagram isso pode marcar o áudio como "ouvido" pra quem mandou — se isso for um problema numa conversa específica, gere o report só depois de já ter ouvido os áudios normalmente.

> **Instagram Direct é recente:** se o report sair estranho (mensagem trocada de remetente, áudio faltando) me avisa com um print — o Instagram muda o layout com frequência e pode precisar de ajuste.

## 4. Ficha do lead (RD Station) no WhatsApp

Ao abrir a conversa de um lead no WhatsApp Web, aparece um cartão no canto de cima da conversa com o que já está no RD Station. O jeito mais certeiro é abrir pelo ícone de WhatsApp do card do lead no RD: o número vai junto e ele acha o lead mesmo se o contato estiver salvo com outro nome. O cartão mostra: **etapa e funil**, **responsável** e as respostas do formulário (**Profissão, Estado, Vende online, Investimento**...). Use para abrir a conversa já sabendo com quem está falando.

- **–** minimiza (fica minimizado nas próximas conversas até você abrir de novo); **×** fecha só nesta conversa.
- **"Não achei este lead no RD Station"**: o número da conversa não está no contato do RD (ou o contato está salvo com outro nome). Digite o telefone ou o nome no campo do cartão e clique em **Buscar**.
- **"Mais de um contato com esse nome"**: clique no certo.
- Para desligar: popup da PRONIX → desmarque **Mostrar a ficha do RD Station**.

## 5. Fim do dia: o .zip para o líder

Todo dia, antes de ir embora, baixe o .zip com os seus reports do dia e mande para o líder. Tem dois jeitos:

- **Pela extensão:** clique no ícone da PRONIX → **Baixar meus reports de hoje (.zip)**. Pronto.
- **Pelo site:** abra o site da PRONIX → aba **Reports do dia** (cole a sua chave na aba "Gerar report" na primeira vez). Lá aparece a lista do dia e dá para escolher outro dia.

**Gerou mais de um report do mesmo lead** (o áudio não veio, leu algo errado, você refez)? O .zip leva só o **último** de cada lead — os anteriores ficam de fora sozinhos. No site, eles aparecem apagados como "refeito — vale o das 15:42". Se por algum motivo você quiser mandar um anterior em vez do último, marque e desmarque na lista antes de baixar.

> "Mesmo lead" = o mesmo contato (o nome ou telefone que aparece no topo da conversa) no mesmo dia. No modo manual, use sempre o mesmo **Nome do lead** ao refazer, senão ele entende como leads diferentes.

## No celular (WhatsApp Business do telefone)

A extensão só funciona no computador. Pra gerar report do que você atende pelo celular:

1. Tire **print** da conversa (pode ser mais de um, se for longa).
2. Abra o site da PRONIX no navegador do celular e cole a sua chave.
3. Toque em **"Ou cole um print da conversa"** e escolha os prints da galeria.
4. O texto da conversa aparece sozinho na caixa (print muito comprido é lido em partes). Confira, ajuste se precisar, e toque em **Gerar Report**. O botão fica travado enquanto ainda está lendo prints ou áudios.
5. Se colar **áudios**, escolha antes se quem gravou foi o **lead** ou **você**: o texto entra no fim da caixa como `LEAD (áudio):` ou `VENDEDOR (áudio):`. Mova a linha se a ordem importar.

> Outra opção sem print: no WhatsApp, abra a conversa → menu (⋮) → **Exportar conversa** → **Sem mídia**. Aí é só colar o texto na caixa.

## O que ele faz

Lê a conversa inteira (inclusive as mensagens antigas), transcreve os áudios e monta o report em PDF, sempre com **investimento, decisores e prioridade**, mais as falas do lead entre aspas. Também traz o **nível de consciência** do lead (só quando ele está bom: de "consciente da solução" para cima), os **sinais de compra** e **"Como foi a conversa"**, contando o que você apresentou e como o lead reagiu. Por isso vale a pena explicar a entrega com clareza na conversa: ela vai para o report com o seu nome. O arquivo sai como `Report_NomeDoLead_Data.pdf`.

## Se der problema

| O que aparece | O que fazer |
| --- | --- |
| "Chave inválida ou ausente" | A chave foi colada errada ou tem espaço sobrando. Copie de novo e valide. Se insistir, peça outra ao admin. |
| "O WhatsApp não entregou os arquivos de áudio" | O WhatsApp Web só consegue tocar áudio que ainda está nos servidores dele; áudio antigo costuma expirar (aparece erro no console e o áudio nem toca se você clicar nele à mão). Eles entram no report como `[áudio]`. Se o áudio é importante, ouça no celular e escreva o resumo na conversa, ou use a **Transcrição** do próprio WhatsApp quando ela aparecer. |
| "A conversa mudou durante a leitura" | Você abriu outra conversa enquanto ele lia. Nada foi gerado: abra a conversa do lead, espere o aviso virar "Gerando report…" e tente de novo. |
| "Nenhuma mensagem encontrada" | Abra a conversa do lead (a janela com as mensagens na tela) e atualize a página (F5). |
| O ícone não faz nada | Atualize a aba (F5). Ele só age em `web.whatsapp.com` e `instagram.com/direct`. |
| ⚠️ nos áudios | Chame o admin com um print.  |

> Abrir várias abas não atrapalha: gere o report na aba onde a conversa está aberta.
