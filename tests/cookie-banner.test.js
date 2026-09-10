/**
 * @jest-environment jsdom
 *
 * Rozpoznání cookie lišty se rozhoduje nad DOM, takže se musí nad DOM
 * i testovat. Zbytek testů v souboru je čistě textový a jsdom mu nevadí.
 */
import {
  normalizuj,
  klasifikujTlacitko,
  vyberTlacitko,
  jeVListe,
  sesbirejKandidatyZDokumentu,
  popisOdkliknuti,
  popisPredSouhlasem,
} from '../cookie-banner.js';

/**
 * Odkliknutí cookie lišty.
 *
 * Dvě rizika, obě vážná:
 *   • zmáčknout „Přijmout vše" a natáhnout si do běhu marketingové
 *     skripty, které pak agent hlásí jako vlastní nálezy,
 *   • zmáčknout mimo lištu a provést za uživatele akci, o kterou
 *     nikdo nežádal.
 * Testy jsou psané hlavně proti nim.
 */

describe('normalizace textu', () => {
  test('diakritika a velikost písmen nerozhodují', () => {
    expect(normalizuj('  Pouze   NEZBYTNÉ  ')).toBe('pouze nezbytne');
    expect(normalizuj('Odmítnout Vše')).toBe('odmitnout vse');
  });

  test('null a undefined jsou prázdný řetězec', () => {
    expect(normalizuj(null)).toBe('');
    expect(normalizuj(undefined)).toBe('');
  });
});

describe('klasifikace tlačítka', () => {
  const odmitnuti = [
    'Pouze nezbytné', 'Jen nezbytné cookies', 'Odmítnout vše',
    'Odmítnout cookies', 'Nesouhlasím', 'Zamítnout vše', 'Pouze základní',
    'Reject all', 'Decline all', 'Only necessary', 'Necessary only',
    'Strictly necessary cookies', 'Alle ablehnen', 'Nur notwendige',
  ];
  for (const text of odmitnuti) {
    test(`„${text}" je odmítnutí`, () => {
      expect(klasifikujTlacitko(text).druh).toBe('nezbytne');
    });
  }

  const souhlas = [
    'Přijmout vše', 'Souhlasím', 'Rozumím', 'Povolit vše',
    'Accept all', 'Allow all', 'Got it', 'Alle akzeptieren',
  ];
  for (const text of souhlas) {
    test(`„${text}" je souhlas, a tedy se nemačká`, () => {
      expect(klasifikujTlacitko(text).druh).toBe('prijmout');
    });
  }

  test('„Nesouhlasím" nesmí spadnout pod „souhlasím"', () => {
    // Podřetězec „souhlasim" je v „nesouhlasim" obsažený. Bez pravidla
    // nejdelší shody by tlačítko odmítnutí prošlo jako souhlas — a to
    // je přesně opačný úkon, než jaký má nástroj provést.
    expect(klasifikujTlacitko('Nesouhlasím').druh).toBe('nezbytne');
  });

  test('„Přijmout pouze nezbytné" je odmítnutí, ne souhlas', () => {
    // Obsahuje obojí. Konkrétnější vzor („pouze nezbytne") rozhoduje
    // a je to i věcně správně — nad rámec nezbytných to nic neschvaluje.
    expect(klasifikujTlacitko('Přijmout pouze nezbytné').druh).toBe('nezbytne');
  });

  test('nastavení se pozná, ale nemačká', () => {
    expect(klasifikujTlacitko('Nastavení cookies').druh).toBe('nastaveni');
    expect(klasifikujTlacitko('Manage preferences').druh).toBe('nastaveni');
  });

  test('neznámý text se neklasifikuje', () => {
    expect(klasifikujTlacitko('Do košíku')).toBeNull();
    expect(klasifikujTlacitko('')).toBeNull();
    expect(klasifikujTlacitko(null)).toBeNull();
  });

  test('odstavec textu není tlačítko lišty', () => {
    // Kdyby se do výběru dostal prvek s celým poučením o cookies,
    // obsahuje „odmítnout" i „přijmout" a klasifikace by byla loterie.
    const dlouhy = 'Odmítnout můžete kdykoli. '.repeat(10);
    expect(klasifikujTlacitko(dlouhy)).toBeNull();
  });
});

