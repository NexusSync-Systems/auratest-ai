# AuraGuard 🛡️ (dříve AuraTest AI)

> **Stav: 🟢 Aktivní vývoj — růstová linie**
>
> **Probíhá přepozicování těžiště z EAA na NIS2.** Důvod: EAA má pokutu 10 mil. Kč,
> kupuje ho vývojář a konkurujeme Deque na jejich vlastním enginu (Axe-Core).
> NIS2 (zákon č. 264/2025 Sb.) dopadá na ~6 000 subjektů v ČR, přechodné období
> končí **1. 1. 2027**, pokuty jdou do **250 mil. Kč nebo 2 % obratu** a nese je
> i statutární orgán osobně. Modul NIS2 zde už je — chybí obal, dokumentace
> doložitelnosti a workflow hlášení incidentu NÚKIB do 24 hodin.
>
> Druhý modul v pořadí: **AI Act registr** (plná použitelnost 2. 8. 2026).

AuraGuard je nástroj pro **Compliance-as-a-Code** a automatizované QA testování.
Kombinuje LLM, Playwright a statické analyzátory a sbírá technické důkazy
o webové aplikaci před nasazením (CI/CD) i po něm.

> **Co nástroj je a co není.** Skenuje webovou vrstvu zvenčí. Evropské předpisy
> ale z velké části požadují i organizační opatření — směrnice, role, školení,
> testy obnovy — která externí sken ověřit nedokáže. Výsledky proto rozlišují
> tři stavy: **splněno**, **nesplněno** a **neprůkazné**. „Neprůkazné" znamená,
> že kontrolu nelze zvenčí provést; není to skryté „splněno".

---

## 🚀 Fáze 1: Jádro a AI Testing (Původní funkce)
Původní jádro systému se soustředí na funkční testování webu "lidským způsobem".
- **Autonomní AI Playwright Agent**: AI (např. přes model Llama 3 nebo Apfel) projde vaši aplikaci, "kliká" na tlačítka, hledá chyby a vygeneruje čistý Playwright skript pro opakovatelné testy.
- **Monitoring sítě a konzole**: Sleduje selhání HTTP požadavků (500/404) a JS errory v konzoli přímo během běhu.

## 🇪🇺 Fáze 2: Evropské směrnice & Resilence
Nástroj se transformoval na ochránce evropské byrokracie a spolehlivosti.
- **Evropský akt o přístupnosti (EAA)**: Axe-Core skener s filtrem na pravidla
  WCAG 2.1 A/AA. Vrací porušení i položky vyžadující ruční posouzení
  (`incomplete`).
  *Omezení:* automatizované nástroje pokrývají zhruba třetinu kritérií WCAG —
  zbytek vyžaduje ruční test.
- **Bezpečnostní hlavičky a TLS**: Kontroluje HSTS, CSP, X-Content-Type-Options,
  X-Frame-Options, Referrer-Policy, Permissions-Policy a použitý TLS protokol.
  *Rozsah:* jde o technický indikátor k opatření „aplikační bezpečnost" a
  „kryptografické algoritmy" podle § 14 zákona č. 264/2025 Sb. **Není to
  posouzení shody s NIS2** — zákon žádné konkrétní HTTP hlavičky nepředepisuje
  a většina jeho požadavků je organizační.
- **Post-kvantová výměna klíčů**: Nástroj naváže samostatný TLS handshake,
  ve kterém nabídne **pouze** hybridní skupinu `X25519MLKEM768` (ML-KEM-768
  podle FIPS 203 zkombinovaný s X25519). Projde-li handshake, server ji
  prokazatelně podporuje.
  *Omezení:* vyžaduje OpenSSL 3.5+ (Node 22+). Na starším buildu — a stejně
  tak když se sonda k serveru vůbec nedostane — je výsledek **neprůkazný**,
  ne „nepodporuje". Testuje se **tahle jedna skupina**: server může podporovat
  jinou post-kvantovou (např. `SecP256r1MLKEM768`), takže odmítnutí není důkaz
  obecné absence PQC. Testuje se výměna klíčů, ne podpis certifikátu — ten je
  u dnešních CA stále klasický (ECDSA/RSA), což ale proti strategii „sesbírej
  teď, dešifruj později" nevadí. Chybějící post-kvantová výměna klíčů je
  **doporučení, ne závada** — do celkového verdiktu nevstupuje.
