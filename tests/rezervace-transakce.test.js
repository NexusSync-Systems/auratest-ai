/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { teloRezervace, STAV_SLOTU } from '../monitor-slot.js';

/**
 * Tělo transakce rezervace.
 *
 * NÁLEZ Z KONTROLNÍ VLNY, kvůli kterému tenhle soubor vznikl: tahle část
 * nebyla krytá ŽÁDNÝM testem. `monitor-slot.test.js` testoval rozhodnutí,
 * `scheduler-rezervace.test.js` testoval plánovač — ale ten si `db.js`
 * celý podvrhuje, takže se skutečné tělo transakce nikdy nespustilo.
 * Hlavička prvního z nich přitom tvrdila „testuje se OBOJÍ". Ten samý
 * vzorec, na který projekt naráží pořád dokola, jen o patro níž — a tentokrát
 * ho komentář prohlašoval za vyřešený.
 *
 * Netestované tak zůstávalo právě to, co rozhoduje o zápisu: že se
 * `update` volá JEN při rezervaci, do kterých polí a s jakými hodnotami.
 *
 * Firestore k tomu potřeba není — `teloRezervace` bere transakci
 * parametrem, takže stačí dvojník s `get` a `update`.
 */

function transakce(dokument) {
  const update = jest.fn();
  const t = {
    get: jest.fn(async () => (
      dokument === null
        ? { exists: false, data: () => undefined }
        : { exists: true, data: () => dokument }
    )),
    update,
  };
  return { t, update };
}

const docRef = { id: 'm1' };

describe('teloRezervace', () => {
  it('při rezervaci zapíše čas i zámek, a to jedním zápisem', () => {
    // Dva zápisy by znamenaly okno, ve kterém je slot rezervovaný,
    // ale nezamčený.
    const { t, update } = transakce({ active: true, lastRunTime: 100 });
    return teloRezervace(t, docRef, {
      ocekavanyLastRun: 100, novyCas: 500, zamekDo: 9999, ted: 400,
    }).then((v) => {
      expect(v.stav).toBe(STAV_SLOTU.REZERVOVANO);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(docRef, { lastRunTime: 500, bezimDo: 9999 });
    });
  });

  it.each([
    ['obsazeno', { active: true, lastRunTime: 777 }, STAV_SLOTU.OBSAZENO],
    ['neaktivní', { active: false, lastRunTime: 100 }, STAV_SLOTU.NEAKTIVNI],
    ['běžící', { active: true, lastRunTime: 100, bezimDo: 100000 }, STAV_SLOTU.BEZI],
  ])('při stavu %s NEZAPÍŠE nic', async (_popis, dokument, ocekavanyStav) => {
    const { t, update } = transakce(dokument);
    const v = await teloRezervace(t, docRef, {
      ocekavanyLastRun: 100, novyCas: 500, zamekDo: 9999, ted: 400,
    });
    expect(v.stav).toBe(ocekavanyStav);
    expect(update).not.toHaveBeenCalled();
  });

  it('u smazaného dokumentu nezapíše nic a nevyhodí', async () => {
    // `update` na neexistujícím dokumentu by transakci shodil.
    const { t, update } = transakce(null);
    const v = await teloRezervace(t, docRef, {
      ocekavanyLastRun: 0, novyCas: 500, zamekDo: 9999, ted: 400,
    });
    expect(v.stav).toBe(STAV_SLOTU.SMAZANO);
    expect(update).not.toHaveBeenCalled();
  });

  it('čte dokument uvnitř transakce, ne mimo ni', async () => {
    // Kdyby se četlo mimo transakci, celé porovnej-a-zapiš by nic
    // negarantovalo — Firestore hlídá jen to, co prošlo přes `t.get`.
    const { t } = transakce({ active: true, lastRunTime: 100 });
    await teloRezervace(t, docRef, {
      ocekavanyLastRun: 100, novyCas: 500, zamekDo: 9999, ted: 400,
    });
    expect(t.get).toHaveBeenCalledWith(docRef);
  });

  it('vrací výsledek posouzení, ne jen příznak', async () => {
    const { t } = transakce({ active: true, lastRunTime: 777 });
    const v = await teloRezervace(t, docRef, {
      ocekavanyLastRun: 100, novyCas: 500, zamekDo: 9999, ted: 400,
    });
    // Bez důvodu se v logu nepozná souběh od vadného typu hodnoty.
    expect(v.duvod).toContain('777');
  });

  it('vrácení rezervace (zámek 0) je tentýž kód, ne druhá cesta', async () => {
    const { t, update } = transakce({ active: true, lastRunTime: 500 });
    const v = await teloRezervace(t, docRef, {
      ocekavanyLastRun: 500, novyCas: 100, zamekDo: 0, ted: 400,
    });
    expect(v.stav).toBe(STAV_SLOTU.REZERVOVANO);
    expect(update).toHaveBeenCalledWith(docRef, { lastRunTime: 100, bezimDo: 0 });
  });
});
