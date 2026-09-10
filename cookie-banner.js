/**
 * Rozpoznání a odkliknutí cookie lišty.
 *
 * PROČ TO EXISTUJE
 * Lišta překrývá stránku a chytá kliknutí. Agent kvůli ní utrácel kroky
 * za to, že se pokoušel proklikat něčím, co je pod překryvem — a část
 * běhů tak vůbec nedošla k testované aplikaci.
 *
 * POŘADÍ JE PODSTATNÉ
 * Odkliknout ji SMÍ až poté, co je zaznamenaný stav PŘED souhlasem.
 * GDPR sken měří přesně to, co se načte a uloží před udělením souhlasu;
 * kdyby lišta zmizela dřív, zničili bychom si vlastní důkaz. Volající
 * je proto povinen měření provést sám a teprve pak tuhle funkci zavolat.
 *
 * CO SE MAČKÁ
 * Volba „pouze nezbytné" (nebo rovnocenné odmítnutí). Odpovídá tomu, co
 * udělá opatrný návštěvník, a nezanese do běhu marketingové skripty,
 * které by pak agent hlásil jako své nálezy.
 *
 * ČEHO SE TO DRŽÍ
 * Nikdy se nehádá. Zmáčkne se jen ovládací prvek, který je (a) uvnitř
 * prvku, jehož text mluví o cookies nebo souhlasu, a (b) jehož vlastní
 * text odpovídá známé formulaci. Když se nic takového nenajde, VRÁTÍ SE
 * důvod — protože „lištu jsem nerozpoznal" a „žádná lišta tam nebyla"
 * jsou dvě různá zjištění a v dokumentu se nesmějí slít v jedno.
 */

