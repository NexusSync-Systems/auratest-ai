import { zaznamBehu, stavBehu, stavMonitoru, KLICE_ZAZNAMU } from '../run-result.js';
import { jeChybiDokument, KOD_NENALEZENO } from '../firestore-errors.js';

/**
 * Sdílený převod výsledku běhu na pole session.
 *
 * Vznikl proto, že tenhle převod byl trojmo a každá kopie se rozešla jinak.
 * Dvakrát to znamenalo, že běh vypadal v dokumentu pro úřad líp, než jaký
 * byl — a obojí našla až kontrolní vlna.
 */

describe('zaznamBehu', () => {
  it('vrací PŘESNĚ deklarovanou sadu klíčů', () => {
    // Tenhle test je celý smysl modulu. Přidat pole bez doplnění
    // `KLICE_ZAZNAMU` ho shodí — a to je správně: nové pole se musí
    // propsat na všechny cesty, jinak se jedna bude tvářit líp.
    expect(Object.keys(zaznamBehu({})).sort()).toEqual([...KLICE_ZAZNAMU].sort());
  });

  it('sada klíčů nezávisí na tom, co běh vyplnil', () => {
    const bohaty = zaznamBehu({
      measured: true, bugs: ['a'], warnings: ['b'], runErrors: [],
      modelObservations: ['c'], runNotes: ['d'], ukonceni: 'limit-kroku',
      ukonceniPopis: 'x', nerozhodnutychKroku: 2, nezmerenoBlokaci: 1,
      summary: 's', performanceMetrics: {}, generatedScript: 'g', videoUrl: 'v',
    });
    expect(Object.keys(bohaty).sort()).toEqual(Object.keys(zaznamBehu({})).sort());
  });

  it('nezměřený běh není completed', () => {
    expect(zaznamBehu({ measured: false }).status).toBe('failed');
    expect(zaznamBehu({ measured: true }).status).toBe('completed');
  });

  it('chybějící measured se nečte jako neměřeno', () => {
    // `!measured` by z chybějícího pole udělalo „neměřeno" a běh by se
    // zapsal jako `failed`, přestože o něm nic takového nevíme.
    expect(stavBehu(undefined)).toBe('completed');
    expect(stavBehu(null)).toBe('completed');
    expect(stavBehu(false)).toBe('failed');
  });

  it('nevím není nula u počítaných polí', () => {
    const z = zaznamBehu({});
    expect(z.nerozhodnutychKroku).toBe(null);
    expect(z.nezmerenoBlokaci).toBe(null);
  });

  it('nula zůstane nulou', () => {
    const z = zaznamBehu({ nerozhodnutychKroku: 0, nezmerenoBlokaci: 0 });
    expect(z.nerozhodnutychKroku).toBe(0);
    expect(z.nezmerenoBlokaci).toBe(0);
  });

  it('seznamy jsou prázdné pole, ne undefined', () => {
    const z = zaznamBehu({});
    for (const klic of ['bugs', 'warnings', 'runErrors', 'modelObservations', 'runNotes']) {
      expect(Array.isArray(z[klic])).toBe(true);
      expect(z[klic]).toEqual([]);
    }
  });

  it('nálezy se nepřepisují ani nepřeskupují', () => {
    expect(zaznamBehu({ bugs: ['b', 'a'] }).bugs).toEqual(['b', 'a']);
  });
});

describe('stavMonitoru', () => {
  it('nezměřený běh je error, ne success ani failure', () => {
    // Nezměřený běh není ani „v pořádku", ani „nález" — je to chyba
    // našeho měření a monitor to musí ukázat jako takovou.
    expect(stavMonitoru({ measured: false, bugs: [] }))
      .toEqual({ lastRunStatus: 'error', lastRunBugsCount: 0 });
  });

  it('u nezměřeného běhu se nepočítají nálezy', () => {
    expect(stavMonitoru({ measured: false, bugs: ['x', 'y'] }).lastRunBugsCount).toBe(0);
  });

  it('změřený běh bez nálezu je success', () => {
    expect(stavMonitoru({ measured: true, bugs: [] }))
      .toEqual({ lastRunStatus: 'success', lastRunBugsCount: 0 });
  });

  it('změřený běh s nálezy je failure', () => {
    expect(stavMonitoru({ measured: true, bugs: ['a', 'b'] }))
      .toEqual({ lastRunStatus: 'failure', lastRunBugsCount: 2 });
  });

  it('chybějící seznam nálezů nespadne', () => {
    expect(stavMonitoru({ measured: true })).toEqual({ lastRunStatus: 'success', lastRunBugsCount: 0 });
    expect(stavMonitoru({})).toEqual({ lastRunStatus: 'success', lastRunBugsCount: 0 });
  });
});

describe('jeChybiDokument', () => {
  it('pozná gRPC NOT_FOUND', () => {
    expect(jeChybiDokument({ code: KOD_NENALEZENO })).toBe(true);
    expect(jeChybiDokument({ code: '5' })).toBe(true);
    expect(jeChybiDokument({ code: 'NOT_FOUND' })).toBe(true);
  });

  it('pozná znění Firestore, když kód chybí', () => {
    expect(jeChybiDokument(new Error('5 NOT_FOUND: no document to update: projects/x/documents/monitors/y')))
      .toBe(true);
  });

  it('SKUTEČNOU chybu databáze nespolkne', () => {
    // Kdyby se pod „už neexistuje" schovala nedostupná databáze nebo
    // odepřené oprávnění, zápisy by tiše mizely a nikdo by se to nedozvěděl.
    expect(jeChybiDokument({ code: 7, message: 'PERMISSION_DENIED' })).toBe(false);
    expect(jeChybiDokument({ code: 14, message: 'UNAVAILABLE' })).toBe(false);
    expect(jeChybiDokument({ code: 4, message: 'DEADLINE_EXCEEDED' })).toBe(false);
  });

  it('se známým jiným kódem neposuzuje podle znění', () => {
    // Zpráva o chybějícím dokumentu u chyby s kódem 7 by znamenala, že
    // přehlušíme skutečný problém s oprávněními.
    expect(jeChybiDokument({ code: 7, message: 'no document to update' })).toBe(false);
  });

  it('nic a prázdno nejsou chybějící dokument', () => {
    expect(jeChybiDokument(null)).toBe(false);
    expect(jeChybiDokument(undefined)).toBe(false);
    expect(jeChybiDokument(new Error('něco jiného'))).toBe(false);
  });
});