describe('výběr tlačítka ke zmáčknutí', () => {
  test('z lišty se dvěma tlačítky se zmáčkne odmítnutí', () => {
    const volba = vyberTlacitko([
      { idx: 0, text: 'Přijmout vše', vListe: true },
      { idx: 1, text: 'Pouze nezbytné', vListe: true },
    ]);
    expect(volba.idx).toBe(1);
  });

  test('mimo lištu se nemačká NIC', () => {
    // „Odmítnout" se na e-shopu vyskytne i u zrušení objednávky.
    // Zmáčknout ho by znamenalo provést za uživatele akci, o kterou
    // nikdo nežádal — a u nástroje, který má jen měřit, je to
    // nepřijatelné bez ohledu na následek.
    const volba = vyberTlacitko([
      { idx: 0, text: 'Odmítnout vše', vListe: false },
    ]);
    expect(volba).toBeNull();
  });

  test('lišta jen se souhlasem nechá nezmáčknuto', () => {
    // Když je odmítnutí schované pod „Nastavením", klikat naslepo by
    // znamenalo udělit souhlas. Volba souhlasu není na nástroji.
    const volba = vyberTlacitko([
      { idx: 0, text: 'Přijmout vše', vListe: true },
      { idx: 1, text: 'Nastavení', vListe: true },
    ]);
    expect(volba).toBeNull();
  });

  test('při více odmítnutích vyhraje konkrétnější', () => {
    const volba = vyberTlacitko([
      { idx: 0, text: 'Odmítnout', vListe: true },
      { idx: 1, text: 'Odmítnout vše', vListe: true },
    ]);
    expect(volba.idx).toBe(1);
  });

  test('prázdný seznam nic nevybere', () => {
    expect(vyberTlacitko([])).toBeNull();
  });
});

describe('popis do záznamu běhu', () => {
  test('„nenalezena" a „nerozpoznána" jsou dvě různá zjištění', () => {
    // Slít je v jedno by znamenalo, že z dokumentu nejde poznat, jestli
    // web lištu nemá, nebo jestli ji nástroj neuměl přečíst.
    const nenalezena = popisOdkliknuti({ reason: 'lista-nenalezena' });
    const bezOdmitnuti = popisOdkliknuti({ reason: 'lista-nalezena-bez-odmitnuti' });
    expect(nenalezena).not.toBe(bezOdmitnuti);
    expect(nenalezena).toMatch(/nenalezena/);
    expect(bezOdmitnuti).toMatch(/bez tlačítka odmítnutí/);
  });

  test('zmáčknutí uvádí, CO se zmáčklo a že to bylo až po měření', () => {
    const v = popisOdkliknuti({ reason: 'odmitnuto', label: 'Pouze nezbytné' });
    expect(v).toMatch(/Pouze nezbytné/);
    expect(v).toMatch(/po zaznamenání stavu před souhlasem/);
  });

  test('selhání se přizná a upozorní na následek', () => {
    const v = popisOdkliknuti({ reason: 'klik-selhal: timeout', label: 'x' });
    expect(v).toMatch(/nepodařilo/);
    expect(v).toMatch(/pod překryvem/);
  });
});

/**
 * Rozpoznání lišty nad skutečným DOM.
 *
 * Předchozí verze testů předávala `vListe` jako VSTUP, takže rozhodnutí,
 * které nese celé riziko chybného kliknutí, netestovala vůbec. Kontrolní
 * vlna na tom postavila dva P0: agent běží PŘIHLÁŠENÝ v zákazníkově
 * aplikaci a nástroj by mu tam zmáčkl „Odmítnout" u nabídky nebo
 * „Zamítnout žádost" ve schvalovacím workflow.
 */
const dom = (html, styly = {}) => {
  document.body.innerHTML = html;
  // jsdom `position` z tříd nedopočítá, takže se předává mapa
  // selektor → position.
  const getStyle = (el) => {
    for (const [sel, position] of Object.entries(styly)) {
      if (el.matches?.(sel)) return { position };
    }
    return { position: 'static' };
  };
  return { getStyle };
};

const kandidati = (html, styly) => {
  const { getStyle } = dom(html, styly);
  return sesbirejKandidatyZDokumentu(document, { getStyle });
};

