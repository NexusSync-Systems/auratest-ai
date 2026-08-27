/**
 * Registr kontrol s verzemi.
 *
 * PROČ
 * Report starý rok tvrdí „hlavička CSP chybí". Za rok se ale mohlo změnit,
 * co za dostatečnou CSP považujeme — a bez záznamu, které pravidlo tehdy
 * běželo, nejde ten nález obhájit ani zpochybnit. Při kontrole je to rozdíl
 * mezi doložitelným zjištěním a tvrzením.
 *
 * Každá kontrola má:
 *   id       stabilní identifikátor bez verze (`nis2.headers.csp`)
 *   version  celé číslo; roste, kdykoli se změní CHOVÁNÍ kontroly
 *   title    co kontroluje, česky
 *   method   jak to zjišťuje — aby šlo posoudit váhu nálezu
 *   limits   co z výsledku NEPLYNE; u compliance nástroje to není poznámka
 *            pod čarou, ale součást zjištění
 *
 * KDY ZVYŠOVAT VERZI
 * Když se změní, co kontrola považuje za splněné nebo za neprůkazné. Ne
 * když se přeformuluje hláška nebo zrychlí implementace. Verze je slib:
 * „stejné id a verze = stejný způsob posouzení".
 *
 * Historie změn patří do `changelog`, ne do commit message — report se čte
 * bez přístupu ke gitu.
 */

import { createHash } from 'crypto';

/** @typedef {{id: string, version: number, title: string, method: string, limits: string, changelog?: Record<number, string>}} Rule */

