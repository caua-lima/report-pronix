# PRONIX · Closer Report

Extensão do Chrome + servidor (Node/Express) que lê a **conversa aberta no WhatsApp
Web** — incluindo o histórico retroativo e os áudios — e gera, com um clique, um
**relatório de handoff de pré-vendas em PDF** para o closer.

Sem bot, sem QR code, sem biblioteca não-oficial do WhatsApp: a extensão só lê a página
que o SDR já tem aberta e logada.

## O que o report faz

- Lê a conversa inteira (texto + áudio, transcrito automaticamente) e monta um PDF de
  no máximo 2 páginas com resumo, seções de análise, citações do lead e uma fala pronta
  para o closer abrir a call.
- **Investimento, Motivação e Decisor(es) nunca ficam em branco** — o prompt é
  instruído a extrair o sinal de qualificação que já está na conversa (inclusive
  estrutura implícita: "tenho uma distribuidora há 12 anos" já responde investimento,
  sem precisar de número).
- **Tom só positivo** — o relatório é pensado para "vender" o lead pro closer: nenhum
  ponto de atenção real (objeção, decisor ausente, orçamento apertado) é omitido, mas
  tudo é escrito como próximo passo estratégico, nunca como alerta ou veredito ruim.
- O card final ("Como iniciar a reunião") traz a fala pronta **e** os 3 pontos-chave
  do resumo juntos — o closer não precisa reler o handoff inteiro entre uma call e
  outra.
- É editável: dá pra corrigir qualquer campo (no popup da extensão ou no dashboard) e
  rebaixar o PDF sem chamar a IA de novo — de graça.

## Como funciona

```
WhatsApp Web
   │  extensão (content.js) lê o DOM, rola o histórico, captura áudio
   ▼
servidor (Express) ── autentica por chave (x-cr-key) ──▶ usuarios.js
   │
   ├─ transcreve os áudios (Groq API, ou faster-whisper local)
   ├─ chama a Anthropic (prompt cacheado + saída estruturada) ──▶ src/report.js
   ├─ monta o PDF (pdfkit, marca PRONIX)                       ──▶ src/generatePdf.js
   └─ registra custo/uso                                        ──▶ src/stats.js
   ▼
PDF em base64 ──▶ extensão baixa direto (sem passar por disco)
```

- **Local** (`npm start`): dados em `data/*.json`; transcrição via `faster-whisper`
  (Python) a menos que `GROQ_API_KEY` esteja definida.
- **Produção** (Vercel): mesmo `server.js`, exposto por `api/index.js`; dados no
  Vercel KV/Upstash Redis (sem isso, a Vercel nem sobe — disco não persiste lá);
  transcrição sempre via Groq (não há Python na Vercel).

`src/db.js` decide sozinho entre os dois modos, olhando se `KV_REST_API_URL` +
`KV_REST_API_TOKEN` estão preenchidas.

## Estrutura do projeto

```
server.js                  Express: rotas de página, admin, report e transcrição
api/index.js                Entrada da Vercel (reexporta server.js)
vercel.json                 Config da Vercel (rewrite tudo pra api/index.js)

src/
  report.js                 Prompt do relatório, chamada à Anthropic/Ollama, validação
  conversation-normalizer.js Limpa/agrupa/corta a conversa antes do prompt (menos custo)
  idempotencia.js             Hash da conversa (reportKey) — evita cobrar 2x a mesma
  generatePdf.js             Monta o PDF (pdfkit) com a marca PRONIX, teto de 2 páginas
  generateDoc.js             Legado (só o helper slugify ainda é usado)
  transcribe.js               Escolhe Groq (nuvem) ou faster-whisper (local)
  groq.js                     Cliente da API do Groq (Whisper)
  usuarios.js                  Acessos da equipe (chave pnx_..., sem e-mail real)
  base.js                      Base de conhecimento (playbook) que entra em todo report
  stats.js                     Histórico de reports gerados + custo em dólar
  precos.js                    Tabela de preço por modelo (calcula o custo de cada report)
  db.js                        Redis (Vercel KV) em produção, data/*.json localmente; trava de concorrência

extension/                  Extensão MV3 (publicada na Chrome Web Store)
  manifest.json
  content.js                  Lê o DOM do WhatsApp, rola o histórico, captura áudio
  inject.js                   Roda no contexto da página (world: MAIN): hook de áudio
  background.js                Service worker: chama o servidor por trás da CSP do WhatsApp
  popup.html / popup.js        UI: gerar, editar e baixar o report

public/                     Servido como estático pelo Express
  dashboard.html               Painel (gerar report manual, acessos, números, base, extensão)
  dia.html                      Resumo do dia (reports gerados)
  privacidade.html              Política de privacidade (exigida pela Chrome Web Store)
  icons/                        Favicon (mesma marca da extensão)
  PRONIX-extensao.zip           Gerado por `npm run empacotar`, servido pra equipe baixar

scripts/
  transcribe.py                faster-whisper local (só usado sem GROQ_API_KEY)

data/                        (git-ignorado) usuarios.json, reports.json, base.json locais
output/                      (git-ignorado) PDFs gerados localmente fora do fluxo da API
```

