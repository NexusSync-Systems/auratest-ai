import { popisHttpChyby, popisHttpChybyBehu } from '../http-status.js';

/**
 * Chybová stránka není měřená aplikace.
 *
 * `page.goto()` na server, který vrací 503, navigaci za selhanou
 * nepovažuje — odpověď PŘIŠLA, jen je chybová. Chaos test proto dostal
 * v baseline i v hlavním běhu tentýž 503, rozdíl byl nulový a verdikt
 * vyšel „Aplikace přežila N injektovaných poruch bez pádu". Odolnost
 * chybové stránky o aplikaci nevypovídá nic.
 */

const odpoved = (status) => ({ ok: () => status >= 200 && status < 300, status: () => status });

describe('popisHttpChyby', () => {
  it('použitelná odpověď nedá žádnou chybu', () => {
    expect(popisHttpChyby(odpoved(200))).toBe(null);
    expect(popisHttpChyby(odpoved(204))).toBe(null);
  });

  it('chybový stav se pojmenuje', () => {
    expect(popisHttpChyby(odpoved(503))).toBe('Server odpověděl 503.');
    expect(popisHttpChyby(odpoved(404))).toBe('Server odpověděl 404.');
    expect(popisHttpChyby(odpoved(403))).toBe('Server odpověděl 403.');
  });

  it('přesměrování se nevydává za použitelnou odpověď', () => {
    // `response.ok()` je v Playwrightu 200–299. Stránka, která zůstala
    // na 301 bez následování, nic neukazuje.
    expect(popisHttpChyby(odpoved(301))).toBe('Server odpověděl 301.');
  });

  it('žádná odpověď je „server neodpověděl", ne „v pořádku"', () => {
    expect(popisHttpChyby(null)).toBe('Server neodpověděl.');
    expect(popisHttpChyby(undefined)).toBe('Server neodpověděl.');
  });

  it('nečitelná odpověď se přizná, nemlčí', () => {
    // `ok()` na odpovědi z uzavřeného kontextu vyhodí. „Nevím" je
    // pravdivější než „v pořádku".
    const rozbita = { ok: () => { throw new Error('Target closed'); }, status: () => 0 };
    expect(popisHttpChyby(rozbita)).toMatch(/nepodařilo přečíst.*Target closed/);
  });
});

describe('popisHttpChybyBehu', () => {
  it('bez chyby v obou bězích nic nehlásí', () => {
    expect(popisHttpChybyBehu({ baseline: null, hlavni: null })).toBe(null);
    expect(popisHttpChybyBehu({})).toBe(null);
    expect(popisHttpChybyBehu()).toBe(null);
  });

  it('stejná chyba v obou bězích se uvede jednou', () => {
    expect(popisHttpChybyBehu({ baseline: 'Server odpověděl 503.', hlavni: 'Server odpověděl 503.' }))
      .toBe('Server odpověděl 503. (v baseline i v hlavním běhu)');
  });

  it('rozdílné chyby se uvedou obě', () => {
    const out = popisHttpChybyBehu({ baseline: 'Server odpověděl 500.', hlavni: 'Server odpověděl 503.' });
    expect(out).toMatch(/Baseline: Server odpověděl 500\./);
    expect(out).toMatch(/Hlavní běh: Server odpověděl 503\./);
  });

  it('stačí jeden běh na chybové stránce', () => {
    // Porovnávat dva různé stavy serveru nic neměří.
    expect(popisHttpChybyBehu({ baseline: 'Server odpověděl 503.', hlavni: null }))
      .toMatch(/Baseline běh: Server odpověděl 503\./);
    expect(popisHttpChybyBehu({ baseline: null, hlavni: 'Server odpověděl 503.' }))
      .toMatch(/Hlavní běh: Server odpověděl 503\./);
  });
});
