import {
  zkratCommit, formatBuildTime, popisVerze, verzeSouhlasi, serverBuildInfo,
} from '../build-info.js';

/**
 * Po nasazení nešlo poznat, jestli to, co je vidět v prohlížeči, odpovídá
 * repozitáři. Číslo verze ale musí platit stejná pravidla jako pro
 * všechno ostatní: raději „nevím" než vymyšlená hodnota, protože podle
 * něj se rozhoduje, jestli se má nasazovat znovu.
 */

describe('zkrácení commitu', () => {
  test('plný hash se zkrátí na sedm znaků', () => {
    expect(zkratCommit('3488793abcdef1234567890abcdef1234567890a')).toBe('3488793');
  });

  test('už zkrácený projde', () => {
    expect(zkratCommit('b26ad41')).toBe('b26ad41');
  });

  test('výplně z build argů znamenají „nevím", ne verzi', () => {
    // Bez tohohle by se do UI dostalo `unknown` jako by to byl commit
    // a z „nevím" by se stalo tvrzení.
    for (const v of ['', '   ', 'unknown', 'null', 'undefined', null, undefined]) {
      expect(zkratCommit(v)).toBeNull();
    }
  });

  test('co není hash, se za hash nevydává', () => {
    expect(zkratCommit('v1.2.3')).toBeNull();
    expect(zkratCommit('zzzzzzz')).toBeNull();
    expect(zkratCommit('abc')).toBeNull();
  });
});

describe('čas buildu', () => {
  test('platný čas se normalizuje', () => {
    expect(formatBuildTime('2026-09-11T16:10:00Z')).toBe('2026-09-11T16:10:00.000Z');
  });

  test('nečitelný čas nepředstírá datum', () => {
    expect(formatBuildTime('nesmysl')).toBeNull();
    expect(formatBuildTime('')).toBeNull();
    expect(formatBuildTime(undefined)).toBeNull();
  });
});

describe('popisek verze', () => {
  test('commit i datum', () => {
    expect(popisVerze({ commit: 'b26ad41', buildTime: '2026-09-11T16:10:00Z' }))
      .toBe('b26ad41 · 2026-09-11');
  });

  test('samotný commit', () => {
    expect(popisVerze({ commit: 'b26ad41' })).toBe('b26ad41');
  });

  test('samotné datum', () => {
    expect(popisVerze({ buildTime: '2026-09-11T16:10:00Z' }))
      .toBe('sestaveno 2026-09-11');
  });

  test('nic se přizná jako „verze neznámá"', () => {
    expect(popisVerze({})).toBe('verze neznámá');
    expect(popisVerze(null)).toBe('verze neznámá');
    expect(popisVerze({ commit: 'unknown', buildTime: 'nesmysl' })).toBe('verze neznámá');
  });
});

describe('shoda frontendu a serveru', () => {
  test('stejný commit', () => {
    expect(verzeSouhlasi('b26ad41', 'b26ad41abcdef')).toBe(true);
  });

  test('jiný commit znamená starý bundle v prohlížeči', () => {
    // Přesně ten stav, kvůli kterému vznikl `lazy-with-reload.js`.
    expect(verzeSouhlasi('b26ad41', '3488793')).toBe(false);
  });

  test('chybějící údaj NENÍ shoda', () => {
    // Tvrdit „vše v pořádku" na základě chybějícího údaje je táž vada,
    // jakou hlídají skenery.
    expect(verzeSouhlasi(null, 'b26ad41')).toBeNull();
    expect(verzeSouhlasi('b26ad41', null)).toBeNull();
    expect(verzeSouhlasi('unknown', 'unknown')).toBeNull();
  });
});

describe('verze serveru z prostředí', () => {
  test('čte GIT_COMMIT a BUILD_TIME', () => {
    const info = serverBuildInfo({
      GIT_COMMIT: '3488793abcdef', BUILD_TIME: '2026-09-11T16:10:00Z',
    });
    expect(info.commit).toBe('3488793');
    expect(info.buildTime).toBe('2026-09-11T16:10:00.000Z');
  });

  test('prázdné prostředí vrací null, ne vymyšlenou verzi', () => {
    expect(serverBuildInfo({})).toEqual({ commit: null, buildTime: null });
  });
});
