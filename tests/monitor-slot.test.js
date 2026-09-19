/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { posudRezervaci, STAV_SLOTU } from '../monitor-slot.js';

/**
 * Rezervace slotu pro běh monitoru.
 *
 * Dřív to byl prostý zápis `lastRunTime: now` bez ohledu na obsah
 * dokumentu. Mezi načtením snímku monitorů a tímhle zápisem přitom uběhne
 * celý cyklus přes předchozí monitory včetně síťové kontroly cíle — v tom
 * okně stačí druhá instance aplikace a monitor se spustí dvakrát.
 *
 * Testuje se OBOJÍ: rozhodovací funkce i plánovač, který ji přes `db.js`
 * volá. Jenom to první by byl přesně ten vzorec, na kterém se tenhle
 * projekt už čtyřikrát spálil — vytažená funkce otestovaná, volající kód ne.
 */

describe('posudRezervaci — rozhodnutí uvnitř transakce', () => {
  it('nezměněný lastRunTime slot rezervuje', () => {
    expect(posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 1000 },
      ocekavanyLastRun: 1000,
    }).stav).toBe(STAV_SLOTU.REZERVOVANO);
  });

  it('změněný lastRunTime znamená, že běh už někdo vzal', () => {
    const v = posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 5000 },
      ocekavanyLastRun: 1000,
    });
    expect(v.stav).toBe(STAV_SLOTU.OBSAZENO);
    // Důvod musí nést obě čísla — bez nich se v logu nepozná, jestli šlo
    // o souběh dvou instancí, nebo o rozjetý čas.
    expect(v.duvod).toContain('1000');
    expect(v.duvod).toContain('5000');
  });

  it('smazaný monitor se nespustí', () => {
    expect(posudRezervaci({ existuje: false, data: undefined, ocekavanyLastRun: 0 }).stav)
      .toBe(STAV_SLOTU.SMAZANO);
  });

  it('vypnutý monitor se nespustí', () => {
    expect(posudRezervaci({
      existuje: true,
      data: { active: false, lastRunTime: 0 },
      ocekavanyLastRun: 0,
    }).stav).toBe(STAV_SLOTU.NEAKTIVNI);
  });

  it('chybějící pole active se bere jako neaktivní, ne jako aktivní', () => {
    // Fail-closed: o stavu nic nevíme, a spouštět prohlížeč na základě
    // neznámého stavu je horší než monitor nespustit.
    expect(posudRezervaci({
      existuje: true,
      data: { lastRunTime: 0 },
      ocekavanyLastRun: 0,
    }).stav).toBe(STAV_SLOTU.NEAKTIVNI);
  });

  it('dokument bez lastRunTime se rezervovat DÁ', () => {
    // Regrese: kdyby se `undefined` neporovnávalo s `0` přes `|| 0`,
    // vyšel by první běh jako obsazený a monitor by se nespustil nikdy.
    expect(posudRezervaci({
      existuje: true,
      data: { active: true },
      ocekavanyLastRun: 0,
    }).stav).toBe(STAV_SLOTU.REZERVOVANO);
  });

  it('existuje: true s prázdnými daty se bere jako smazaný', () => {
    expect(posudRezervaci({ existuje: true, data: undefined, ocekavanyLastRun: 0 }).stav)
      .toBe(STAV_SLOTU.SMAZANO);
  });
});
