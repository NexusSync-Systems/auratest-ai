import { isEmailAllowed, accessConfig, accessWarnings } from '../access-control.js';

/**
 * Kdo smí nástroj používat.
 *
 * Skenování je za přihlášením proto, aby nešlo poslat server na libovolnou
 * adresu. Jenže registrace ve Firebase je otevřená — kdokoli si účet
 * vyrobí sám. Brána bez zámku.
 */

const env = (over) => ({ ALLOWED_EMAILS: '', ALLOWED_EMAIL_DOMAINS: '', ...over });

describe('bez omezení', () => {
  test('prázdná konfigurace pouští všechny', () => {
    // Opačná volba by při upgradu existující instalace zamkla všechny
    // uživatele naráz, včetně toho, kdo upgrade dělá.
    expect(isEmailAllowed('kdokoli@example.com', env()).allowed).toBe(true);
    expect(accessConfig(env()).restricted).toBe(false);
  });

  test('neomezená instalace se ozve při startu', () => {
    // Tichá otevřenost je horší než hlučná.
    const warnings = accessWarnings(env());
    expect(warnings.join(' ')).toMatch(/POZOR/);
    expect(warnings.join(' ')).toMatch(/ALLOWED_EMAILS/);
  });
});

describe('seznam adres', () => {
  const config = env({ ALLOWED_EMAILS: 'jan@firma.cz, eva@firma.cz' });

  test('adresa na seznamu projde', () => {
    expect(isEmailAllowed('jan@firma.cz', config).allowed).toBe(true);
  });

  test('adresa mimo seznam neprojde', () => {
    const result = isEmailAllowed('cizi@jinde.cz', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/nemá přístup/);
  });

  test('na velikosti písmen ani mezerách nezáleží', () => {
    // Firebase vrací adresu tak, jak ji uživatel napsal při registraci.
    expect(isEmailAllowed('  Jan@Firma.CZ  ', config).allowed).toBe(true);
  });
});

describe('seznam domén', () => {
  const config = env({ ALLOWED_EMAIL_DOMAINS: 'firma.cz' });

  test('kdokoli z domény projde', () => {
    expect(isEmailAllowed('novy@firma.cz', config).allowed).toBe(true);
  });

  test('cizí doména neprojde', () => {
    expect(isEmailAllowed('jan@jinde.cz', config).allowed).toBe(false);
  });

  test('podobná doména neprojde', () => {
    // `zlafirma.cz` končí na `firma.cz` — kontrola na konec řetězce by ji
    // pustila dovnitř.
    expect(isEmailAllowed('utok@zlafirma.cz', config).allowed).toBe(false);
  });

  test('subdoména neprojde, dokud není uvedená', () => {
    expect(isEmailAllowed('jan@mail.firma.cz', config).allowed).toBe(false);
  });

  test('zavináč v konfiguraci se odpustí', () => {
    const withAt = env({ ALLOWED_EMAIL_DOMAINS: '@firma.cz' });
    expect(isEmailAllowed('jan@firma.cz', withAt).allowed).toBe(true);
  });
});

describe('hraniční případy', () => {
  const config = env({ ALLOWED_EMAILS: 'jan@firma.cz' });

  test('token bez adresy při zapnutém omezení neprojde', () => {
    // Anonymní token by jinak omezení obešel.
    for (const value of [undefined, null, '']) {
      const result = isEmailAllowed(value, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/neobsahuje e-mailovou adresu/);
    }
  });

  test('token bez adresy projde, když omezení není', () => {
    expect(isEmailAllowed(null, env()).allowed).toBe(true);
  });

  test('adresa bez zavináče neprojde přes doménovou kontrolu', () => {
    const byDomain = env({ ALLOWED_EMAIL_DOMAINS: 'firma.cz' });
    expect(isEmailAllowed('firma.cz', byDomain).allowed).toBe(false);
  });

  test('oba seznamy naráz fungují jako sjednocení', () => {
    const both = env({
      ALLOWED_EMAILS: 'externista@jinde.cz',
      ALLOWED_EMAIL_DOMAINS: 'firma.cz',
    });
    expect(isEmailAllowed('kdokoli@firma.cz', both).allowed).toBe(true);
    expect(isEmailAllowed('externista@jinde.cz', both).allowed).toBe(true);
    expect(isEmailAllowed('nikdo@nikde.cz', both).allowed).toBe(false);
  });

  test('omezená instalace vypíše, na co je omezená', () => {
    const warnings = accessWarnings(env({ ALLOWED_EMAIL_DOMAINS: 'firma.cz' }));
    expect(warnings.join(' ')).toMatch(/firma\.cz/);
    expect(warnings.join(' ')).not.toMatch(/POZOR/);
  });
});
