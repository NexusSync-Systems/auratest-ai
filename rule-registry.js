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
    version: 1,
    title: 'Hlavička Content-Security-Policy',
    method: 'Kontroluje se přítomnost hlavičky, ne obsah politiky.',
    limits:
      'Politika může být přítomná a přitom bezzubá (např. `default-src *`). ' +
      'Tuhle kontrolu neprojde jen úplná absence.',
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
    version: 1,
    title: 'Informování uživatele, že komunikuje s AI (čl. 50 odst. 1)',
    method:
      'Hledají se volání známých AI API, konverzační widgety a vzory v DOM ' +
      '(role="log" s textovým vstupem apod.).',
    limits:
      'Server-side integraci externí sken nevidí. Nezachycení proto znamená ' +
      'neprůkazné, nikoli splněné ani porušené.',
  },
  {
    id: 'aiact.cl50.2.synthetic-marking',
    version: 1,
    title: 'Strojově čitelné označení syntetického obsahu (čl. 50 odst. 2)',
    method: 'Ve vzorku obrázků na stránce se hledá manifest C2PA.',
    limits:
      'Chybějící manifest neznamená, že obsah je syntetický a neoznačený — ' +
      'bez znalosti toho, co systém generuje, z toho porušení neplyne. ' +
      'Vzorkuje se jen část obrázků.',
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
 * Počítá se z id, verzí a popisů metody a mezí. Pořadí v poli výsledek
 * neovlivní, protože se před hashováním třídí — jinak by pouhé přeuspořádání
 * souboru vypadalo jako změna pravidel.
 */
export function rulesetDigest() {
  const canonical = RULE_LIST
    .map((r) => [r.id, r.version, r.title, r.method, r.limits].join(' '))
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