/** @type {Rule[]} */
const RULE_LIST = [
  // ── NIS2: bezpečnostní hlavičky ────────────────────────────────────────
  {
    id: 'nis2.headers.hsts',
    version: 1,
    title: 'Hlavička Strict-Transport-Security',
    method: 'Čte se hlavička odpovědi finální URL po přesměrováních.',
    limits:
      'Přítomnost hlavičky neříká nic o délce max-age ani o zahrnutí subdomén.',
  },
  {
    id: 'nis2.headers.csp',
    version: 3,
    title: 'Content-Security-Policy — obsah politiky',
    method:
      'Politika se rozebere na direktivy a posoudí se, co skutečně zakazuje. ' +
      'Hledá se `*`, `https:`, `http:`, `data:` a `https://*` u skriptů, ' +
      "`'unsafe-inline'` bez nonce, hashe či `'strict-dynamic'`, " +
      "`'unsafe-eval'`, a chybějící `base-uri`, `frame-ancestors`, " +
      '`object-src` a hlášení porušení. Posuzují se i `script-src-elem` ' +
      'a `script-src-attr`, které `script-src` pro své kontexty přebíjejí. ' +
      'Když hlavička obsahuje víc politik (oddělených čárkou), vyhodnocuje ' +
      'se jejich průnik — stejně jako to dělá prohlížeč.',
    limits:
      'Posuzuje se text politiky, ne její účinek na konkrétní stránce. ' +
      'Klíčová slova se porovnávají bez ohledu na velikost písmen. ' +
      "Politika s nonce, hashem nebo `'strict-dynamic'` vedle " +
      "`'unsafe-inline'` se NEhlásí jako vada — prohlížeče od CSP Level 2 " +
      'tuhle hodnotu ignorují; v seznamu se objeví jen jako poznámka. ' +
      'Hlavička `Content-Security-Policy-Report-Only` se nečte vůbec, ' +
      'protože nic nevynucuje. Za splněné se považuje politika bez ' +
      'závažného nálezu; střední a nízké se vypisují, ale verdikt neshazují.',
    changelog: {
      2:
        'Doplněn rozbor obsahu. Verze 1 posuzovala jen script-src na ' +
        'unsafe-inline a hvězdičku, takže politika bez base-uri nebo ' +
        'frame-ancestors procházela bez poznámky.',
      3:
        "Doplněno `'strict-dynamic'`, průnik více politik v jedné hlavičce, " +
        'porovnávání klíčových slov bez ohledu na velikost písmen, tvary ' +
        'typu `https://*` a direktivy `script-src-elem` a `script-src-attr`. ' +
        "Verze 2 hlásila doporučenou přísnou politiku s `'strict-dynamic'` " +
        'jako závažnou díru — falešný nález u nejlépe zabezpečených webů.',
    },
  },
  {
    id: 'nis2.headers.frame-options',
    version: 1,
    title: 'Ochrana proti vkládání do rámu',
    method: 'X-Frame-Options nebo frame-ancestors v CSP.',
    limits: 'Neposuzuje se, zda je nastavení pro danou aplikaci vhodné.',
  },
  {
    id: 'nis2.headers.content-type-options',
    version: 1,
    title: 'X-Content-Type-Options: nosniff',
    method: 'Přítomnost hlavičky v odpovědi.',
    limits: 'Nic neříká o správnosti Content-Type u jednotlivých zdrojů.',
  },
  {
    id: 'nis2.headers.referrer-policy',
    version: 1,
    title: 'Referrer-Policy',
    method: 'Přítomnost hlavičky v odpovědi.',
    limits: 'Neposuzuje se přísnost zvolené hodnoty.',
  },
  {
    id: 'nis2.headers.permissions-policy',
    version: 1,
    title: 'Permissions-Policy',
    method: 'Přítomnost hlavičky v odpovědi.',
    limits: 'Neposuzuje se, které funkce jsou omezené.',
  },

  // ── TLS ────────────────────────────────────────────────────────────────
  {
    id: 'tls.pqc.x25519mlkem768',
    version: 1,
    title: 'Hybridní post-kvantová výměna klíčů',
    method:
      'Naváže se TLS spojení, které serveru nabídne VÝHRADNĚ skupinu ' +
      'X25519MLKEM768 (ML-KEM-768 podle FIPS 203 + X25519). Projde-li ' +
      'handshake, server ji prokazatelně podporuje.',
    limits:
      'Neúspěch znamená „nenabízí tuhle skupinu", ne „není kvantově odolný". ' +
      'Selhání sítě nebo starý OpenSSL na naší straně dává neprůkazný ' +
      'výsledek, nikoli negativní. Absence PQC dnes není porušením předpisu.',
  },
  {
    id: 'tls.protocols.deprecated',
    version: 1,
    title: 'Zastaralé verze protokolu (TLS 1.0, 1.1)',
    method:
      'Každá verze se testuje samostatným spojením. TLS 1.0 a 1.1 se posílají ' +
      'ručně sestaveným ClientHellem po holém TCP, protože moderní OpenSSL je ' +
      'odmítá už na straně klienta.',
    limits:
      'Verze, kterou se nepodařilo otestovat, je označená jako netestovaná — ' +
      'ne jako odmítnutá. Vydávat neschopnost našeho klienta za odmítnutí ' +
      'serverem by znamenalo tvrdit výsledek testu, který neproběhl.',
  },
  {
    id: 'tls.certificate.validity',
    version: 1,
    title: 'Platnost a síla certifikátu',
    method: 'Čte se z navázaného spojení: platnost, typ klíče, délka, vydavatel.',
    limits:
      'Neověřuje se řetěz důvěry proti konkrétnímu úložišti kořenů ani ' +
      'odvolání certifikátu (CRL/OCSP).',
  },

  // ── AI Act, čl. 50 ─────────────────────────────────────────────────────
  {
    id: 'aiact.cl50.1.chatbot-disclosure',
    version: 2,
    title: 'Informování uživatele, že komunikuje s AI (čl. 50 odst. 1)',
    method:
      'Hledají se volání známých AI API, konverzační widgety a vzory v DOM ' +
      '(role="log" s textovým vstupem apod.). Je-li použití AI prokázané, ' +
      'posuzuje se UMÍSTĚNÍ upozornění: jestli se vykresluje, jestli je vidět ' +
      'bez posouvání a jestli stojí u konverzačního prvku, nebo jen v patičce.',
    limits:
      'Server-side integraci externí sken nevidí. Nezachycení proto znamená ' +
      'neprůkazné, nikoli splněné ani porušené. ' +
      'Posuzuje se umístění, NE formulace: rozlišit „tento chat používá AI" ' +
      'od marketingové zmínky o AI automaticky nelze. ' +
      'Měření vidí jen hlavní rámec a světlý DOM — do vloženého widgetu ' +
      '(iframe) ani do shadow DOM nedohlédne, a právě tam bývá upozornění ' +
      'umístěné. Když je takový widget na stránce a upozornění se nenajde, ' +
      'výsledek je neprůkazný, ne porušení. Totéž platí, když se čtení ' +
      'stránky nezdaří. ' +
      'Upozornění pouze v patičce se hodnotí jako neprůkazné — jestli splňuje ' +
      '„nejpozději při první interakci", je právní výklad, ne měření. ' +
      'Za porušení se považuje jen upozornění, které se prokazatelně ' +
      'nevykresluje.',
    changelog: {
      2:
        'Verze 1 považovala za splnění pouhý výskyt slova „AI" kdekoli ' +
        'v textu stránky — projde tím zmínka v patičce i v marketingové ' +
        'větě. Nově rozhoduje umístění a splnění se přiznává jen tam, kde ' +
        'uživatel upozornění skutečně uvidí.',
    },
  },
  {
    id: 'aiact.cl50.2.synthetic-marking',
    version: 2,
    title: 'Strojově čitelné označení syntetického obsahu (čl. 50 odst. 2)',
    method:
      'Ve vzorku obrázků se stáhne prvních 64 kB souboru a hledá se v nich ' +
      'obal JUMBF spolu se značkou C2PA. Z manifestu se čte typ zdroje ' +
      'podle slovníku IPTC, takže se rozliší obsah hlásící se jako vytvořený ' +
      'generativním modelem od obsahu hlásícího se jako pořízený zařízením.',
    limits:
      'PODPIS MANIFESTU SE NEOVĚŘUJE. Manifest tvrdí, co tvrdí; jeho pravost ' +
      'by vyžadovala kryptografické ověření proti důvěryhodnému kořeni. ' +
      'Manifest se hledá jen v prvních 64 kB, takže u souborů s velkým ' +
      'náhledem může typ zdroje ležet mimo načtenou část. Pokryta je jen ' +
      'část slovníku IPTC — nepřečtený typ se počítá jako NEPRŮKAZNÝ, ' +
      'nikoli jako „není to AI". ' +
      'Chybějící manifest neznamená, že obsah je syntetický a neoznačený — ' +
      'většina fotografií žádné pověření nemá. Vzorkuje se jen část obrázků ' +
      'a report uvádí, kolik jich zůstalo neprozkoumaných; obrázky, které ' +
      'se nepodařilo stáhnout, se do vzorku nepočítají.',
    changelog: {
      2:
        'Verze 1 uměla jen zjistit, že pověření existuje. Nově se čte typ ' +
        'zdroje, takže jde rozlišit deklarovaný výstup generativního modelu ' +
        'od fotografie s pověřením.',
    },
  },
  {
    id: 'aiact.cl50.3.emotion-recognition',
    version: 1,
    title: 'Rozpoznávání emocí a biometrická kategorizace (čl. 50 odst. 3)',
    method: 'Hledají se náznaky v obsahu stránky (video, zmínky o rozpoznávání).',
    limits:
      'Mimo dosah externího skenu. Zda jde o rozpoznávání emocí nebo ' +
      'kategorizaci, ze stránky určit nelze — vždy vyžaduje ruční posouzení.',
  },
  {
    id: 'aiact.cl50.4.deepfake-disclosure',
    version: 1,
    title: 'Zveřejnění, že obsah je umělý (čl. 50 odst. 4)',
    method: 'Neexistuje automatická kontrola.',
    limits:
      'Mimo dosah externího skenu. Rozpoznání deepfake vyžaduje znalost ' +
      'původu obsahu, kterou z doručené stránky získat nelze.',
  },

  // ── CRA ────────────────────────────────────────────────────────────────
  {
    id: 'cra.sbom.bundle-fingerprint',
    version: 1,
    title: 'Soupis komponent z obsahu bundlů',
    method:
      'Prohledávají se stažené skripty, běhové globály a source mapy. ' +
      'Každá položka nese, odkud pochází.',
    limits:
      'Není to kusovník podle nařízení — ten sestavuje výrobce ze zdrojového ' +
      'kódu a obsahuje i závislosti, které se do prohlížeče nikdy nedostanou. ' +
      'Knihovna bez zjistitelné verze se nepočítá jako ověřená.',
  },
  {
    id: 'cra.vulnerabilities.osv',
    version: 1,
    title: 'Známé zranitelnosti podle OSV',
    method: 'Dotaz do databáze OSV.dev pro každou komponentu se zjištěnou verzí.',
    limits:
      'Bez verze se dotaz neprovádí a komponenta zůstává neověřená. ' +
      'Nepřítomnost nálezu neznamená nepřítomnost zranitelnosti.',
  },

  // ── Přístupnost a GDPR ─────────────────────────────────────────────────
  {
    id: 'eaa.wcag21aa.axe',
    version: 1,
    title: 'WCAG 2.1 AA přes axe-core',
    method: 'Automatická pravidla axe-core nad vykreslenou stránkou.',
    limits:
      'Automat pokrývá odhadem třetinu kritérií WCAG. Položky označené jako ' +
      '„k ručnímu posouzení" nejsou splněné ani porušené.',
  },
  {
    id: 'gdpr.cookies.pre-consent',
    version: 1,
    title: 'Trackery načtené před udělením souhlasu',
    method:
      'Stránka se načte bez interakce se souhlasovou lištou a sledují se ' +
      'požadavky na známé tracking domény a zapsané cookies.',
    limits:
      'Posuzuje se stav bez souhlasu. Neřeší se, zda je souhlasová lišta ' +
      'sama o sobě v souladu (předvybrané volby, dark patterns).',
  },
  {
    id: 'appsec.cookies.flags',
    version: 1,
    title: 'Příznaky cookies: Secure, HttpOnly, SameSite',
    method:
      'Cookies nastavené při načtení stránky se čtou z prohlížeče (vidí ' +
      'i HttpOnly, na rozdíl od `document.cookie`). Závažnost se odvíjí od ' +
      'druhu cookie: u relační či autentizační váží chybějící příznak víc ' +
      'než u analytické, kde bývá čitelnost ze skriptu záměr.',
    limits:
      'Posuzují se jen cookies vzniklé bez přihlášení a bez interakce. ' +
      'Ty, které aplikace nastaví až po přihlášení, sken nevidí — ' +
      'nenalezení proto neznamená, že žádné rizikové neexistují. ' +
      'Druh cookie se odhaduje z názvu. ' +
      'Cookies nastavené třetí stranou (vložený přehrávač, widget) se ' +
      'započítají, ale nehodnotí: provozovatel je nemá jak změnit. ' +
      'Příznak Secure se na nešifrovaném spojení neposuzuje vůbec, protože ' +
      'tam ho prohlížeč stejně nepřijme.',
  },
  {
    id: 'gdpr.residency.geoip',
    version: 1,
    title: 'Rezidence dat podle geolokace serverů',
    method: 'IP adresy dotčených domén se překládají přes geoip databázi.',
    limits:
      'Geolokace IP neurčuje, kde jsou data uložena. U anycast CDN ukazuje na ' +
      'nejbližší uzel, ne na místo zpracování — u těch domén je údaj ' +
      'orientační a rezidenci lze doložit jen smlouvou s poskytovatelem.',
  },
];

