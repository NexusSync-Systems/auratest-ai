import { readFileSync } from 'fs';
import { residencyVerdict, originNote } from '../agent.js';
import { PROJECT_ROOT } from '../paths.js';

/**
 * VERDIKT O REZIDENCI A VĚTA, KTERÁ HO DOPROVÁZÍ.
 *
 * Nález z kontrolní vlny nad dnešní prací. Proměnná se jmenovala
 * `originMeasured`, ale nastavovala se jen při `jeOrigin && isEU`.
 * Pro verdikt to nevadí — doména mimo EU skončí v `nonEULocations`
 * a verdikt je `false` dřív. `originNote` ji ale čte jako „podařilo se
 * změřit doménu webu", takže u zákazníka, jehož server vyšel MIMO EU,
 * se do dokumentu pro úřad přilepilo:
 *
 *   „GDPR Rezidence [Nesplněno]: 1 z 3 posouzených serverů je mimo
 *    EU/EHP. Doménu auditovaného webu (www.firma.cz) se umístit
 *    nepodařilo, takže o rezidenci dat provozovatele tenhle sken
 *    neříká nic — posouzené domény patří jiným službám."
 *
 * Nepravda o měření, která navíc OMLOUVÁ skutečný nález. A dokument si
 * sám protiřečí: verdikt říká nesplněno, věta pod ním říká nic nevíme.
 */
const dom = (domain, isEU, isOrigin = false) => ({ domain, isEU, isOrigin });
const SNIMEK = { generatedAt: '2026-09-18T00:00:00.000Z' };

describe('věta o doméně webu', () => {
  test('změřený origin MIMO EU nedostane větu „nepodařilo se umístit"', () => {
    // Tohle je ten nález. `true` = origin změřen (bez ohledu na zemi).
    const veta = originNote(true, 'www.firma.cz', SNIMEK);
    expect(veta).not.toMatch(/nepodařilo/);
    expect(veta).not.toMatch(/neříká nic/);
  });

  test('skutečně nezměřený origin větu dostane', () => {
    const veta = originNote(false, 'www.firma.cz', SNIMEK);
    expect(veta).toMatch(/www\.firma\.cz/);
    expect(veta).toMatch(/nepodařilo/);
    expect(veta).toMatch(/neříká nic/);
  });

  test('chybějící snímek se hlásí zvlášť od nezměřeného originu', () => {
    const bezSnimku = originNote(true, 'www.firma.cz', {});
    expect(bezSnimku).toMatch(/Snímek IP rozsahů/);
    expect(bezSnimku).not.toMatch(/nepodařilo/);
  });
});

describe('verdikt o rezidenci', () => {
  test('doména mimo EU dá NESPLNĚNO, i když je origin změřený', () => {
    const mimo = [dom('www.firma.cz', false, true)];
    expect(residencyVerdict(mimo, mimo, true)).toBe(false);
  });

  test('nezměřený origin dá NEPRŮKAZNÉ, ne splněno', () => {
    // Kladný verdikt opřený o cizí evropskou doménu (widget, písmo)
    // je tvrzení o provozovateli z cizího serveru.
    const cizi = [dom('fonts.example', true)];
    expect(residencyVerdict(cizi, [], false)).toBeNull();
  });

  test('změřený origin v EU a nic mimo EU dá SPLNĚNO', () => {
    const vlastni = [dom('www.firma.cz', true, true)];
    expect(residencyVerdict(vlastni, [], true)).toBe(true);
  });

  test('bez jediné posouzené domény je to neprůkazné', () => {
    expect(residencyVerdict([], [], true)).toBeNull();
  });
});

/**
 * HLÍDAČ NAD MÍSTEM, KDE SE TA PROMĚNNÁ NASTAVUJE.
 *
 * Testy výš volají `residencyVerdict` a `originNote` přímo, takže
 * ověřují, co ty funkce DĚLAJÍ — ne to, co se do nich předá. Cyklus,
 * který `originZmeren` nastavuje, běží uvnitř `auditGreenAndResidency`
 * a rozjede se jedině se skutečným prohlížečem.
 *
 * Ověřeno mutací: vrácení původní chyby (`jeOrigin && isEU`) do cyklu
 * projde všemi testy výš zeleně. Vytáhnout to celé do čisté funkce by
 * znamenalo rozebrat delikátní blok rezidence; tenhle hlídač je proti
 * tomu levný a míří přesně na tu chybu, která se stala.
 *
 * Je to kontrola ZDROJE, ne chování — stejně jako `trojstav.test.js`.
 * Zaslouží si to proto, že jde o dvě větve (rozsahy poskytovatele
 * a geolokace) a stačí opravit jednu. „Opraveno všude kromě jednoho
 * místa" je v tomhle projektu nejčastější vzorec.
 */
describe('nastavení originZmeren v obou větvích', () => {
  const zdroj = readFileSync(`${PROJECT_ROOT}/agent.js`, 'utf8');

  test('obě přiřazení jsou podmíněná JEN tím, že jde o doménu webu', () => {
    const prirazeni = [...zdroj.matchAll(/^\s*if \((.+?)\) originZmeren = true;/gm)]
      .map((m) => m[1].trim());

    // Dvě větve: rozsahy poskytovatele a geolokační databáze.
    expect(prirazeni).toHaveLength(2);
    for (const podminka of prirazeni) {
      expect(podminka).toBe('jeOrigin');
      // Tohle je ta chyba: „a zároveň je v EU" z toho dělá jiný údaj,
      // než jaký `originNote` čte.
      expect(podminka).not.toMatch(/isEU/);
    }
  });

  test('stará zavádějící jména se do kódu nevrátila', () => {
    // `originMeasured` zůstává jen jako NÁZEV POLE ve výstupu (zpětná
    // kompatibilita uložených běhů), ne jako proměnná v cyklu.
    expect(zdroj).not.toMatch(/let originMeasured/);
    expect(zdroj).toMatch(/originMeasured: originZmeren/);
  });
});
