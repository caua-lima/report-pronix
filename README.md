# WhatsApp Closer Report

Extensão do Chrome + servidor local que lê a **conversa aberta no WhatsApp Web**
(incluindo o histórico retroativo) e gera, com um clique, um relatório de handoff de
pré-vendas em Word (`.docx`).

Sem configurar lead por lead, sem QR code, sem bot: você abre a conversa no WhatsApp
Web, clica na extensão e baixa o relatório.

## Como funciona

```
WhatsApp Web  ──(extensão lê a conversa)──▶  servidor local (Node)
                                                   │
                                          LLM (Anthropic/Ollama)
                                                   │
                                             relatório .docx  ◀── você baixa
```

1. A **extensão** roda em cima do `web.whatsapp.com`. Ao clicar em *Gerar Report*, ela
   rola a conversa aberta para carregar o histórico e lê todas as mensagens.
2. Manda a conversa para o **servidor local**, que chama a LLM e monta o `.docx`.
3. A extensão mostra a prévia e o botão de download.

**Áudios:** a extensão lê a *transcrição nativa do WhatsApp*. Ative em
**WhatsApp → Configurações → Conversas → Transcrever áudios** para que o texto dos
áudios entre no relatório.

## Requisitos

- Node.js 18+ (usa `fetch` nativo).
- Google Chrome (ou Edge/Brave — qualquer navegador Chromium).
- Uma chave da Anthropic **ou** Ollama rodando local (custo zero).

## Instalação

### 1. Servidor

```bash
npm install
cp .env.example .env      # e preencha
```

No `.env`, o essencial:

| Variável | Descrição |
| --- | --- |
| `COMPANY_NAME` | Nome da empresa (título do relatório). |
| `PORT` | Porta do servidor (padrão 3000). |
| `LLM_PROVIDER` | `anthropic` (padrão) ou `ollama`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Credenciais da Anthropic. |
| `OLLAMA_MODEL` / `OLLAMA_URL` | Config do Ollama local (custo zero). |

### 2. Extensão no Chrome

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta `extension/`.
4. Fixe a extensão na barra (ícone de quebra-cabeça → alfinete).

## Uso

```bash
npm start        # deixe o servidor rodando
```

1. Abra o **WhatsApp Web** e entre na conversa com o lead.
2. Clique no ícone da extensão → **Testar** (confere o servidor) → **Gerar Report**.
3. Um aviso aparece no **canto inferior direito da tela do WhatsApp** com o progresso:
   - **Lendo a conversa…** — não troque de conversa nesse momento (ela está lendo o histórico).
   - **Gerando report…** — a partir daqui você já pode **fechar o popup e responder outros
     leads**; o trabalho continua em segundo plano.
   - **✅ Report pronto** — clique em **⬇ Baixar .docx** no próprio aviso.
4. O popup também guarda o último report gerado (com botão de download) ao ser reaberto.

> A leitura é retroativa: ela sobe pela conversa para carregar o histórico. Em conversas
> muito longas isso pode levar alguns segundos. Só a fase de leitura exige ficar na
> conversa; a geração roda em background.

## Gravador de ligação (report a partir de chamada)

Além do WhatsApp Web, dá para gerar o mesmo relatório a partir de uma **ligação
gravada**. Com o servidor rodando, abra **http://localhost:3000/gravador**:

1. Clique em **Começar gravação** → o navegador pede para compartilhar a tela: escolha
   **“Tela inteira”** e marque **“Compartilhar áudio do sistema”** (é o que captura a voz
   do lead; seu microfone é capturado automaticamente).
2. Faça a ligação normalmente.
3. Clique em **Terminar e gerar report** → o áudio é transcrito **localmente** com
   `faster-whisper` e vira o mesmo `.docx`.

Requer `faster-whisper` (Python): `pip install faster-whisper --break-system-packages`.

> A transcrição de ligação não separa quem falou (fala corrida). O relatório sai mesmo
> assim; só a divisão “eu/lead” fica menos precisa do que no chat.

## Riscos e custos

- **Risco de ban:** baixo. A extensão apenas **lê** a página que você já tem aberta e
  logada — não cria nenhuma conexão não oficial (ao contrário de bots com biblioteca
  não oficial). É um uso passivo.
- **Fragilidade de layout:** a leitura depende do HTML do WhatsApp Web; se o WhatsApp
  mudar a estrutura, os seletores em `extension/content.js` podem precisar de ajuste.
- **Custo:** tudo gratuito, exceto a chamada à API da Anthropic por relatório (poucos
  centavos). Com `LLM_PROVIDER=ollama` o custo é zero.

## Estrutura

```
server.js              # servidor Express (endpoint /api/report-direto + download)
src/report.js          # monta o prompt, chama a LLM, valida o JSON
src/generateDoc.js     # gera o .docx no layout de handoff
extension/
  manifest.json        # extensão MV3
  content.js           # lê a conversa (DOM + scroll) + aviso de progresso na tela
  background.js        # service worker: chama o servidor (roda em background)
  popup.html/.js       # botão "Gerar Report" + prévia + download
```
