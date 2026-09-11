import {
  jeZaseknuty,
  zaseknuteBehy,
  zaznamPrerusenehoBehu,
  HEARTBEAT_STALE_MS,
  LEGACY_STALE_MS,
} from '../stale-runs.js';

/**
 * Běh se zapíše jako `running` na začátku a přepíše až na konci. Když
 * proces mezitím skončí, ten zápis nikdo neprovede — a záznam tvrdí
 * „běží" navždycky. U nás to za jedno odpoledne vyrobilo tři takové
 * běhy, protože každé `docker compose up -d --build` posílá SIGTERM.
 */

const TED = new Date('2026-09-11T10:00:00Z').getTime();
const pred = (ms) => new Date(TED - ms).toISOString();

describe('kdy je běh zaseknutý', () => {
  test('rozhoduje tep, ne čas startu', () => {
    // Dlouhý ŽIVÝ běh a mrtvý běh vypadají podle času startu stejně.
    const zivy = {
      status: 'running',
      timestamp: pred(3 * 60 * 60 * 1000),
      heartbeatAt: pred(30 * 1000),
    };
    expect(jeZaseknuty(zivy, TED)).toBe(false);
  });

  test('běh bez tepu po prahu je mrtvý', () => {
    const mrtvy = {
      status: 'running',
      timestamp: pred(3 * 60 * 60 * 1000),
      heartbeatAt: pred(HEARTBEAT_STALE_MS + 1000),
    };
    expect(jeZaseknuty(mrtvy, TED)).toBe(true);
  });

  test('těsně pod prahem se nezabíjí', () => {
    // Zabít živý běh znamená zahodit výsledek, o kterém se uživatel
    // nikdy nedozví. Zombie je jen zmatený seznam — menší škoda.
    const tesne = { status: 'running', heartbeatAt: pred(HEARTBEAT_STALE_MS - 1000) };
    expect(jeZaseknuty(tesne, TED)).toBe(false);
  });

  test('starý záznam bez tepu se posuzuje podle startu', () => {
    // Běhy z doby před zavedením tepu — jinak by se nedoučistily nikdy.
    const stary = { status: 'running', timestamp: pred(20 * 60 * 60 * 1000) };
    expect(jeZaseknuty(stary, TED)).toBe(true);
  });

  test('záznam bez tepu se NEZABÍJÍ po patnácti minutách', () => {
    // Bez tepu rozhoduje čas startu — a ten o životě nevypovídá nic.
    // Měřit ho prahem pro tep by znamenalo zabíjet živé běhy kvůli
    // zápisu, který s měřením nesouvisí.
    const bezTepu = { status: 'running', timestamp: pred(20 * 60 * 1000) };
    expect(jeZaseknuty(bezTepu, TED)).toBe(false);
  });

  test('práh pro tep a pro záznam bez tepu je jiný', () => {
    const cas = pred(HEARTBEAT_STALE_MS + 60 * 1000);
    expect(jeZaseknuty({ status: 'running', heartbeatAt: cas }, TED)).toBe(true);
    expect(jeZaseknuty({ status: 'running', timestamp: cas }, TED)).toBe(false);
  });

  test('prahy jdou přebít pro testy i pro ladění', () => {
    const s = { status: 'running', heartbeatAt: pred(5000) };
    expect(jeZaseknuty(s, TED, { heartbeatMs: 1000 })).toBe(true);
    expect(jeZaseknuty(s, TED, { heartbeatMs: 10000 })).toBe(false);
  });

  test('dokončený ani selhaný běh není zaseknutý', () => {
    expect(jeZaseknuty({ status: 'completed', heartbeatAt: pred(10 ** 9) }, TED)).toBe(false);
    expect(jeZaseknuty({ status: 'failed', heartbeatAt: pred(10 ** 9) }, TED)).toBe(false);
  });

  test('nečitelný čas NENÍ důvod prohlásit běh za mrtvý', () => {
    expect(jeZaseknuty({ status: 'running', heartbeatAt: 'nesmysl' }, TED)).toBe(false);
    expect(jeZaseknuty({ status: 'running' }, TED)).toBe(false);
  });

  test('vadný vstup nespadne', () => {
    expect(jeZaseknuty(null, TED)).toBe(false);
    expect(jeZaseknuty(undefined, TED)).toBe(false);
    expect(zaseknuteBehy(null, TED)).toEqual([]);
  });

  test('výběr ze seznamu vrátí jen mrtvé', () => {
    const seznam = [
      { id: 'zivy', status: 'running', heartbeatAt: pred(1000) },
      { id: 'mrtvy', status: 'running', heartbeatAt: pred(HEARTBEAT_STALE_MS + 1) },
      { id: 'hotovy', status: 'completed' },
      { id: 'stary-bez-tepu', status: 'running', timestamp: pred(LEGACY_STALE_MS + 1) },
      { id: 'cerstvy-bez-tepu', status: 'running', timestamp: pred(20 * 60 * 1000) },
    ];
    expect(zaseknuteBehy(seznam, TED).map((s) => s.id))
      .toEqual(['mrtvy', 'stary-bez-tepu']);
  });
});