/** Rychlé vyhledání podle id. */
const BY_ID = new Map(RULE_LIST.map((r) => [r.id, r]));

export const RULES = RULE_LIST;

/**
 * Plný identifikátor pravidla i s verzí: `nis2.headers.csp.v1`.
 *
 * Právě tenhle řetězec patří do záznamu auditu. Samotné `id` by za rok
 * neřeklo, co se testovalo.
 *
 * @param {string} id
 * @returns {string}
 * @throws když pravidlo neexistuje — překlep v id by jinak vyrobil záznam
 *   odkazující na pravidlo, které nikdy neexistovalo
 */
export function ruleRef(id) {
  const rule = BY_ID.get(id);
  if (!rule) throw new Error(`Neznámé pravidlo: ${id}`);
  return `${rule.id}.v${rule.version}`;
}

/** @param {string} id */
export function getRule(id) {
  return BY_ID.get(id) || null;
}

/**
 * Otisk celé sady pravidel.
 *
 * Do záznamu auditu se ukládá, aby šlo poznat, že mezi dvěma běhy někdo
 * sadu změnil — i když se u konkrétního nálezu verze pravidla nezměnila.
 *
 * Počítá se z id, verzí, popisů metody a mezí A ZE ZÁZNAMU ZMĚN. Pořadí
 * v poli výsledek neovlivní, protože se před hashováním třídí — jinak by
 * pouhé přeuspořádání souboru vypadalo jako změna pravidel.
 *
 * Changelog do otisku dřív nevstupoval. Přitom vysvětlení „proč se týž web
 * posuzuje jinak než dřív" je to jediné, co změnu verdiktu u nezměněného
 * webu ospravedlňuje — a šlo ho přepsat, aniž se otisk hnul.
 *
 * Pole se oddělují řídicími znaky (\u0000, \u0002), aby přesun textu
 * z konce jednoho pole na začátek dalšího nedal stejný otisk.
 */
export function rulesetDigest() {
  const canonical = RULE_LIST
    .map((r) =>
      [
        r.id,
        r.version,
        r.title,
        r.method,
        r.limits,
        // Klíče se třídí — pořadí vlastností objektu by jinak měnilo
        // otisk bez změny obsahu.
        Object.keys(r.changelog || {})
          .sort()
          .map((k) => `${k}=${r.changelog[k]}`)
          .join('\u0002'),
      ].join('\u0000')
    )
    .sort()
    .join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Metadata sady pro záznam auditu.
 */
export function rulesetInfo() {
  return {
    count: RULE_LIST.length,
    digest: rulesetDigest(),
  };
}
