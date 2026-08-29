import {
  firstHeaderValue,
  hasNosniff,
  framingProtected,
  referrerProtected,
} from '../header-values.js';

/**
 * Všechny případy níž našla kontrolní vlna jako skutečné vady. Blok, který
 * je obsahoval, žil uvnitř `analyzeNis2` v `agent.js` a neměl test žádný —
 * testovaly se až hodnoty ručně dosazené o dvě patra výš.
 */

describe('hlavička nastavená víckrát dorazí sloučená čárkou', () => {
  it('nosniff, nosniff je platná ochrana', () => {
    // Typicky když hlavičku nastaví proxy i aplikace. Fetch Standard
    // posuzuje první hodnotu, takže ochrana funguje. Porovnání celého
    // řetězce z toho dělalo nález na webu, který je v pořádku.
    expect(hasNosniff('nosniff, nosniff')).toBe(true);
    expect(hasNosniff('nosniff')).toBe(true);
    expect(hasNosniff('NOSNIFF')).toBe(true);
    expect(hasNosniff(' nosniff , cokoliv')).toBe(true);
  });

  it('jiná hodnota ochranu nedává', () => {
    expect(hasNosniff('sniff')).toBe(false);
    expect(hasNosniff('')).toBe(false);
    expect(hasNosniff(undefined)).toBe(false);
  });

  it('firstHeaderValue vrací první hodnotu malými písmeny', () => {
    expect(firstHeaderValue(' DENY , SAMEORIGIN')).toBe('deny');
  });
});

describe('frame-ancestors musí někoho zakazovat', () => {
  it('hvězdička není ochrana', () => {
    // Dřív se hledal jen výskyt názvu direktivy, takže web bez jakékoli
    // obrany proti clickjackingu dostal „splněno".
    expect(framingProtected("frame-ancestors *")).toBe(false);
    expect(framingProtected("default-src 'self'; frame-ancestors *; img-src *")).toBe(false);
  });

  it('schéma bez hostitele není ochrana', () => {
    expect(framingProtected('frame-ancestors https:')).toBe(false);
    expect(framingProtected('frame-ancestors http: https:')).toBe(false);
  });

  it("'none' a 'self' ochranou jsou", () => {
    expect(framingProtected("frame-ancestors 'none'")).toBe(true);
    expect(framingProtected("frame-ancestors 'self'")).toBe(true);
    expect(framingProtected("default-src 'self'; frame-ancestors 'self' https://partner.cz")).toBe(true);
  });

  it('chybějící nebo prázdná direktiva ochranou není', () => {
    expect(framingProtected("default-src 'self'")).toBe(false);
    expect(framingProtected('frame-ancestors')).toBe(false);
    expect(framingProtected(undefined)).toBe(false);
  });
});

describe('Referrer-Policy: platí poslední hodnota, které prohlížeč rozumí', () => {
  it('fallback seznam se čte odzadu', () => {
    // Seznamy se píšou právě proto, aby starší prohlížeč vzal první
    // hodnotu a novější tu poslední. Podřetězcové hledání z toho dělalo
    // nález, přestože prohlížeč použije tu bezpečnou.
    expect(referrerProtected('unsafe-url, strict-origin-when-cross-origin')).toBe(true);
    expect(referrerProtected('no-referrer, unsafe-url')).toBe(false);
  });

  it('no-referrer-when-downgrade ochranou není', () => {
    // Posílá celou adresu včetně cesty na cizí weby přes HTTPS. Dřív
    // procházelo, protože obsahuje podřetězec „no-referrer" — a to i přes
    // komentář v kódu, který ho jmenoval jako nedostatečné.
    expect(referrerProtected('no-referrer-when-downgrade')).toBe(false);
  });

  it('chránící hodnoty projdou', () => {
    for (const v of [
      'no-referrer', 'same-origin', 'strict-origin',
      'origin-when-cross-origin', 'strict-origin-when-cross-origin',
    ]) {
      expect(referrerProtected(v)).toBe(true);
    }
  });

  it('unsafe-url a origin ochranou nejsou', () => {
    expect(referrerProtected('unsafe-url')).toBe(false);
    expect(referrerProtected('origin')).toBe(false);
  });

  it('neznámá hodnota se nepočítá za ochranu', () => {
    // Prohlížeč sáhne po výchozím chování, takže hlavička nedělá to,
    // co provozovatel zamýšlel.
    expect(referrerProtected('nesmysl')).toBe(false);
    expect(referrerProtected('')).toBe(false);
  });
});