## Rodando localmente

```bash
npm install
cp .env.example .env      # preencha pelo menos ANTHROPIC_API_KEY e ADMIN_PASSWORD
npm start                  # http://localhost:3000
```

Sem `KV_REST_API_URL`/`KV_REST_API_TOKEN`, os dados (acessos, base, histórico de
reports) gravam em `data/*.json` — ótimo para testar, mas não sobrevive num deploy
sem disco persistente (é exatamente por isso que a Vercel exige o KV).

### Extensão no Chrome

1. `npm run empacotar` (gera `public/PRONIX-extensao.zip`) — ou use a pasta `extension/`
   direto, sem zipar.
2. `chrome://extensions` → ative o **Modo do desenvolvedor** → **Carregar sem
   compactação** → selecione a pasta `extension/`.
3. Abra o popup, cole a URL do servidor (`http://localhost:3000` local, ou a URL da
   Vercel em produção) e uma chave válida (crie uma em `/` → aba **Acessos**, como
   admin).

Em produção o time usa a versão publicada na **Chrome Web Store** (atualiza sozinha) —
ver o passo a passo de instalação para o SDR em [`GUIA-SDR.md`](GUIA-SDR.md).

## Deploy (Vercel)

1. Conecte o repositório na Vercel.
2. Adicione um **Vercel KV** (ou Upstash Redis) ao projeto — sem isso o servidor recusa
   gravar dados em produção (ver `src/db.js`).
3. Preencha as variáveis de ambiente do projeto na Vercel (mesmas do `.env.example`,
   sem `PYTHON_BIN`/`WHISPER_MODEL_SIZE` — não há Python lá, então `GROQ_API_KEY` é
   obrigatória para transcrever áudio em produção).
4. `git push origin main` — a Vercel builda e publica sozinha (`vercel.json` redireciona
   tudo para `api/index.js`).

