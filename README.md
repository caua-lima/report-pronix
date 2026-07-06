# WhatsApp Closer Report

App 100% local (Node.js) que lê a conversa do WhatsApp com um lead (texto + áudio
transcrito), permite visualizá-la e gera com um clique um relatório de handoff de
pré-vendas em Word (`.docx`).

## Como funciona

1. **Bot (`npm start`)** — conecta ao WhatsApp via QR (Baileys), escuta os contatos de
   `WATCHED_CONTACTS` e salva cada mensagem em `data/<numero>.json`. Áudios são
   transcritos localmente com `faster-whisper` antes de salvar.
2. **Interface web (`npm run server`)** — sobe uma página em `http://localhost:PORT` com:
   - dropdown dos contatos monitorados,
   - **Ler conversa** → mostra o histórico completo e real,
   - **Gerar Report** → chama a LLM, monta o `.docx` e disponibiliza o download.

## Requisitos

- Node.js 18+ (usa `fetch` nativo).
- Python 3 com `faster-whisper` (só para transcrever áudio).

## Instalação

```bash
npm install
pip install faster-whisper --break-system-packages
cp .env.example .env   # e preencha as variáveis
```

Variáveis principais do `.env`:

| Variável | Descrição |
| --- | --- |
| `WATCHED_CONTACTS` | Números dos leads (DDI+DDD+número), separados por vírgula. |
| `COMPANY_NAME` | Nome da empresa (título do relatório). |
| `PORT` | Porta da interface web (padrão 3000). |
| `LLM_PROVIDER` | `anthropic` (padrão) ou `ollama`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Credenciais da Anthropic. |
| `OLLAMA_MODEL` / `OLLAMA_URL` | Config do Ollama local (custo zero). |
| `PYTHON_BIN` / `WHISPER_MODEL_SIZE` | Config da transcrição. |

## Uso

```bash
# Terminal 1 — bot que captura as mensagens
npm start          # escaneie o QR code

# Terminal 2 — interface web
npm run server     # abra http://localhost:3000
```

Antes da reunião: selecione o contato → **Ler conversa** para conferir → **Gerar Report**
→ baixe o `.docx`.

## Riscos assumidos

- **Baileys** é biblioteca não oficial: há risco de ban mesmo em uso passivo (menor que
  em automação de envio em massa). Recomenda-se usar um chip secundário.
- **Custo**: tudo gratuito, exceto a chamada à API da Anthropic por relatório (poucos
  centavos). Com `LLM_PROVIDER=ollama` o custo é zero.
