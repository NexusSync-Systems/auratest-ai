import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';

/**
 * TROJSTAV SE NESMÍ PROTLAČIT PŘES FALSY TEST.
 *
 * Tahle chyba se opakovala ČTYŘIKRÁT, pokaždé jinde a pokaždé na
 * stejný způsob:
 *
 *   {loc.isEU ? 'EU/EEA' : 'Mimo EU'}
 *   {gdpr.isCompliant ? '#10b981' : '#ef4444'}
 *
 * `null` znamená „nepodařilo se posoudit". V JavaScriptu je ale falsy,
 * takže spadne do větve pro NESPLNĚNO — a neprůkazný výsledek se
 * uživateli ukáže jako doložené porušení. U rezidence dat to znamenalo
 * obvinění z přenosu do třetí země u všech pěti domén ukázkového skenu.
 *
 * Opravovat to po jednom nestačí: pokaždé se opravilo jedno místo a
 * druhé zůstalo. Tenhle test proto hlídá CELOU TŘÍDU — hledá v UI
 * ternární výraz nad polem, které může být `null`.
 *
 * Správně se používá `complianceColor` / `complianceLabel` /
 * `popisUmisteni` / `headerStateLabel`, které trojstav umí.
 *
 * SLEPÉ MÍSTO, O KTERÉM JE LEPŠÍ VĚDĚT NEŽ MU VĚŘIT.
 * Hledá se `\.pole` — tedy tečkový přístup. Ternár nad LOKÁLNÍ
 * proměnnou (`const { isEU } = loc` nebo položka z `map`) tenhle hlídač
 * NEODHALÍ. Ověřeno mutací: vrácení `{stav ? 'Aktivní' : 'Chybí'}` do
 * NIS2 bloku v App.jsx prošlo zeleně, protože `stav` je lokální jméno.
 * Takové zapojení proto hlídá cílený test v `compliance.test.js`
 * („obrazovka používá headerStateLabel"). Statická kontrola zachytí
 * nedbalost, ne úmysl a ne přejmenování.
 */

/** Pole, která mohou být `true`, `false`, NEBO `null`. */
const TROJSTAVOVA_POLE = [
  'isCompliant',
  'isEU',
  'isEUCompliant',
  'isResilient',
  'isQuantumSafe',
  'supported',
  'headersComplete',
  // DOPLNĚNO PO KONTROLNÍ VLNĚ. Seznam byl neúplný, a chybělo v něm
  // zrovna to, co v té chvíli bylo rozbité: `hsts` a `csp` na obrazovce.
  // Hlídač se tedy jmenoval po celé třídě chyb, svítil zeleně a tu
  // třídu nepokrýval — to je horší než žádný test, protože uklidňuje.
  //
  // POZOR NA `ok` SAMO O SOBĚ. Je to ambivalentní jméno: `fetch`
  // Response, `checkPage` i řetěz ve spisu ho vracejí striktně logicky
  // (ověřeno: `checkPage` inicializuje `ok: false` a nastavuje jen
  // true/false, `server.js` u řetězu totéž). Plošné hlídání `\.ok` by
  // tedy hlásilo 17 míst, z nichž ani jedno není vada — a hlídač, který
  // křičí na správný kód, se vypne.
  //
  // Hlídají se proto KVALIFIKOVANÉ tvary: `ok` u objektů, kde ho
  // `cookie-flags.js` a `tls-audit.js` skutečně nastavují na `null`.
  'cookieFlags.ok',
  'hstsDetail.ok',
  'cspDetail.ok',
  'ciphers.ok',
  'ocsp.ok',
  // `chain.ok` v seznamu NENÍ: `verifyChain` v `audit-ledger.js:671`
  // a `:720` vrací `problems.length === 0`, tedy striktně logickou
  // hodnotu, a `CaseFilePanel` podstavy (`fullChainOk`, `ownRecordsOk`,
  // ukotvení) rozlišuje výslovně. Ověřeno, ne odhadnuto — hlídač, který
  // křičí na správný kód, se vypne a přestane hlídat i to ostatní.
  'hsts',
  'csp',
  'secure',
  'protocols',
  'certificate',
  'pqc',
  'xContentTypeOptions',
  'xFrameOptions',
  'referrerPolicy',
  'permissionsPolicy',
];

/**
 * Seznam souborů byl pevný a tříprvkový, takže nová komponenta by se
 * ocitla mimo dohled automaticky. Teď se hledají VŠECHNY `.jsx` pod
 * `src/`, aby to nešlo obejít tím, že vznikne soubor jinde.
 */
function vsechnyKomponenty(dir = 'src') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const cesta = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...vsechnyKomponenty(cesta));
    else if (e.name.endsWith('.jsx') && !e.name.includes('.test.')) out.push(cesta);
  }
  return out;
}
const SOUBORY = vsechnyKomponenty();

describe('trojstav v UI', () => {
  for (const soubor of SOUBORY) test(`${soubor} nepoužívá falsy ternár nad trojstavem`, () => {
    // Cesta od kořene projektu — vitest běží z `frontend/`.
    const zdroj = readFileSync(`${process.cwd()}/${soubor}`, 'utf8');
    const nalezy = [];

    for (const pole of TROJSTAVOVA_POLE) {
      // Tři způsoby, jak trojstav zploštit. Ternár byl hlídaný, `&&`
      // a `||` ne — a zplošťují ho stejně:
      //   {loc.isEU && 'EU/EHP'}     → u `null` nevykreslí nic
      //   {loc.isEU || 'Mimo EU'}    → u `null` tvrdí „mimo EU"
      // Kvalifikovaný tvar (`cookieFlags.ok`) se hledá jako celek,
      // jednoduchý (`isEU`) s tečkou před sebou.
      const escaped = pole.replace(/\./g, '\\.');
      const predpona = pole.includes('.') ? '' : '\\.';
      const vzory = [
        [new RegExp(`${predpona}${escaped}\\s*\\?(?!\\.)`, 'g'), '?'],
        [new RegExp(`${predpona}${escaped}\\s*&&`, 'g'), '&&'],
        [new RegExp(`${predpona}${escaped}\\s*\\|\\|`, 'g'), '||'],
      ];
      for (const [vzor, operator] of vzory) {
        for (const m of zdroj.matchAll(vzor)) {
          const radek = zdroj.slice(0, m.index).split('\n').length;
          nalezy.push(`${soubor}:${radek} — .${pole} ${operator}`);
        }
      }
    }

    expect(nalezy).toEqual([]);
  });
});
