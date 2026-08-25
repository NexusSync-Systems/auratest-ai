import { describe, test, expect } from 'vitest';
import {
  tabFromPath,
  pathFromTab,
  isKnownPath,
  isPublicPath,
  isProtectedTab,
  TAB_TO_PATH,
  PUBLIC_TAB_TO_PATH,
  DEFAULT_TAB,
} from './routes.js';

/**
 * Adresy obrazovek.
 *
 * Lidé je posílají dál a zakládají do záložek, takže jakmile se jednou
 * objeví v adresním řádku, jsou to veřejné rozhraní. Změna cesty rozbije
 * cizí odkaz.
 */

describe('mapování obrazovek na adresy', () => {
  test('každá obrazovka má svou cestu a je zpětně rozpoznatelná', () => {
    for (const [tab, path] of Object.entries({ ...TAB_TO_PATH, ...PUBLIC_TAB_TO_PATH })) {
      expect(tabFromPath(path)).toBe(tab);
    }
  });

  test('cesty jsou navzájem různé', () => {
    const paths = [...Object.values(TAB_TO_PATH), ...Object.values(PUBLIC_TAB_TO_PATH)];
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('klíče veřejných a zamčených obrazovek se nepřekrývají', () => {
    const overlap = Object.keys(TAB_TO_PATH).filter((k) => k in PUBLIC_TAB_TO_PATH);
    expect(overlap).toEqual([]);
  });

  test('neznámá cesta padá na úvodní stránku, ne na prázdnou obrazovku', () => {
    expect(tabFromPath('/neexistuje')).toBe('landing');
    expect(tabFromPath('/agent/podsekce')).toBe('landing');
  });

  test('kořen je úvodní stránka', () => {
    expect(tabFromPath('/')).toBe('landing');
    expect(tabFromPath('')).toBe('landing');
  });

  test('koncové lomítko ani velikost písmen nerozhoduje', () => {
    expect(tabFromPath('/agent/')).toBe('agent');
    expect(tabFromPath('/AGENT')).toBe('agent');
    expect(tabFromPath('/Ukazka/')).toBe('sample');
  });

  test('prázdná nebo chybějící hodnota nespadne', () => {
    for (const value of [undefined, null]) {
      expect(tabFromPath(value)).toBe('landing');
    }
  });

  test('neznámá obrazovka dostane cestu úvodní stránky', () => {
    expect(pathFromTab('vymyslena')).toBe(PUBLIC_TAB_TO_PATH.landing);
  });

  test('isKnownPath rozpozná veřejné i zamčené cesty', () => {
    expect(isKnownPath('/')).toBe(true);
    expect(isKnownPath('/hub')).toBe(true);
    expect(isKnownPath('/ukazka')).toBe(true);
    expect(isKnownPath('/neexistuje')).toBe(false);
  });
});

describe('co je veřejné a co ne', () => {
  test('veřejné jsou přesně tři cesty: úvod, ukázka, přihlášení', () => {
    expect(Object.keys(PUBLIC_TAB_TO_PATH).sort()).toEqual(['landing', 'login', 'sample']);
  });

  test('žádná sekce se skenováním není veřejná', () => {
    // Kdyby sem přibyla, znamenalo by to, že kdokoli může poslat server
    // na libovolnou adresu. Test to zachytí dřív než produkce.
    for (const path of Object.values(TAB_TO_PATH)) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  test('veřejné cesty nejsou označené jako zamčené', () => {
    for (const tab of Object.keys(PUBLIC_TAB_TO_PATH)) {
      expect(isProtectedTab(tab)).toBe(false);
    }
  });

  test('výchozí sekce po přihlášení je zamčená', () => {
    expect(isProtectedTab(DEFAULT_TAB)).toBe(true);
  });

  test('cesty nekolidují s API ani s artefakty', () => {
    // server.js servíruje /api, /sdk, /screenshots, /videos — kdyby sem
    // spadla cesta obrazovky, catch-all na index.html by ji nikdy nedostal.
    const reserved = ['/api', '/sdk', '/screenshots', '/videos', '/ws', '/health'];
    const all = [...Object.values(TAB_TO_PATH), ...Object.values(PUBLIC_TAB_TO_PATH)];
    for (const path of all) {
      expect(reserved).not.toContain(path);
      expect(reserved.some((r) => path.startsWith(`${r}/`))).toBe(false);
    }
  });

  test('ukázkový report nekoliduje se souborem, který sám načítá', () => {
    expect(Object.values(PUBLIC_TAB_TO_PATH)).not.toContain('/sample-report.json');
  });
});
