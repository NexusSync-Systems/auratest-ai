import { runStatus, runningSessions, STALE_AFTER_MS } from './run-status.js';

/**
 * Ukazatel v hlavičce.
 *
 * Četl jediný lokální příznak, takže během compliance skenů svítilo
 * „Připraven" a po obnovení stránky se stav ztratil — uživatel viděl klid,
 * spustil další běh a narazil na vyčerpané sloty.
 */

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const bezi = (over = {}) => ({
  id: 's1',
  status: 'running',
  timestamp: new Date(NOW - 60_000).toISOString(),
  ...over,
});

const stav = (over = {}) =>
  runStatus({ localRunning: false, auditsLoading: false, sessions: [], now: NOW, ...over });

test('bez čehokoli běžícího je připraven', () => {
  expect(stav().state).toBe('idle');
  expect(stav().label).toBe('Připraven');
});

test('dokončený běh na serveru ukazatel nerozsvítí', () => {
  expect(stav({ sessions: [bezi({ status: 'completed' })] }).state).toBe('idle');
});

test('compliance sken rozsvítí ukazatel', () => {
  // Osm prohlížečů drtilo server a hlavička tvrdila, že se nic neděje.
  expect(stav({ auditsLoading: true }).state).toBe('running');
});

test('agentní test z tohohle panelu rozsvítí ukazatel', () => {
  expect(stav({ localRunning: true }).state).toBe('running');
});

test('běh na serveru přežije obnovení stránky', () => {
  // JÁDRO VĚCI: lokální příznaky jsou po reloadu prázdné, běh ale
  // pokračuje na serveru.
  const s = stav({ sessions: [bezi()] });
  expect(s.state).toBe('running');
  expect(s.title).toMatch(/i po zavření stránky/);
});

test('víc běhů se spočítá', () => {
  const s = stav({ sessions: [bezi(), bezi({ id: 's2' })] });
  expect(s.count).toBe(2);
  expect(s.label).toMatch(/2/);
});

test('zaseknutý běh není ani „běží", ani „připraven"', () => {
  // Běh zůstane ve stavu `running` i tehdy, když proces spadl — nikdo mu
  // status nepřepíše. Tvrdit po dvou hodinách „běží" je domněnka, ne
  // měření; a „připraven" by zamlčelo, že se něco nedokončilo.
  const s = stav({ sessions: [bezi({ timestamp: new Date(NOW - STALE_AFTER_MS - 1000).toISOString() })] });
  expect(s.state).toBe('unknown');
  expect(s.title).toMatch(/nedokončil/);
});

test('živý běh má přednost před zaseknutým', () => {
  const s = stav({
    sessions: [
      bezi({ id: 'stary', timestamp: new Date(NOW - STALE_AFTER_MS - 1000).toISOString() }),
      bezi({ id: 'novy' }),
    ],
  });
  expect(s.state).toBe('running');
});

test('nečitelný čas se bere jako živý běh, ne jako klid', () => {
  // Radši varovat než mlčet: kdyby se ukazatel tvářil klidně, uživatel by
  // spustil další běh do už vyčerpaných slotů.
  expect(stav({ sessions: [bezi({ timestamp: 'nesmysl' })] }).state).toBe('running');
});

test('nesmyslný vstup nespadne', () => {
  for (const value of [null, undefined, 'x', {}]) {
    expect(runningSessions(value)).toEqual([]);
    expect(stav({ sessions: value }).state).toBe('idle');
  }
});
