import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../paths.js';

/**
 * Firestore pravidla jako druhá cesta k datům.
 *
 * Backend jede přes Admin SDK, který pravidla obchází — snadno se proto na ně
 * zapomene. Jenže apiKey webového klienta je veřejný a registrace ve Firebase
 * otevřená, takže cokoli, co pravidla dovolí, dovolí komukoli na internetu,
 * i mimo allowlist e-mailů.
 *
 * Tenhle test čte pravidla jako text. Nespustí emulátor, takže neověří
 * chování — ověří ZÁMĚR, a ten je to, co se při úpravách ztrácí.
 */
const rules = fs.readFileSync(path.join(PROJECT_ROOT, 'firestore.rules'), 'utf8');

/** Tělo bloku `match /kolekce/{...}`. */
const blockFor = (collection) => {
  const start = rules.indexOf(`match /${collection}/{`);
  if (start === -1) return null;
  // Otevírací závorka bloku je POSLEDNÍ na řádku s `match` — `{id}` v cestě
  // je dřív, takže hledat zleva by našlo tu špatnou.
  const lineEnd = rules.indexOf('\n', start);
  const open = rules.lastIndexOf('{', lineEnd);
  let depth = 0;
  for (let i = open; i < rules.length; i += 1) {
    if (rules[i] === '{') depth += 1;
    if (rules[i] === '}') {
      depth -= 1;
      if (depth === 0) return rules.slice(open, i + 1);
    }
  }
  return null;
};

describe('Firestore pravidla', () => {
  for (const collection of ['sessions', 'monitors', 'projects']) {
    test(`${collection} nejsou přístupné přímo z klienta`, () => {
      // REGRESE: pravidla dovolovala zápis komukoli, kdo si do dokumentu
      // napsal vlastní uid. Tím se obcházel allowlist i kontrola cíle proti
      // SSRF: útočník si zapsal monitor mířící na 169.254.169.254, plánovač
      // ho spustil a screenshot si vyzvedl přes artifactToken, který si do
      // téhož dokumentu vložil.
      const block = blockFor(collection);
      expect(block).not.toBeNull();
      expect(block).toMatch(/allow read, write:\s*if false;/);
      expect(block).not.toMatch(/request\.auth\.uid/);
    });
  }

  test('uživatelský profil má omezený tvar', () => {
    // Bez omezení je profil volné úložiště v produkčním Firestore pro
    // kohokoli, kdo si založí účet — byť mimo allowlist.
    const block = blockFor('users');
    // Tvar hlídá pojmenovaná funkce, aby šla použít u create i update.
    expect(block).toMatch(/profileShapeOk\(\)/);
    expect(rules).toMatch(/function profileShapeOk\(\)[\s\S]*hasOnly/);
  });

  test('na konci stojí default deny', () => {
    const tail = rules.slice(rules.indexOf('match /{document=**}'));
    expect(tail).toMatch(/allow read, write:\s*if false;/);
  });
});
