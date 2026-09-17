#!/usr/bin/env node
/**
 * Co vlastně `request.sizes()` vrací na tomhle serveru?
 *
 * PROČ TENHLE SKRIPT EXISTUJE
 * Oprava výpočtu uhlíkové stopy přepnula měření objemu z `content-length`
 * na `request.sizes().transferSize`. Ostrý běh proti cloudflare.com pak
 * vrátil „změřeno 0 požadavků, nezměřeno 140" — tedy ani jeden požadavek
 * se nezměřil.
 *
 * Mám hypotézu (`guardNavigation` instaluje route na kontextu a Chromium
 * u odchycených požadavků hlásí `encodedDataLength: 0`, takže odvozený
 * `transferSize` vyjde nulový nebo záporný), ale hypotéza není měření.
 * V téhle kódové bázi už třikrát platilo, že nález byl tam, kam se nikdo
 * nepodíval, a že test psaný proti mým předpokladům potvrdil moji
 * představu, ne skutečnost.
 *
 * Skript proto nic netvrdí — jen vypíše syrová čísla ze všech polí
 * `sizes()` a k tomu hlavičky, podle kterých se dá poznat, které pole je
 * použitelné. A pustí to DVAKRÁT: jednou s route ochranou, jednou bez ní,
 * ať je vidět, jestli za rozdíl může opravdu ta ochrana.
 *
 * Playwright v mém prostředí nenaběhne (chybí `libXdamage.so.1`), takže
 * tohle musí běžet na serveru:
 *
 *   docker compose exec auratest-ai node scripts/probe-sizes.mjs https://www.cloudflare.com
 *
 * NIC NEMĚNÍ a nikam nezapisuje. Jen čte.
 */
import { chromium } from 'playwright';
import { guardNavigation } from '../ssrf-guard.js';

const url = process.argv[2] || 'https://www.cloudflare.com';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

/**
 * Jeden průchod. `sOchranou` říká, jestli se má nainstalovat route
 * ochrana — to je jediná proměnná, kterou mezi průchody měníme.
 */
async function pruchod(sOchranou) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (sOchranou) await guardNavigation(context);
  const page = await context.newPage();

  const zaznamy = [];
  const mereni = [];

  context.on('requestfinished', (request) => {
    mereni.push((async () => {
      try {
        const s = await request.sizes();
        const resp = await request.response();
        const h = resp ? resp.headers() : {};
        zaznamy.push({
          url: request.url().slice(0, 70),
          status: resp ? resp.status() : null,
          transferSize: s.transferSize,
          responseBodySize: s.responseBodySize,
          responseHeadersSize: s.responseHeadersSize,
          contentLength: h['content-length'] ?? null,
          contentEncoding: h['content-encoding'] ?? null,
          fromCache: resp ? await resp.serverAddr().then((a) => !a).catch(() => null) : null,
        });
      } catch (err) {
        zaznamy.push({ url: request.url().slice(0, 70), chyba: err.message });
      }
    })());
  });

  let selhalo = 0;
  context.on('requestfailed', () => { selhalo += 1; });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch (err) {
    console.log(`  ${DIM}navigace: ${err.message}${RESET}`);
  }
  await Promise.allSettled(mereni);
  await browser.close();
  return { zaznamy, selhalo };
}

function shrn(nazev, { zaznamy, selhalo }) {
  console.log(`\n${BOLD}▶ ${nazev}${RESET}`);
  console.log(`  dokončených požadavků: ${zaznamy.length}, selhaných: ${selhalo}`);

  const chybne = zaznamy.filter((z) => z.chyba);
  if (chybne.length) {
    console.log(`  ${chybne.length}× sizes() vyhodilo:`);
    const duvody = {};
    for (const z of chybne) duvody[z.chyba] = (duvody[z.chyba] || 0) + 1;
    for (const [d, n] of Object.entries(duvody)) console.log(`    ${n}× ${d}`);
  }

  const ok = zaznamy.filter((z) => !z.chyba);
  // Kolik požadavků by prošlo kterým kritériem. Tohle je jádro sondy:
  // ukáže, které pole je na tomhle serveru použitelné.
  const kladny = (f) => ok.filter((z) => Number.isFinite(z[f]) && z[f] > 0).length;
  const nulovy = (f) => ok.filter((z) => z[f] === 0).length;
  const zaporny = (f) => ok.filter((z) => Number.isFinite(z[f]) && z[f] < 0).length;

  for (const f of ['transferSize', 'responseBodySize', 'responseHeadersSize']) {
    console.log(`  ${f.padEnd(21)} kladné: ${String(kladny(f)).padStart(4)}`
      + `   nula: ${String(nulovy(f)).padStart(4)}`
      + `   záporné: ${String(zaporny(f)).padStart(4)}`);
  }

  const sCl = ok.filter((z) => z.contentLength !== null).length;
  console.log(`  content-length přítomen: ${sCl}/${ok.length}`);

  const soucetTransfer = ok.reduce((a, z) => a + (z.transferSize > 0 ? z.transferSize : 0), 0);
  const soucetTelo = ok.reduce(
    (a, z) => a + (z.responseBodySize > 0 ? z.responseBodySize : 0)
      + (z.responseHeadersSize > 0 ? z.responseHeadersSize : 0),
    0,
  );
  console.log(`  součet transferSize:              ${soucetTransfer} B`);
  console.log(`  součet responseBody+Headers:      ${soucetTelo} B`);

  console.log(`\n  ${DIM}prvních 8 požadavků:${RESET}`);
  for (const z of ok.slice(0, 8)) {
    console.log(`    ${DIM}${z.url}${RESET}`);
    console.log(`      status=${z.status} transfer=${z.transferSize} `
      + `body=${z.responseBodySize} headers=${z.responseHeadersSize} `
      + `content-length=${z.contentLength} enc=${z.contentEncoding}`);
  }
}

console.log(`\nSonda velikostí proti ${url}`);
console.log(`${DIM}Nic nemění. Jen vypisuje, co Playwright hlásí.${RESET}`);

shrn('BEZ route ochrany', await pruchod(false));
shrn('S route ochranou (guardNavigation) — takhle běží skener', await pruchod(true));

console.log(`\n${DIM}Co z toho chci vědět: které pole je kladné u většiny`);
console.log('požadavků v DRUHÉM průchodu. To je pole, které smí měřit');
console.log(`objem dat. Pokud se oba průchody liší, může za to ta ochrana.${RESET}\n`);
