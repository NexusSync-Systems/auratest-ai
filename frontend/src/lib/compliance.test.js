import { describe, test, expect } from 'vitest';
import { popisUmisteni } from './compliance.js';

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
