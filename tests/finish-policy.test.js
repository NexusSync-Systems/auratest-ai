import {
  vyhodnotFinish,
  popisUkonceni,
  souhrnneUkonceni,
  UKONCENI,
  UKONCENI_BEZ_POKRYTI,
} from '../finish-policy.js';

describe('vyhodnotFinish', () => {
  it('prázdná stránka po úspěšné extrakci ukončení dokládá', () => {
    const v = vyhodnotFinish({ prvkuNaStrance: 0, extrakceSelhala: false, interakci: 0 });
    expect(v.povoleno).toBe(true);
    expect(v.duvod).toBe(UKONCENI.VYCERPANO);
  });

  it('prázdno ze SELHANÉ extrakce ukončení nedokládá', () => {
    // Ověřená vada první verze opravy: `extractInteractiveElements` vracela
    // při pádu `[]`, z toho vyšlo „vyčerpáno", běh skončil v prvním kroku
    // s `measured: true` a vytiskl se jako doložený čistý výsledek.
    const v = vyhodnotFinish({ prvkuNaStrance: 0, extrakceSelhala: true, interakci: 0 });
    expect(v.povoleno).toBe(false);
    expect(v.popis).toMatch(/selhalo/i);
  });

  it('tvrzení stránky platí až po provedené interakci', () => {
    const v = vyhodnotFinish({ completionContext: true, interakci: 1, prvkuNaStrance: 5 });
    expect(v.povoleno).toBe(true);
    expect(v.duvod).toBe(UKONCENI.POTVRZENO);
  });

  it('titulek „dokončeno" v prvním kroku běh neukončí', () => {
    // Toto je ta vada, kterou našla kontrolní vlna: hradba se z
    // `detected_bugs` jen přesunula na `<title>`, který nastavuje
    // auditovaný web.
    const v = vyhodnotFinish({ completionContext: true, interakci: 0, prvkuNaStrance: 20 });
    expect(v.povoleno).toBe(false);
    expect(v.popis).toMatch(/ještě nic neprovedl/i);
  });

  it('samotný návrh modelu ukončení nedokládá', () => {
    const v = vyhodnotFinish({ completionContext: false, interakci: 5, prvkuNaStrance: 3 });
    expect(v.povoleno).toBe(false);
    expect(v.duvod).toBe(null);
  });

  it('nevím není nula — bez počtu prvků se neukončuje', () => {
    expect(vyhodnotFinish({ prvkuNaStrance: undefined, interakci: 3 }).povoleno).toBe(false);
  });

  it('prázdný vstup neukončí běh', () => {
    expect(vyhodnotFinish().povoleno).toBe(false);
    expect(vyhodnotFinish({}).povoleno).toBe(false);
  });

  it('completionContext musí být opravdu true, ne jen pravdivý', () => {
    expect(vyhodnotFinish({ completionContext: 'ano', interakci: 2, prvkuNaStrance: 2 }).povoleno)
      .toBe(false);
  });

  it('nečíselný počet interakcí tvrzení stránky nepropustí', () => {
    expect(vyhodnotFinish({ completionContext: true, interakci: null, prvkuNaStrance: 2 }).povoleno)
      .toBe(false);
    expect(vyhodnotFinish({ completionContext: true, interakci: NaN, prvkuNaStrance: 2 }).povoleno)
      .toBe(false);
  });
});

describe('popisUkonceni', () => {
  it('každý důvod má vlastní větu', () => {
    const vety = Object.values(UKONCENI).map(popisUkonceni);
    expect(new Set(vety).size).toBe(Object.values(UKONCENI).length);
  });

  it('limit kroků se nevydává za dokončení', () => {
    expect(popisUkonceni(UKONCENI.LIMIT)).toMatch(/nedoložil/i);
  });

  it('u tvrzení stránky se řekne, že pochází z auditovaného webu', () => {
    expect(popisUkonceni(UKONCENI.POTVRZENO)).toMatch(/z auditovaného webu/i);
    expect(popisUkonceni(UKONCENI.POTVRZENO)).toMatch(/nikoli z nezávislého měření/i);
  });

  it('neznámý důvod se nedomýšlí', () => {
    expect(popisUkonceni('cokoli')).toMatch(/není zaznamenán/i);
    expect(popisUkonceni(undefined)).toMatch(/není zaznamenán/i);
  });
});

describe('souhrnneUkonceni', () => {
  it('jedna stránka na limitu stáhne celý běh', () => {
    expect(souhrnneUkonceni([UKONCENI.VYCERPANO, UKONCENI.LIMIT, UKONCENI.POTVRZENO]))
      .toBe(UKONCENI.LIMIT);
  });

  it('chyba měření přebíjí všechno', () => {
    expect(souhrnneUkonceni([UKONCENI.VYCERPANO], true)).toBe(UKONCENI.CHYBA);
    expect(souhrnneUkonceni([UKONCENI.CHYBA, UKONCENI.VYCERPANO])).toBe(UKONCENI.CHYBA);
  });

  it('chybějící důvod u stránky se čte jako limit, ne jako doložené dokončení', () => {
    expect(souhrnneUkonceni([UKONCENI.VYCERPANO, null])).toBe(UKONCENI.LIMIT);
  });

  it('bez stránek nemá co doložit', () => {
    expect(souhrnneUkonceni([])).toBe(UKONCENI.LIMIT);
    expect(souhrnneUkonceni(undefined)).toBe(UKONCENI.LIMIT);
  });

  it('tvrzení stránky je slabší než změřená prázdnota', () => {
    expect(souhrnneUkonceni([UKONCENI.VYCERPANO, UKONCENI.POTVRZENO]))
      .toBe(UKONCENI.POTVRZENO);
    expect(souhrnneUkonceni([UKONCENI.VYCERPANO, UKONCENI.VYCERPANO]))
      .toBe(UKONCENI.VYCERPANO);
  });
});

describe('UKONCENI_BEZ_POKRYTI', () => {
  it('žádný důvod ukončení agentního běhu pokrytí nedokládá', () => {
    // Včetně `VYCERPANO`: „na stránce nebylo co ovládat" znamená, že agent
    // neprovedl nic. Dřív takový běh dostával zelené „agent na žádný
    // problém nenarazil" — nejsilnější tvrzení nástroje nad během, který
    // nic nezkusil.
    expect(UKONCENI_BEZ_POKRYTI.has(UKONCENI.LIMIT)).toBe(true);
    expect(UKONCENI_BEZ_POKRYTI.has(UKONCENI.CHYBA)).toBe(true);
    expect(UKONCENI_BEZ_POKRYTI.has(UKONCENI.VYCERPANO)).toBe(true);
  });
});

describe('fail-closed chování (regrese druhé vlny)', () => {
  it('nepravdivý tvar extrakceSelhala větev neotevře', () => {
    // Bezpečnostní podmínka se nesmí otvírat kvůli tvaru dat.
    for (const podivnost of ['ano', 1, {}, []]) {
      expect(vyhodnotFinish({ prvkuNaStrance: 0, extrakceSelhala: podivnost }).povoleno)
        .toBe(false);
    }
  });

  it('souhrnneUkonceni propadá na limit, ne na nejsilnější důvod', () => {
    // Dřív `['nesmysl']` vracelo `vycerpano` — důvod, který žádná stránka
    // neměla, a zároveň tehdy jediný bez výhrady o pokrytí.
    expect(souhrnneUkonceni(['nesmysl'])).toBe(UKONCENI.LIMIT);
    expect(souhrnneUkonceni([undefined])).toBe(UKONCENI.LIMIT);
  });
});
