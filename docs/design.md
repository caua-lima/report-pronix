# Sistema visual do Report PRONIX

**Papel, tinta e marca-texto.** O produto entrega um documento (o handoff), então a interface é um
documento: fundo de papel, texto em tinta e um risco de âmbar — o marca-texto — só onde importa.

`tests/design.test.js` trava o que está aqui: tokens iguais nas quatro páginas, nenhuma cor solta,
a marca nova em todo lugar e a paleta dos cartões da extensão. O PDF do handoff editorial é travado
por conteúdo (`tests/handoff-editorial.test.js`): todos os fatos presentes, sem repetição da ficha,
sem página em branco.

## Onde vale

| Superfície | Arquivo | Tema |
|---|---|---|
| Painel | `public/dashboard.html` | claro e escuro (botão "Tema" no menu) |
| Report do Dia | `public/dia.html` | o mesmo escolhido no painel |
| Política de privacidade | `public/privacidade.html` | o mesmo escolhido no painel |
| Popup da extensão | `extension/popup.html` | segue o sistema |
| Cartões no WhatsApp e no Instagram | `extension/content.js`, `extension/content-instagram.js` | sempre "tinta" (escuro) |
| PDF do handoff | `src/generatePdf.js` | papel |

## Tokens

O bloco entre `/* tokens:inicio` e `/* tokens:fim */` é **idêntico** nas quatro páginas HTML.
Mudou em uma, mude nas quatro (o teste acusa). Nas páginas, use sempre `var(--token)`; cor fixa só
na marca e no texto sobre âmbar (`#18171b`).

| Token | Papel (claro) | Tinta (escuro) | Uso |
|---|---|---|---|
| `--bg` | `#f3efe6` | `#121113` | fundo da página |
| `--lateral` | `#eae5d8` | `#0d0c0e` | menu e cabeçalhos |
| `--card` / `--card-2` | `#fffdf7` / `#f7f2e7` | `#1a191c` / `#222125` | cartão e área recuada |
| `--campo` | `#ffffff` | `#141316` | campos de formulário |
| `--border` / `--border-forte` | `#e2dbc9` / `#c9c0a9` | `#2f2d32` / `#47444c` | fio e contorno de controle |
| `--text` / `--text-2` / `--muted` | `#18171b` / `#4d4a45` / `#6f6a60` | `#f3efe6` / `#bcb7ab` / `#8f8a7f` | texto |
| `--ouro` | `#ffb800` | `#ffc233` | âmbar da marca, ação principal |
| `--ouro-tinta` | `#8a5d00` | `#ffc233` | âmbar como texto ou contorno de foco |
| `--marca` | âmbar a 45% | âmbar a 28% | o risco de marca-texto |
| `--ok` / `--danger` / `--info` / `--roxo` | verde / vermelho / azul / roxo | versões claras | estado e categoria |

Letras: `--f-titulo` (Bahnschrift, com DIN Alternate e Roboto Condensed de reserva) em títulos,
números grandes e rótulos em caixa alta; `--f-texto` (Segoe UI) no resto; `--f-mono` em chaves e
contadores. São letras do sistema: nada é baixado de fora.

## Regras

- **O âmbar é marca-texto, não tinta.** Aparece no item ativo do menu, no título da página, no
  número principal e na ação principal da tela (um botão âmbar por tela). O resto é tinta.
- **Botão comum é tinta** (`.btn`); o secundário é só contorno (`.btn.sec`). No passar do mouse,
  um risco âmbar na base.
- **Cartão é folha:** borda fina, sem sombra. Sombra só no que flutua (aviso, cartões da extensão).
- **Cor de estado fica na faixa de cima** dos cartões (extensão e PDF), nunca na lateral.
- **Etiqueta é retangular** (canto de 4–5px), em caixa alta na letra de título. Sem pílulas.
- **Tabela de relatório:** cabeçalho em caixa alta com um traço de tinta embaixo; linhas finas.
- **Sem emoji como ícone.** Ícones são de traço, na cor do texto.
- **Verde é "deu certo"**, vermelho é erro, âmbar nunca é status.

## Cartões da extensão

Não leem os tokens (rodam dentro da página do WhatsApp), então a paleta está escrita nos estilos:
fundo `#1a191c`, área recuada `#121113`, contorno e botão `#3a373f`, texto `#f3efe6`, texto
secundário `#a39e93`, âmbar `#ffc233`, verde `#3ddc84`, erro `#ff6f5c`, aviso `#f2a93b`.
Ao mexer neles, mantenha esses valores.

## PDF

Desde a auditoria de 04/11/2026 há dois desenhos, escolhidos pelo `schemaVersion` do report:

**Handoff editorial (`schemaVersion: 2`, `src/pdfEditorial.js`)** — relatório editorial, não painel decorativo.
- Ordem: nome do lead e negócio → tese → **Leitura de <SDR>** → Oportunidade em foco → Panorama comercial →
  Condução da reunião (Conectar, Aprofundar, Avançar) → Abertura sugerida → Contexto → Nas palavras do lead →
  Como foi a conversa.
- O nome do lead é a âncora (24 pt). "Handoff de pré-vendas" é subtítulo discreto ao lado da marca pequena.
- **Um único destaque:** a leitura do SDR, com fundo `#fbf6ea` e filete âmbar. Nada de caixa preta, faixa
  âmbar em cartão, marca-texto em todo título, termômetro ou frase de impacto.
- Corpo 11 pt regular, títulos 13,5 pt, margem de ~17 mm. Nada relevante abaixo de 9,5 pt (só o rodapé).
  Itálico só em fala curta do lead. Negrito no fato que o closer procura ao bater o olho.
- Paginação: título nunca fica sozinho no pé da página; panorama curto não quebra; bloco longo continua na
  página seguinte (o fundo da leitura acompanha). **Nada é cortado para caber em 2 páginas** — antes o
  `enxugar` tirava bullets, falas e até a visão do SDR sem a tela mostrar.
- Fontes padrão do PDF (Helvetica): o texto continua extraível (`src/textoDoPdf.js`, importações, match).
- Régua visual: `node scripts/renderizar-fixtures.js` gera os PDFs das fixtures sintéticas em
  `output/fixtures/` (nome longo, leitura com 9 pontos, conversa curta, etc.).

**Reports antigos (sem `schemaVersion`)** — continuam com o desenho de antes (`renderLegado` em
`src/generatePdf.js`), para o histórico abrir igual; também sem cortes.

## Marca

Quadrado âmbar, folha escura com três linhas e o selo verde de "pronto". Os PNGs ficam em
`extension/icons/` e `public/icons/`; nas páginas ela é um SVG embutido (`class="logo-rp"`) e no
PDF é desenhada por `desenharMarca`.