describe('co lištou NENÍ — nástroj tam nesmí sáhnout', () => {
  test('panel sledování zásilky s tlačítkem Odmítnout', () => {
    const k = kandidati(`
      <div class="objednavka">
        <h3>Sledování zásilky</h3>
        <p>Nabídka dopravce čeká na potvrzení.</p>
        <button>Přijmout</button>
        <button>Odmítnout</button>
      </div>`);
    expect(k.every((x) => !x.vListe)).toBe(true);
    expect(vyberTlacitko(k)).toBeNull();
  });

  test('schvalovací karta se slovem „souhlas"', () => {
    const k = kandidati(`
      <section class="pozadavek">
        <p>Souhlas nadřízeného: čeká</p>
        <button>Zamítnout žádost</button>
      </section>`);
    expect(vyberTlacitko(k)).toBeNull();
  });

  test('issue panel s „Time tracking" a tlačítkem Reject', () => {
    const k = kandidati(`
      <div class="issue-panel">
        <span>Time tracking: 4h</span>
        <button>Reject</button>
      </div>`);
    expect(vyberTlacitko(k)).toBeNull();
  });

  test('mělká stránka s odkazem na zásady cookies v patičce', () => {
    // Bez druhé podmínky (překryv) by osm úrovní předků došlo k obalu
    // celé stránky a slovo „cookies" v patičce by z každého tlačítka
    // na webu udělalo kandidáta.
    const k = kandidati(`
      <div id="root">
        <main><button>Odmítnout vše</button></main>
        <footer><a href="/cookies">Zásady cookies</a></footer>
      </div>`);
    expect(vyberTlacitko(k)).toBeNull();
  });

  test('slovo „consent" v inline skriptu lištu nedělá', () => {
    // `textContent` by vytáhl i obsah <script>; `dataLayer` se slovem
    // „consent" má dnes skoro každá stránka.
    const k = kandidati(`
      <div class="app">
        <script>window.dataLayer=[{"consent":"granted"}]</script>
        <button>Odmítnout vše</button>
      </div>`);
    expect(vyberTlacitko(k)).toBeNull();
  });
});

describe('co lištou JE', () => {
  test('překryv s position: fixed a textem o cookies', () => {
    const k = kandidati(`
      <div class="lista">
        <p>Tento web používá cookies.</p>
        <button>Přijmout vše</button>
        <button>Pouze nezbytné</button>
      </div>`, { '.lista': 'fixed' });
    const volba = vyberTlacitko(k);
    expect(volba).not.toBeNull();
    expect(volba.text).toMatch(/Pouze nezbytné/);
  });

  test('dialog s aria-modal', () => {
    const k = kandidati(`
      <div role="dialog" aria-modal="true">
        <p>Nastavení cookies</p>
        <button>Odmítnout vše</button>
      </div>`);
    expect(vyberTlacitko(k)).not.toBeNull();
  });

  test('kontejner známého CMP podle názvu třídy', () => {
    const k = kandidati(`
      <div id="onetrust-banner-sdk">
        <p>We use cookies</p>
        <button>Reject all</button>
      </div>`);
    expect(vyberTlacitko(k)).not.toBeNull();
  });

  test('lišta jen se souhlasem zůstane nezmáčknutá', () => {
    const k = kandidati(`
      <div class="lista">
        <p>Používáme cookies.</p>
        <button>Přijmout vše</button>
        <button>Nastavení</button>
      </div>`, { '.lista': 'fixed' });
    expect(vyberTlacitko(k)).toBeNull();
  });

  test('holé „Odmítnout" na liště se taky nemačká', () => {
    // Je to sice pravděpodobně cookie lišta, ale stejný text nese
    // i tlačítko v aplikaci. Cena za omyl je nesouměrná: nezmáčknutá
    // lišta stojí pár kroků, zamítnutá žádost v produkci je nevratná.
    const k = kandidati(`
      <div class="lista">
        <p>Používáme cookies.</p>
        <button>Odmítnout</button>
      </div>`, { '.lista': 'fixed' });
    expect(vyberTlacitko(k)).toBeNull();
  });
});

describe('jeVListe přímo', () => {
  test('bez předků je odpověď ne', () => {
    dom('<button>Odmítnout vše</button>');
    expect(jeVListe(document.querySelector('button'))).toBe(false);
  });

  test('null nespadne', () => {
    expect(jeVListe(null)).toBe(false);
  });
});

describe('věty o stavu před souhlasem', () => {
  test('prázdný seznam NENÍ doklad souladu', () => {
    const v = popisPredSouhlasem({ cookies: [], storage: [] });
    expect(v.join(' ')).toMatch(/není to doklad souladu/);
  });

  test('nálezy se vypíšou jmény', () => {
    const v = popisPredSouhlasem({ cookies: ['_ga'], storage: ['_hjSession'] });
    expect(v.join(' ')).toMatch(/_ga/);
    expect(v.join(' ')).toMatch(/_hjSession/);
  });
});
