/**
 * Chybová stránka není měřená aplikace.
 *
 * PROČ TENHLE SOUBOR VZNIKL
 * Vlna hledající vzorec „všude kromě jednoho místa" našla, že podmínku
 * na stav odpovědi mají jen některé skenery. Dva ji neměly vůbec
 * a jeden jen napůl:
 *
 *   • cookie skener chytal jen VÝJIMKU z navigace. `page.goto()` na 503
 *     ale nevyhazuje — a na chybové stránce nejsou trackery, takže
 *     `isCompliant` vyšlo `true` a do neměnného záznamu se zapsalo
 *     „BEZ NÁLEZU: před udělením souhlasu nebyly nalezeny trackery".
 *   • NIS2 skener neposuzoval stav vůbec a jako jediný z osmi nevracel
 *     `navigationError`. Hlavičky blokovací stránky se vyhodnotily jako
 *     hlavičky zákazníka — a dvanáct pravidel z toho udělalo PROKÁZANÁ
 *     porušení, ne neprůkazné výsledky.
 *
 * Komentář v `agent.js` přitom tvrdil, že „skener přístupnosti i cookie
 * skener tohle mají od úkolu #91". U cookie skeneru to nebyla pravda —
 * a to je důvod, proč se sem testuje SPOLEČNÁ funkce: kopírovaná
 * podmínka se vždycky někde zapomene, funkce se buď zavolá, nebo je to
 * vidět v diffu.
 */
import { navigujAOver, popisHttpChyby } from '../http-status.js';
import { verdictsForAudit, AUDIT_RULE_SCOPE } from '../audit-scope.js';

/** Napodobenina `page`, která se chová jako Playwright. */
const page = (chovani) => ({
  goto: async () => {
    if (chovani.vyhodi) throw new Error(chovani.vyhodi);
    if (chovani.zadnaOdpoved) return null;
    return {
      ok: () => chovani.status >= 200 && chovani.status < 300,
      status: () => chovani.status,
    };
  },
});

describe('navigujAOver', () => {
  test('úspěšná navigace nemá chybu', async () => {
    const v = await navigujAOver(page({ status: 200 }), 'https://a.example/');
    expect(v.navigationError).toBeNull();
    expect(v.response).not.toBeNull();
  });

  /**
   * JÁDRO NÁLEZU.
   *
   * `page.goto()` na server vracející 503 NEVYHAZUJE — odpověď přišla,
   * jen je chybová. Kdo chytá jen výjimku, dostane `navigationError: null`
   * a měří chybovou stránku jako by to byl auditovaný web.
   */
  test.each([503, 403, 404, 500, 429])('stav %s je chyba, i když goto nevyhodilo', async (status) => {
    const v = await navigujAOver(page({ status }), 'https://a.example/');
    expect(v.navigationError).toBe(`Server odpověděl ${status}.`);
  });

  test('přesměrování 3xx je taky chyba — obsah není to, co jsme chtěli', async () => {
    const v = await navigujAOver(page({ status: 302 }), 'https://a.example/');
    expect(v.navigationError).toMatch(/302/);
  });

  test('výjimka z navigace má přednost — je konkrétnější', async () => {
    const v = await navigujAOver(page({ vyhodi: 'net::ERR_NAME_NOT_RESOLVED' }), 'https://a.example/');
    expect(v.navigationError).toBe('net::ERR_NAME_NOT_RESOLVED');
    expect(v.navigationError).not.toMatch(/Server neodpověděl/);
  });

  test('chybějící odpověď se nevydává za úspěch', async () => {
    const v = await navigujAOver(page({ zadnaOdpoved: true }), 'https://a.example/');
    expect(v.navigationError).toBe('Server neodpověděl.');
  });

  test('odpověď z uzavřeného kontextu je „nevím", ne „v pořádku"', () => {
    const rozbita = { ok: () => { throw new Error('Target closed'); }, status: () => 0 };
    expect(popisHttpChyby(rozbita)).toMatch(/nepodařilo přečíst/);
  });
});

