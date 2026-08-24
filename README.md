# PRONIX · Closer Report

Extensão do Chrome + servidor (Node/Express) que lê a **conversa aberta no WhatsApp
Web ou no Instagram Direct** — incluindo o histórico retroativo e os áudios,
transcritos automaticamente nas duas plataformas — e gera, com um clique, um
**relatório de handoff de pré-vendas em PDF** para o closer.

Sem bot, sem QR code, sem biblioteca não-oficial: a extensão só lê a página que o
SDR já tem aberta e logada — em qualquer uma das duas plataformas.

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
  closers.js                    Roster de closers (nome+e-mail, sem login) pra marcar quem fez cada call
  base.js                      Base de conhecimento (playbook) que entra em todo report
  stats.js                     Histórico de reports gerados + custo em dólar
  pdfStorage.js                 Guarda/lê/remove o PDF de cada report (download individual/zip)
  precos.js                    Tabela de preço por modelo (calcula o custo de cada report)
  db.js                        Redis (Vercel KV) em produção, data/*.json localmente; trava de concorrência

extension/                  Extensão MV3 (publicada na Chrome Web Store)
  manifest.json
  content.js                  Lê o DOM do WhatsApp, rola o histórico, captura áudio
  inject.js                   Roda no contexto da página (world: MAIN): hook de áudio
  content-instagram.js         Lê o DOM do Instagram Direct (texto + voz)
  background.js                Service worker: chama o servidor por trás da CSP da página
  popup.html / popup.js        UI: detecta a plataforma da aba, gera, edita e baixa o report

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
| `GROQ_VISION_MODEL` | não (padrão `qwen/qwen3.6-27b`) | Modelo com visão que lê o print da conversa no modo manual. |
| `MAX_IMAGEM_BYTES` | não (padrão `4194304`) | Teto do print enviado para leitura (o dashboard já reduz antes). |
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

## Armazenamento dos PDFs e download em massa

Todo PDF gerado fica guardado (`src/pdfStorage.js`, chave própria `pdf_<id>` no
mesmo banco de `src/db.js` — Redis/KV em produção, `data/*.json` local; os
arquivos são pequenos, poucos KB cada, então isso é barato). A aba **Arquivos**
do dashboard é só para isso — **só aparece pra admin** (mesmo gate das abas
Acessos/Números/Base: escondida na tela pra quem não é admin, e as rotas abaixo
exigem a mesma autenticação de admin no servidor, então não dá para contornar
só escondendo o botão) — e deixa:
- baixar o PDF de um report específico (botão **PDF** na tabela "Reports do período");
- baixar de **um SDR só** (botão **Baixar .zip** na tabela "Por SDR");
- baixar **tudo** de uma vez num `.zip` (botão **Baixar tudo**), sempre
  organizado em pastas por SDR, respeitando o filtro de período/SDR da própria aba.

`GET /api/admin/reports/:id/pdf` e `GET /api/admin/reports/pdf-zip?de=&ate=&sdr=`
(ambas atrás do middleware `admin`). O zip usa `archiver` (única dependência
nova — **pin em `^7.0.1`**: a partir da v8 o pacote virou ESM puro e quebra o
`require()` deste projeto). Removeu um report na aba Números? O PDF salvo dele
some junto. Não há expurgo automático por tempo — como os arquivos são
pequenos isso não é urgente, mas fica registrado como próximo passo caso vire
necessidade.

## Print de conversa (e uso no celular)

No modo manual dá pra **colar um print** da conversa (Ctrl+V), arrastar ou
escolher o arquivo. O servidor lê a imagem com o modelo de visão do Groq
(`POST /api/ler-imagem`) e devolve a conversa transcrita no formato
`VENDEDOR:`/`LEAD:`, que cai direto na caixa de texto — daí segue o fluxo normal
de geração. Vários prints podem ser colados em sequência; cada um vai
acrescentando à conversa.

**Custo: zero.** A leitura da imagem usa o mesmo plano gratuito do Groq que já
transcreve os áudios. O que continua custando é só a geração do relatório em si
(Anthropic), igual a qualquer outro report.

Cuidados que já estão no código:
- O tipo do arquivo é conferido pelos **magic bytes** no servidor, não pela
  extensão nem pelo que o navegador declara (`tipoDeImagem()` em `server.js`).
- O dashboard **reduz a imagem** antes de enviar (máx. 1600px, JPEG 0.92): um
  print de celular sai de vários MB para algumas centenas de KB, sem perder a
  legibilidade do texto.
- O erro nunca loga a imagem nem o texto lido — é conversa de lead.

**No celular:** a extensão do Chrome não roda em Android/iOS, então o caminho
para quem atende pelo WhatsApp Business do telefone é este: tira o print da
conversa, abre o dashboard no navegador do celular e toca no campo de print (o
`accept="image/*"` abre a galeria direto). Alternativa sem print: o próprio
WhatsApp tem **Exportar conversa**, que gera um `.txt` para colar na caixa de
texto.

## Closer e resultado da call

Cada report pode ser marcado manualmente (pelo admin, na aba **Reports gerados**)
com **quem foi o closer** e **o que aconteceu com aquela call** — nada disso vem da
IA nem é preenchido sozinho, é o admin alimentando aos poucos:

- **Closers**: um roster simples (nome + e-mail, sem login) em `src/closers.js` —
  cadastra uma vez, depois só escolhe num select na tabela de reports.
- **E-mail do lead** (`leadEmail`): campo de texto por report — é o e-mail de
  quem comprou/negociou, não do closer, pra dar pra puxar o report depois por
  e-mail (ex.: cruzar com um sistema de pagamento).
- **Resultado**: `venda_call` (fechou na própria reunião), `venda_fup` (fechou
  depois, num follow-up), `pix_compromisso` (entrou com PIX de compromisso), ou
  em branco (nada marcado ainda — não confundir com "não vendeu").
- **Data da reunião** e **data do fechamento**: dois campos de data; o servidor
  calcula sozinho quantos dias levou entre uma e outra (`diasParaFechar`).

Tudo isso é `PATCH /api/admin/reports/:id/resultado` (admin), guardado direto no
registro do report em `src/stats.js` (mesmo armazenamento do custo/tokens — nada
de tabela nova). Editar de novo é só marcar de novo; não tem histórico de mudanças.

**Desempenho por closer** (card na mesma aba): total de reports que cada closer
pegou, quantos fecharam (por tipo de resultado) e a taxa de conversão — calculado
puro em `stats.resumo()`, sem IA. É a base de dados que uma futura análise de
"qual closer se dá bem com qual perfil de lead" vai precisar ter acumulado antes
de fazer sentido — não tem volume suficiente pra isso ainda, então essa parte
fica para quando os resultados estiverem sendo marcados na rotina.

## Base de conhecimento (playbook)

Na aba **Base** do dashboard (admin), dá pra colar o script de qualificação, a oferta,
objeções comuns e o perfil de cliente ideal. Esse conteúdo entra no prompt de todo
report gerado — não é fato sobre o lead específico, é contexto para a IA calibrar o
relatório (ex.: não fazer qualificação financeira de quem já tem uma distribuidora
consolidada).

## Riscos

- **Risco de ban:** baixo — a extensão só **lê** a página que o SDR já tem aberta e
  logada (WhatsApp ou Instagram); não abre conexão própria com nenhum dos dois
  (diferente de bots com biblioteca não-oficial).
- **Fragilidade de layout:** a leitura depende do HTML de cada site. Se o WhatsApp ou
  o Instagram mudarem a estrutura da página, os seletores em `extension/content.js`
  (WhatsApp) ou `extension/content-instagram.js` (Instagram) podem precisar de ajuste
  — são os arquivos mais sensíveis do projeto. O **Instagram Direct usa CSS atômico
  com classes trocadas a cada build** (ex.: `xexx8yu`, sem nome com sentido) — por
  isso `content-instagram.js` evita depender de classes e usa sinais estruturais
  (posição do texto na tela, `flex-direction` do container) pra saber quem enviou
  cada mensagem, e faixa vertical pra agrupar as marcações de uma bolha de voz.
- **Áudio no Instagram:** como não se sabia de antemão como o Direct entrega o
  arquivo de voz, `capturarAudio()` tenta em ordem — `<audio>` da bolha, clicar
  no play e olhar de novo, e o gancho `URL.createObjectURL` (o mesmo do WhatsApp)
  — validando tudo por magic bytes. Se o `src` apontar pro CDN da Meta e o CORS
  bloquear, o log `[CR-ig-audio]` diz exatamente isso, e o áudio entra no report
  como `[áudio]` sem quebrar o resto. O caminho seguinte nesse caso seria buscar
  pelo service worker, que exigiria `host_permissions` do CDN — não pedimos
  enquanto não houver necessidade comprovada.
- Transcrever exige **tocar** o áudio (no mudo). No Instagram isso pode marcar a
  mensagem como ouvida pra quem enviou — está avisado no `GUIA-SDR.md`.

## Documentação relacionada

- [`GUIA-SDR.md`](GUIA-SDR.md) — passo a passo de instalação e uso para quem só vai
  gerar reports (sem acesso admin).
