import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { popisUmisteni, headerStateLabel } from './compliance.js';

/**
 * POPIS UMÍSTĚNÍ DOMÉNY.
 *
 * Dva nálezy v jedné větě, oba z ostré ukázky na veřejné stránce.
 *
 * 1) Na OBRAZOVCE stálo `{loc.isEU ? 'EU/EEA' : 'Mimo EU'}`. `null` je
 *    falsy, takže každá NEPOSOUZENÁ doména se uživateli vypsala jako
 *    „Mimo EU" — tedy jako doložené porušení GDPR — zatímco verdikt nad
 *    tím správně hlásil „neprůkazné". V ukázkovém skenu se to týkalo
 *    všech pěti domén. Tiskový report tuhle opravu dostal dřív.
 *
 * 2) V TISKU stálo „www.cloudflare.com (US) — za CDN, umístění dat z IP
 *    určit nelze". Jedna věta uvede zemi a hned vedle řekne, že zemi
 *    určit nelze.
 */
describe('popisUmisteni', () => {
  test('neposouzená doména NENÍ mimo EU', () => {
    const u = popisUmisteni({ domain: 'x.cz', country: 'US', isEU: null, onCdn: false });
    expect(u.stav).toBeNull();
    expect(u.popis).not.toMatch(/mimo EU/i);
    expect(u.popis).toMatch(/nepodařilo určit/);
  });

  test('doména za CDN: země jen s vysvětlením, co znamená', () => {
    const u = popisUmisteni({
      domain: 'www.cloudflare.com', country: 'US', isEU: null,
      onCdn: true, cdnProvider: 'Cloudflare',
    });
    expect(u.stav).toBeNull();
    expect(u.popis).toMatch(/za CDN \(Cloudflare\)/);
    expect(u.popis).toMatch(/nejbližší uzel sítě, ne místo uložení dat/);
    // Země smí zaznít JEN v téhle větě, ne jako holý údaj u domény.
    expect(u.domena).toBe('www.cloudflare.com');
    expect(u.domena).not.toMatch(/US/);
  });

  test('CDN bez známé země zemi nevymýšlí', () => {
    const u = popisUmisteni({ domain: 'x.cz', country: null, isEU: null, onCdn: true });
    expect(u.popis).not.toMatch(/Geolokace/);
  });

  test('skutečně posouzené domény verdikt nesou', () => {
    expect(popisUmisteni({ domain: 'a.cz', country: 'DE', isEU: true }).popis)
      .toMatch(/EU\/EHP \(DE\)/);
    expect(popisUmisteni({ domain: 'b.cz', country: 'US', isEU: false }).popis)
      .toMatch(/mimo EU\/EHP \(US\)/);
  });

  test('prázdný vstup nespadne a netvrdí nic', () => {
    const u = popisUmisteni(null);
    expect(u.stav).toBeNull();
    expect(u.domena).toBe('neznámá doména');
  });
});

/**
 * STAV BEZPEČNOSTNÍ HLAVIČKY — čtyři stavy, ne dva.
 *
 * Nález z kontrolní vlny: obrazovka tiskla `{nis2.hsts ? 'Aktivní' :
 * 'Chybí'}`. `hsts` je trojstav a `agent.js:2723` ho u nedostupné
 * stránky nastavuje na `null`, takže web za bot-ochranou i každý web na
 * `http://` dostal červené „HSTS: Chybí" — tvrzení, které nikdo neměřil.
 */
describe('headerStateLabel', () => {
  const nis2 = {
    weakHeaders: ['Content-Security-Policy'],
    missingHeaders: ['Strict-Transport-Security'],
  };

  test('null je „Nelze posoudit", ne „Chybí"', () => {
    expect(headerStateLabel(null, 'Strict-Transport-Security', nis2)).toBe('Nelze posoudit');
    expect(headerStateLabel(undefined, 'Strict-Transport-Security', nis2)).toBe('Nelze posoudit');
  });

  test('rozliší chybějící hlavičku od neúčinné', () => {
    // „Chybí" a „je tam, ale nechrání" vedou k jiné opravě.
    expect(headerStateLabel(false, 'Strict-Transport-Security', nis2)).toBe('Chybí');
    expect(headerStateLabel(false, 'Content-Security-Policy', nis2)).toBe('Přítomná, ale nechrání');
  });

  test('true je aktivní', () => {
    expect(headerStateLabel(true, 'Strict-Transport-Security', nis2)).toBe('Aktivní');
  });

  test('starší běh bez seznamů netvrdí „Chybí"', () => {
    // Bez `missingHeaders`/`weakHeaders` nevíme, co `false` znamená.
    expect(headerStateLabel(false, 'Strict-Transport-Security', {})).toBe('Nesplněno');
  });
});

/**
 * ZAPOJENÍ, na které statický hlídač trojstavu NEDOSÁHNE.
 *
 * `trojstav.test.js` hledá `\.hsts ?`. Oprava výš ale ternár nahradila
 * voláním nad LOKÁLNÍ proměnnou z `map`, takže by vrácení chyby
 * (`{stav ? 'Aktivní' : 'Chybí'}`) hlídač NEODHALIL — ověřeno mutací.
 * To je slepé místo, o kterém je lepší vědět než mu věřit.
 */
describe('obrazovka používá headerStateLabel', () => {
  test('NIS2 blok v App.jsx nerozhoduje o hlavičkách sám', () => {
    const zdroj = readFileSync(`${process.cwd()}/src/App.jsx`, 'utf8');
    expect(zdroj).toMatch(/headerStateLabel\(stav, hlavicka, nis2Result\.nis2\)/);
    // A zpátky se nesmí vrátit binární znění.
    expect(zdroj).not.toMatch(/stav \? 'Aktivní' : 'Chybí'/);
  });
});