describe('NIS2: neprůkazné měření nevyrobí dvanáct verdiktů', () => {
  /**
   * Bez pojistky v `audit-scope.js` by se `nis2: { hsts: null, … }`
   * protáhlo do dvanácti řádků, které vypadají jako výsledek kontroly.
   * `null` u každého je sice pravdivé, ale bez důvodu — čtenář nepozná,
   * že se neměřilo nic.
   */
  const rows = verdictsForAudit('analyze-nis2', {
    navigationError: 'Server odpověděl 403.',
    nis2: { isCompliant: null },
  });

  test('řádků je pořád dvanáct — rozsah se nezmenšuje', () => {
    expect(rows).toHaveLength(AUDIT_RULE_SCOPE['analyze-nis2'].length);
  });

  test('žádný z nich není true ani false', () => {
    expect(rows.every((r) => r.ok === null)).toBe(true);
  });

  test('u každého stojí, PROČ je neprůkazný', () => {
    expect(rows.every((r) => /Měření neproběhlo: Server odpověděl 403/.test(r.rationale)))
      .toBe(true);
    // „Nenašli jsme hlavičku" a „nepodařilo se otevřít stránku" nejsou totéž.
    expect(rows.every((r) => /neplyne splnění ani porušení/.test(r.rationale))).toBe(true);
  });

  test('na úspěšném měření se pojistka neuplatní', () => {
    const ok = verdictsForAudit('analyze-nis2', {
      nis2: { isCompliant: true, hsts: true, csp: true, missingHeaders: [], weakHeaders: [] },
      tls: {},
    });
    expect(ok.some((r) => r.ok !== null)).toBe(true);
  });
});

describe('AI Act: důvod neprůkaznosti sedí na to, co se stalo', () => {
  /**
   * Verdikty u čl. 50 vycházejí neprůkazně tak jako tak, takže falešné
   * „splněno" tu nehrozilo. Vadné bylo ODŮVODNĚNÍ: „povinnost nelze
   * externím skenem posoudit" je tvrzení o mezích nástroje, ne o tom, že
   * server vrátil 503. Skener `navigationError` dřív nevracel vůbec —
   * byl poslední z osmi, kde kontrola statusu chyběla.
   */
  const obligations = [
    { id: 'art50.1', title: 'Informování uživatele', status: 'inconclusive',
      rationale: 'Na stránce nebyl nalezen chat ani jiné rozhraní AI.' },
    { id: 'art50.2', title: 'Označení syntetického obsahu', status: 'inconclusive',
      rationale: 'Žádný obrázek se nedeklaroval jako AI.' },
  ];

  test('při chybě navigace se vypíše skutečný důvod', () => {
    const rows = verdictsForAudit('ai-act-audit', {
      navigationError: 'Server odpověděl 503.',
      aiAct: { obligations },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ok === null)).toBe(true);
    expect(rows.every((r) => /Měření neproběhlo: Server odpověděl 503/.test(r.rationale)))
      .toBe(true);
    // Původní odůvodnění by tvrdilo, že jsme se dívali a nic nenašli.
    expect(rows.some((r) => /nebyl nalezen chat/.test(r.rationale))).toBe(false);
  });

  test('bez chyby navigace zůstane původní odůvodnění', () => {
    const rows = verdictsForAudit('ai-act-audit', { aiAct: { obligations } });
    expect(rows[0].rationale).toMatch(/nebyl nalezen chat/);
  });
});

describe('CRA: chyba serveru je slepé místo i u neprázdného SBOM', () => {
  /**
   * `ev.httpError` se dřív četl JEN ve větvi s prázdným SBOM. Chybová
   * stránka za CDN ale často načte vlastní skripty (challenge, jQuery),
   * takže `libraries.length > 0` a šlo se do hlavní větve — a tam o chybě
   * serveru nikdo nevěděl. Výsledek mohl znít „PASS: všech N knihoven
   * bez známých CVE" o stránce, která vrátila 403.
   *
   * Testuje se přes `verdictsForAudit`, protože vlastní sestavení verdiktu
   * v `agent.js` potřebuje prohlížeč.
   */
  test('httpError se dostane do odůvodnění, ne jen do prázdné větve', () => {
    const rows = verdictsForAudit('analyze-cra', {
      sbom: [{ name: 'jQuery', version: '3.6.0' }],
      evidence: { httpError: 'Server odpověděl 403.', scriptsCaptured: 2, scriptsScanned: 2 },
    });
    const text = rows.map((r) => r.rationale).join(' ');
    expect(text).toMatch(/403/);
  });
});
