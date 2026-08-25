import { inspectImageBytes, summarizeC2pa, SOURCE_TYPE } from '../c2pa.js';

/**
 * Čtení Content Credentials.
 *
 * Dosud se jen počítalo, kolik obrázků nese pověření. Obrázek s pověřením,
 * které se hlásí jako pořízený fotoaparátem, a obrázek hlásící se jako
 * výstup generativního modelu jsou přitom pro čl. 50 odst. 2 dvě různé věci.
 */

/**
 * Napodobenina hlavičky souboru s manifestem.
 *
 * Skutečný JUMBF kontejner obsahuje superbox `jumb` i popisný box `jumd` —
 * ty se vyskytují vždy spolu. K tomu značka C2PA.
 */
const withManifest = (extra = '') =>
  `\xFF\xD8\xFF\xE0JFIF...jumb..jumd...c2pa...${extra}...binární smetí`;

describe('rozpoznání manifestu', () => {
  test('úplný obal a značka C2PA znamenají manifest', () => {
    expect(inspectImageBytes(withManifest()).hasManifest).toBe(true);
  });

  test('jediná značka nestačí', () => {
    // Čtyřznakový řetězec se v obrazových datech může vyskytnout náhodou.
    // Falešný nález u důkazního nástroje je horší než chybějící.
    const result = inspectImageBytes('\xFF\xD8 nějaká data c2pa a nic dalšího');
    expect(result.hasManifest).toBe(false);
    expect(result.sourceType).toBe(SOURCE_TYPE.NONE);
  });

  test('jumb a jumd nejsou dva nezávislé důkazy', () => {
    // REGRESE: dřív stačily dvě libovolné značky ze společného seznamu.
    // `jumb` a `jumd` ale v každém JUMBF souboru stojí vedle sebe, takže
    // podmínku splnil i kontejner, který s C2PA nesouvisí.
    const jumbfBezC2pa = '\xFF\xD8 ...jumb..jumd... nějaká jiná metadata';
    expect(inspectImageBytes(jumbfBezC2pa).hasManifest).toBe(false);
  });

  test('text o formátu neprojde jako obrázek s manifestem', () => {
    // REGRESE: článek popisující formát obsahuje slova „jumb" i „c2pa".
    const clanek = 'Formát C2PA ukládá manifest do boxu jumb uvnitř souboru.';
    expect(inspectImageBytes(clanek).hasManifest).toBe(false);
  });

  test('obyčejný obrázek nemá manifest', () => {
    expect(inspectImageBytes('\xFF\xD8\xFF\xE0JFIF' + 'x'.repeat(500)).hasManifest).toBe(false);
  });

  test('prázdný nebo chybějící vstup nespadne', () => {
    for (const value of [null, undefined, '', new Uint8Array(0)]) {
      expect(inspectImageBytes(value).hasManifest).toBe(false);
    }
  });

  test('zvládne Uint8Array i řetězec', () => {
    const text = withManifest('trainedAlgorithmicMedia');
    const bytes = Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff));
    expect(inspectImageBytes(bytes).sourceType).toBe(SOURCE_TYPE.AI_GENERATED);
  });
});

describe('typ zdroje podle IPTC', () => {
  test('trainedAlgorithmicMedia = vytvořeno AI', () => {
    expect(inspectImageBytes(withManifest('trainedAlgorithmicMedia')).sourceType)
      .toBe(SOURCE_TYPE.AI_GENERATED);
  });

  test('compositeWithTrainedAlgorithmicMedia se nesplete s AI_GENERATED', () => {
    // Delší identifikátor obsahuje ten kratší jako podřetězec, takže na
    // pořadí zkoušení záleží.
    expect(inspectImageBytes(withManifest('compositeWithTrainedAlgorithmicMedia')).sourceType)
      .toBe(SOURCE_TYPE.AI_COMPOSITE);
  });

  test('digitalCapture = pořízeno zařízením', () => {
    expect(inspectImageBytes(withManifest('digitalCapture')).sourceType)
      .toBe(SOURCE_TYPE.CAPTURE);
  });

  test('manifest bez rozpoznaného typu zdroje je UNKNOWN, ne NONE', () => {
    // Rozdíl je podstatný: „pověření tam je, ale typ jsme nenašli"
    // není totéž co „pověření není".
    const result = inspectImageBytes(withManifest('něco jiného'));
    expect(result.hasManifest).toBe(true);
    expect(result.sourceType).toBe(SOURCE_TYPE.UNKNOWN);
  });
});