- **Verze TLS protokolu**: Každá verze se zkouší zvlášť. TLS 1.0 a 1.1 se posílají
  ručně sestaveným ClientHellem po holém TCP socketu, protože je moderní OpenSSL
  odmítá už na straně klienta — a „náš klient to neumí" není totéž co „server to
  odmítá". Když odpověď serveru přečíst nejde, výsledek je **netestováno**.
- **Chaos test odolnosti**: Zahodí ~10 % požadavků a ~20 % zpozdí o 3 s
  (skripty, fetch/XHR, obrázky) a sleduje, jestli se aplikace rozpadne.
  O každém požadavku rozhoduje **hash ze seedu a URL**, takže stejný seed
  zahodí přesně stejné požadavky. (Sekvenční generátor by nestačil: čísla by
  se konzumovala v pořadí, v jakém požadavky dorazí, a to prohlížeč mezi běhy
  nedodrží.) Seed se vrací ve výsledku a dá se poslat zpět v těle requestu
  (`{ "seed": "..." }`). Výsledek obsahuje i seznam konkrétně zahozených
  a zdržených požadavků.

  Před injektáží proběhne **baseline běh bez poruch**. Verdikt se počítá
  z rozdílu, ne z absolutních čísel — bez toho by stránka, která hlásí chyby
  i za klidu, dostala „rozpadla se pod injektovanými poruchami", tedy závěr
  o kauzalitě, která se neměřila.

  *Omezení:* když se neinjektovala žádná porucha, nebo se nepodařil baseline,
  je výsledek **neprůkazný**, ne „odolná". Inspirováno požadavky DORA na
  testování odolnosti, ale nejde o formální test podle čl. 25 nařízení
  (EU) 2022/2554 — ten předpokládá zdokumentovaný program testování, scénáře
  hrozeb a nápravná opatření.
- **Green-Aware Computing**: Widget a endpoint doporučují vhodnou dobu pro
  náročné úlohy. **Data jsou simulovaná** podle denní doby — nejde o reálné
  měření sítě. Odpověď to označuje polem `simulated: true`. Pro auditní účely
  je potřeba napojení na ENTSO-E nebo Electricity Maps.
- **Odhad uhlíkové stopy**: Z objemu přenesených dat, koeficientem 0,81 g CO₂/MB.
  Jde o hrubý odhad podle jednoho zveřejněného modelu, ne o měření.

## 🏛️ Fáze 3: Kybernetická bezpečnost a Ochrana dat
Plní další kritické body nutné k provozu webových služeb.
- **AI Act — článek 50**: Posuzuje **čtyři samostatné povinnosti** zvlášť.
  Povinnost 1 (informovat, že jde o AI) umí testovat dobře — z odchozích volání
  AI API i z konverzačních prvků v UI. Povinnost 2 (strojově čitelné označení
  syntetického obsahu) částečně, přes C2PA v metadatech obrázků. Povinnosti 3 a 4
  (rozpoznávání emocí, deepfakes) jsou povinnosti provozovatele a externí sken
  je posoudit nedokáže — hlásí se jako **mimo dosah nástroje**.
  Celkový výsledek proto nikdy nevyjde jako „splněno", jen „nesplněno" nebo
  „neprůkazné". *Účinnost: čl. 50 platí od 2. 8. 2026.*
