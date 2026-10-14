# Report PRONIX

Extensão do Chrome + servidor que transformam a conversa de prospecção em um **relatório de
handoff em PDF** para o closer — com um clique, direto do **WhatsApp Web** ou do **Instagram
Direct**, lendo o histórico inteiro e transcrevendo os áudios.

Em volta do report, a ferramenta virou a mesa de trabalho do pré-vendedor: mostra a **ficha do
lead no RD Station** ao lado da conversa, resume onde a conversa parou, tem um **coach gratuito**
que lê o perfil do lead e sugere a próxima mensagem, move o card no RD quando o lead responde e
acumula dados para responder, com número, **qual closer fecha com qual tipo de lead** e **o que
funciona na prospecção**.

Sem bot, sem QR code e sem biblioteca não oficial: a extensão só lê a página que o SDR já tem
aberta e logada.

---

## Sumário

1. [O que a ferramenta entrega](#o-que-a-ferramenta-entrega)
2. [Como funciona](#como-funciona)
3. [Começando](#começando)
4. [Papéis e permissões](#papéis-e-permissões)
5. [O report](#o-report)
6. [O cartão do lead no WhatsApp](#o-cartão-do-lead-no-whatsapp)
7. [Inteligência comercial](#inteligência-comercial)
8. [O painel](#o-painel)
9. [API](#api)
10. [Variáveis de ambiente](#variáveis-de-ambiente)
11. [Dados guardados](#dados-guardados)
12. [Testes](#testes)
13. [Deploy e publicação](#deploy-e-publicação)
14. [Segurança e privacidade](#segurança-e-privacidade)
15. [Limites e riscos](#limites-e-riscos)
16. [Estrutura do projeto](#estrutura-do-projeto)
17. [Documentação relacionada](#documentação-relacionada)

---

## O que a ferramenta entrega

| Para quem | O quê |
| --- | --- |
| **Pré-vendedor (SDR)** | Report em PDF com um clique; ficha do lead do RD ao abrir a conversa; resumo rápido para retomar um lead; coach em popup com a dica de como seguir; .zip com os reports do dia. |
| **Closer** | Handoff de até 2 páginas: resumo, perfil do lead e como conduzir, nível de consciência, sinais de compra, como foi a conversa e a fala pronta para abrir a reunião. |
| **Gestão** | Custo por report e por SDR, PDFs de toda a equipe, resultado de cada reunião, matriz closer × perfil de lead, padrões da prospecção que fecha e insights escritos por IA gratuita. |

**Custo:** só a geração do report (Anthropic) é paga. Transcrição de áudio, leitura de print,
coach, insights, ficha do RD e a automação do cartão não têm custo por uso.

---

## Como funciona

```
WhatsApp Web / Instagram Direct
   │  extensão (content script): lê o DOM, rola o histórico, captura os áudios no mudo
   ▼
service worker da extensão ── x-cr-key ──▶ servidor (Express, na Vercel)
                                             │
                                             ├─ transcreve os áudios ........ Groq (Whisper)
                                             ├─ normaliza a conversa ........ src/conversation-normalizer.js
                                             ├─ gera o report ............... Anthropic (prompt em cache, saída estruturada)
                                             ├─ confere as citações sem IA .. src/citacoes.js
                                             ├─ monta o PDF ................. pdfkit, até 2 páginas
                                             └─ registra custo e leitura .... src/stats.js
   ▼
PDF em base64 ──▶ a extensão oferece o download (e o painel guarda uma cópia)
```

- **Produção (Vercel):** o mesmo `server.js`, exposto por `api/index.js`. Dados no Vercel KV /
  Upstash Redis (o disco da Vercel não persiste). Áudio sempre pelo Groq.
- **Local (`npm start`):** dados em `data/*.json`; áudio pelo Groq se houver `GROQ_API_KEY`,
  senão pelo `faster-whisper` em Python.

`src/db.js` escolhe o modo sozinho, olhando se `KV_REST_API_URL` e `KV_REST_API_TOKEN` existem.

---

## Começando

### Servidor local

```bash
npm install
cp .env.example .env      # preencha pelo menos ANTHROPIC_API_KEY e ADMIN_PASSWORD
npm start                 # http://localhost:3000
```

Abra `http://localhost:3000`, entre com a `ADMIN_PASSWORD` e crie o primeiro acesso na aba
**Acessos** (papel **Master**). Cada acesso é um nome + uma chave `pnx_…` — não há e-mail nem senha.

### Extensão

- **Equipe:** instala pela Chrome Web Store (atualiza sozinha). Passo a passo em
  [`GUIA-SDR.md`](GUIA-SDR.md).
- **Desenvolvimento:** `chrome://extensions` → **Modo do desenvolvedor** → **Carregar sem
  compactação** → pasta `extension/`. No popup, cole a chave; para apontar para o servidor local,
  troque o endereço para `http://localhost:3000`.

Para usar: abra a conversa do lead, clique no ícone da extensão e em **Gerar Report da conversa
aberta**. Um aviso no canto acompanha a leitura e, no fim, oferece o PDF. Dá para responder
outros leads enquanto a IA escreve — só não troque de conversa durante a leitura.

---

## Papéis e permissões

| | Usuário (SDR) | Gestor | Master |
| --- | :---: | :---: | :---: |
| Gerar report (extensão e painel) | ✓ | ✓ | ✓ |
| Reports do dia — os próprios (.zip) | ✓ | ✓ | ✓ |
| Reports do dia — equipe inteira (.zip com uma pasta por SDR) | | ✓ | ✓ |
| Reports gerados (números, custo, closer e resultado) | | ✓ | ✓ |
| Arquivos (PDFs guardados, download em massa) | | ✓ | ✓ |
| Base de conhecimento | | ✓ | ✓ |
| Aba Extensão (download, teste do RD) | | ✓ | ✓ |
| Acessos (criar, editar, remover chaves e permissões) | | | ✓ |
| Resultados da reunião e inteligência | | | ✓ |
| Closers (adicionar e remover) | | | ✓ |
| Escolher o closer no aviso "Report pronto!" | | | ✓ |

O papel é só o ponto de partida. Na aba Acessos o master marca, **pessoa por pessoa**, quais abas do
painel ela abre (Reports gerados, Resultados da reunião, Closers, Arquivos, Base, Extensão e os
reports do dia da equipe) — a aba Acessos é sempre só do master. Quem recebe a aba Resultados sem ser
gestor vê e edita apenas os próprios reports. O servidor confere a mesma permissão em cada rota.

Além do papel, o master liga quatro recursos **por pessoa** na aba Acessos:

| Recurso | Padrão | O que libera |
| --- | --- | --- |
| **Popup do lead** | ligado para todos | Ficha do RD e resumo rápido no WhatsApp. |
| **Coach** | só o master | Popup do coach: a dica de como seguir, quando você pede. |
| **Automação RD** | só o master | Mover o card para "Respondeu", etiqueta "Qualificado" e agendamento. |
| **Etiquetas** | só o master | No cartão, o investimento do formulário ("R$ 3 a 5k", "R$ 5k+") e se o lead já vende. |
| **Cor na agenda** | master: Banana; demais: nenhuma | A cor com que as reuniões dos leads da pessoa são pintadas no Google Agenda. O master já começa na Banana sem configurar; "Não pintar" escolhido à mão é respeitado. |

Regras do cadastro (`src/usuarios.js`): o único master não pode ser rebaixado nem removido; enquanto
não houver nenhum, o usuário cujo nome é `MASTER_NOME` é promovido uma vez. A `ADMIN_PASSWORD` é o acesso
reserva (cria o primeiro master).

---

## O report

### O que vem no PDF

- **Resumo** em linhas (nível, investimento, motivação, decisor, perfil…). **Investimento,
  Motivação e Decisor(es) nunca ficam em branco:** a IA extrai o sinal que já está na conversa
  ("tenho uma distribuidora há 12 anos" já responde investimento).
- **Perfil do lead** — dominante, analítico, cético, relacional, cauteloso ou entusiasta — com
  a evidência e uma frase de **como conduzir** a reunião (`src/perfil.js`).
- **Termômetro de dores:** até 3 dores que o lead demonstrou, cada uma com a intensidade de 1 a
  5 (cinco degraus, mais quentes quanto mais dói) e a prova do que ele disse. É o motivo da
  compra, então abre o cartão do topo. Só entra **dor de fato** (3 ou mais): a citada de passagem
  fica fora, e na dúvida a IA dá a intensidade menor (`src/dores.js`).
- **Temperatura do lead:** nível de consciência (inconsciente → problema → solução → nossa
  entrega → pronto para decidir) com o porquê, e os sinais de compra com a prova da conversa.
  O selo só aparece **de "consciente da solução" para cima** (`src/consciencia.js`) e cada nível
  exige prova: sem ela, a IA desce um degrau.
- **Como foi a conversa:** 4 a 6 frases em ordem cronológica, com os nomes de quem falou.
- **Seções de análise**, **nas palavras do lead** (0 a 2 falas, só as muito boas) e a
  **frase de impacto**.
- **Como iniciar a reunião:** fala pronta para o closer, junto dos 3 pontos-chave do resumo.

**Tom só positivo.** O report existe para "vender" o lead ao closer: nenhum ponto real é omitido
(objeção, decisor ausente, orçamento apertado), mas tudo é escrito como próximo passo, nunca como
alerta. Fala do lead que desanima fica fora das citações — pelo prompt e por um filtro sem IA
(`citacaoDesanimadora`).

**Editável e de graça.** Qualquer campo pode ser corrigido no popup da extensão ou no painel; o
PDF é refeito sem chamar a IA (`POST /api/pdf`).

### Qualidade

- **Conversa é dado, não instrução.** O texto vai entre `<conversa>` e `</conversa>`; marcas
  parecidas escritas por alguém na conversa são neutralizadas.
- **Regras de leitura:** só é afirmação do lead o que o lead disse; correção posterior
  prevalece; faturamento não é lucro nem verba; números e nomes exatamente como ditos; **nome de
  pessoa nunca é inventado**.
- **Citações conferidas sem IA** (`verificarCitacoes`): a fala precisa estar na conversa, ou ter
  ≥ 80% das palavras na mesma ordem e todos os números iguais. A que não passa sai do report.
- **Captura parcial à vista.** A extensão informa quantos áudios achou e quantos transcreveu; o
  painel marca *captura parcial*.
- **Remetente conferido.** O aviso final mostra "N mensagens · X suas · Y do lead" e alerta
  quando um lado vem zerado. Se o site some com os sinais de remetente, vale a posição da bolha.
- **Trava de conversa.** Trocou de conversa durante a leitura? A extensão aborta em vez de
  misturar duas conversas.

### Custo

- **Cache do prompt.** Instruções, exemplos e a base de conhecimento ficam num prefixo em cache
  (1 h): a partir do segundo report, essa parte custa cerca de 0,1x.
- **Idempotência.** A `reportKey` é o hash da conversa normalizada + versão do prompt + modo de
  qualidade (`src/idempotencia.js`). Conversa igual não chama a IA de novo: a extensão pergunta
  entre **Abrir o existente** e **Gerar de novo**. Uma trava por chave impede duas gerações
  simultâneas da mesma conversa.
- **Normalização** (`src/conversation-normalizer.js`): remove vazios e ecos longos, agrupa falas
  seguidas e, só acima de `MAX_CONVERSATION_CHARS`, corta preservando o mais recente e todo
  trecho com sinal comercial. Quando corta, o report avisa.
- **Modo de qualidade.** `qualidade: "eco" | "standard" | "premium"` troca só o modelo; nunca é
  automático. `POST /api/estimar-custo` mostra a estimativa no painel sem chamar a IA.
- **Custo registrado.** `src/precos.js` calcula o custo real de cada report (com cache) e
  `src/stats.js` guarda o número da época — recalcular depois daria outro valor.

**Versão do prompt:** `PROMPT_VERSAO = 'v6'` em `src/report.js`. Subir a versão permite gerar de
novo uma conversa já feita.

---

## O cartão do lead no WhatsApp

Ao abrir uma conversa no WhatsApp Web, um cartão aparece encostado na borda direita da conversa —
e, para quem tem o Coach, o popup dele na borda esquerda. Liga e desliga no popup da extensão;
**–** minimiza e **×** fecha só naquela conversa.

### Ficha do RD Station

Etapa e funil, responsável, as respostas do formulário (a anotação com linhas "Campo: valor"),
campos personalizados, outras anotações e o link **Abrir no RD Station**.

- **Como acha o lead.** Pelo telefone: o cabeçalho (contato não salvo), o link de WhatsApp do
  card no RD (`send?phone=…`) ou o painel "Dados do contato". O servidor tenta os formatos em que
  o número pode estar no RD e só aceita contato cujos **8 últimos dígitos** batem.
- **Contato salvo com nome.** O nome é limpo das etiquetas do time ("Armando PRONIX Moretti" →
  "Armando Moretti") e buscado do mais específico para o mais amplo. Só escolhe sozinho quando
  não há dúvida; senão mostra a lista. Não achou? O cartão tem busca.
- **Lead com vários cards.** O servidor junta todos os contatos com o mesmo telefone e abre o
  card que o SDR já escolheu; senão, o em aberto com atividade mais recente. O seletor "Este lead
  tem N cards" lembra a escolha no servidor.
- **Limpeza.** Acentos quebrados por integrações ("EmpresÃ¡rio") são consertados, campos
  repetidos aparecem uma vez e campos de anúncio/origem ficam de fora.

### Resumo rápido

Botão no cartão: lê a conversa e os áudios e devolve o **cenário**, **onde parou**, a **última
pergunta** e o **próximo passo**. Mesma conversa = resumo do cache por 7 dias, sem custo.

### Coach da conversa (custo zero)

Um **popup próprio**, separado do cartão da ficha, que só trabalha **quando você clica**:

- **Pedir dica** lê as mensagens que já estão na tela (não rola a conversa nem toca áudio) e, num
  modelo gratuito do Groq, devolve:
  - **AGORA** — a dica do momento: o que a última fala do lead revela e o que fazer em seguida;
  - a **próxima mensagem** pronta para copiar e o **perfil do lead**;
  - a **análise completa** (recolhida): evidência do perfil, como abordar, **o que ainda falta
    levantar** (BANT, a implicação do SPIN e o que o closer mais usa: valor disponível, cartão e
    limite, meta, tentativa anterior, concorrente), objeções com resposta e perguntas.
- **Ler conversa inteira** faz a leitura completa, com os áudios transcritos. As transcrições
  ficam lembradas naquela aba e entram nas dicas seguintes; áudio ainda não lido aparece como
  `[áudio]` e o popup avisa quantos faltam.
- **Nada é pedido sozinho.** Chegou mensagem depois da dica? O popup só avisa e espera o clique
  em **Atualizar**.
- **Aprende sem treinar modelo:** o que o SDR marca como "Funcionou" vira exemplo nos próximos
  pedidos.
- **Popup de verdade:** arrasta pelo topo (o lugar fica guardado; duplo clique volta ao padrão),
  minimizado mostra só a dica do momento, e não depende do RD.
- **Modelos:** fila `openai/gpt-oss-120b` → `openai/gpt-oss-20b` → `llama-3.3-70b-versatile` →
  `llama-3.1-8b-instant`. Saiu do ar ou bateu no limite, o seguinte assume. O plano gratuito
  limita cerca de 8 mil tokens por minuto por modelo, por isso o pedido vai enxuto.

### Automação do cartão

Três coisas, sem IA e sem custo, para quem o master ligou:

1. **Mover para "Respondeu" no RD.** Com a conversa aberta, se há mensagem do lead depois de uma
   mensagem sua e o card está em aberto e **antes** de "Respondeu" no mesmo funil, o servidor
   avança o card. É a única escrita **automática** que o sistema faz no RD (a outra é a limpeza do funil, pedida pelo master): nunca volta um card, não mexe em
   card fechado nem em funil sem essa etapa, confere tudo de novo no RD na hora e registra cada
   movimento. O RD só aceita se o dono do token for o responsável pelo card ou do mesmo time; se
   recusar, o cartão mostra o motivo.
2. **Etiqueta "Qualificado".** Serve para saber, sem reouvir a conversa, que aquele lead **já foi
   qualificado**. Só entra por três caminhos: o card está na etapa "Qualificado" do RD, um report
   foi gerado para o lead, ou você marcou à mão. Lead que apenas respondeu **não** ganha
   etiqueta, e ter agendamento também não qualifica ninguém. Uma vez colocada, **fica lembrada**
   mesmo que o card mude de etapa (remarcou, sumiu); passar o mouse mostra de onde ela veio.
   Marcar ou tirar à mão vale sobre a leitura automática.
3. **Dia e horário agendados.** `extension/agenda.js` lê, no navegador, a última mensagem sua
   que **confirma** um compromisso com dia e hora ("reunião agendada para quinta às 15h",
   "remarquei para 10/10 às 16h", "ficou para amanhã às 9h") — ou o lead escolhendo um horário
   que você ofereceu, seguido do seu "Agendado!". Citar reunião, horário ou diagnóstico não
   basta, e proposta ("posso agendar para amanhã às 15h?"), oferta de opções e duração ("2h por
   dia") não contam. Agendamento dito em áudio entra quando o resumo, o coach ou o report leem
   a conversa inteira. Depois do horário, vira "Estava agendado".

O texto da conversa não vai ao servidor para isso — só o pedido de mover, a etiqueta e a data.

**Etiqueta de perda.** Se o card do lead foi dado como perdido no RD, o cartão mostra, em vermelho,
**DESQUALIFICADO · motivo** (card na etapa de desqualificados) ou **PERDIDO · motivo** (perdido em
outra etapa), com a anotação da perda ao passar o mouse. Vem da própria ficha do RD, então aparece
para quem vê o cartão, sem depender da automação; cobre tanto a perda dada à mão quanto a da
Limpeza do RD. Lead com outro card em aberto não ganha a etiqueta: a ficha mostra o card aberto.

**Reunião pelo Google Agenda.** Quando o master conecta a conta dele (aba **Extensão** → **Google
Agenda**), o servidor lê as agendas que essa conta enxerga — as dos closers, compartilhadas com
ela — e procura o evento em que o **e-mail do lead** é convidado (sem e-mail no RD, o nome inteiro
no título). O cartão mostra "Agendado: hoje às 14:00 · Vitor", e isso vale mais que o lido na
conversa. Remarcou pelo link? Vale a próxima reunião. Cache de 10 min por lead, e uma falha do Google nunca derruba a ficha (`src/agendaGoogle.js`).

**Cor do pré-vendedor na agenda.** O time marca de quem é cada lead pela cor do evento. Em Acessos,
cada pessoa pode ter uma cor: ao abrir a conversa do lead, a reunião **futura** dele é pintada com
ela, se o evento ainda não tiver cor (lead já marcado por outro não é trocado). É a única alteração
que o sistema faz na agenda, e exige que a conta conectada possa editar os eventos dos closers.

---

## Inteligência comercial

O objetivo é decidir por dado, não por achismo: **que closer pega que lead** e **que prospecção
funciona**.

1. **Cada report guarda uma leitura** (fora do PDF): perfil do lead, nível de consciência e a
   análise da prospecção — BANT, SPIN, as perguntas-chave do pré-vendedor e a abordagem.
2. **O closer é escolhido na extensão**, no aviso "Report pronto!". Havendo histórico, o closer
   indicado para aquele perfil vem marcado "(indicado)" com o motivo. Nada é salvo sozinho.
3. **O resultado é marcado na aba Resultados da reunião:** venda em call, venda em follow-up,
   pix de compromisso, não fechou, no-show ou em follow-up, com anotação e a correção do perfil e
   do nível de consciência quando a IA errou.
4. **A conta é feita sem IA** (`src/inteligencia.js`): matriz closer × perfil, conversão por
   perfil e por nível, e o que difere na prospecção das reuniões que fecharam.
5. **Insights** escritos pelo Groq gratuito, só em cima dos números e das perguntas do SDR (a fala
   dos leads não é enviada). Exige 5 reuniões com resultado.

- **Onde cada closer vai melhor, e por quê.** A aba mostra, sem IA, frases como "Paulo vai melhor
  com lead cauteloso: fechou 3 de 4 (75%), contra 0 de 2 com os outros perfis", seguidas das
  anotações de "o que deu a reunião" — é delas que sai o porquê. Os insights da IA recebem os
  mesmos dados e não podem inventar motivo: sem anotação, dizem que falta anotar.
- **Closer preenchido sozinho.** Ao abrir a conversa do lead, se o card no RD já está em "Reunião
  Realizada" (ou no funil dos closers) com o closer como responsável, ou se a reunião está na agenda
  de um closer, os handoffs daquele lead que estão sem closer são preenchidos (`src/closerAuto.js`).
  Só vale closer cadastrado na aba Closers, e closer já marcado nunca é trocado.
- **Desfecho puxado do RD.** O closer registra o fim no RD: vendido (com o produto e o valor), ou
  perdido / etapa "Não compraram" com o motivo. O servidor lê isso (`src/vendasRd.js`) e preenche
  a linha sozinho:
  - **vendido** vira **Venda em call** — ou **Venda em follow-up**, se o card já tinha passado pelo
    follow-up ou fechou depois do dia da reunião —, com o **produto** e o **ticket** do card. Você
    só completa a forma de pagamento. Tipo, produto e ticket preenchidos à mão nunca são trocados;
  - **não comprou** vira "Não fechou" com o motivo em "o que deu a reunião" e sai da lista.

  Só vale desfecho registrado depois de o report existir.
- **O resultado acompanha o estado do card.** O que o RD deu (e não o que foi marcado à mão) muda
  junto com o card: "Não compraram" vira "Não fechou"; perda com motivo de falta ("no-show", "não
  compareceu") vira **No-show**; o lead que "não comprou" e voltou a negociar volta para **Em
  follow-up**; e se ele comprar depois, vira **Venda em follow-up**. Resultado escolhido à mão nunca
  é trocado (o report guarda de onde o resultado veio: `resultadoOrigem`).
- **Puxar do RD é retroativo.** O botão confere **todo o período escolhido** em Resultados — um lote
  por vez, até acabar (`?varredura=`) —, inclusive os reports com resultado à mão que estão sem
  closer (ganham o closer; o resultado fica). Para preencher o mês, escolha o período e clique uma vez.
- **Trazer do Report Closer.** Report gerado só no Report Closer (o sistema da empresa) fica só no
  banco de lá. Lá, em Resultados → **Levar para o Report PRONIX** (período, closer, só vendas), sai um
  .json com cada report e o PDF; aqui, em Resultados → **Trazer do Report Closer**, ele é importado
  (`POST /api/master/importar-reports`, `src/importarReports.js`): só os reports do próprio usuário, o
  closer achado pelo nome no cadastro daqui, sem duplicar (mesmo report, ou o mesmo lead com até 3 dias
  de diferença).
- **De hora em hora.** A conferência roda sozinha: a extensão bate no servidor a cada hora enquanto o
  Chrome está aberto (`POST /api/rd/atualizar`), a aba Resultados confere ao abrir, o agendador da
  Vercel roda uma vez por dia (`/api/cron/rd`, com `CRON_SECRET`) e o botão **Puxar do RD** confere
  na hora. Para não gastar consulta à toa: nunca roda mais de uma vez a cada 30 min, olha no máximo
  10 a 25 leads por rodada, report recente conferido há menos de 50 min e report antigo conferido há
  menos de 20 h ficam para a próxima. É só leitura no RD e não usa IA.
- **Achar o card certo.** O nome do contato no WhatsApp não serve para achar o lead no RD. Ao gerar
  o report, a extensão manda o que o cartão aberto sabe do card — id do contato, e-mail e telefone —
  e o report fica **vinculado**. A busca vai pelo e-mail, depois pelo telefone (os dois enxergam os
  cadastros repetidos do mesmo lead, onde o card da reunião às vezes está), depois pelo id e, por
  último, pelo nome. Cada linha mostra o que o RD respondeu ("RD: Reunião Realizada · CLOSERS ·
  Fulano"). Lead não achado aparece em vermelho com um campo para informar o **e-mail ou o telefone**:
  o sistema vincula e confere na hora. Reports antigos se vinculam sozinhos quando a conversa é
  reaberta com o cartão na tela.
- **Conferir uma pessoa.** Em "Reports de", o master escolhe ver os resultados de um usuário.
- **Dados da venda.** Na venda, a linha ganha produto (PRONIX Performance ou Acelera), ticket e forma
  de pagamento. O valor do card vendido no RD já vem como ticket, se o campo estiver vazio.
- **Etapas do funil dos closers.** "FUP Agendado" e "Fluxo de FUP" marcam "Em follow-up" ("Em
  contato" e "Negociação Avançada" também, quando o card está no funil dos closers), "Vendido" vale
  como venda mesmo sem o card estar marcado como ganho, e o responsável do card que está com um
  closer vira o closer do report — mesmo que o lead tenha outro card ainda no funil do pré-vendedor.
- **No-show não é reunião.** Sai da lista de resultados (volta com "Mostrar no-show"), fica fora
  do .zip do dia e não conta como venda perdida do closer.
- **Perfil com critério.** A IA testa os perfis em ordem e exige prova na fala do lead;
  "cauteloso" só com hesitação dita, para não virar o perfil de todo lead educado.
- **Sem amostra, sem indicação.** O closer só é indicado com **3 ou mais reuniões** dele com
  aquele perfil, com taxa suavizada (1 de 1 não passa na frente de 8 de 10).
- **A IA aprende o nível de consciência de graça.** Cada correção do master vira um exemplo no
  prompt dos próximos reports (os 8 mais recentes). Não há treino de modelo.
- **Escopo.** Resultados e inteligência usam os reports de quem está olhando; o seletor "Toda a
  equipe" inclui os demais.

### Linha do tempo do contato no report

Das **datas das mensagens** (sem IA), o resumo do report ganha, quando faz sentido:

- **Contato:** "Conversando com o lead desde 23/09 (24 dias)" — quando o primeiro contato tem mais de 7 dias;
- **Confirmação:** "Confirmado desde quarta-feira (14/10)" — quando o lead confirmou a reunião num dia
  anterior ao do report (inclusive 1 ou 2 dias antes), e "· reconfirmado no dia (sábado, 17/10)" quando
  ele confirmou de novo no dia. Conta como confirmação o lead escrever que confirma ("confirmado",
  "confirmo", "estarei lá") ou responder que sim logo depois de você pedir a confirmação; se a reunião foi
  remarcada, vale a confirmação de depois (`src/linhaDoTempo.js`).

Conversa colada como texto, sem datas, não ganha essas linhas.

### Desqualificar pelo WhatsApp

No cartão do lead, o botão **Desqualificar** (para quem tem a automação do cartão) mostra os motivos de
perda cadastrados no RD; escolhido o motivo e confirmado, o card do lead vira **perda** com esse motivo,
vai para "Desqualificados" (se o funil dele tiver essa etapa) e o campo SDR recebe o seu nome — sem abrir o
card no RD. Só vale o card em aberto do lead da conversa (o servidor confere na ficha), e a mudança entra
no registro da limpeza: aparece no relatório por motivo e dá para **desfazer** pelo painel
(`GET /api/crm/motivos-perda`, `POST /api/crm/desqualificar`, `desqualificarCard` em `src/limpezaRd.js`).

### Limpeza do funil no RD

Card parado no começo do funil vira **perda em "Desqualificados"**, com o motivo certo:

| Onde o card está | Parado há mais de | Motivo de perda |
|---|---|---|
| Contato iniciado | 15 dias (ajustável) | Nunca respondeu |
| Respondeu | 15 dias (ajustável) | Parou de responder |

O campo **SDR** do card recebe o nome de quem pediu a limpeza. Fica na aba **Limpeza do RD** do menu
(Gestão comercial), só para o master, e nada acontece sozinho:

1. **Funil** — você escolhe em qual funil rodar (ex.: só o de SMQLs automáticas). A lista traz os
   funis que têm as três etapas; com mais de um, a limpeza nunca escolhe sozinha.
2. **Prévia** — lista o que seria mexido e de onde, sem alterar nada.
3. **Testar com 5 cards** — para conferir no RD antes do resto. A tela lista os cards movidos com
   o **e-mail do lead** e o link "Abrir no RD".
4. **Executar todos** — em lotes de 15. Cada card é lido de novo antes de mudar: se saiu da etapa,
   teve movimento, foi fechado ou é de outro responsável (em "só os meus"), é pulado.
5. **Relatório** — quantos cards por motivo ("• Nunca respondeu - 110"), com botão de copiar.
   Cada execução vira um **relatório salvo** (dia, funil e contagem), que fica no histórico da aba.
6. **Desfazer o último lote** — volta para a etapa de onde saiu e reabre o card.

"Parado" conta do movimento mais recente entre a última atividade, a última atualização e a criação
do card. É uma leitura conservadora do "esfriando" da tela do RD: na dúvida, não mexe. Os outros
campos personalizados do card são reenviados como estavam (`src/limpezaRd.js`).
`CRM_MOVER_ETAPA=0` desliga também esta escrita.

**Cadastros duplicados.** Na mesma aba, **Procurar duplicados** olha os cards em aberto do funil em
que você é o responsável e acha o mesmo lead em mais de um card: **e-mail igual ou telefone igual**
(DDD + 8 últimos dígitos, então "+55 71 99999-8888" e "(71) 9999-8888" são o mesmo). Um card fica e os
outros vão para "Desqualificados" com a perda **"Duplicado"** e o campo SDR preenchido.

- **Quem fica:** o card na etapa mais adiantada; no empate, o de movimento mais recente.
- **O que não é duplicado:** lead que já foi perdido e se inscreveu de novo (card fechado não entra
  na conta), card de outro responsável e card de outro funil.
- **Dado genérico:** e-mail ou telefone repetido em mais de 6 cards (teste, número de preenchimento)
  fica de fora, e a tela avisa.
- **Antes de fechar**, cada par é lido de novo: só fecha se o card que fica continua em aberto no
  funil, com o mesmo responsável e contato em comum. Nunca se fecha o último card vivo de um lead.
- A prévia mostra, por lead, o que fica e o que sai, e avisa quando o lead **cadastrou de novo**
  (o card que sai é mais novo que o que fica). Tem o mesmo "Testar com 5", os lotes, o relatório
  (linha "Duplicado") e o desfazer. O nome do motivo no RD pode ser trocado em
  `CRM_LIMPEZA_MOTIVO_DUPLICADO` (padrão: qualquer motivo que contenha "duplic").

### Afinidade com o closer ("Analisar Match com PH")

Para cada closer com **inteligência cadastrada** (aba Closers → Inteligência), o popup da extensão
ganha um botão **"Analisar Match com {apelido}"**. Clicar gera o report normal e, logo abaixo
do "Report pronto!", a análise:

- **nota de 0 a 10** da combinação lead × closer (não é "o lead é bom?", é "é bom *para ele*?");
- no aviso: o veredito, até três motivos, um ponto de atenção e a base da nota;
- um **segundo PDF**, de uso do pré-vendedor, com o relatório completo:
  - **pontos que dão match** — cada um com a prova do lead (a fala ou o fato) e o que as calls do
    closer mostram, com o número;
  - **pontos de atenção** — de onde vêm e como contornar antes ou durante a call;
  - **casos parecidos nas calls do closer** — as contas dos recortes em que o lead se encaixa (quem
    decide, momento, presença) e exemplos reais do que fechou e do que não, sem nome de lead;
  - **plano da call** em oito fases: abertura, quem decide e quem paga, perguntas de diagnóstico,
    devolver a dor, prova, proposta, pagamento e fechamento;
  - **objeções prováveis** (o sinal na conversa e a resposta), o que não fazer, **falas do lead**
    para usar (só as que ele disse de fato) e o que confirmar antes.

A análise são dois pedidos à IA gratuita — a avaliação e o plano da call —, porque cada pedido tem
tamanho limitado. Se o plano falhar, o relatório sai com a avaliação e os passos curtos, e a próxima
tentativa refaz o plano.

A nota cruza três coisas: a inteligência do closer (o que as calls dele ensinaram: com que tipo de
lead fecha — sozinho, casal, com sócio; perfil —, como conduz, onde trava), o histórico dele em
Resultados (vendas e reuniões por perfil de lead) e o que o report levantou do lead, mais o fim da
conversa. A inteligência é texto destilado, **sem nome nem dado de lead**; o material bruto
(transcrições) fica na pasta `privado/`, fora do Git.

Custo zero: a análise roda no Groq e o PDF é montado no servidor. Se a análise falhar, o report
continua pronto e o aviso oferece tentar de novo. A nota fica guardada no report, para comparar
depois com o que a reunião deu.

**Casos das calls e padrão.** Além do texto, a análise usa números medidos: cada negociação do
closer vira um *caso* com quem decidia (sozinho, casal, sócios, família), se todos os decisores
estavam na call, o momento do lead (loja física, já vende online, do zero), quantas reuniões e como
terminou. Os casos vêm de dois lugares (`src/casos.js`):

- do **pacote do closer** (aba Closers → Importar pacote): um `.json` com o cadastro, o apelido, a
  inteligência e os casos classificados das transcrições. Cria o closer se ele não existe; importar
  de novo troca os casos das transcrições, sem duplicar. Os casos não levam nome nem contato de lead,
  e o pacote, como as transcrições, fica em `privado/`, fora do Git;
- dos **reports**: lead analisado para aquele closer que teve o resultado da reunião marcado
  (venda ou não comprou) entra na conta sozinho, com o que a análise leu dele.

O padrão ("casal com os dois na call: 9 de 17") vai dentro do histórico no pedido à IA e aparece no
painel, em Closers → Inteligência.

**Conversa por ligação.** Sem conversa escrita, a extensão não tem o que ler. No painel, aba Gerar report, o cartão **Match com o closer** recebe o **PDF do handoff** (o que o próprio sistema gera) ou o texto do report colado, e devolve o PDF do match (`POST /api/afinidade/handoff`, `src/textoDoPdf.js`). Report gerado ali mesmo nem precisa do PDF: é só clicar. O PDF enviado não fica guardado; "falas do lead" no plano só as que estão entre aspas no report.

**Transcrições novas, direto do Drive.** Em Closers → Inteligência, cole o link da **pasta do Google
Drive** onde caem as transcrições das calls do closer (as anotações do Google Meet) e a data a partir
da qual ler. Todo documento novo vira um caso dele, e o padrão se atualiza (`src/transcricoes.js`,
`src/driveGoogle.js`):

- a pasta pode ter **uma subpasta por call** (com a gravação e o documento dentro), como o Meet costuma
  ficar organizado: a busca desce até dois níveis, descarta as subpastas com data no nome anterior à
  data de corte e pergunta pelos documentos de várias pastas por consulta. Com a pasta em dia, cada
  leitura olha só as duas últimas semanas; mudar a pasta ou a data recomeça da data escolhida;
- a leitura acontece sozinha de hora em hora (junto da batida da extensão; no máximo uma rodada a cada
  45 min, dois documentos por closer) e no botão **Ler agora** (três por clique). A tela diz o que foi
  olhado — quantas subpastas, a data da mais nova e, se há call nova sem texto para ler, que tipos de
  arquivo ela tem —, sem nome de ninguém; se a conta conectada não enxerga a pasta, avisa;
- lê Documento Google, Word (`.docx`), `.txt` e atalho para um deles; vídeo e o resto ficam de fora;
- reunião sem conversa (não compareceu, caiu) não vira caso; duas reuniões do mesmo lead em até 15
  dias viram **um** caso, com o melhor desfecho; o que chega pelo Drive e por um report com resultado
  conta uma vez só;
- a classificação é da IA gratuita, a partir das anotações. É automática e pode errar: a tela lista
  cada call lida, com "quem decide" e "como terminou" editáveis e o botão de apagar. Caso corrigido
  não é mais mexido. Tarefa para a pessoa do onboarding nas "Próximas etapas" vale como prova de venda
  (`TRANSCRICAO_ONBOARDING`, padrão `Carlos`);
- **privacidade:** só leitura no Drive; a transcrição não fica guardada no servidor; antes de ir para a
  IA os nomes, e-mails e telefones são mascarados; o caso guardado não tem nome de lead (só uma
  impressão do primeiro nome, para juntar as reuniões).

Para funcionar: ative a **Google Drive API** no projeto do Google Cloud do aplicativo e conecte o
Google de novo no painel (a permissão `drive.readonly` é nova). A conta conectada precisa ter acesso à
pasta.

**Ligar e desligar.** Na aba Closers, cada closer com inteligência tem o botão **Desligar análise**
(e depois **Ligar análise**). Desligada, o botão some do popup de todo mundo e `POST /api/afinidade`
responde 403, sem chamar a IA; o texto da inteligência continua guardado, é só ligar de novo.

### Base de conhecimento

Seis campos na aba **Base**: empresa, oferta e valores, perfil de cliente, roteiro, régua de
qualificação (SPIN e BANT) e objeções. Entram no prefixo em cache de todo report e, resumidos, no
coach. Campo nunca escrito vem com o texto recomendado (`src/baseInicial.js`, versão 3), montado
com os scripts, apresentações, contratos e a análise de 12 reuniões que viraram venda
([docs/analise-calls-vendas.md](docs/analise-calls-vendas.md)). Uma versão nova só substitui o
campo que ninguém editou; **Voltar aos textos anteriores** desfaz a migração.

---

## O painel

Em `SUA_URL/`. As abas aparecem conforme o papel.

| Aba | Para | O que faz |
| --- | --- | --- |
| **Gerar report** | todos | Report sem a extensão, em formato de chat (abaixo). |
| **Reports do dia** | todos | Lista do dia e .zip para o líder; gestor e master veem a equipe. |
| **Acessos** | master | Chaves da equipe, papel e os três recursos por pessoa. |
| **Reports gerados** | gestor, master | Números, custo por SDR, closer e resultado de cada report. |
| **Resultados da reunião** | master | Resultado por reunião, inteligência e insights. |
| **Closers** | master | Lista de closers. |
| **Arquivos** | gestor, master | PDFs guardados; download individual, por SDR ou tudo em .zip. |
| **Base** | gestor, master | Base de conhecimento. |
| **Extensão** | gestor, master | Download do .zip e teste da ficha do RD. |

**Report em formato de chat.** Escreva fala por fala (Lead ou Eu), cole a conversa inteira ou
anexe e arraste áudios (transcritos), prints (lidos como conversa) e arquivos de texto. Cada fala
vira uma bolha removível; o texto final continua editável. PDF e Word ainda não são lidos.

**Print e celular.** O print é lido pelo modelo de visão do Groq (custo zero); o painel reduz a
imagem antes de enviar e o servidor confere o tipo pelos *magic bytes*. É o caminho para quem
atende pelo telefone, onde a extensão não roda: tira o print e abre o painel no navegador do
celular. Sem print, o **Exportar conversa** do WhatsApp gera um `.txt` para colar.

**Reports do dia.** Quando o SDR refaz o report de um lead, vale **o último** (`src/diario.js`
agrupa por SDR + dia + contato). Dá para marcar outra versão antes de baixar. O mesmo .zip sai
pelo botão **Baixar meus reports de hoje** do popup.

---

## API

Autenticação por cabeçalho `x-cr-key` (a chave do usuário). `gestor+` = master, gestor ou a
`ADMIN_PASSWORD` em `x-admin-pass`.

### Report e mídia

| Rota | Acesso | Para quê |
| --- | --- | --- |
| `POST /api/report-direto` | chave | Report a partir das mensagens lidas pela extensão. |
| `POST /api/report-texto` | chave | Report a partir de texto (painel). |
| `POST /api/pdf` | chave | Refaz o PDF de um report editado — sem IA. |
| `POST /api/transcrever` | chave | Transcreve um áudio (cache pelo hash dos bytes). |
| `POST /api/ler-imagem` | chave | Lê um print de conversa. |
| `POST /api/estimar-custo` | chave | Estimativa de custo, sem IA. |
| `GET /api/reports/:id/pdf` | chave | Reabre o PDF (o dono; gestor e master, qualquer um). |
| `POST /api/reports/:id/closer` | chave | Define o closer do próprio report (gestor e master, de qualquer um). |
| `GET /api/closers` | chave | Closers (id e nome) e a indicação para um perfil. |

### Cartão do lead

| Rota | Acesso | Para quê |
| --- | --- | --- |
| `POST /api/crm/lead` | chave + popup do lead | Ficha do RD do lead da conversa. |
| `POST /api/crm/respondeu` | chave + automação | Avança o card para "Respondeu". |
| `GET /api/master/diagnostico` | master | Confere, sem alterar nada, se a automação do "Respondeu" e a cor da agenda têm tudo no lugar, e mostra a última vez que cada uma funcionou. |
| `GET /api/crm/motivos-perda` · `POST /api/crm/desqualificar` | chave com a automação do cartão | Botão Desqualificar: os motivos de perda do RD e a perda no card do lead da conversa. |
| `GET /api/master/limpeza-rd/funis` · `GET …/previa` · `POST …/executar` · `POST …/desfazer` · `GET …/relatorio` | master | Limpeza do funil no RD: prévia, lotes, desfazer e relatório por motivo. |
| `GET/POST /api/master/limpeza-rd/duplicados` | master | Cadastros duplicados no funil: a busca (sem alterar nada) e o fechamento em lotes como "Duplicado". |
| `POST /api/rd/atualizar` | chave | Batida de hora em hora da extensão: põe venda, follow-up, perda e closer dos reports em dia com o RD (no máximo a cada 30 min). |
| `POST /api/lead/marca` | chave + automação | Etiqueta "Qualificado" e agendamento. |
| `POST /api/resumo-rapido` | chave + popup do lead | Resumo rápido da conversa. |
| `POST /api/coach` · `POST /api/coach/feedback` | chave + coach | Coach e o "Funcionou". |
| `POST /api/afinidade` | chave | Nota de 0 a 10 do lead para um closer, com motivos e o PDF. |

### Dia a dia e gestão

| Rota | Acesso | Para quê |
| --- | --- | --- |
| `GET /api/eu` | chave | Nome, papel e recursos liberados. |
| `GET /api/meus-reports` · `POST /api/meus-reports/zip` | chave | Reports do dia do próprio usuário. |
| `GET /api/equipe-reports` · `POST /api/equipe-reports/zip` | gestor+ | Reports do dia da equipe. |
| `GET /api/admin/stats` | gestor+ | Números e custo. |
| `PATCH /api/admin/reports/:id/resultado` | gestor+ | Closer, resultado, datas e correções. |
| `DELETE /api/admin/reports/:id` | gestor+ | Remove o report e o PDF. |
| `GET /api/admin/reports/:id/pdf` · `GET /api/admin/reports/pdf-zip` | gestor+ | PDFs guardados. |
| `GET/POST /api/admin/base` · `…/recomendada` · `…/restaurar` | gestor+ | Base de conhecimento. |
| `GET /api/admin/closers` | gestor+ | Lista completa de closers. |
| `POST /api/admin/crm/teste` | gestor+ | Busca no RD sem cache, com o passo a passo. |
| `POST/DELETE /api/admin/closers` | master | Adiciona e remove closers. |
| `PATCH /api/admin/closers/:id` | master | Apelido e inteligência do closer (alimenta a afinidade); `analiseAtiva` liga e desliga a análise. |
| `POST /api/admin/closers/importar` | master | Pacote do closer: cadastro, apelido, inteligência e casos das calls. |
| `GET /api/admin/closers/:id/padrao` | master | As contas dos casos do closer (transcrições + reuniões com resultado). |
| `POST /api/admin/closers/:id/drive/ler` · `GET …/drive` | master | Lê os documentos novos da pasta do Drive do closer; lista os casos lidos e a última leitura. |
| `PATCH/DELETE /api/admin/closers/:id/casos/:caso` | master | Corrige ou apaga um caso lido do Drive. |
| `GET/POST/PATCH/DELETE /api/admin/usuarios` | master | Acessos da equipe. |
| `GET /api/master/resultados` · `GET /api/master/inteligencia` · `POST /api/master/insights` | master | Resultados, inteligência e insights. |
| `GET /api/status` | pública | Verificação de conexão. |

Do RD Station CRM (API v1) o servidor **lê** `/contacts`, `/deals/{id}`, `/activities`, `/users`,
`/custom_fields` e `/deal_pipelines`, e **escreve** só `PUT /deals/{id}` com `deal_stage_id`.

---

## Variáveis de ambiente

Tudo tem padrão seguro no código; o `.env.example` traz a lista comentada.

### Essenciais

| Variável | Quando | Descrição |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | sempre | Gera os reports. |
| `ADMIN_PASSWORD` | sempre | Acesso reserva do painel; cria o primeiro master. |
| `GROQ_API_KEY` | produção | Áudio, print, coach e insights. Local sem ela: `faster-whisper`. |
| `KV_REST_API_URL` · `KV_REST_API_TOKEN` | produção | Banco (Vercel KV / Upstash; também aceita `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`). Vazias: `data/*.json`. |
| `RDSTATION_CRM_TOKEN` | ficha do lead | Token do RD Station CRM. Vazio: ficha desligada. |

### Modelos

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `LLM_PROVIDER` | `anthropic` | `anthropic` ou `ollama` (local, custo zero). |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Modelo dos reports; precisa de preço em `src/precos.js`. |
| `ANTHROPIC_MODEL_ECO` · `ANTHROPIC_MODEL_PREMIUM` | `claude-haiku-4-5` · `claude-opus-4-8` | Só com `qualidade` explícita no pedido. |
| `ANTHROPIC_MODEL_RESUMO` | o dos reports | Modelo do resumo rápido. |
| `GROQ_MODEL` | `whisper-large-v3-turbo` | Transcrição. |
| `GROQ_VISION_MODEL` | `qwen/qwen3.6-27b` | Leitura de print (reserva: `qwen/qwen3.8-27b`). |
| `GROQ_COACH_MODEL` | fila padrão | Modelo a tentar primeiro no coach e nos insights. |
| `OLLAMA_MODEL` · `OLLAMA_URL` | `llama3.1` · `localhost:11434` | Só com `LLM_PROVIDER=ollama`. |

### RD Station

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `CRM_CACHE_TTL_SEG` · `CRM_TIMEOUT_MS` | `300` · `8000` | Cache da ficha e tempo máximo por chamada. |
| `CRM_PALAVRAS_IGNORADAS` | — | Etiquetas extras a tirar do nome salvo (separadas por vírgula). |
| `CRM_MOVER_ETAPA` | ligado | `0` desliga a escrita no RD; as etiquetas continuam. |
| `CRM_ETAPA_RESPONDEU` · `CRM_ETAPA_QUALIFICADO` | `Respondeu` · `Qualificado` | Nome das etapas, se o time renomear. |
| `CRM_ETAPA_NAO_COMPROU` | `Não compraram` | Etapa dos closers que encerra o report como "não fechou". |
| `CRM_ETAPA_VENDIDO` · `CRM_ETAPA_FUP` | `Vendido` · `Fluxo de FUP` | Etapas dos closers que viram "Vendido no RD" e "Em follow-up". |
| `CRON_SECRET` | — | Segredo do agendador diário da Vercel que confere vendas e perdas no RD. |

### Google Agenda

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` | — | Cliente OAuth do Google Cloud. Vazias: recurso desligado. |
| `GOOGLE_REFRESH_TOKEN` | — | Opcional: a autorização da conta, em vez de conectar pelo painel. |
| `GOOGLE_TIMEOUT_MS` | `8000` | Tempo máximo de cada chamada ao Google. |

### Limites e ajustes

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `MAX_CONVERSATION_CHARS` | `24000` | Teto da conversa antes do prompt. |
| `MAX_REPORT_OUTPUT_TOKENS` | `4000` | Teto de saída pedido à Anthropic. |
| `MAX_AUDIO_BYTES` · `MAX_AUDIO_TRANSCRIPTION_CHARS` | `20971520` · `6000` | Tamanho do áudio e da transcrição. |
| `MAX_IMAGEM_BYTES` | `4194304` | Tamanho do print. |
| `MAX_RESUMO_CHARS` · `MAX_COACH_CHARS` | `16000` · `7000` | Conversa enviada ao resumo e ao coach. |
| `TRANSCRIPTION_CACHE_TTL_SEG` | `86400` | Cache da transcrição; `0` desliga. |
| `ANTHROPIC_TIMEOUT_MS` · `GROQ_TIMEOUT_MS` | `50000` | A Vercel corta a função em 60 s. |
| `USD_BRL_RATE` | `5.3` | Câmbio fixo, só para exibir a estimativa em reais. |
| `TZ_RELATORIO` | `America/Sao_Paulo` | Fuso que define o "dia" de cada report. |
| `COMPANY_NAME` · `SDR_NAME` | `PRONIX` · — | Nome no PDF; `SDR_NAME` é só reserva para uso sem chave. |
| `MASTER_NOME` | `Cauã Lima` | Quem é promovido enquanto não houver master. |
| `PORT` · `CR_DATA_DIR` | `3000` · `data/` | Servidor local. |
| `PYTHON_BIN` · `WHISPER_MODEL_SIZE` | `python` · `small` | Transcrição local, sem Groq. |

---

## Dados guardados

Tudo em `src/db.js` (Redis em produção, `data/*.json` local). **A conversa não é guardada.**

| Chave | Conteúdo |
| --- | --- |
| `usuarios` | Acessos: nome, chave, papel e recursos. |
| `reports` | Histórico (até 5.000): lead, contato, SDR, custo, leitura da IA, closer e resultado. |
| `consumo` | Custo por geração — continua valendo se o report for removido. |
| `pdf_<id>` | O PDF de cada report. |
| `base` | Base de conhecimento (com os textos anteriores, para restaurar). |
| `closers` | Lista de closers, com o apelido e a inteligência de cada um. |
| `crm_cards` | Card escolhido para cada lead com mais de um. |
| `google_agenda` | Autorização da conta conectada ao Google Agenda (só no servidor). |
| `lead_marcas` | Etiqueta "Qualificado" e agendamento por lead (até 4.000). |
| `crm_movimentos` | Registro de cada card movido para "Respondeu" (últimos 500). |
| `rd_limpeza_relatorios` | Um relatório por execução da limpeza: quando, funil e quantos cards por motivo (últimos 400). |
| `rd_limpeza_log` | Cada card desqualificado pela limpeza do funil: de que etapa saiu, o motivo e quando (últimos 8.000). É o que permite desfazer. |
| `coach_feedback` | Sugestões marcadas como úteis ou não. |
| `aprendizado_consciencia` | Correções do nível de consciência (até 200). |
| `insights_ultimo` | Últimos insights gerados. |
| `cache:*` | Temporários: transcrições, ficha do RD (5 min), funis (1 h), resumos (7 dias), coach (24 h). |

### Copiar os dados de um banco para outro

`scripts/migrar-dados.js` copia todas as chaves permanentes de um banco Upstash/KV para outro
(usuários, reports, resultados, base de aprendizado...). As credenciais ficam só em variáveis de
ambiente da janela do terminal: `ORIGEM_URL`, `ORIGEM_TOKEN`, `DESTINO_URL` e `DESTINO_TOKEN`.

```
node scripts/migrar-dados.js            # só lista o que seria copiado
node scripts/migrar-dados.js --copiar   # copia de fato
```

Não apaga nada na origem; no destino, substitui a chave de mesmo nome. Chaves temporárias (cache e
travas) ficam de fora.

---

## Testes

```bash
npm test
```

**393 testes**, sem rede, sem chave real, sem custo e sem tocar em `data/` (o banco é uma pasta
temporária). O `jsdom` roda os scripts **reais** da extensão e do painel.

| Arquivo | O que cobre |
| --- | --- |
| `servidor.test.js` | A API com IA e Groq simulados: acessos, geração, duplicado, PDFs, resultado, áudio. |
| `qualidade.test.js` | Conferência de citações e normalização da conversa, em casos sintéticos. |
| `report-rico.test.js` | Nível de consciência, "Como foi a conversa", sinais de compra e o limite de 2 páginas. |
| `extensao-dom.test.js` | Leitura da conversa no WhatsApp e no Instagram: ordem, remetente, áudios, troca de conversa. |
| `ficha-crm.test.js` | O cartão no WhatsApp: ficha, busca, vários cards e resumo. |
| `coach-popup.test.js` | O popup do coach: só no clique, aviso de mensagens novas, erro, leitura com áudios, arrastar. |
| `automacao-dom.test.js` | Mover para "Respondeu", etiqueta e agendamento no cartão. |
| `automacao.test.js` | A escrita no RD e as marcas do lead, com RD simulado. |
| `agenda.test.js` | Leitura de dia e horário nas mensagens. |
| `crm.test.js` | Busca do lead no RD: telefone, nome, duplicados, cache. |
| `coach.test.js` · `resumo.test.js` | Coach e resumo rápido no servidor, com IA simulada. |
| `inteligencia.test.js` | Perfil, closer × perfil, resultados, calibragem e base recomendada. |
| `diario.test.js` | Regra do .zip do dia (vale o último report de cada lead). |
| `painel.test.js` | O painel inteiro com API falsa. |
| `popup.test.js` | Popup da extensão. |
| `audio-cliente.test.js` · `auditoria.test.js` | Validador de áudio e correções da auditoria. |

Os testes não substituem o uso real: WhatsApp e Instagram mudam de layout sem avisar, e a
qualidade do texto gerado pela IA só se confere em reports de verdade.

---

## Deploy e publicação

### Servidor (Vercel)

1. Conecte o repositório e adicione um **Vercel KV** (ou Upstash Redis).
2. Preencha as variáveis do projeto (as [essenciais](#essenciais), no mínimo).
3. `git push origin main` — a Vercel publica sozinha (`vercel.json` manda tudo para
   `api/index.js`, com limite de 60 s por função).

Mudança só no servidor ou no painel: basta o push.

### Extensão (Chrome Web Store)

Qualquer mudança em `extension/` exige versão nova:

1. Suba a `version` em `extension/manifest.json`.
2. `npm run empacotar` — gera `public/PRONIX-extensao.zip`.
3. Envie o .zip no painel da Chrome Web Store e aguarde a revisão.

Não é preciso sincronizar as duas publicações: recurso que o outro lado ainda não conhece fica
desligado até ele ser atualizado.

---

## Segurança e privacidade

- **Segredos só no servidor.** Chaves da Anthropic e do Groq e o token do RD ficam em variáveis
  de ambiente; nunca vão para a extensão, para o navegador nem para log.
- **O servidor é fixo na extensão.** O service worker só fala com o endereço salvo no popup
  (https, ou `localhost` em desenvolvimento) e ignora endereço vindo da página.
- **Nada de fora vira HTML.** Nome do contato, dados do CRM e erros entram na tela como texto.
- **Cada um vê o seu.** O SDR só reabre e baixa os próprios reports; a chave é mascarada no painel.
- **Telefone e nome do lead** vão por POST, fora de URL e de log de acesso.
- **Leitura sob clique.** O conteúdo das mensagens só vai ao servidor quando o SDR clica (report,
  resumo ou coach). A automação do cartão lê no navegador e envia apenas o resultado.
- **Tipo conferido pelos bytes** em áudio e imagem, não pela extensão do arquivo.

A política completa, exigida pela Chrome Web Store, está em `/privacidade`
(`public/privacidade.html`).

---

## Limites e riscos

- **Risco de ban: baixo.** A extensão só lê a página aberta; não abre conexão própria com o
  WhatsApp nem com o Instagram.
- **Layout dos sites.** A leitura depende do HTML de cada site. `extension/content.js` e
  `extension/content-instagram.js` são os arquivos mais sensíveis do projeto.
- **Instagram.** O Direct usa classes trocadas a cada build e **destrói do DOM** as mensagens
  fora da tela, além de ignorar `scrollTop`. Por isso a leitura navega com `scrollIntoView`,
  costura cada janela na anterior pela maior sobreposição de sequência e captura o áudio no
  momento em que a bolha aparece.
- **Áudio.** Transcrever exige tocar o áudio no mudo; no Instagram isso pode marcá-lo como
  ouvido. Áudio antigo, que o WhatsApp não entrega mais, entra como `[áudio]`.
- **Automação do RD.** Montada pela documentação da API e testada com RD simulado; depende de o
  token ter permissão sobre os cards. A leitura de agendamento é por regra de texto e pode errar
  em frases fora do padrão — o × no cartão corrige.
- **Coach e o plano gratuito.** Cada dica gasta do limite gratuito do Groq; quando acaba, o popup
  avisa e os reports não são afetados (usam outro provedor).
- **Amostra pequena.** A inteligência só vale com resultados marcados na rotina.
- **Ainda não existe:** leitura de PDF e Word no chat manual, status por campo
  (confirmado/inferido) no report e expurgo automático dos PDFs antigos.

---

## Estrutura do projeto

```
server.js                     Rotas: páginas, report, cartão do lead, gestão
api/index.js · vercel.json    Entrada e configuração da Vercel

src/
  report.js                   Prompt do report, chamada à IA, validação da resposta
  conversation-normalizer.js  Limpa, agrupa e corta a conversa antes do prompt
  citacoes.js                 Conferência das citações e filtro de falas, sem IA
  consciencia.js · perfil.js  Nível de consciência e perfil do lead (a mesma régua em tudo)
  generatePdf.js              PDF com a marca PRONIX, até 2 páginas
  idempotencia.js             Hash da conversa (reportKey)
  precos.js · stats.js        Preço por modelo; histórico, custo e resultados
  pdfStorage.js · diario.js   PDFs guardados; regra do .zip do dia
  transcribe.js · groq.js     Transcrição, visão e chat gratuito (com fila de modelos)
  resumoRapido.js · coach.js  Resumo rápido e coach da conversa
  crm.js · leads.js           RD Station (ficha e mover etapa); etiqueta e agendamento por lead
  inteligencia.js             Closer × perfil, padrões da prospecção, insights
  aprendizado.js              Correções que calibram o nível de consciência
  base.js · baseInicial.js    Base de conhecimento e o texto recomendado
  usuarios.js · closers.js    Acessos, papéis e recursos; lista de closers
  db.js                       Redis em produção, arquivos localmente; cache e trava

extension/                    Extensão MV3
  content.js                  WhatsApp: leitura da conversa, áudios, cartão do lead, popup do coach
  agenda.js                   Leitura de agendamento e de "lead respondeu" (sem rede)
  content-instagram.js        Instagram Direct: leitura da conversa e dos áudios
  inject.js                   Gancho de áudio no contexto da página
  background.js               Service worker: fala com o servidor
  popup.html · popup.js       Gerar, editar e baixar o report; chave e servidor

public/
  dashboard.html              O painel
  dia.html                    Resumo do dia
  privacidade.html            Política de privacidade
  PRONIX-extensao.zip         Gerado por `npm run empacotar`

tests/                        22 arquivos; helpers/dom.js simula WhatsApp e Instagram
docs/                         Sistema visual, auditoria, plano, checklist e análise das calls
scripts/transcribe.py         faster-whisper local (só sem GROQ_API_KEY)
```

---

## Documentação relacionada

- [`GUIA-SDR.md`](GUIA-SDR.md) — instalação e uso para quem só gera reports.
- [`docs/design.md`](docs/design.md) — o sistema visual (papel, tinta e marca-texto): tokens, regras e onde vale.
- [`docs/analise-calls-vendas.md`](docs/analise-calls-vendas.md) — o que 12 reuniões que viraram
  venda ensinam (sem dados de clientes).
- [`docs/checklist-pendencias.md`](docs/checklist-pendencias.md) — o que entrou em cada versão e
  o que falta conferir.
- [`docs/auditoria-pronix.md`](docs/auditoria-pronix.md) — status de cada achado da auditoria.
- [`docs/plano-implementacao.md`](docs/plano-implementacao.md) — o que falta, em etapas.