describe('souhrn přes vzorek', () => {
  const ai = { url: 'a.jpg', hasManifest: true, sourceType: SOURCE_TYPE.AI_GENERATED };
  const photo = { url: 'b.jpg', hasManifest: true, sourceType: SOURCE_TYPE.CAPTURE };
  const plain = { url: 'c.jpg', hasManifest: false, sourceType: SOURCE_TYPE.NONE };

  test('počítá zvlášť pověření a zvlášť deklarované AI', () => {
    const s = summarizeC2pa([ai, photo, plain], 10);
    expect(s).toMatchObject({ sampled: 3, withManifest: 2, declaredAi: 1, declaredCapture: 1 });
  });

  test('kompozitní obsah se počítá k AI', () => {
    const composite = { hasManifest: true, sourceType: SOURCE_TYPE.AI_COMPOSITE };
    expect(summarizeC2pa([composite], 1).declaredAi).toBe(1);
  });

  test('přiznává, kolik obrázků zůstalo neprozkoumaných', () => {
    // Vzorek osmi obrázků neříká nic o zbylých dvou stech.
    expect(summarizeC2pa([ai], 200).unsampled).toBe(199);
  });

  test('bez pověření se NEtvrdí porušení', () => {
    // Většina fotografií na světě žádné pověření nemá.
    const s = summarizeC2pa([plain, plain], 2);
    expect(s.rationale).toMatch(/neplyne porušení/);
  });

  test('u deklarovaného AI se přiznává, že podpis se neověřuje', () => {
    // Jinak by se z „hlásí se jako" stalo „je".
    expect(summarizeC2pa([ai], 1).rationale).toMatch(/[Pp]odpis.*neověřuje/);
  });

  test('prázdný vzorek to řekne', () => {
    expect(summarizeC2pa([], 5).rationale).toMatch(/[Nn]epodařilo se načíst/);
  });

  test('neznámý počet obrázků nespadne', () => {
    expect(summarizeC2pa([ai], null).unsampled).toBeNull();
  });
});

describe('nepřečtený typ zdroje (regrese kontrolní vlny)', () => {
  const unknown = { url: 'a.jpg', hasManifest: true, sourceType: SOURCE_TYPE.UNKNOWN };
  const photo = { url: 'b.jpg', hasManifest: true, sourceType: SOURCE_TYPE.CAPTURE };

  test('UNKNOWN se počítá zvlášť, ne mezi „nehlásí se jako AI"', () => {
    // Slovník IPTC je delší, než co pokrýváme, a typ může ležet za hranicí
    // načtených 64 kB. Vydávat nepřečtený typ za „není to AI" znamená
    // tvrdit výsledek měření, které neproběhlo.
    const s = summarizeC2pa([unknown, photo], 2);
    expect(s.unknownSource).toBe(1);
    expect(s.declaredCapture).toBe(1);
    expect(s.declaredAi).toBe(0);
  });

  test('všechny manifesty s nepřečteným typem → odůvodnění to přizná', () => {
    const s = summarizeC2pa([unknown], 1);
    expect(s.rationale).toMatch(/nepodařilo přečíst/);
    expect(s.rationale).not.toMatch(/žádný z přečtených/);
  });

  test('část nepřečtená → odůvodnění uvede kolik', () => {
    const s = summarizeC2pa([unknown, photo], 2);
    expect(s.rationale).toMatch(/U 1 se typ zdroje přečíst nepodařilo/);
  });

  test('odůvodnění vždy říká, že se podpis neověřuje', () => {
    for (const vzorek of [[unknown], [photo], [{ hasManifest: true, sourceType: SOURCE_TYPE.AI_GENERATED }]]) {
      expect(summarizeC2pa(vzorek, 1).rationale).toMatch(/[Pp]odpis/);
    }
  });
});
