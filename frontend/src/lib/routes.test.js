import { describe, test, expect } from 'vitest';
import { tabFromPath, pathFromTab, isKnownPath, TAB_TO_PATH, DEFAULT_TAB } from './routes.js';

/**
 * Adresy sekcí.
 *
 * Lidé je posílají dál a zakládají do záložek, takže jakmile se jednou
 * objeví v adresním řádku, jsou to veřejné rozhraní. Změna cesty rozbije
 * cizí odkaz.
 */

describe('mapování sekcí na adresy', () => {
  test('každá sekce má svou cestu a je zpětně rozpoznatelná', () => {
    for (const [tab, path] of Object.entries(TAB_TO_PATH)) {
      expect(tabFromPath(path)).toBe(tab);
    }
  });

  test('cesty jsou navzájem různé', () => {
    const paths = Object.values(TAB_TO_PATH);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('neznámá cesta padá na výchozí sekci, ne na prázdnou obrazovku', () => {
    expect(tabFromPath('/neexistuje')).toBe(DEFAULT_TAB);
    expect(tabFromPath('/agent/podsekce')).toBe(DEFAULT_TAB);
  });

  test('kořen zobrazí výchozí sekci', () => {
    expect(tabFromPath('/')).toBe(DEFAULT_TAB);
    expect(tabFromPath('')).toBe(DEFAULT_TAB);
  });

  test('koncové lomítko ani velikost písmen nerozhoduje', () => {
    expect(tabFromPath('/agent/')).toBe('agent');
    expect(tabFromPath('/AGENT')).toBe('agent');
    expect(tabFromPath('/Nastaveni/')).toBe('settings');
  });

  test('prázdná nebo chybějící hodnota nespadne', () => {
    for (const value of [undefined, null]) {
      expect(tabFromPath(value)).toBe(DEFAULT_TAB);
    }
  });

  test('neznámá sekce dostane cestu výchozí sekce', () => {
    expect(pathFromTab('vymyslena')).toBe(TAB_TO_PATH[DEFAULT_TAB]);
  });

  test('isKnownPath bere kořen jako legitimní vstupní adresu', () => {
    expect(isKnownPath('/')).toBe(true);
    expect(isKnownPath('/hub')).toBe(true);
    expect(isKnownPath('/neexistuje')).toBe(false);
  });

  test('cesty nekolidují s API ani s artefakty', () => {
    // server.js servíruje /api, /sdk, /screenshots, /videos — kdyby sem
    // spadla cesta sekce, catch-all na index.html by ji nikdy nedostal.
    const reserved = ['/api', '/sdk', '/screenshots', '/videos', '/ws', '/health'];
    for (const path of Object.values(TAB_TO_PATH)) {
      expect(reserved).not.toContain(path);
      expect(reserved.some((r) => path.startsWith(`${r}/`))).toBe(false);
    }
  });
});
