import { inspectImageBytes, summarizeC2pa, SOURCE_TYPE } from '../c2pa.js';

/**
 * Čtení Content Credentials.
 *
 * Dosud se jen počítalo, kolik obrázků nese pověření. Obrázek s pověřením,
 * které se hlásí jako pořízený fotoaparátem, a obrázek hlásící se jako
 * výstup generativního modelu jsou přitom pro čl. 50 odst. 2 dvě různé věci.
 */

/** Napodobenina hlavičky souboru s manifestem. */
const withManifest = (extra = '') =>
  `\xFF\xD8\xFF\xE0JFIF...jumb...c2pa...${extra}...binární smetí`;

describe('rozpoznání manifestu', () => {
  test('dvě nezávislé značky znamenají manifest', () => {
    expect(inspectImageBytes(withManifest()).hasManifest).toBe(true);
  });

  test('jediná značka nestačí', () => {
    // Čtyřznakový řetězec se v obrazových datech může vyskytnout náhodou.
    // Falešný nález u důkazního nástroje je horší než chybějící.
    const result = inspectImageBytes('\xFF\xD8 nějaká data c2pa a nic dalšího');
    expect(result.hasManifest).toBe(false);
    expect(result.sourceType).toBe(SOURCE_TYPE.NONE);
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