O painel admin fica em `SUA_URL/` (aba **Acessos**), e é lá que se cria a chave de cada
SDR — nada de e-mail real, é só nome + chave gerada.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `COMPANY_NAME` | não (padrão `PRONIX`) | Nome exibido no cabeçalho do PDF. |
| `ADMIN_PASSWORD` | sim, pra usar o painel admin | Senha reserva do painel — cria o primeiro acesso admin. |
| `PORT` | não (padrão `3000`) | Porta do servidor local. |
| `LLM_PROVIDER` | não (padrão `anthropic`) | `anthropic` ou `ollama`. |
| `ANTHROPIC_API_KEY` | sim, se `LLM_PROVIDER=anthropic` | Chave da API da Anthropic. |
| `ANTHROPIC_MODEL` | não (padrão `claude-sonnet-5`) | Modelo usado; precisa ter entrada em `src/precos.js` pra calcular custo. |
| `OLLAMA_MODEL` / `OLLAMA_URL` | só se `LLM_PROVIDER=ollama` | Modelo e endpoint do Ollama local (custo zero). |
| `GROQ_API_KEY` | sim, em produção (Vercel) | Transcrição de áudio via API do Groq (Whisper). Sem ela, cai no faster-whisper local. |
| `GROQ_MODEL` | não (padrão `whisper-large-v3-turbo`) | Modelo de transcrição do Groq. |
| `PYTHON_BIN` / `WHISPER_MODEL_SIZE` | só localmente, sem `GROQ_API_KEY` | Transcrição local via `faster-whisper` (`pip install faster-whisper`). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | sim, na Vercel | Credenciais do Vercel KV/Upstash Redis. Vazias = grava em `data/*.json`. |
| `TZ_RELATORIO` | não (padrão `America/Sao_Paulo`) | Fuso usado pra decidir o "dia" de cada report nos números do dashboard. |
| `ANTHROPIC_MODEL_ECO` / `ANTHROPIC_MODEL_PREMIUM` | não | Modelos usados só quando o pedido manda `qualidade: "eco"` ou `"premium"` explicitamente — nunca automático. `ANTHROPIC_MODEL` continua o padrão (`"standard"`). |
| `MAX_CONVERSATION_CHARS` | não (padrão `24000`) | Teto de caracteres da conversa antes do prompt (ver [normalização](#normalização-e-custo) abaixo). |
| `MAX_AUDIO_TRANSCRIPTION_CHARS` | não (padrão `6000`) | Teto de caracteres de uma transcrição de áudio (aplicado em `/api/transcrever`). |
| `MAX_REPORT_OUTPUT_TOKENS` | não (padrão `4000`) | Teto de tokens de saída pedido à Anthropic. |
| `USD_BRL_RATE` | não (padrão `5.3`) | Taxa fixa usada só para exibir a estimativa de custo em BRL — nunca busca câmbio numa API externa. |

`SDR_NAME` no `.env.example` é só um nome de exibição de reserva para quando o PDF é
gerado sem usuário autenticado (uso local avulso) — em uso normal, quem assina o
report é sempre o dono da chave (`x-cr-key`).

## Custo por report

A Anthropic é o único custo por report (Groq e o dashboard/stats são gratuitos). O
prompt usa **cache** (system + exemplos + base de conhecimento ficam num prefixo
cacheado, TTL de 1h): a partir do segundo report do dia, a maior parte do prompt é lida
a ~0,1x do preço normal. `src/precos.js` calcula o custo real de cada report (já
considerando cache) e `src/stats.js` guarda esse número — dá pra ver o total, a média
diária/mensal e o gasto por SDR na aba **Reports gerados** do dashboard.

Reeditar um report e baixar o PDF de novo (`/api/pdf`) **não** chama a IA — não conta
como um novo report nem soma custo.

### Normalização e custo

Antes de montar o prompt, `src/conversation-normalizer.js` limpa a conversa: remove
mensagens vazias/duplicadas consecutivas, agrupa mensagens de texto seguidas do mesmo
remetente (menos prefixo repetido) e, só se a conversa passar de `MAX_CONVERSATION_CHARS`,
corta preservando as mensagens mais recentes **e** qualquer trecho com sinal comercial
(dor, orçamento, prazo, decisor, objeção, concorrência, próximos passos, compromissos —
essas nunca somem por causa do limite). Quando isso acontece, o report volta com
`resumida: true` e a tela mostra um aviso.

### Idempotência (não pagar duas vezes pela mesma conversa)

`/api/report-direto` e `/api/report-texto` calculam uma `reportKey` (hash da conversa
normalizada + versão do prompt + modo de qualidade, em `src/idempotencia.js`). Se já
existe um report com a mesma chave, o servidor **não chama a IA de novo** — devolve
`{ duplicado: true, existente: {...} }` e a extensão/dashboard perguntam ao SDR se quer
gerar mesmo assim (`forcarNovo: true` no corpo do pedido pula a checagem). Uma trava
por `reportKey` (`db.travar`/`db.destravar`) também impede que duas chamadas
simultâneas da mesma conversa (ex.: um retry de rede) gerem e cobrem em paralelo.

### Modo de qualidade e estimativa

O pedido pode mandar `qualidade: "eco" | "standard" | "premium"` — troca só o modelo da
Anthropic (`ANTHROPIC_MODEL_ECO`/`ANTHROPIC_MODEL`/`ANTHROPIC_MODEL_PREMIUM`); sem esse
campo, o comportamento é o de sempre (`standard`). `POST /api/estimar-custo` calcula uma
estimativa (entrada real da conversa normalizada + uma saída média por modo) sem chamar
a IA nem nenhuma API de câmbio — o dashboard usa isso pra mostrar "Custo estimado" ao
digitar a conversa no modo manual.

## Base de conhecimento (playbook)

Na aba **Base** do dashboard (admin), dá pra colar o script de qualificação, a oferta,
objeções comuns e o perfil de cliente ideal. Esse conteúdo entra no prompt de todo
report gerado — não é fato sobre o lead específico, é contexto para a IA calibrar o
relatório (ex.: não fazer qualificação financeira de quem já tem uma distribuidora
consolidada).

## Riscos

- **Risco de ban do WhatsApp:** baixo — a extensão só **lê** a página que o SDR já tem
  aberta e logada; não abre conexão própria com o WhatsApp (diferente de bots com
  biblioteca não-oficial).
- **Fragilidade de layout:** a leitura depende do HTML do WhatsApp Web. Se o WhatsApp
  mudar a estrutura da página, os seletores em `extension/content.js` podem precisar
  de ajuste (é o arquivo mais sensível do projeto).

## Documentação relacionada

- [`GUIA-SDR.md`](GUIA-SDR.md) — passo a passo de instalação e uso para quem só vai
  gerar reports (sem acesso admin).
