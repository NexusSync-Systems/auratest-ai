/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { posudRezervaci, jakoCislo, STAV_SLOTU } from '../monitor-slot.js';

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

/**
 * Zámek běhu.
 *
 * Nález z kontrolní vlny: samotné porovnej-a-zapiš překrývající se běhy
 * NEŘEŠÍ, i když to komentář tvrdil. `lastRunTime` se zapíše při rezervaci
 * a na konci běhu se už neaktualizuje, takže monitor s intervalem 1 minuta
 * a desetiminutovým během se po minutě spustí podruhé — a CAS to korektně
 * propustí, protože se opravdu nic nezměnilo.
 */
describe('posudRezervaci — zámek běhu', () => {
  const ted = 1_000_000;

  it('živý zámek předchozího běhu druhý běh nepustí', () => {
    const v = posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 0, bezimDo: ted + 60_000 },
      ocekavanyLastRun: 0,
      ted,
    });
    expect(v.stav).toBe(STAV_SLOTU.BEZI);
    expect(v.duvod).toContain('60');
  });

  it('vypršelý zámek běh pustí', () => {
    // Jinak by pád procesu umlčel monitor navždy — proto je zámek časový,
    // ne booleovský.
    expect(posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 0, bezimDo: ted - 1 },
      ocekavanyLastRun: 0,
      ted,
    }).stav).toBe(STAV_SLOTU.REZERVOVANO);
  });

  it('zámek přesně na hranici běh pustí', () => {
    expect(posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 0, bezimDo: ted },
      ocekavanyLastRun: 0,
      ted,
    }).stav).toBe(STAV_SLOTU.REZERVOVANO);
  });

  it('chybějící bezimDo neblokuje (monitory z doby před zámkem)', () => {
    expect(posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 0 },
      ocekavanyLastRun: 0,
      ted,
    }).stav).toBe(STAV_SLOTU.REZERVOVANO);
  });

  it('vypnutý monitor se posoudí dřív než zámek', () => {
    // Pořadí má význam: u vypnutého monitoru nezajímá, jestli něco běží.
    expect(posudRezervaci({
      existuje: true,
      data: { active: false, bezimDo: ted + 60_000 },
      ocekavanyLastRun: 0,
      ted,
    }).stav).toBe(STAV_SLOTU.NEAKTIVNI);
  });
});

/**
 * Převod hodnot z databáze.
 *
 * Nález z kontrolní vlny: `|| 0` řešilo jen chybějící pole. Dokument
 * s `lastRunTime` jako Timestamp nebo řetězec by přísné `!==` proti číslu
 * vyhodnotilo vždycky jako různé → monitor navždy `obsazeno`, tichá smrt
 * s falešnou stopou v logu („lastRunTime se změnil").
 */
describe('jakoCislo', () => {
  it('číslo projde beze změny', () => {
    expect(jakoCislo(1234)).toBe(1234);
  });

  it('Firestore Timestamp se převede přes toMillis', () => {
    expect(jakoCislo({ toMillis: () => 5000 })).toBe(5000);
  });

  it('číselný řetězec se převede', () => {
    expect(jakoCislo('1234')).toBe(1234);
  });

  it('datum v ISO se převede', () => {
    expect(jakoCislo('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it.each([[undefined], [null], [NaN], [Infinity], ['nesmysl'], [{}], [[]]])(
    'nepřevoditelná hodnota (%p) se bere jako 0, ne jako věčné obsazeno', (v) => {
      expect(jakoCislo(v)).toBe(0);
    });

  it('vadný dokument se rezervací sám uzdraví', () => {
    // Obě strany jdou přes stejný převod, takže vyjdou stejně, rezervace
    // projde a zapíše se číslo. Cena je nanejvýš jeden běh navíc —
    // alternativou byl monitor, který mlčí napořád.
    const vadny = { toMillis: () => NaN };
    expect(posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: vadny },
      ocekavanyLastRun: vadny,
      ted: 1000,
    }).stav).toBe(STAV_SLOTU.REZERVOVANO);
  });
});

/**
 * Mezera v měření.
 *
 * Nejdůležitější je tu ten druhý test: falešná mezera by do spisu pro
 * úřad napsala, že se v nějakém okně neměřilo, ačkoli měřilo. To je horší
 * než mezeru neohlásit — nástroj by tvrdil něco, co není pravda.
 */
describe('posudRezervaci — mezera v měření', () => {
  const ted = 1_000_000;

  it('nedoběhlý běh po vypršení zámku se ohlásí jako mezera', () => {
    const v = posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 500, bezimDo: ted - 1, bezimSession: 'session_mrtvy' },
      ocekavanyLastRun: 500,
      ted,
    });
    expect(v.stav).toBe(STAV_SLOTU.REZERVOVANO);
    expect(v.mezera).toEqual({ sessionId: 'session_mrtvy', od: 500 });
  });

  it('po řádně doběhnutém běhu ŽÁDNÁ mezera není', () => {
    // `uvolniZamekMonitoru` nuluje bezimDo i bezimSession. Kdyby nulovalo
    // jen zámek, hlásila by se mezera po každém úspěšném běhu.
    const v = posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 500, bezimDo: 0, bezimSession: null },
      ocekavanyLastRun: 500,
      ted,
    });
    expect(v.stav).toBe(STAV_SLOTU.REZERVOVANO);
    expect(v.mezera).toBeNull();
  });

  it('mezeru hlásí jen ten, kdo slot dostal', () => {
    // Jinak by ji ohlásila každá instance, která o slot marně zabojovala,
    // a týž nezměřený úsek by byl ve spisu několikrát.
    const v = posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 999, bezimDo: ted - 1, bezimSession: 'session_mrtvy' },
      ocekavanyLastRun: 500,
      ted,
    });
    expect(v.stav).toBe(STAV_SLOTU.OBSAZENO);
    expect(v.mezera).toBeUndefined();
  });

  it('živý běh mezeru nehlásí — ještě neskončil', () => {
    const v = posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 500, bezimDo: ted + 60_000, bezimSession: 'session_zivy' },
      ocekavanyLastRun: 500,
      ted,
    });
    expect(v.stav).toBe(STAV_SLOTU.BEZI);
    expect(v.mezera).toBeUndefined();
  });

  it('monitor z doby před zámkem mezeru nehlásí', () => {
    // Dokumenty založené před touhle změnou pole `bezimSession` nemají.
    expect(posudRezervaci({
      existuje: true,
      data: { active: true, lastRunTime: 500 },
      ocekavanyLastRun: 500,
      ted,
    }).mezera).toBeNull();
  });
});
