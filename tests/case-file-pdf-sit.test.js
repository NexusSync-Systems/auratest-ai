import { zakazSit } from '../case-file-pdf.js';

/**
 * Tisk spisu byl JEDINÝ kontext prohlížeče v celém nástroji bez hlídače.
 *
 * Dnes ho drží escapování v `case-file.js`. To ale znamená, že bezpečnost
 * exportu závisí na jedné funkci a jedné chybě v ní — a do spisu se
 * dostávají adresy auditovaných webů, tedy vstup od zákazníka.
 *
 * Playwright se v tomhle prostředí nespustí (chybí `libXdamage.so.1`),
 * takže se testuje hlídač samotný proti napodobenině `route`. To je
 * poctivé jen do té míry, do jaké napodobenina odpovídá skutečnosti:
 * `route.continue()` a `route.abort()` jsou obojí async a obojí vrací
 * `Promise<void>` — nic víc handler nepoužívá.
 */
function fakePage() {
  let handler = null;
  return {
    route: async (_vzor, fn) => { handler = fn; },
    /** Prožene adresu hlídačem a vrátí, co s ní udělal. */
    async pozadavek(url) {
      const stopa = [];
      await handler(
        {
          continue: async () => stopa.push('continue'),
          abort: async () => stopa.push('abort'),
        },
        { url: () => url }
      );
      return stopa;
    },
  };
}

describe('hlídač sítě při tisku spisu', () => {
  test('adresa ven se zablokuje a ohlásí', async () => {
    const page = fakePage();
    const blokovane = [];
    await zakazSit(page, (u) => blokovane.push(u));

    // Metadata cloudu — přesně to, kvůli čemu hlídač existuje.
    expect(await page.pozadavek('http://169.254.169.254/latest/meta-data/'))
      .toEqual(['abort']);
    expect(await page.pozadavek('https://evil.example/pixel.png'))
      .toEqual(['abort']);
    expect(blokovane).toHaveLength(2);
  });

  test('vložená data a prázdný rámec projdou', async () => {
    const page = fakePage();
    await zakazSit(page);
    expect(await page.pozadavek('data:image/png;base64,iVBORw0KGgo='))
      .toEqual(['continue']);
    expect(await page.pozadavek('about:blank')).toEqual(['continue']);
  });

  test('selhání hlídače nesmí položit export', async () => {
    const page = fakePage();
    // Callback, který vyhodí. Handler je async — neodchycená výjimka by
    // skončila jako unhandled rejection a Node by proces shodil. Přesně
    // to se u skenerů jednou stalo naostro.
    await zakazSit(page, () => { throw new Error('rozbité hlášení'); });
    await expect(page.pozadavek('https://evil.example/')).resolves.toEqual(['abort']);
  });

  test('stránka bez route() hlídač nezapne, ale nespadne', async () => {
    await expect(zakazSit({}, null)).resolves.toBeUndefined();
  });
});
