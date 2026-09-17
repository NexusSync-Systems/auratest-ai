import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { fingerprintScript } from '../sbom-fingerprint.js';

/**
 * Otisk knihoven proti SKUTEČNÝM bundlům.
 *
 * Tohle je specifikace. Ručně psané řetězce v `sbom-fingerprint.test.js`
 * popisují záměr jednotlivých vzorů; tenhle soubor říká, co nástroj
 * doopravdy udělá se souborem, který mu přijde z webu.
 *
 * Vznikl proto, že předchozí oprava falešných položek (64005ab, revert
 * 38ef9f6) prošla 67 zelenými testy a na reálném vstupu nefungovala ani
 * jednou. Vzory `preactAttr` a `VERSION` v preactu neexistují; `timeFormat`
 * je naopak v d3-scale přítomný, takže rozlišovací důkaz misfiroval na tom
 * souboru, kvůli kterému vznikl.
 *
 * KAŽDÁ položka v soupisu je tvrzení „tenhle balíček tu je" a odvozuje se
 * z ní dotaz do OSV. Falešná položka proto nevyrobí jen chybný řádek, ale
 * i nález o zranitelnosti balíčku, který zákazník nepoužívá.
 */

// `import.meta` pod babel-jest není k dispozici, proto cesta od kořene
// projektu. `process.cwd()` je při běhu jestu vždy kořen repozitáře.
const VZORKY = path.join(process.cwd(), 'tests', 'fixtures', 'sbom');

function nactiVzorek(nazev) {
  const soubor = path.join(VZORKY, `${nazev}.gz`);
  if (!fs.existsSync(soubor)) {
    throw new Error(
      `Vzorek ${nazev} chybí. Vyrob ho: node scripts/build-sbom-fixtures.mjs`
    );
  }
  return gunzipSync(fs.readFileSync(soubor)).toString('utf8');
}

const balicky = (nazev) =>
  [...new Set(fingerprintScript(nactiVzorek(nazev)).map((f) => f.npm))].sort();

/**
 * Očekávaný výsledek pro každý vzorek.
 *
 * `musi` — balíčky, které v soupisu BÝT MUSÍ (jsou v bundlu doopravdy).
 * `nesmi` — balíčky, které tam BÝT NESMÍ (v bundlu nejsou).
 *
 * Nezmíněný balíček se neposuzuje: detekce je zvenčí a neúplná, takže
 * „nenašli jsme X" je přiznaná mez, ne chyba. Vyžadovat úplnost by
 * znamenalo tvrdit, že soupis z prohlížeče je kompletní kusovník — a to
 * `auditCRA_SBOM` ve svém `scope` výslovně popírá.
 */