/** Odstraní diakritiku a sjednotí bílé znaky. */
export function normalizuj(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Formulace odmítnutí, od nejkonkrétnější po nejobecnější.
 *
 * Pořadí rozhoduje: „odmítnout vše" má přednost před „odmítnout", aby
 * na liště se dvěma tlačítky padla volba na to jednoznačnější.
 */
const NEZBYTNE = [
  'pouze nezbytne', 'jen nezbytne', 'pouze nutne', 'jen nutne',
  'nezbytne nutne', 'pouze zakladni', 'jen zakladni', 'pouze technicke',
  'odmitnout vse', 'odmitnout vsechny', 'odmitnout cookies',
  'zamitnout vse', 'nesouhlasim',
  'only necessary', 'necessary only', 'only essential', 'essential only',
  'strictly necessary', 'reject all', 'decline all', 'refuse all',
  'reject cookies', 'deny all',
  'nur notwendige', 'alle ablehnen',
  'odmietnut vsetko', 'iba nevyhnutne',
];
// POZOR: holá slovesa („Odmítnout", „Zamítnout", „Reject", „Decline",
// „Ablehnen") tu SCHVÁLNĚ nejsou.
//
// Kontrolní vlna ukázala, na čem to padá: agent běží PŘIHLÁŠENÝ
// v zákazníkově aplikaci. Panel „Sledování zásilky" s tlačítkem
// „Odmítnout", schvalovací karta „Souhlas nadřízeného" s tlačítkem
// „Zamítnout žádost", issue s „Time tracking" a tlačítkem „Reject" —
// všechno to prošlo jako cookie lišta a nástroj by ta tlačítka zmáčkl.
//
// Odmítnutí cookies se v praxi vždycky píše s určením („vše", „all",
// „cookies", „nezbytné"). Bez určení radši nezmáčkneme nic: nezmáčknutá
// lišta stojí pár kroků běhu, zamítnutá žádost v produkci je nevratná.

/** Formulace souhlasu — poznávají se proto, aby se NEZMÁČKLY. */
const PRIJMOUT = [
  'prijmout vse', 'prijmout vsechny', 'prijmout vsechno', 'souhlasim',
  'prijmout', 'rozumim', 'povolit vse',
  'accept all', 'allow all', 'accept', 'agree', 'got it', 'i understand',
  'alle akzeptieren', 'akzeptieren', 'zustimmen',
];

/** Formulace vedoucí do nastavení — taky se nemačkají, jen se poznávají. */
const NASTAVENI = [
  'nastaveni', 'predvolby', 'upravit', 'spravovat', 'vlastni nastaveni',
  'podrobnosti', 'vice informaci',
  'settings', 'preferences', 'manage', 'customi', 'more options', 'details',
  'einstellungen',
];

/**
 * Slova, podle kterých se pozná text cookie lišty.
 *
 * Seznam se ZÚŽIL po kontrolní vlně. Dřív tu bylo i „souhlas", „privacy",
 * „sledovani", „tracking" a „gdpr" — každé z nich se běžně vyskytne
 * v aplikaci, kterou agent testuje přihlášený, a stačilo k tomu, aby se
 * za cookie lištu označil panel sledování zásilky nebo schvalovací karta.
 *
 * Zbylo jen to, co v jiném významu prakticky nepotkáte. Cookie lišta
 * v češtině i angličtině vždycky slovo „cookies" obsahuje; když ne,
 * radši ji nerozpoznáme.
 */
const LISTA = ['cookie', 'cookies', 'consent'];

/**
 * Značky kontejneru, který cookie lištou být MŮŽE.
 *
 * Samotný text nestačí. Lišta je vždycky překryv — proto se vyžaduje
 * `position: fixed|sticky`, dialogová role, nebo název známého CMP.
 * Bez téhle druhé podmínky by na mělké stránce (SPA, kde je `#root`
 * druhá úroveň) stačil odkaz „Zásady cookies" v patičce a za lištu by
 * se označil celý dokument.
 */
const CMP_ZNACKY = [
  'cookie', 'consent', 'cmp', 'onetrust', 'cookiebot', 'didomi',
  'usercentrics', 'klaro', 'cookieyes', 'borlabs', 'osano', 'termly',
  'iubenda', 'quantcast', 'trustarc',
];

/**
 * Nejdelší shoda ze seznamu, nebo `null`.
 *
 * Porovnává se na podřetězec, ale VÝHRADNĚ nad textem jednoho ovládacího
 * prvku (typicky dvě slova), ne nad celou stránkou — tam by to bylo
 * bezcenné. Délka vzoru slouží jako míra konkrétnosti.
 */
function nejdelsiShoda(text, vzory) {
  let nejlepsi = null;
  for (const vzor of vzory) {
    if (text.includes(vzor) && (!nejlepsi || vzor.length > nejlepsi.length)) {
      nejlepsi = vzor;
    }
  }
  return nejlepsi;
}

/**
 * Zařadí text ovládacího prvku.
 *
 * @returns {{druh: 'nezbytne'|'prijmout'|'nastaveni', vzor: string}|null}
 */
export function klasifikujTlacitko(text) {
  const t = normalizuj(text);
  // Prázdný a nesmyslně dlouhý text se neklasifikuje. Tlačítko s odstavcem
  // textu není tlačítko lišty; kdyby ano, radši ho nezmáčkneme.
  if (t.length === 0 || t.length > 80) return null;

  const kandidati = [
    ['nezbytne', nejdelsiShoda(t, NEZBYTNE)],
    ['prijmout', nejdelsiShoda(t, PRIJMOUT)],
    ['nastaveni', nejdelsiShoda(t, NASTAVENI)],
  ].filter(([, vzor]) => vzor !== null);

  if (kandidati.length === 0) return null;

  // Nejkonkrétnější vzor vyhrává. „Odmítnout vše" (12) přebije
  // „prijmout" jen tehdy, když v textu opravdu je — dvojznačné texty
  // typu „Přijmout pouze nezbytné" tak padnou na odmítnutí, což je
  // správně: takové tlačítko nezbytné cookies neschvaluje nad rámec.
  kandidati.sort((a, b) => b[1].length - a[1].length);
  const [druh, vzor] = kandidati[0];
  return { druh, vzor };
}

/**
 * Ze seznamu kandidátů vybere ten, který se má zmáčknout.
 *
 * @param {Array<{idx:number, text:string, vListe:boolean}>} kandidati
 * @returns {{idx:number, text:string, vzor:string}|null}
 */
export function vyberTlacitko(kandidati) {
  let nejlepsi = null;
  for (const k of kandidati) {
    // Mimo lištu se nemačká nic. Slovo „odmítnout" se na e-shopu vyskytne
    // i u zrušení objednávky a zmáčknout ho by znamenalo provést za
    // uživatele akci, o kterou nikdo nežádal.
    if (!k.vListe) continue;
    const klasifikace = klasifikujTlacitko(k.text);
    if (!klasifikace || klasifikace.druh !== 'nezbytne') continue;
    if (!nejlepsi || klasifikace.vzor.length > nejlepsi.vzor.length) {
      nejlepsi = { idx: k.idx, text: k.text, vzor: klasifikace.vzor };
    }
  }
  return nejlepsi;
}

/**
 * Text prvku bez obsahu skriptů a stylů.
 *
 * `innerText` je přesně to, co chceme (vidí jen viditelný text), ale
 * neimplementuje ho každé prostředí — jsdom ho nemá vůbec. Slepý
 * fallback na `textContent` je přitom nebezpečný: vytáhl by obsah
 * inline `<script>`, a slovo „consent" v `dataLayer` nebo
 * `__NEXT_DATA__` má dnes skoro každá stránka. Proto se `textContent`
 * skládá ručně a značky, které uživatel nevidí, se přeskakují.
 */
function textPrvku(el) {
  if (typeof el?.innerText === 'string') return el.innerText;
  const NEVIDITELNE = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const kusy = [];
  const projdi = (uzel) => {
    for (const dite of uzel.childNodes || []) {
      if (dite.nodeType === 3) { kusy.push(dite.nodeValue); continue; }
      if (dite.nodeType !== 1 || NEVIDITELNE.has(dite.tagName)) continue;
      projdi(dite);
    }
  };
  projdi(el);
  return kusy.join(' ');
}

/**
 * Je tenhle prvek uvnitř cookie lišty?
 *
 * Vytaženo z `page.evaluate` ven, aby to šlo otestovat nad jsdom.
 * Předtím rozhodnutí, které nese celé riziko chybného kliknutí, běželo
 * jen uvnitř prohlížeče a testy kontrolovaly `vListe` předané jako
 * vstup — tedy nic.
 *
 * DVĚ NEZÁVISLÉ PODMÍNKY, obě povinné:
 *   1. text předka obsahuje „cookie"/„cookies"/„consent",
 *   2. předek je překryv — `position: fixed|sticky`, dialogová role,
 *      nebo název známého CMP v id/class.
 *
 * Samotná první podmínka nestačila: panel „Sledování zásilky",
 * schvalovací karta „Souhlas nadřízeného" ani issue s „Time tracking"
 * překryv nejsou, a přesně na nich by nástroj zmáčkl cizí tlačítko
 * v přihlášené aplikaci zákazníka.
 *
 * @param {Element} el
 * @param {{maxUrovni?: number, getStyle?: (el: Element) => CSSStyleDeclaration}} [opts]
 */
export function jeVListe(el, { maxUrovni = 8, getStyle = null } = {}) {
  const styl = getStyle
    || ((e) => (e.ownerDocument?.defaultView || globalThis).getComputedStyle(e));

  let uzel = el?.parentElement || null;
  for (let h = 0; h < maxUrovni && uzel; h++) {
    const doc = uzel.ownerDocument;
    if (uzel === doc?.body || uzel === doc?.documentElement) break;

    // Viz `textPrvku`: obsah <script> se nezapočítává.
    const text = normalizuj(textPrvku(uzel));
    const maText = text.length > 0 && text.length <= 4000
      && LISTA.some((v) => text.includes(v));
    if (!maText) { uzel = uzel.parentElement; continue; }

    const znacky = normalizuj(`${uzel.id || ''} ${uzel.className || ''}`);
    if (CMP_ZNACKY.some((v) => znacky.includes(v))) return true;

    const role = (uzel.getAttribute?.('role') || '').toLowerCase();
    if (role === 'dialog' || role === 'alertdialog'
      || uzel.getAttribute?.('aria-modal') === 'true') return true;

    try {
      const pozice = styl(uzel)?.position;
      if (pozice === 'fixed' || pozice === 'sticky') return true;
    } catch { /* bez computed stylu se rozhoduje podle zbylých značek */ }

    uzel = uzel.parentElement;
  }
  return false;
}

/** Selektory ovládacích prvků, které přicházejí v úvahu. */
export const VYBER_TLACITEK = 'button, [role="button"], a[href="#"],'
  + ' a[role="button"], input[type="button"], input[type="submit"]';

/**
 * Projde dokument a vrátí kandidáty. Značku nasadí jen tam, kde je
 * potřeba, ne na každé tlačítko na stránce.
 *
 * @param {Document} doc
 */
export function sesbirejKandidatyZDokumentu(doc, opts = {}) {
  const prvky = [];
  const koreny = [doc];
  // Lišty bývají ve stínovém DOM (Cookiebot, OneTrust a spol.).
  const doStinu = (uzel) => {
    for (const el of uzel.querySelectorAll('*')) {
      if (el.shadowRoot) { koreny.push(el.shadowRoot); doStinu(el.shadowRoot); }
    }
  };
  try { doStinu(doc); } catch { /* hluboké stromy se přeskočí */ }
  for (const koren of koreny) prvky.push(...koren.querySelectorAll(VYBER_TLACITEK));

  const vysledek = [];
  prvky.forEach((el, i) => {
    // Neviditelný prvek se nemačká — lišta bývá v DOM i po zavření.
    // V jsdom `getBoundingClientRect` vrací samé nuly, takže se kontrola
    // zapíná jen tam, kde má smysl (v prohlížeči).
    if (opts.kontrolujViditelnost) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
    }
    vysledek.push({
      idx: i,
      el,
      text: (textPrvku(el) || el.value || el.getAttribute('aria-label') || '').slice(0, 200),
      vListe: jeVListe(el, opts),
    });
  });
  return vysledek;
}

