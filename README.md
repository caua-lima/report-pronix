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
- **Temperatura do lead** (logo abaixo do resumo, cartão escuro): o **nível de
  consciência** do lead (escala de Schwartz: inconsciente → problema → solução → nossa
  entrega → pronto para decidir) com o porquê, e os **sinais de compra** com a prova da
  conversa. O selo de consciência **só aparece de "consciente da solução" para cima** —
  abaixo disso fica fora do PDF, para não esfriar o closer (`src/consciencia.js`). Na
  dúvida entre dois níveis, a IA fica com o menor, para o selo ser confiável.
- **Como foi a conversa**: 3 a 5 frases do desenrolar, com os nomes ("Cauã explicou que a
  entrega é…; Marcos respondeu que faz sentido…") — o closer chega sabendo o que o SDR
  já apresentou e como o lead reagiu. Só o que foi dito, no mesmo tom de venda.
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

### Testes

```bash
npm test
```

Roda todos os `tests/*.test.js` (Node ≥ 18; a única dependência extra é o `jsdom`, só de
desenvolvimento). Sem rede, sem chave de API real, sem custo e sem tocar em `data/`
(o banco de teste é uma pasta temporária, via `CR_DATA_DIR`):

| Arquivo | O que cobre |
| --- | --- |
| `servidor.test.js` | A API inteira com IA e Groq simulados: acessos, geração, duplicado, reabrir PDF só do dono, resultado com versão (409), consumo de reports excluídos, áudio (tipo real, cache), `captureQuality`. |
| `qualidade.test.js` | 36 casos sintéticos: conferência de citações (número trocado, fala inventada, ordem das palavras) e normalização da conversa (falas repetidas, limite, sinal comercial). |
| `extensao-dom.test.js` | Os content scripts **reais** do WhatsApp e do Instagram em DOM simulado: lista virtualizada que ignora `scrollTop`, remetente, áudios, troca de conversa no meio da leitura, falas repetidas, duplicado. |
| `painel.test.js` | O painel **real** com API falsa: abas sob demanda, edição de resultado, duplicado, áudio/print, rascunho, chaves mascaradas. |
| `popup.test.js` | Popup da extensão: último report só do dono da chave, edição guardada. |
| `audio-cliente.test.js` | Validador de áudio dos dois content scripts. |
| `auditoria.test.js` | Correções pontuais da auditoria (escape de HTML, silenciamento de áudio, destino do servidor). |

Não substitui um teste manual no WhatsApp e no Instagram reais: o DOM simulado reproduz o
que foi medido ao vivo, mas os dois sites mudam de layout sem avisar.

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
| `MAX_AUDIO_BYTES` | não (padrão `20971520`) | Teto do tamanho de um áudio enviado para transcrição. |
| `TRANSCRIPTION_CACHE_TTL_SEG` | não (padrão `86400`) | Por quanto tempo a transcrição de um mesmo áudio fica em cache (chave = hash dos bytes). `0` desliga. |
| `ANTHROPIC_TIMEOUT_MS` / `GROQ_TIMEOUT_MS` | não (padrão `50000`) | Tempo máximo de cada chamada. A Vercel corta a função em 60s; estourar dá mensagem clara em vez de erro opaco. |
| `CR_DATA_DIR` | não | Pasta dos arquivos de dados no modo local (padrão `data/`). Os testes usam uma pasta temporária. |
| `RDSTATION_CRM_TOKEN` | só para a ficha do lead | Token de acesso do RD Station CRM (API v1). Vazio = ficha desligada. De um usuário que vê todas as negociações. |
| `CRM_CACHE_TTL_SEG` / `CRM_TIMEOUT_MS` | não (padrão `300` / `8000`) | Cache da ficha no servidor e tempo máximo de cada chamada ao RD. |

`SDR_NAME` no `.env.example` é só um nome de exibição de reserva para quando o PDF é
gerado sem usuário autenticado (uso local avulso) — em uso normal, quem assina o
report é sempre o dono da chave (`x-cr-key`).

## Qualidade do report

- **Conversa como dado, não como instrução.** O prompt (`PROMPT_VERSAO = 'v2'`) põe a
  conversa entre `<conversa>` e `</conversa>` e manda tratar tudo ali dentro como
  material a analisar; marcas parecidas escritas por alguém na conversa são
  neutralizadas (`src/citacoes.js`).
- **Regras de leitura:** só é afirmação do lead o que o lead escreveu; correção posterior
  prevalece; faturamento não é lucro nem verba; números e nomes exatamente como ditos.
- **Citações conferidas sem IA.** Depois da geração, cada "fala do lead" é comparada com
  as falas reais (`verificarCitacoes`): inteira na conversa, ou com ≥ 80% das palavras
  **na mesma ordem** e **todos os números iguais**. Fala inventada ou com número trocado
  sai do report (o report continua válido sem citações). O painel mostra quantas foram
  removidas, junto do cache do prompt e das capturas parciais — a base para decidir
  custo e qualidade com número.
- **Captura parcial visível.** A extensão manda quantos áudios achou e quantos
  transcreveu (`captureQuality`); o servidor recalcula "incompleta" e o painel marca o
  report como *captura parcial*.
- **Remetente conferido.** A extensão também manda quantas mensagens leu de cada lado;
  o aviso final mostra "N mensagens · X suas · Y do lead" e alerta quando um lado vem
  zerado numa conversa de 6+ mensagens (quase sempre é leitura errada do remetente). O
  painel marca esses reports como *remetente a conferir*. Quando o WhatsApp/Instagram
  some com os sinais de remetente, a extensão usa a posição da bolha (a sua encosta na
  direita) em vez de jogar tudo para o lead.
- **Trava de conversa.** Se o SDR abrir outra conversa durante a leitura, a extensão
  aborta em vez de misturar duas conversas (WhatsApp: id da conversa nos `data-id`;
  Instagram: endereço `/direct/t/<id>`). O nome do contato é o do começo da leitura.

O que **não** existe: status por campo (confirmado/inferido) e a origem de cada
afirmação por mensagem. Mudam o contrato com a IA e o PDF e só dá para validar com
chamadas pagas de verdade — ver `docs/plano-implementacao.md`.

## Custo por report

A Anthropic é o único custo por report (Groq e o dashboard/stats são gratuitos). O
prompt usa **cache** (system + exemplos + base de conhecimento ficam num prefixo
cacheado, TTL de 1h): a partir do segundo report do dia, a maior parte do prompt é lida
a ~0,1x do preço normal. `src/precos.js` calcula o custo real de cada report (já
considerando cache) e `src/stats.js` guarda esse número — dá pra ver o total, a média
diária/mensal e o gasto por SDR na aba **Reports gerados** do dashboard.

Reeditar um report e baixar o PDF de novo (`/api/pdf`) **não** chama a IA — não conta
como um novo report nem soma custo.

### Versão do prompt

`PROMPT_VERSAO` (em `src/report.js`) compõe a `reportKey`: subir a versão faz a mesma
conversa poder ser gerada de novo com o prompt novo. `v3` = nível de consciência, "Como foi
a conversa" e sinais de compra.

### Normalização e custo

Antes de montar o prompt, `src/conversation-normalizer.js` limpa a conversa: remove
mensagens vazias e o eco de texto **longo** repetido em seguida ("ok", "sim" e "[áudio]"
repetidos são falas reais e ficam), agrupa mensagens de texto seguidas do mesmo
remetente (menos prefixo repetido) e, só se a conversa passar de `MAX_CONVERSATION_CHARS`,
corta preservando as mensagens mais recentes **e** qualquer trecho com sinal comercial
(dor, orçamento, prazo, decisor, objeção, concorrência, próximos passos, compromissos —
essas nunca somem por causa do limite). Quando isso acontece, o report volta com
`resumida: true` e a tela mostra um aviso.

### Idempotência (não pagar duas vezes pela mesma conversa)

`/api/report-direto` e `/api/report-texto` calculam uma `reportKey` (hash da conversa
normalizada + versão do prompt + modo de qualidade, em `src/idempotencia.js`). Se já
existe um report com a mesma chave, o servidor **não chama a IA de novo** — devolve
`{ duplicado: true, existente: { id, quando, lead, podeAbrir } }`. A extensão e o painel
mostram duas opções: **Abrir o existente** (baixa o PDF guardado, sem IA — o SDR só abre
os seus; o admin abre qualquer um, via `GET /api/reports/:id/pdf`) ou **Gerar de novo**
(`forcarNovo: true` no corpo do pedido pula a checagem e cobra a IA de novo). Uma trava
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

## Ficha do lead no WhatsApp (RD Station CRM)

Ao abrir uma conversa no WhatsApp Web, a extensão mostra um cartão no canto com a negociação
do lead no RD Station CRM: etapa e funil, responsável, as respostas do formulário (a anotação
com linhas "Campo: valor", como *Profissão / Estado / Vende online / Investimento*), campos
personalizados, outras anotações e o link para abrir no RD. Liga/desliga no popup.

- **Como acha o lead.** Pelo telefone da conversa: o cabeçalho mostra o número quando o
  contato não está salvo; ao abrir pelo botão de WhatsApp do card no RD
  (`web.whatsapp.com/send?phone=…`), o número vem no link e vale para a conversa que ele
  abriu, mesmo com o contato salvo por nome; ou o id do chat, quando o WhatsApp o expõe. O
  servidor tenta os formatos em que o número pode estar no RD — primeiro como o card mostra,
  `(11) 96763-6300`, depois só dígitos, com/sem 55 e com/sem o 9 — e só aceita um contato
  cujos **8 últimos dígitos** batem.
- **Onde aparece.** Encostado na borda direita da conversa (não da janela): quando a extensão
  oficial do RD Station CRM está aberta à direita, o cartão fica ao lado do painel dela. Contato salvo com nome: busca pelo nome; mais
  de um resultado vira uma lista para o SDR escolher. Não achou: o próprio cartão tem busca.
- **Qual negociação.** A em aberto mais recente do contato; se todas fecharam, a última.
- **Segurança.** O token (`RDSTATION_CRM_TOKEN`) fica só no servidor. A extensão manda só
  telefone/nome, por POST (fora de URL e de log). Tudo que vem do CRM entra no cartão como
  texto, nunca como HTML. O cartão fica fora do `#main`, então a leitura do report nunca o
  confunde com mensagem.
- **Custo de API.** Cache de 5 min por telefone no servidor (não achado: 2 min); usuários e
  rótulos de campos do CRM: 1 h. Uma conversa nova custa de 3 a 8 chamadas ao RD.
- `POST /api/crm/lead` `{ telefone?, nome?, contatoId? }` (chave do SDR) e
  `POST /api/admin/crm/teste` (admin: sem cache, mostra quais formatos de telefone foram
  tentados). No painel, aba **Extensão** → **Ficha do lead (RD Station CRM)** → Testar.
- API usada (RD Station CRM v1): `/contacts?phone=`, `/contacts?q=`, `/contacts/{id}`,
  `/deals/{id}`, `/activities?deal_id=`, `/users`, `/custom_fields?for=contact`.

## Reports do dia (.zip para o líder)

Todo usuário (SDR ou admin) baixa o .zip com **os próprios** reports do dia — pela aba
**Reports do dia** do painel ou pelo botão **Baixar meus reports de hoje (.zip)** do
popup da extensão.

- **Só o último de cada lead.** Quando o SDR refaz o report de um lead (áudio que não
  veio, informação lida errado), vale o último. `src/diario.js` agrupa por SDR + dia +
  lead e marca o gerado por último. "Mesmo lead" = mesmo **contato** (nome ou telefone
  que a extensão leu no cabeçalho, guardado em `contato` em cada report) — estável entre
  gerações, ao contrário do nome que a IA devolve. Sem contato (reports manuais sem nome
  ou anteriores a esta versão), usa o nome do lead. Status lido por engano ("online",
  "Ativo(a) agora") nunca junta leads diferentes.
- **Ajuste manual.** A aba lista todos os reports do dia com uma caixa por report
  (marcada = vai no .zip); o SDR pode trocar qual versão manda.
- `GET /api/meus-reports?dia=YYYY-MM-DD` (lista, com `usar`, `substituidoPor`,
  `geracoes`) e `POST /api/meus-reports/zip` `{ dia, ids? }` — sem `ids`, o último de cada
  lead; com `ids`, exatamente esses, sempre restritos aos reports **da própria chave**
  naquele dia. Nome do arquivo: `Reports_<SDR>_<dd-mm-aaaa>.zip`; nomes repetidos dentro
  do .zip ganham " (2)". Cabeçalhos `X-Reports-No-Zip` e `X-Reports-Sem-Pdf`.
- **Admin:** o .zip da aba **Arquivos** tem a opção **"só o último report de cada lead
  no dia"** marcada por padrão (`?ultimo=1` em `/api/admin/reports/pdf-zip`).

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
- **Virtualização do Direct + rolagem:** o Instagram DESTRÓI do DOM as mensagens
  que saem da tela (medido ao vivo: 5 nós no DOM numa conversa de 2959px), então
  não dá pra rolar até o topo e ler tudo no fim. Pior: **a lista ignora escrita
  em `scrollTop`** (pedir `scrollTop = 2959` deixava em `1`), então dirigir a
  rolagem por número não funciona — `coletarConversa()` navega com
  `scrollIntoView()` na própria mensagem, deixando o navegador resolver como
  rolar. Lê progressivamente enquanto desce, costurando cada janela na anterior
  pela maior sobreposição de sequência — repetição real na conversa ("kkk" duas vezes)
  continua aparecendo duas vezes, porque a comparação é de sequência e não de
  conjunto. O áudio é capturado no passo em que a bolha aparece, pelo mesmo
  motivo (depois ela não existe mais pra clicar no play).
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
- [`docs/auditoria-pronix.md`](docs/auditoria-pronix.md) — status de cada achado da
  auditoria externa (corrigido, parcial, confirmado, não verificado).
- [`docs/plano-implementacao.md`](docs/plano-implementacao.md) — o que falta, em etapas.
