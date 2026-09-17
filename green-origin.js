/**
 * Kolik z přenesených dat si web dělá sám a kolik mu tam natahal někdo jiný.
 *
 * PROČ TO DÁVÁ SMYSL MĚŘIT
 * Celkový objem stránky je jedno číslo a provozovatel z něj nepozná, co
 * s tím může udělat. „7,76 MB" a „z toho 5 MB natáhly jiné domény" vedou
 * k jinému rozhodnutí než „7,76 MB, všechno vlastní".
 *
 * ZMĚŘENO na www.cloudflare.com (2026-09-17): 7,75 MB na vlastních
 * doménách (2), 0,01 MB na jiných (3) — tedy 0,1 %. Cloudflare si hostuje
 * prakticky všechno sám. Je to užitečný protipříklad: rozpad nemá
 * předpokládat, že cizích domén je hodně.
 *
 * (První verze tohohle komentáře tu měla „z toho 5,1 MB natáhly cizí
 * domény" jako ilustraci a četlo se to jako naměřený údaj. Nebyl.
 * V souboru, jehož smysl je netvrdit víc, než co se změřilo, je vymyšlené
 * číslo v komentáři stejná chyba jako v kódu — jen se hůř hledá.)
 *
 * CO TO MĚŘÍ A CO NE — a tohle je ta důležitá část
 * Měří se DOMÉNA, ne VLASTNICTVÍ. Z jednoho skenu nejde zjistit, kdo
 * kterou doménu provozuje. `cdn.mujweb-static.net` může patřit témuž
 * provozovateli a vyjde jako cizí; `analytics.mujweb.cz` může být
 * nakoupená služba a vyjde jako vlastní.
 *
 * Nazvat výsledek „emise třetích stran" by tedy bylo tvrzení, na které
 * měření nestačí — a přesně to řídící zásada nástroje zakazuje. Proto
 * se tomu v reportu říká „jiné domény", ne „třetí strany", a `pravidlo`
 * cestuje s výsledkem.
 *
 * PROČ NE REGISTROVATELNÁ DOMÉNA (eTLD+1)
 * Správně by se `www.firma.cz` a `img.firma.cz` měly spárovat přes
 * veřejný seznam přípon (`firma.co.uk` má jinou hranici než `firma.cz`).
 * Ten seznam ale mezi závislostmi serveru není a přidávat kvůli téhle
 * jedné věci další balík do nástroje, který sám kontroluje SBOM, nedává
 * smysl. Bez seznamu by se hranice musela HÁDAT — a špatně odhadnutá
 * hranice u `firma.co.uk` by sloučila celé `.co.uk` do jedné „vlastní"
 * domény. Radši hloupé pravidlo, které je vidět, než chytré, které se
 * občas splete.
 */

/**
 * `www.` se před porovnáním odřízne.
 *
 * Bez toho by pravidlo nespárovalo `www.firma.cz` s `img.firma.cz` —
 * sourozenecké poddomény, tedy nejběžnější rozložení vůbec. Vlastní
 * obrázky by vyšly jako cizí a číslo by bylo k ničemu. Našel to test.
 *
 * Odříznout jde jen `www.`, protože jen u něj víme, že je to konvence
 * a ne vlastní poddoména. `shop.` nebo `app.` odříznout nelze.
 */
function bezWww(hostname) {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

/**
 * Patří hostname k auditované doméně?
 *
 * Pravidlo je záměrně doslovné: shoda, poddoména, nebo naopak nadřazená
 * doména. Nic víc se neodvozuje.
 *
 * ZNÁMÁ MEZ: sourozenecké poddomény jiné než `www` se nespárují.
 * Sken na `shop.firma.cz` tedy vykáže `img.firma.cz` jako jinou doménu.
 * Správně by se to řešilo registrovatelnou doménou přes veřejný seznam
 * přípon — viz komentář v hlavičce souboru, proč tu ten seznam není.
 */
export function jeVlastni(hostname, originHost) {
  if (!hostname || !originHost) return false;
  const a = bezWww(String(hostname).toLowerCase());
  const b = bezWww(String(originHost).toLowerCase());
  if (a === b) return true;
  if (a.endsWith(`.${b}`)) return true;
  if (b.endsWith(`.${a}`)) return true;
  return false;
}

/** Jak se rozhodovalo — cestuje do reportu, aby šel závěr přezkoumat. */
export const PRAVIDLO_PUVODU =
  'Za „vlastní" se počítá auditovaná doména, její poddomény a doména '
  + 'nadřazená; předpona „www." se před porovnáním odřezává. Všechno '
  + 'ostatní je „jiná doména". Je to srovnání JMEN, ne vlastnictví: sken '
  + 'nezjistí, kdo kterou doménu provozuje, takže vlastní CDN na jiné '
  + 'doméně vyjde jako cizí a nakoupená služba na poddoméně jako vlastní. '
  + 'Sourozenecké poddomény jiné než „www" se nespárují — u skenu '
  + 'spuštěného na „shop.firma.cz" vyjde „img.firma.cz" jako jiná doména. '
  + 'Chyba tedy může jít oběma směry; číslo není horní ani dolní mez.';

/**
 * Rozdělí změřený objem podle domén.
 *
 * @param {Map<string, {bajtu: number, pozadavku: number}>} podleDomen
 * @param {string|null} originHost doména auditovaného webu
 * @param {number} [nejvyseCizich] kolik největších cizích domén vypsat
 */
export function rozdelPodlePuvodu(podleDomen, originHost, nejvyseCizich = 5) {
  // Bez domény auditovaného webu nejde rozdělit nic.
  //
  // Nastane to, když se nepodařila navigace. Vrátit v tu chvíli
  // „0 % cizích" by bylo tvrzení o webu odvozené z neúspěšného měření.
  if (!originHost || !(podleDomen instanceof Map) || podleDomen.size === 0) {
    return {
      rozdeleno: false,
      duvod: !originHost
        ? 'Doménu auditovaného webu se nepodařilo určit, objem proto nejde rozdělit.'
        : 'Nezměřil se objem u žádné domény.',
      pravidlo: PRAVIDLO_PUVODU,
    };
  }

  let vlastniBajtu = 0;
  let ciziBajtu = 0;
  const vlastniDomeny = [];
  const ciziDomeny = [];

  for (const [domena, { bajtu, pozadavku }] of podleDomen) {
    if (jeVlastni(domena, originHost)) {
      vlastniBajtu += bajtu;
      vlastniDomeny.push({ domena, bajtu, pozadavku });
    } else {
      ciziBajtu += bajtu;
      ciziDomeny.push({ domena, bajtu, pozadavku });
    }
  }

  const celkem = vlastniBajtu + ciziBajtu;
  ciziDomeny.sort((a, b) => b.bajtu - a.bajtu);

  return {
    rozdeleno: true,
    originHost,
    vlastniBajtu,
    ciziBajtu,
    // Podíl se počítá jen z toho, co se ZMĚŘILO. Když je měření neúplné,
    // je neúplný i jmenovatel — `green.uplne` u výsledku říká, jestli to
    // platí, a report to musí přenést.
    podilCizichProcent: celkem > 0
      ? Math.round((ciziBajtu / celkem) * 1000) / 10
      : 0,
    vlastnichDomen: vlastniDomeny.length,
    cizichDomen: ciziDomeny.length,
    nejvetsiCizi: ciziDomeny.slice(0, nejvyseCizich),
    pravidlo: PRAVIDLO_PUVODU,
  };
}