/**
 * Kód sběru, jak ho spolkne prohlížeč.
 *
 * Uvnitř `page.evaluate` nejsou k dispozici moduly, takže se logika
 * z `jeVListe` a `sesbirejKandidatyZDokumentu` musí poslat jako text.
 * Sestavuje se z týchž zdrojů, aby se obě kopie nemohly rozejít —
 * kontrolní vlna přesně tenhle rozchod našla u předchozí verze, kde
 * měl kód v prohlížeči vlastní, širší seznam slov.
 */
const KOD_SBERU = new Function(`
  const LISTA = ${JSON.stringify(LISTA)};
  const CMP_ZNACKY = ${JSON.stringify(CMP_ZNACKY)};
  const normalizuj = ${normalizuj.toString()};
  const textPrvku = ${textPrvku.toString()};
  const jeVListe = ${jeVListe.toString()};
  const VYBER_TLACITEK = ${JSON.stringify(VYBER_TLACITEK)};
  const sesbirej = ${sesbirejKandidatyZDokumentu.toString()};
  return sesbirej(document, { kontrolujViditelnost: true })
    .map(({ idx, text, vListe }) => ({ idx, text, vListe }));
`);

/**
 * Najde cookie lištu a zmáčkne na ní „pouze nezbytné".
 *
 * VOLAT AŽ PO ZAZNAMENÁNÍ STAVU PŘED SOUHLASEM. Viz komentář nahoře.
 *
 * @param {import('playwright').Page} page
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{clicked: boolean, label: string|null, reason: string}>}
 */