const OCEKAVANE = {
  // ── Preact vs. React ──────────────────────────────────────────────────
  'app-preact.min.js': {
    musi: ['preact'],
    nesmi: ['react'],
    proc: 'Aplikace na Preactu. Řetězec „preact" v produkčním bundlu nepřežije, '
      + 'takže detekce musí stát na jiném důkazu.',
  },
  'app-preact-compat.min.js': {
    musi: ['preact'],
    nesmi: ['react'],
    proc: 'OVĚŘENÁ VADA: `preact/compat` sdílí s Reactem symbol `react.element`, '
      + 'protože jeho účelem je být náhradou Reactu. Web na Preactu tak dostal '
      + 'do soupisu „React" a audit se ptal na CVE balíčku, který tam není.',
  },
  'preact.min.js': {
    musi: ['preact'],
    nesmi: ['react'],
    proc: 'Distribuce preactu z CDN.',
  },
  'app-react.min.js': {
    musi: ['react', 'react-dom'],
    nesmi: ['preact'],
    proc: 'Kontrolní vzorek. Zúžení nesmí umlčet pravdivý nález — umlčet '
      + 'pravdu váží stejně jako vyrobit lež.',
  },
  'app-react-signals.min.js': {
    musi: ['react', 'react-dom'],
    nesmi: ['preact'],
    proc: 'OVĚŘENÁ VADA druhého pokusu: `@preact/signals-react` je knihovna '
      + 'PRO React a nese řetězec „preact-signals". Vylučovací vzor `\\bpreact\\b` '
      + 'na něj sedl, React ze soupisu zmizel a přibyl Preact, který tam není — '
      + 'obě chyby naráz.',
  },
  'dist-react.production.js': {
    musi: ['react'],
    nesmi: ['preact'],
    proc: 'Distribuce Reactu.',
  },

  // ── d3 vs. d3-scale ───────────────────────────────────────────────────
  'd3-scale.min.js': {
    musi: ['d3-scale'],
    nesmi: ['d3'],
    proc: 'OVĚŘENÁ VADA: distribuce `d3-scale` se hlásila jako `d3` — jiný '
      + 'balíček s jinou historií zranitelností. Pozor: tenhle soubor OBSAHUJE '
      + '`timeFormat` (d3-scale závisí na d3-time-format a volá ho ve scaleTime), '
      + 'takže `timeFormat` nesmí sloužit jako důkaz „tohle je kompletní d3". '
      + 'Přesně na tomhle ztroskotal druhý pokus o opravu.',
  },
  'app-d3scale.min.js': {
    musi: ['d3-scale'],
    nesmi: ['d3'],
    proc: 'Aplikace, která bundluje jen modul d3-scale.',
  },
  'dist-d3.min.js': {
    musi: ['d3'],
    nesmi: [],
    proc: 'Kompletní balík d3. Modul d3-scale je jeho součástí, takže objeví-li '
      + 'se v soupisu i ten, je to pravda — obojí tam doopravdy je.',
  },
  'app-d3full.min.js': {
    musi: ['d3'],
    nesmi: [],
    proc: 'Aplikace s kompletním d3.',
  },

  // ── Kontrolní vzorky: zúžení nesmí rozbít, co fungovalo ───────────────
  'dist-jquery.min.js': { musi: ['jquery'], nesmi: [], proc: 'Kontrolní vzorek.' },
  'dist-lodash.min.js': { musi: ['lodash'], nesmi: [], proc: 'Kontrolní vzorek.' },
  'dist-vue.global.prod.js': { musi: ['vue'], nesmi: [], proc: 'Kontrolní vzorek.' },
  'dist-axios.min.js': { musi: ['axios'], nesmi: [], proc: 'Kontrolní vzorek.' },
  'dist-react-dom.production.js': {
    musi: ['react-dom'],
    nesmi: ['preact'],
    proc: 'Kontrolní vzorek.',
  },
};

describe('otisk knihoven proti skutečným bundlům', () => {
  it('všechny vzorky jsou v repozitáři', () => {
    for (const nazev of Object.keys(OCEKAVANE)) {
      expect(() => nactiVzorek(nazev)).not.toThrow();
    }
  });

  describe.each(Object.entries(OCEKAVANE))('%s', (nazev, { musi, nesmi, proc }) => {
    it(`obsahuje: ${musi.join(', ') || '(nic povinného)'} — ${proc}`, () => {
      const nalezeno = balicky(nazev);
      for (const balik of musi) {
        expect(nalezeno).toContain(balik);
      }
    });

    if (nesmi.length > 0) {
      it(`NEOBSAHUJE: ${nesmi.join(', ')}`, () => {
        const nalezeno = balicky(nazev);
        for (const balik of nesmi) {
          expect(nalezeno).not.toContain(balik);
        }
      });
    }
  });
});

describe('verze se nesmí připsat cizímu balíčku', () => {
  it('jQuery si verzi ze své distribuce přečte', () => {
    const jq = fingerprintScript(nactiVzorek('dist-jquery.min.js'))
      .find((f) => f.npm === 'jquery');
    expect(jq.version).toBe('3.7.1');
  });

  it('d3-scale nedostane verzi kompletního balíku', () => {
    // d3-scale je na 4.x. Dotaz do OSV na d3-scale@7.9.0 by se ptal na
    // něco, co nikdy neexistovalo.
    for (const vzorek of ['d3-scale.min.js', 'app-d3scale.min.js']) {
      const scale = fingerprintScript(nactiVzorek(vzorek)).find((f) => f.npm === 'd3-scale');
      expect(scale?.version ?? null).not.toBe('7.9.0');
    }
  });

  it('nalezená verze je vždy použitelné trojčíslí, nebo žádná', () => {
    // `presence-only` je poctivý stav: knihovna tu je, verzi neznáme.
    // Poloviční verze („3.", „detekováno") by se poslala do OSV a vrátila
    // nesmyslnou odpověď.
    for (const nazev of Object.keys(OCEKAVANE)) {
      for (const f of fingerprintScript(nactiVzorek(nazev))) {
        if (f.version === null) {
          expect(f.confidence).toBe('presence-only');
          continue;
        }
        expect(f.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(f.confidence).toBe('version-detected');
      }
    }
  });
});
