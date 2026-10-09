'use strict';
// Copia TODOS os dados de um banco Upstash/Vercel KV para outro (usuários e chaves, reports,
// resultados, base de aprendizado, marcas dos leads, conexão do Google...).
//
// Uso (PowerShell), com as credenciais só em variáveis de ambiente desta janela — nunca em arquivo:
//   $env:ORIGEM_URL = '...'; $env:ORIGEM_TOKEN = '...'      (KV_REST_API_URL / KV_REST_API_TOKEN do projeto antigo)
//   $env:DESTINO_URL = '...'; $env:DESTINO_TOKEN = '...'    (os mesmos dois valores do projeto novo)
//   node scripts/migrar-dados.js            -> só mostra o que seria copiado
//   node scripts/migrar-dados.js --copiar   -> copia de fato
//
// Não apaga nada na origem. No destino, cada chave copiada substitui a que existir com o mesmo nome.
// Chaves com validade (cache, travas) não são copiadas: elas se refazem sozinhas.

const { ORIGEM_URL, ORIGEM_TOKEN, DESTINO_URL, DESTINO_TOKEN } = process.env;
const COPIAR = process.argv.includes('--copiar');

async function redis(url, token, comando) {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(comando) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Banco respondeu ${j.error || r.status} em ${comando[0]}.`);
  return j.result;
}
const origem = (c) => redis(ORIGEM_URL, ORIGEM_TOKEN, c);
const destino = (c) => redis(DESTINO_URL, DESTINO_TOKEN, c);

async function chaves() {
  const todas = [];
  let cursor = '0';
  do {
    const [proximo, lote] = await origem(['SCAN', cursor, 'COUNT', '500']);
    todas.push(...lote);
    cursor = String(proximo);
  } while (cursor !== '0');
  return [...new Set(todas)].sort();
}

async function copiar(chave) {
  const tipo = await origem(['TYPE', chave]);
  const ttl = await origem(['TTL', chave]);
  if (ttl > 0) return { chave, tipo, pulada: 'temporária' };
  if (tipo === 'string') {
    const v = await origem(['GET', chave]);
    if (COPIAR) await destino(['SET', chave, v]);
    return { chave, tipo, itens: 1 };
  }
  if (tipo === 'list') {
    const itens = await origem(['LRANGE', chave, 0, -1]);
    if (COPIAR) {
      await destino(['DEL', chave]);
      for (let i = 0; i < itens.length; i += 200) await destino(['RPUSH', chave, ...itens.slice(i, i + 200)]);
    }
    return { chave, tipo, itens: itens.length };
  }
  return { chave, tipo, pulada: 'tipo não usado pelo sistema' };
}

(async () => {
  if (!ORIGEM_URL || !ORIGEM_TOKEN || !DESTINO_URL || !DESTINO_TOKEN) {
    console.error('Defina ORIGEM_URL, ORIGEM_TOKEN, DESTINO_URL e DESTINO_TOKEN (veja o topo deste arquivo).');
    process.exit(1);
  }
  if (ORIGEM_URL === DESTINO_URL) {
    console.error('Origem e destino são o mesmo banco: nada a fazer.');
    process.exit(1);
  }
  const lista = await chaves();
  console.log(`${lista.length} chave(s) na origem. ${COPIAR ? 'Copiando...' : 'Simulação (use --copiar para valer).'}`);
  let copiadas = 0;
  for (const chave of lista) {
    const r = await copiar(chave);
    if (r.pulada) console.log(`  pulada   ${r.chave} (${r.pulada})`);
    else {
      copiadas++;
      console.log(`  ${COPIAR ? 'copiada ' : 'copiaria'} ${r.chave} (${r.tipo}, ${r.itens} item(ns))`);
    }
  }
  console.log(`${copiadas} chave(s) ${COPIAR ? 'copiadas' : 'seriam copiadas'}.`);
})().catch((e) => {
  console.error('Falhou:', e.message);
  process.exit(1);
});