export async function dismissCookieBanner(page, { timeoutMs = 5000 } = {}) {
  const uklid = () => page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-ag-cookie-vybrano]')) {
      el.removeAttribute('data-ag-cookie-vybrano');
    }
  }).catch(() => {});

  let kandidati;
  try {
    kandidati = await Promise.race([
      page.evaluate(KOD_SBERU),
      new Promise((_, odmitni) =>
        setTimeout(() => odmitni(new Error('vypršel čas')), timeoutMs)),
    ]);
  } catch (err) {
    // Chyba HLEDÁNÍ není zjištění o webu. Musí být odlišitelná od
    // „lišta tam není", aby se v reportu nedala číst jako nález.
    //
    // Uklidit se musí i tady: `Promise.race` `page.evaluate` nezruší,
    // takže sběr může doběhnout dodatečně a značku v DOM nechat.
    await uklid();
    return { clicked: false, label: null, reason: `hledani-selhalo: ${err.message}` };
  }

  try {
    if (!kandidati.some((k) => k.vListe)) {
      return { clicked: false, label: null, reason: 'lista-nenalezena' };
    }

    const volba = vyberTlacitko(kandidati);
    if (!volba) {
      // Lišta tam je, ale jednoznačné odmítnutí na ní není — bývá
      // schované pod „Nastavením", nebo je tam jen holé „Odmítnout",
      // které se schválně nemačká. Klikat naslepo by znamenalo buď
      // udělit souhlas, nebo provést cizí akci.
      return { clicked: false, label: null, reason: 'lista-nalezena-bez-odmitnuti' };
    }

    // Značku dostane JEN vybraný prvek, ne každé tlačítko na stránce.
    const oznaceno = await page.evaluate((idx) => {
      const VYBER = 'button, [role="button"], a[href="#"], a[role="button"],'
        + ' input[type="button"], input[type="submit"]';
      const koreny = [document];
      const doStinu = (uzel) => {
        for (const el of uzel.querySelectorAll('*')) {
          if (el.shadowRoot) { koreny.push(el.shadowRoot); doStinu(el.shadowRoot); }
        }
      };
      try { doStinu(document); } catch { /* prázdné */ }
      const prvky = [];
      for (const koren of koreny) prvky.push(...koren.querySelectorAll(VYBER));
      const el = prvky[idx];
      if (!el) return false;
      el.setAttribute('data-ag-cookie-vybrano', '1');
      return true;
    }, volba.idx).catch(() => false);

    if (!oznaceno) {
      return { clicked: false, label: volba.text, reason: 'prvek-mezitim-zmizel' };
    }

    try {
      await page.click('[data-ag-cookie-vybrano]', { timeout: timeoutMs });
    } catch (err) {
      return { clicked: false, label: volba.text, reason: `klik-selhal: ${err.message}` };
    }

    // ZMÁČKNUTO ≠ ZMIZELO.
    //
    // Skutečný běh na drinkboostup.cz to ukázal názorně: report tvrdil
    // „Lišta odkliknuta volbou Pouze nezbytné — zbytek běhu proto
    // probíhal bez souhlasu s marketingovými cookies" a o odstavec níž
    // pětkrát „prvek překrývá jiná vrstva, typicky cookie lišta".
    // Polovina běhu selhala na překryvu, který podle dokumentu neměl
    // existovat.
    //
    // `clicked: true` znamená jen, že Playwright klik provedl. Že tím
    // lišta zmizela, je DŮSLEDEK — a ten se musí ověřit, ne odvodit.
    await page.waitForTimeout(600).catch(() => {});
    let zbyva = null;
    try {
      const po = await page.evaluate(KOD_SBERU);
      zbyva = po.some((k) => k.vListe);
    } catch { /* ověření se nepodařilo — `null` to říká nahlas */ }

    if (zbyva === true) {
      return {
        clicked: true,
        label: volba.text.trim(),
        reason: 'odmitnuto-lista-zustala',
      };
    }
    return {
      clicked: true,
      label: volba.text.trim(),
      reason: zbyva === false ? 'odmitnuto-overeno' : 'odmitnuto-neovereno',
    };
  } finally {
    // Úklid ve VŠECH cestách, ne jen po kliknutí. Značka v DOM by se
    // jinak dostala do screenshotů, do stavu posílaného modelu
    // i do generovaného Playwright skriptu — a nástroj, který má jen
    // měřit, by po sobě nechal stopu.
    await uklid();
  }
}