describe('jak se přerušený běh zapíše', () => {
  test('NIKDY jako dokončený', () => {
    // `completed` ve spisu znamená „výsledek platí". Přerušený běh
    // žádný výsledek nemá.
    for (const duvod of ['vypnuti', 'bez-tepu']) {
      expect(zaznamPrerusenehoBehu({}, duvod).status).toBe('failed');
    }
  });

  test('důvod jde do runErrors, ne mezi nálezy', () => {
    // `runErrors` jsou chyby MĚŘENÍ. Zapsat přerušení mezi `bugs` by
    // znamenalo nález o zákazníkově webu — přesně to, čemu oddělení
    // těch dvou polí brání.
    const z = zaznamPrerusenehoBehu({ bugs: ['skutečný nález'] }, 'vypnuti');
    expect(z.runErrors).toHaveLength(1);
    expect(z.runErrors[0]).toMatch(/restartem serveru/);
    expect(z).not.toHaveProperty('bugs');
  });

  test('existující chyby měření se nepřepisují', () => {
    const z = zaznamPrerusenehoBehu({ runErrors: ['dřívější chyba'] }, 'bez-tepu');
    expect(z.runErrors).toEqual(['dřívější chyba', expect.stringMatching(/nedoběhl/)]);
  });

  test('každý důvod má vlastní znění', () => {
    const vety = ['vypnuti', 'bez-tepu', 'odlozeno']
      .map((d) => zaznamPrerusenehoBehu({}, d).summary);
    expect(new Set(vety).size).toBe(3);
    expect(vety[0]).toMatch(/restartem serveru/);
    expect(vety[1]).toMatch(/přestal odpovídat/);
    expect(vety[2]).toMatch(/nebyl volný prohlížeč/);
  });

  test('neznámý důvod se NEPŘEKLÁDÁ tiše na některý ze známých', () => {
    // Překlep na volajícím by jinak zapsal do dokumentu nesprávnou
    // příčinu — a ta je u přerušeného běhu to jediné, co dokument nese.
    const z = zaznamPrerusenehoBehu({}, 'preklep');
    expect(z.summary).toMatch(/nezařazená příčina: preklep/);
    expect(z.summary).not.toMatch(/restartem serveru|přestal odpovídat/);
    expect(z.status).toBe('failed');
  });

  test('souhrn netvrdí nic o testovaném webu', () => {
    for (const duvod of ['vypnuti', 'bez-tepu']) {
      const s = zaznamPrerusenehoBehu({}, duvod).summary;
      expect(s).not.toMatch(/bez závad|v pořádku|nenalezeno|bez nálezu/i);
      expect(s).toMatch(/nedoběhl|nemá výsledek/);
    }
  });

  test('tep se NENULUJE — jinak se záznam překlápí donekonečna', () => {
    // Původní verze psala `heartbeatAt: null` a `jeZaseknuty` četlo
    // `heartbeatAt ?? timestamp`. `null` propadlo na čas startu, tedy
    // na hodnotu starou hodiny → záznam byl okamžitě zase „zaseknutý"
    // a při každém dalším zápisu běhu se překlápěl running ↔ failed,
    // přičemž `runErrors` narůstaly opakovanými větami o přerušení.
    //
    // Proti opakovanému zpracování chrání `status`.
    const z = zaznamPrerusenehoBehu({}, 'vypnuti');
    expect(z).not.toHaveProperty('heartbeatAt');
    expect(jeZaseknuty({ ...z, status: 'failed' }, TED)).toBe(false);
  });

  test('zapisuje se, KDY se přerušení zjistilo', () => {
    const z = zaznamPrerusenehoBehu({}, 'vypnuti', '2026-09-11T10:00:00.000Z');
    expect(z.interruptedAt).toBe('2026-09-11T10:00:00.000Z');
  });
});
