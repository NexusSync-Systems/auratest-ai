import { describe, test, expect } from 'vitest';
import {
  zkracenyTyp, stavBehu, casBehu, nadpisDne, seskupPodleDne,
} from './history.js';

/**
 * Seznam běhů nesl jen doménu, počet chyb a celý dlouhý `goal`. Čtyři
 * běhy na tutéž doménu tedy vypadaly identicky — nešlo poznat, který je
 * z kdy, který dopadl jak, ani který se nedokončil.
 */

describe('zkrácený typ testu', () => {
  const dvojice = [
    ['Průzkumné testování bez zadání (Monkey Mode - bez AI)', 'Monkey'],
    ['Chytrý průzkumný test s AI (Smart Monkey)', 'Smart Monkey'],
    ['Automatický 3-fázový Smoke Test (AI řízené)', 'Smoke test'],
    ['Odolnostní test za nepříznivých podmínek', 'Chaos'],
    ['GDPR Striktní Cookies', 'Cookies'],
    ['NIS2 & PQC', 'NIS2'],
  ];
  for (const [goal, ocekavano] of dvojice) {
    test(`„${goal}" → ${ocekavano}`, () => {
      expect(zkracenyTyp(goal)).toBe(ocekavano);
    });
  }

  test('vlastní zadání uživatele se nepřekládá, jen zkrátí', () => {
    // Nahradit ho obecným „Agent" by zahodilo jedinou informaci o tom,
    // co po agentovi uživatel vlastně chtěl.
    expect(zkracenyTyp('Projdi košík')).toBe('Projdi košík');
    expect(zkracenyTyp('x'.repeat(60))).toHaveLength(28);
  });

  test('prázdné zadání se nevydává za typ', () => {
    expect(zkracenyTyp('')).toBe('Neurčeno');
    expect(zkracenyTyp(null)).toBe('Neurčeno');
  });
});

describe('stav běhu — nedokončený není bez nálezu', () => {
  test('dokončený bez nálezů', () => {
    const r = stavBehu({ status: 'completed', bugsCount: 0 });
    expect(r.stav).toBe('ciste');
    expect(r.popisek).toBe('Bez nálezu');
  });

  test('dokončený s nálezy uvádí počet ve správném tvaru', () => {
    expect(stavBehu({ status: 'completed', bugsCount: 1 }).popisek).toBe('1 nález');
    expect(stavBehu({ status: 'completed', bugsCount: 3 }).popisek).toBe('3 nálezy');
    expect(stavBehu({ status: 'completed', bugsCount: 7 }).popisek).toBe('7 nálezů');
  });

  test('nedokončený běh se NEHLÁSÍ jako bez nálezu', () => {
    // `bugsCount: 0` u selhaného běhu znamená „nikdo se nedíval", ne
    // „nic se nenašlo". Zobrazit to stejně jako čistý běh by bylo
    // tvrzení o webu, které nikdo neměřil.
    const r = stavBehu({ status: 'failed', bugsCount: 0 });
    expect(r.stav).toBe('nedokonceno');
    expect(r.popisek).toBe('Nedokončeno');
  });

  test('běžící běh má vlastní stav', () => {
    expect(stavBehu({ status: 'running', bugsCount: 0 }).stav).toBe('bezi');
  });

  test('chybějící počet nálezů se přizná', () => {
    const r = stavBehu({ status: 'completed' });
    expect(r.stav).toBe('neznamy');
    expect(r.popisek).toMatch(/Bez údaje/);
  });

  test('neznámý status není ani jedno z toho', () => {
    expect(stavBehu({ status: 'kdovíco', bugsCount: 0 }).stav).toBe('neznamy');
    expect(stavBehu({}).stav).toBe('neznamy');
  });
});

describe('čas a datum', () => {
  test('čas ve tvaru HH:MM', () => {
    expect(casBehu('2026-09-11T07:27:00')).toMatch(/^\d{1,2}:\d{2}$/);
  });

  test('nečitelné datum nepředstírá čas', () => {
    expect(casBehu('nesmysl')).toBe('');
    expect(nadpisDne('nesmysl')).toBe('Bez data');
  });

  test('dnes a včera', () => {
    const ted = new Date('2026-09-11T10:00:00').getTime();
    expect(nadpisDne('2026-09-11T07:27:00', ted)).toBe('Dnes');
    expect(nadpisDne('2026-09-10T23:59:00', ted)).toBe('Včera');
  });

  test('starší datum se vypíše', () => {
    const ted = new Date('2026-09-11T10:00:00').getTime();
    expect(nadpisDne('2026-09-01T12:00:00', ted)).toMatch(/2026/);
  });

  test('„včera" se počítá podle dne, ne podle 24 hodin', () => {
    // Běh v 23:59 a pohled v 00:01 dělí dvě minuty, ale je to jiný den.
    const ted = new Date('2026-09-11T00:01:00').getTime();
    expect(nadpisDne('2026-09-10T23:59:00', ted)).toBe('Včera');
  });
});