/**
 * Věty o stavu PŘED souhlasem.
 *
 * Zaznamenávají se dřív, než se lišta odklikne — po odkliknutí už by
 * nešlo poznat, co si web uložil sám od sebe a co s dodatečným svolením.
 *
 * Formulace je úmyslně opatrná v obou směrech. Nález se pojmenuje jako
 * nález, ale prázdný seznam NENÍ doklad souladu: sledovaný seznam není
 * vyčerpávající a trackovat lze i bez cookie.
 *
 * @param {{cookies: string[], storage: string[], listaByla: boolean}} s
 * @returns {string[]}
 */
export function popisPredSouhlasem(s) {
  const vety = [];
  const cookies = s?.cookies;
  const storage = s?.storage;

  // `null` = nezměřeno. Není to totéž jako prázdný seznam a nesmí
  // z toho vzniknout věta „nic nebylo uloženo".
  if (!Array.isArray(cookies) && !Array.isArray(storage)) {
    return [
      'Stav před souhlasem se nepodařilo zaznamenat'
      + (s?.chyba ? ` (${s.chyba})` : '')
      + '. Z toho neplyne, že se nic neuložilo.',
    ];
  }

  const cekani = s?.cekaniMs ? ` (po ${Math.round(s.cekaniMs / 1000)} s od načtení)` : '';

  if (Array.isArray(cookies) && cookies.length > 0) {
    vety.push(`Před souhlasem${cekani} uloženo ${cookies.length} sledovaných cookies: ${cookies.join(', ')}.`);
  }
  if (Array.isArray(storage) && storage.length > 0) {
    vety.push(`Před souhlasem${cekani} uloženo ${storage.length} sledovaných položek úložiště: ${storage.join(', ')}.`);
  }

  // Část se nezměřila — to se musí přiznat i tehdy, když druhá část
  // nálezy má.
  if (!Array.isArray(cookies)) vety.push(`Cookies se před souhlasem nepodařilo přečíst${s?.chyba ? ` (${s.chyba})` : ''}.`);
  if (!Array.isArray(storage)) vety.push(`Úložiště se před souhlasem nepodařilo přečíst${s?.chyba ? ` (${s.chyba})` : ''}.`);

  if (vety.length === 0) {
    vety.push(
      `Před souhlasem${cekani} nebyla uložena žádná položka ze sledovaného `
      + 'seznamu trackerů. Sledovaný seznam není vyčerpávající — není to '
      + 'doklad souladu.'
    );
  }
  return vety;
}