- **Striktní GDPR Cookie Auditor**: Robot navštíví aplikaci, cookie lištu
  ignoruje a sleduje, co se uloží ještě před souhlasem — cookies (včetně
  HttpOnly), localStorage, sessionStorage i odchozí volání na tracking domény.
  Při nálezu CLI zablokuje nasazení.
  *Omezení:* seznam trackerů (~25 prefixů, ~20 domén) není vyčerpávající —
  „bez nálezu" proto neznamená prokázaný soulad.
- **CRA — SBOM a známé zranitelnosti**: Sestaví frontendový SBOM ze **tří
  zdrojů** a dotáže se databáze OSV.dev na známá CVE:
  1. *source mapy* — pole `sources` obsahuje cesty `node_modules/<balíček>/…`,
     tedy přímý seznam závislostí tak, jak je viděl bundler (nejsilnější
     důkaz, ale bývá jen na testovacích buildech);
  2. *verzní bannery v bundlu* — `/*! jQuery v3.6.0 …`, které minifikace
     zachovává;
  3. *runtime globály* — `window.jQuery`, `window._` a spol. (původní metoda).

  Každá položka nese `confidence` (`version-detected` / `presence-only`)
  a `sources` — z čeho konkrétně vznikla. Když se zdroje neshodnou na verzi,
  rozpor se vypíše místo tichého výběru jedné.

  *Omezení:* knihovna bez banneru, bez source mapy a bez charakteristického
  řetězce zůstane neviditelná — prázdný SBOM znamená „nenašli jsme", ne „nic
  tam není". Inline `<script>` bloky se neskenují (sbírají se jen externí
  soubory). Verze se čte jen z běhového kódu; deklarovaný rozsah z package.json
  (`"react": "^18.2.0"`) se za nasazenou verzi nevydává, protože `^18.2.0` se
  běžně resolvuje na něco jiného. Chybějící patch verze se **nedoplňuje** —
  z „2.6" se nedělá „2.6.0", aby se na domyšlené číslo neptalo OSV.

  Knihovna rozpoznaná bez verze se do OSV dotázat nedá a končí mezi
  **neověřenými**. Celkový výsledek je **neprůkazný** (ne „splněno"), jakmile
  zbyde neověřená knihovna, nepodaří se přečíst některý skript, narazí se na
  limit prohledávaných skriptů, nebo si zdroje odporují ve verzi.

  A hlavně: tohle **není kusovník podle nařízení (EU) 2024/2847** — ten
  sestavuje výrobce ze zdrojového kódu a obsahuje i závislosti, které se do
  prohlížeče nikdy nedostanou (backend, build nástroje, tranzitivní balíčky).
- **Executive PDF Report**: Přes Print CSS exportuje výsledky auditů do PDF
  pro management. *Pozn.:* exportuje jen ty audity, které v daném běhu proběhly,
  a nejde o doložitelný auditní spis — chybí neměnný záznam, verzování pravidel
  a časová razítka.

## 🟢 Fáze 4: Kontinuální Uptime & Form Monitoring
Slouží k provoznímu hlídání. Funguje bez těžkopádného Playwrightu, aby mohl aplikace kontrolovat bleskovou rychlostí každou minutu.
- **On-Demand Page Monitor**: Bleskově kontroluje HTTP odpovědi (status = 200, doba odezvy) bez stahování JS balastu.
- **Form Monitor**: Odesílá naprosto čisté HTTP POST/GET requesty simulující kontaktní/login formulář a ověřuje chování cílového serveru. Ujistí se, že "formuláře stále odesílají" bez nutnosti spouštět plný test.

---

## 💻 Integrace do CI/CD (AuraGuard CLI)

Aplikace poskytuje vlastní bashový/CMD nástroj, kterým zablokujete pipeline v případě nesplnění legislativy.

```bash
# Nainstalování lokálního balíčku
npm link

# Spuštění testu proti produkci nebo staging serveru
auraguard --url https://mojeaplikace.cz --audit all

# Můžete volit i dílčí audity
auraguard --url https://mojeaplikace.cz --audit nis2
auraguard --url https://mojeaplikace.cz --audit cra
auraguard --url https://mojeaplikace.cz --audit eaa
auraguard --url https://mojeaplikace.cz --audit ai
auraguard --url https://mojeaplikace.cz --audit gdpr
auraguard --url https://mojeaplikace.cz --audit cve
```

### Návratové kódy

| Kód | Význam |
|---|---|
| `0` | Vše prošlo |
| `1` | Aplikace nesplňuje některou ze směrnic — pipeline se zastaví |
| `2` | Chyba použití (neplatná URL, neznámý typ auditu) |
| `3` | Interní chyba nástroje (nedostupné LLM, timeout) |

Rozlišení 1 a 3 je podstatné: „web nesplňuje směrnice" je jiná situace než
„nástroj se nespustil" a pipeline na ně má reagovat odlišně.

---

## 🛠 Jak to rozběhnout lokálně

**1. Instalace**
```bash
npm run setup
```
*(Zajistí Node.js závislosti i stažení Playwright prohlížečů).*

**2. Konfigurace**

Zkopírujte si `.env` a nastavte aspoň tyto proměnné. Všechny jsou
**fail-closed** — bez nich se dotčená funkce vypne, místo aby zůstala
otevřená:

| Proměnná | K čemu | Výchozí bez ní |
|---|---|---|
| `ALLOWED_LLM_HOSTS` | Allowlist LLM endpointů (SSRF) | jen `LLM_HOST` |
| `LLM_HOST` | Výchozí LLM endpoint | `http://localhost:11434` |
| `ALLOWED_DB_HOSTS` | Allowlist DB pro zdroje překladů | DB zdroje nefungují |
| `TRANSLATIONS_SQLITE_DIR` | Kořen pro SQLite zdroje překladů | kořen projektu |
| `PUBLIC_BASE_URL` | Veřejná adresa serveru pro generované SDK | v produkci SDK vrací 503 |
| `TRUST_PROXY` | `1`/`true` za reverzní proxy | `req.ip` je IP proxy |
| `ALLOWED_ORIGINS` | CORS allowlist | jen localhost |
| `TRIGGER_TEST_SECRET` | Sdílený secret pro CI/CD trigger | endpoint vypnutý |
| `MAX_CONCURRENT_BROWSERS` | Strop souběžných Chromium instancí | `3` |
| `MAX_AGENT_STEPS` | Strop kroků agenta | `50` |
| `LLM_TIMEOUT_MS` | Timeout LLM volání | `60000` |

**3. Start (React + Node)**
```bash
npm run dev
```

**4. Ověřit proti živému webu**
```bash
# jednorázově, pokud ještě nejsou stažené prohlížeče
npx playwright install chromium

# výchozí cíl: https://nexus-sync-8d50b.web.app/logout
npm run test:smoke

# vlastní cíl
npm run test:smoke -- https://vase-aplikace.cz
```
Automatická sada (`npm test`) běží proti mockům. Tenhle skript spustí agenta
i všechny skenery proti skutečnému webu a ověří, že vzniká video, sedí názvy
screenshotů, nevznikají falešné nálezy z navigační politiky a skenery vracejí
smysluplné výsledky. LLM k tomu potřeba není.

**5. Otevřít prohlížeč**
Běžte na **http://localhost:3001** a začněte testovat.

> **Pozn. k AI endpointu:** pole „URL adresa AI serveru" v nastavení je
> omezené serverovým allowlistem `ALLOWED_LLM_HOSTS`. Adresa mimo allowlist
> se ignoruje a použije se výchozí endpoint serveru — jinak by šlo přes
> aplikaci posílat požadavky na libovolnou interní službu (SSRF).

---
*Vyvinuto s podporou AI (Apfel / Gemini) v rámci transformace testování na Compliance-as-a-Code.*