describe('seskupení podle dne', () => {
  const ted = new Date('2026-09-11T10:00:00').getTime();

  test('běhy z téhož dne jsou v jedné skupině', () => {
    const skupiny = seskupPodleDne([
      { id: 'a', timestamp: '2026-09-11T09:00:00' },
      { id: 'b', timestamp: '2026-09-11T07:00:00' },
      { id: 'c', timestamp: '2026-09-10T20:00:00' },
    ], ted);
    expect(skupiny).toHaveLength(2);
    expect(skupiny[0].nadpis).toBe('Dnes');
    expect(skupiny[0].bezy.map((s) => s.id)).toEqual(['a', 'b']);
    expect(skupiny[1].nadpis).toBe('Včera');
  });

  test('pořadí se nespoléhá na vstup', () => {
    // Server sice řadí, ale spoléhat se na to by znamenalo, že se
    // skupiny při jiném pořadí tiše rozsypou na duplicitní nadpisy.
    const skupiny = seskupPodleDne([
      { id: 'stary', timestamp: '2026-09-10T20:00:00' },
      { id: 'novy', timestamp: '2026-09-11T09:00:00' },
      { id: 'stredni', timestamp: '2026-09-10T22:00:00' },
    ], ted);
    expect(skupiny.map((s) => s.nadpis)).toEqual(['Dnes', 'Včera']);
    expect(skupiny[1].bezy.map((s) => s.id)).toEqual(['stredni', 'stary']);
  });

  test('nečitelné datum patří na konec, ne doprostřed', () => {
    const skupiny = seskupPodleDne([
      { id: 'bezdata', timestamp: undefined },
      { id: 'dnesni', timestamp: '2026-09-11T09:00:00' },
    ], ted);
    expect(skupiny[0].nadpis).toBe('Dnes');
    expect(skupiny[skupiny.length - 1].nadpis).toBe('Bez data');
  });

  test('prázdný a vadný vstup nespadne', () => {
    expect(seskupPodleDne([], ted)).toEqual([]);
    expect(seskupPodleDne(null, ted)).toEqual([]);
    expect(seskupPodleDne(undefined, ted)).toEqual([]);
  });
});

describe('stav se neodvozuje z počtu nálezů, když ten počet nic neznamená', () => {
  test('předpisový sken s porušením se NEHLÁSÍ jako bez nálezu', () => {
    // `buildScanSession` nastavuje compliance skenu `bugs: []` schválně
    // — jeho verdikt je v `checks`. Počítat u něj nálezy znamenalo, že
    // sken, který našel porušení, vypadal v seznamu stejně jako čistý.
    const r = stavBehu({
      status: 'completed', kind: 'compliance-scan', bugsCount: 0, verdict: false,
    });
    expect(r.stav).toBe('nalezy');
    expect(r.popisek).toBe('Porušení');
  });

  test('předpisový sken bez verdiktu je neprůkazný, ne čistý', () => {
    const r = stavBehu({
      status: 'completed', kind: 'compliance-scan', bugsCount: 0, verdict: null,
    });
    expect(r.stav).toBe('neprukazne');
    expect(r.popisek).toBe('Neprůkazné');
  });

  test('předpisový sken s kladným verdiktem je bez nálezu', () => {
    const r = stavBehu({
      status: 'completed', kind: 'compliance-scan', bugsCount: 0, verdict: true,
    });
    expect(r.stav).toBe('ciste');
  });

  test('běh „running" starší než limit se nehlásí jako běžící', () => {
    // Hlavička aplikace to rozlišuje od začátku (`run-status.js`),
    // seznam ne — takže o týchž záznamech tvrdily každý něco jiného:
    // nahoře „3 běhy bez odezvy", dole „Běží".
    const ted = new Date('2026-09-11T09:11:00').getTime();
    const r = stavBehu({ status: 'running', timestamp: '2026-09-10T15:29:00' }, ted);
    expect(r.stav).toBe('bezodezvy');
    expect(r.popisek).toBe('Bez odezvy');
  });

  test('čerstvý běh „running" zůstává běžící', () => {
    const ted = new Date('2026-09-11T09:11:00').getTime();
    const r = stavBehu({ status: 'running', timestamp: '2026-09-11T09:05:00' }, ted);
    expect(r.stav).toBe('bezi');
  });

  test('běh bez čitelného času se neoznačí za mrtvý', () => {
    // Nečitelné datum neznamená, že běh spadl. Spíš varovat než tvrdit.
    expect(stavBehu({ status: 'running', timestamp: 'nesmysl' }).stav).toBe('bezi');
  });
});