/** Věta do záznamu běhu. Popisuje, co se stalo, ne co z toho plyne. */
export function popisOdkliknuti(vysledek) {
  switch (vysledek.reason) {
    case 'odmitnuto-overeno':
      return `Cookie lišta: zmáčknuto „${vysledek.label}" a lišta zmizela `
        + '(po zaznamenání stavu před souhlasem).';
    case 'odmitnuto-lista-zustala':
      return `Cookie lišta: zmáčknuto „${vysledek.label}", ale lišta na stránce `
        + 'ZŮSTALA. Zbytek běhu mohl probíhat pod překryvem a volba se '
        + 'nemusela projevit.';
    case 'odmitnuto-neovereno':
      return `Cookie lišta: zmáčknuto „${vysledek.label}"; jestli tím zmizela, `
        + 'se ověřit nepodařilo.';
    case 'odmitnuto':
      // Starší uložené záznamy, kde se ověření ještě nedělalo.
      return `Cookie lišta: zmáčknuto „${vysledek.label}" (po zaznamenání stavu před souhlasem).`;
    case 'lista-nenalezena':
      return 'Cookie lišta: nenalezena.';
    case 'lista-nalezena-bez-odmitnuti':
      return 'Cookie lišta: nalezena, ale bez tlačítka odmítnutí v první úrovni. '
        + 'Nezmáčknuto nic — volba souhlasu není na nástroji.';
    default:
      return `Cookie lišta: odkliknutí se nepodařilo (${vysledek.reason}). `
        + 'Zbytek běhu mohl probíhat pod překryvem.';
  }
}
