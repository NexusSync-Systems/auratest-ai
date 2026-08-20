# Commity k provedení

Všechny příkazy níž spouštějte z kořene projektu:

```bash
cd /Users/zdenekdias/.gemini/antigravity/scratch/auratest-ai
```

Git commit ze sandboxu nešel (mount nepovoluje mazání v `.git`, zůstal tam
`HEAD.lock`). Nejdřív ho odstraňte:

```bash
rm -f .git/HEAD.lock .git/index.lock
```

Commit 6 přidává devDependencies, takže je potřeba i:

```bash
npm run install:all
```

**Nejrychlejší cesta:** `bash scripts/commit-all.sh` provede všech osm
commitů najednou (skript je vygenerovaný z tohohle souboru, takže zprávy
sedí). Níž jsou pro kontrolu rozepsané jednotlivě.

Změny jsou rozdělené do osmi logických commitů. Protože v repu byly už předtím
vaše necommitnuté změny v `agent.js`, `App.jsx`, `index.css` a dalších ~27
souborech, nejdou od mých oddělit — commity je proto zahrnou (odsouhlaseno).

---

## Commit 1 — P0

```bash
git add frontend/src/App.jsx firestore.rules eslint.config.js .github/workflows/ci.yml .gitignore
git rm -r --cached frontend/dist -q
git commit -F- <<'EOF'
fix(p0): opravit rozbité reference, Firestore pravidla pro /users, ESLint v CI

- App.jsx: onSubmit={handleAuthSubmit} -> handleAuth. Reference na
  nedeklarovaný identifikátor shazovala přihlašovací obrazovku bílou stránkou
  pro každého nepřihlášeného uživatele mimo záložku auraguard.
- App.jsx: doimplementovat fetchProjects() a zavolat ji v auth efektu.
  `projects` se nikdy nenaplnilo, takže správa projektů, API klíčů
  i generátor SDK byly trvale nefunkční.
- firestore.rules: doplnit match /users/{uid} + /history. handleSaveProfile
  zapisoval do kolekce, na kterou platil default-deny -> "Uložit do cloudu"
  vždy skončilo chybou oprávnění.
- eslint.config.js: globální `ignores` přesunout do samostatného objektu.
  Ve flat configu se `ignores` uvnitř objektu s `files` neaplikuje na
  js.configs.recommended, takže se lintoval i frontend/dist (664 chyb).
- ci.yml: přidat blokující lint job a build frontendu.
- frontend/dist vyřadit z gitu (build artefakty = drift proti zdroji).

ESLint: 706 problémů (670 chyb) -> 28 warningů, 0 chyb.
EOF
```

## Commit 2 — bezpečnost

```bash
git add server.js agent.js db-connector.js frontend/src/App.jsx tests/
git commit -F- <<'EOF'
fix(security): SSRF guard na všech routách, autentizace WS, escapování codegenu

SSRF:
- server.js: middleware urlGuard() a jeho nasazení na 12 endpointů, kde
  assertPublicHttpUrl chyběl (run-test, monitors, 8 audit endpointů,
  monitor-page, monitor-form). Osm copy-paste audit handlerů nahrazeno
  tabulkou URL_AUDITS, takže guard je na jednom místě.
- agent.js: checkPage sledovala redirecty přes `redirect: 'follow'`, čímž
  šlo guard obejít přesměrováním na interní adresu. Přesměrování se teď
  sledují ručně a každý hop se znovu ověřuje.
- agent.js: navigace vybraná LLM podle obsahu testované stránky je omezena
  na origin startovní URL (prompt injection -> cloud metadata endpoint).
- db-connector.js: apiUrl přes assertPublicHttpUrl, dbHost přes allowlist
  ALLOWED_DB_HOSTS, sqlitePath omezen na TRANSLATIONS_SQLITE_DIR,
  `cwd` z requestu se ignoruje.
- llmConfig.host se už nebere z těla requestu (allowlist ALLOWED_LLM_HOSTS);
  dřív šlo přes queryLLM poslat libovolný POST na interní službu.

Autentizace a izolace nájemců:
- WebSocket vyžaduje Firebase ID token a ověřuje vlastnictví session.
  Dřív se kontrolovala jen přítomnost sessionId, které bylo `Date.now()` -
  cizí testy šlo odposlouchávat živě. sessionId je teď randomUUID.
- broadcastToAll -> broadcastToUser: monitory a telemetrie všech uživatelů
  se rozesílaly každému připojenému klientovi.
- Screenshoty a videa: express.static bez autentizace nahrazen routou
  s capability tokenem vázaným na session (Bearer nejde, <img> hlavičky
  neposílá). Název souboru validován regexem, sendFile s root.
- PATCH /api/monitors/:id: whitelist polí. Dřív šlo celé req.body do
  docRef.update(), takže uživatel přepsal userId a ukradl cizí monitor.
- analyze-security přijímá jen eventIds a data načítá server. Dřív to byla
  neomezená LLM proxy s prompt injection přes events[].data.message.
- Origin check u /api/auraguard/report: chybějící Origin se už nepřeskakuje
  a porovnává se normalizovaný origin místo startsWith.

Injektáž:
- generatePlaywrightScript escapuje hodnoty přes JSON.stringify. Hodnoty
  z LLM se interpolovaly přímo do apostrofů, takže payload
  `'); require('child_process').exec(...); //` vyrobil spustitelný .spec.ts
  -> RCE na stroji, kde ho uživatel pustí.
- Testovací credentials jdou do promptu jen jako {{TEST_LOGIN}} /
  {{TEST_PASSWORD}}; skutečná hodnota se dosazuje až v page.fill().
  Dřív heslo končilo v promptu posílaném na llmConfig.host, v DB,
  ve WS broadcastu i ve vygenerovaném skriptu na disku.

Robustnost:
- Rate limiting (bez nové závislosti): obecný, per-projekt na telemetrii,
  přísný na endpointy spouštějící Chromium, brzda na trigger secret.
- timingSafeEqual u trigger secretu, PUBLIC_BASE_URL místo reflexe Host
  hlavičky do generovaného SDK, trust proxy.
- queryLLM: AbortSignal.timeout, throw místo propadnutí smyčky (vracelo
  undefined), validace tvaru odpovědi, ošetřený Ollama fallback.
- uncaughtException ukončí proces místo běhu v nedefinovaném stavu.
- Chybový handler vrací errorId místo err.message.
- maxSteps má strop, headless je v produkci vynucené.
- Odstraněna mrtvá in-memory `sessions` mapa a no-op deduplikační větev.
- GET /api/neexistujici vrací 404 místo index.html se stavem 200.

Frontend:
- Samostatné refy pro globální a session WebSocket (první spuštění testu
  natrvalo zabilo živou telemetrii), cleanup při unmountu, try/catch kolem
  JSON.parse, AbortController u načítání session, relativní URL videa.

Testy: mock ssrf-guardu v hub testech (nezávislost na DNS) + nové testy na
odmítnutí interní URL, na ignorování pokusu o přepsání userId a na to, že
generovaný skript nejde injektovat. 76/76 zelených.
EOF
```

## Commit 3 — validita compliance skenerů

```bash
git add agent.js
git commit -F- <<'EOF'
fix(compliance): opravit skenery, které vracely prokazatelně chybné výsledky

NIS2/PQC:
- response.securityDetails() se nikdy neawaitovalo. `pqc.secure` bylo vždy
  true (i na čistém HTTP), `protocol` undefined -> KAŽDÝ web včetně TLS 1.3
  dostal hlášku "Zastaralý protokol! Okamžitě aktualizujte konfiguraci".
- Hlavičky se braly z page.on('response') s podmínkou response.url() === url.
  Po přesměrování (http->https, www.) se URL neshodla a všechny kontroly
  (HSTS, CSP, XFO, XCTO) hlásily false.
  Obojí se teď bere z návratové hodnoty page.goto().
- HSTS vyžaduje max-age >= 1 rok (max-age=0 dřív procházelo jako PASS),
  CSP s unsafe-inline/unsafe-eval/wildcard v script-src neprojde,
  X-Frame-Options akceptuje i CSP frame-ancestors.

AI Act:
- pageText.includes('ai') matchovalo "email", "detail", "main", "retail" ->
  prakticky každá stránka prošla jako compliant a skener nikdy nic nenašel.
  Nahrazeno regexem se slovními hranicemi.
- Rozšířen seznam AI API hostů.
- Když se nezachytí volání AI API, výsledek je `inconclusive` (isCompliant:
  null), ne "PASS: splňuje AI Act" — server-side integrace tenhle test
  vyloučit nedokáže.

CRA/SBOM:
- Prázdný SBOM vracel isCompliant: true. Bundlovaná aplikace nevystavuje
  knihovny do window, takže "vše v pořádku" znamenalo jen "nic jsem neviděl".
  Teď isCompliant: null + NEPRŮKAZNÉ.
- Mapa zobrazovaný název -> npm název ('vue.js' a 'next.js' v OSV neexistují).
- normalizeSemver: React s verzí "detekováno (přes DevTools)" filtrem
  procházel a do OSV šel prázdný řetězec; Vue "3.x" se očistilo na "3.".
- Selhání OSV se už neignoruje tiše (dřív -> "PASS"), eviduje se v `skipped`
  a promítá do ratingu. Přidán timeout.

EAA/axe:
- .withTags(wcag2a/2aa/21a/21aa) — bez filtru běžela i best-practice
  pravidla, jejichž porušení není porušením WCAG 2.1 AA / EN 301 549.
- results.incomplete se zahazovalo (false negatives), teď je v reportu
  k ručnímu posouzení.

GDPR cookies:
- document.cookie nevidí HttpOnly cookies, tedy právě server-side tracking.
  Nahrazeno context.cookies().
- Allowlist rozšířen ze 3 prefixů na ~25, matchuje se název cookie, ne celý
  řetězec "název=hodnota" (dřív falešná pozitiva z hodnoty).
- Přidán sessionStorage a monitoring požadavků na tracking domény.
- "PASS: bez trackerů" -> "BEZ NÁLEZU" s výhradou, že seznam není úplný.

Green:
- getGridEnergyStatus vracel Math.random() a přes /api/auraguard/grid-status
  se to podávalo jako fakt. Hodnota je teď deterministická a výstup nese
  simulated: true + disclaimer.
EOF
```

## Commit 4 — stabilita

```bash
git add agent.js server.js paths.js tests/monitoring.test.js tests/utils.test.js
git commit -F- <<'EOF'
fix(stability): mrtvé predikáty, resource leaky, souběh a plánovač

Logika agenta:
- extractInteractiveElements nevracela `value` ani `disabled`, takže
  hasElementValue() i isDisabledElement() byly VŽDY false. Celá logika
  "nepřepisuj vyplněné pole" a "neklikej na disabled prvek" byla mrtvá.
- isCompletionContext počítala do haystacku i `goal` — uživatelský popis
  cíle skoro vždy obsahuje "dokončení"/"complete", takže agent vyhodnotil
  finish v prvním kroku a test vůbec neproběhl. Rozhoduje jen stav stránky.
- Anti-loop ochrana blokovala `wait` a `scroll` natrvalo (klíč `akce:null`
  přes celou historii) a fallback pak alternoval scroll down/up až do
  vyčerpání maxSteps. Teď se kontrolují jen poslední 3 kroky a akce bez
  cíle jsou z kontroly vyjmuté.
- Výkonnostní signály (long task > 100 ms, pomalé API) šly do `bugs`
  a přes `success: bugs.length === 0` označily za neúspěch prakticky
  každou reálnou aplikaci. Odděleno do `warnings`.

Paměť a resource leaky:
- requestStartTimes: klíčováno objektem requestu ve WeakMap. Dřív klíč URL
  (paralelní požadavky na stejnou adresu se přepsaly → nesmyslná latence)
  a delete jen při response (abortované požadavky zůstaly navždy).
- Kroky nesou jen přírůstek logů/bugů, ne kompletní historii — dřív
  kvadratická paměť, která se navíc celá ukládala do Firestore a posílala
  po WebSocketu.
- Deduplikace bugů přes Set místo Array.includes() v handleru volaném na
  každou událost (O(n²)).
- recentEventsCache: LRU se stropem a periodickým úklidem. Dřív se TTL
  kontrolovalo jen při čtení, takže expirované položky se nikdy nemazaly
  a útočník na veřejném endpointu vygeneroval neomezeně klíčů → OOM.
- context.close() před čtením cesty k videu — Playwright ho finalizuje až
  při zavření kontextu, takže spoléhat na browser.close() dávalo useknuté
  soubory.
- auditTranslations: dřív N+1 sekvenčních LLM dotazů bez limitu (500 textů
  = desítky minut na jednom HTTP requestu). Teď strop, souběh 4 a timeout.
  Slovník se zplošťuje, takže vnořený i18n JSON už neshodí audit na
  "val.trim is not a function". Výběr kontextu pro model je skórovaný —
  dřív se při žádné shodě poslalo prvních 20 klíčů podle pořadí v objektu
  a model halucinoval klíč.

Cesty:
- Nový paths.js: agent.js zapisoval do process.cwd(), server.js servíroval
  z path.resolve(). Při spuštění z jiného adresáře to byla dvě různá místa
  a /api/screenshots/... vracelo 404.
- sessionId v názvu screenshotu prochází safeFileToken() (path traversal).

Souběh a plánovač:
- Semafor MAX_CONCURRENT_BROWSERS na audit endpointech, run-testu
  i v plánovači. Dřív 50 aktivních monitorů = 50 Chromium procesů naráz.
- setInterval s async callbackem nahrazen rekurzivním setTimeout — tik delší
  než 60 s dřív spustil další paralelně.
- db.saveSession bez await dostalo .catch() (unhandled rejections).

Mrtvý kód: typeof kontrola na const ve stejném scope.
EOF
```

## Commit 5 — frontend a testy

```bash
git add frontend/src tests/auth.test.js tests/tenant-isolation.test.js .github/workflows/ci.yml
git commit -F- <<'EOF'
fix(frontend,tests): Error Boundary, API vrstva, testy auth a izolace nájemců

Frontend:
- ErrorBoundary kolem <App/>. Bez něj shodila kterákoli chyba v renderu
  celé UI na bílou stránku — konkrétní kandidáti jsou v.nodes[0]
  .failureSummary.replace(), greenResult.green.rating.includes() a další
  místa sahající hluboko do dat ze serveru.
- lib/api.js + lib/firebase.js. Nahrazuje přepisování globálního
  window.fetch z React komponenty (globální mutace prostředí, selhání pro
  Request objekt i absolutní URL, neošetřené vyhození z getIdToken()).
  Zároveň odstraněno 11 volání s `Bearer ${user.token}` — Firebase User
  vlastnost `.token` nemá, posílalo se "Bearer undefined" a fungovalo to
  jen díky tomu, že override hlavičku přepsal.
- Firebase konfigurace z import.meta.env (oddělení dev/staging/prod).
- Výsledky AI Act a DORA Chaos se nikdy nezobrazily — chyběly
  v zobrazovací podmínce, v isAnyAuditLoading i v clearAllResults.
- Pět handlerů loading flag jen vypínalo, nikdy nezapínalo, takže při
  samostatném spuštění uživatel neviděl žádnou zpětnou vazbu.
- Slack: odesílá backend přes nový POST /api/notify/slack (allowlist na
  hooks.slack.com). Volání přímo z prohlížeče vždy selhalo na CORS a catch
  blok to hlásil jako "Report odeslán (Simulace)"; webhook byl navíc
  vystavený v klientském kódu.
- useMemo pro filtr událostí — stejný filtr běžel třikrát v jednom
  renderu nad bufferem až 500 položek.

Testy (74 -> 110):
- tests/auth.test.js: skutečný authenticateToken. Dosud byl ve všech
  server testech vymockovaný na pass-through, takže neexistoval jediný
  test na 401 bez tokenu, 403 pro podvržený/expirovaný token, ani na to,
  že se uid bere z ověřeného tokenu a ne z těla požadavku.
- tests/tenant-isolation.test.js: uživatel A nesmí číst ani měnit data
  uživatele B (monitory, projekty, session, události) + artefakty vyžadují
  capability token + integrační test, že audit endpointy SKUTEČNĚ volají
  SSRF guard (dosud byl guard testovaný izolovaně, ale jeho zapojení do
  rout ne).
- CI pouští celou sadu; job `full-tests` s continue-on-error zrušen.
EOF
```

## Commit 6 — frontend testy, přístupnost a rozdělení App.jsx

Pozor: přidává devDependencies, takže po checkoutu je nutné `npm run install:all`.

```bash
git add frontend package.json eslint.config.js .github/workflows/ci.yml
git commit -F- <<'EOF'
feat(frontend): vitest, oprava přístupnosti a rozdělení App.jsx

Testovací infrastruktura (0 -> 20 testů):
- vitest + Testing Library + jsdom. Frontend neměl žádný test; bug
  `handleAuthSubmit is not defined`, který shazoval přihlašovací obrazovku
  na bílou stránku, by chytil jediný render test.
- src/App.test.jsx — smoke testy renderu a přihlašovacího formuláře.
- src/a11y.test.jsx — regresní testy přístupnosti.
- src/hooks/useAudits.test.js — testy stavu auditů.
- CI job `frontend` pouští testy i build.

Přístupnost (aplikace překládá axe pravidla, která sama porušovala):
- Na obrazovce nebyl ŽÁDNÝ <h1>. Jediný byl uvnitř .print-only
  s display:none — porušení `page-has-heading-one`, jehož český popis je
  přímo v App.jsx.
- 20 labelů dostalo htmlFor a odpovídající id (`label`). Zbylých 8 obaluje
  input, což je platná implicitní vazba.
- Historie, kroky testu a záložky inspektoru byly <div onClick> —
  nefokusovatelné a neovladatelné klávesnicí. Teď <button>, u záložek
  s role="tab" / aria-selected / aria-controls.
- <a href="#" onClick> pro přepínání přihlášení/registrace nahrazeno
  <button>.
- Aktivní záložka nese aria-current, ne jen CSS třídu.
- Stav běhu, průběh testu a spinner auditu mají role="status" +
  aria-live, aby se změny oznámily čtečce.
- Informace nesené jen barvou nebo emoji doplněny textem v .sr-only.
- Přidány :focus-visible styly (dřív jen :hover a :active) a podpora
  prefers-reduced-motion.
- <video> dostal aria-label a muted (němý screencast).
- eslint-plugin-jsx-a11y v configu; label-has-associated-control,
  no-static-element-interactions a click-events-have-key-events jako error.
  Plugin hned našel tři další porušení, která jsou v tomto commitu opravená.

Bezpečnost:
- AuraGuard Hub byl jako JEDINÁ záložka přístupný bez přihlášení — a je
  výchozí. Anonymní uživatel viděl UI, které pak volalo /api/monitors
  a /api/projects bez tokenu; 401 mizely v prázdném catch bloku.

Rozdělení App.jsx (2989 -> 2702 řádků):
- constants/testTypes.js — katalog testů a překlady axe pravidel.
- lib/format.jsx — formatRedactedText, getDomain.
- components/print/PrintReport.jsx — 230 řádků JSX, které se renderovaly
  při KAŽDÉM překreslení, přestože jsou přes .print-only skryté. Teď
  React.lazy, takže v hlavním bundlu nejsou vůbec.
- hooks/useAudits.js — useReducer nahrazující 22 dvojic xLoading/xResult.
  Řeší systémově problém, že nový audit se musel ručně zapojit na tři
  místa (clearAllResults, isAnyAuditLoading, zobrazovací podmínka) —
  a u aiAct a chaos se na to zapomnělo.
- Odstraněno 13 nepoužitých importů z lucide-react.

Bundle: manualChunks pro firebase a react-markdown.
Hlavní chunk 1039 kB -> 227 kB (gzip 276 kB -> 68 kB).
EOF
```

## Commit 7 — regrese z předchozích commitů a dosud nereviewované soubory

Nezávislá kontrolní vlna. Část nálezů jsou regrese zavedené commity 2–6,
část jsou soubory, na které se dosud nikdo nepodíval.

```bash
git add server.js agent.js public/sdk/auraguard.js bin/auraguard-cli.js \
        slack-notifier.js slack-verify.js frontend/src \
        Dockerfile docker-compose.yml .dockerignore .gitignore \
        firebase.json playwright.config.js package.json \
        screenshot.mjs test-db-connector.js .github
git commit -F- <<'EOF'
fix: opravit regrese z bezpečnostních commitů a dosud nereviewované soubory

REGRESE ZAVEDENÉ PŘEDCHOZÍMI COMMITY

- WebSocket upgrade neměl socket.on('error'). Node po emitu 'upgrade' odebere
  vlastní error listener; reset spojení během await verifyIdToken() tak vedl
  na neošetřenou výjimku. V kombinaci s novým uncaughtException handlerem,
  který proces UKONČÍ, z toho byl triviální vzdálený DoS: připojit se na
  /ws a hned spojení resetnout. Doplněn i ws.on('error').
- Videa vracela vždy 404. Playwright je pojmenovává náhodným hashem, ale
  serveVArtifact si sessionId vytahuje z názvu souboru. Video se teď ukládá
  jako `<sessionId>_video.webm`.
- assertNavigationAllowed porovnávalo přesný origin, takže po běžném
  přesměrování (http->https, apex->www) selhala KAŽDÁ další navigace
  a zapsala se jako bug -> falešné poplachy a success:false na běžných
  webech. Nově se porovnává registrovatelná doména a zablokování vlastní
  politikou jde do `warnings`, ne mezi chyby aplikace.
- Slot pro prohlížeč se ve scheduleru bral PŘED try blokem, takže selhání
  db.saveSession slot nikdy neuvolnilo. Po třech takových chybách se
  plánovač i audity zablokovaly natrvalo.
- browserSlotGuard uvolňoval slot i na události 'close', tedy při odpojení
  klienta, zatímco Chromium běželo dál — limit souběžnosti šlo obejít.
- Kroky nesou od optimalizace paměti jen přírůstek logů a chyb; prázdné pole
  je ale truthy, takže fallback v inspektoru byl nedosažitelný a hlásil
  "žádné chyby" i u session, která chyby měla.
- TRUST_PROXY=true se přes Number() změnilo na NaN a Express pak nedůvěřoval
  žádnému hopu — rate limiting za proxy tiše nefungoval.
- Globální error handler přepisoval na 500 i chyby s vlastním statusem
  (400 u nevalidního JSON, 413 u velkého těla) a chyběla kontrola
  res.headersSent.
- `warnings` z agenta nikdo nekonzumoval — ukládají se do session,
  posílají po WS a zobrazují v inspektoru.
- isCompliant === null (NEPRŮKAZNÉ) vykresloval ternární operátor jako FAIL.
  Nový lib/compliance.js dává neprůkaznému výsledku vlastní stav i barvu.
- greenResult.residency.isEUCompliant a .warning UI četlo, ale agent je nikdy
  nevracel — badge byl vždy červený a text prázdný. Doplněno do agenta.
- DORA Chaos neměl v panelu výsledků žádný render blok, takže spuštění testu
  otevřelo prázdný panel. Doplněno.
- PrintReport vypisoval log.message, které kroky agenta nemají (mají
  reasoning) — sekce "Provedené akce" byla v PDF prázdná.
- lib/api.js byl mrtvý kód (App.jsx používá vlastní authFetch).

DOSUD NEREVIEWOVANÉ SOUBORY

- Generované SDK (server.js) mělo NEKONEČNOU SMYČKU: sendReport používal
  přepsaný window.fetch, jehož wrapper při odpovědi >= 400 poslal další
  'network_error' report. Report endpoint přitom běžně vrací 403/404/429.
  Prohlížeč zákazníka tak donekonečna bombardoval server. Opraveno referencí
  na nativní fetch + přeskočením vlastního endpointu ve wrapperu.
- public/sdk/auraguard.js: posílalo location.href včetně query a fragmentu,
  tedy i ?reset_token= a #access_token= (PII redaktor na serveru zná jen
  e-maily, karty a telefony). Nově jen origin+pathname. Přidán strop
  25 reportů na stránku, deduplikace, ochrana proti rekurzi, truncate
  na 4 kB (Firestore má limit 1 MiB) a fallback na XHR, když sendBeacon
  vrátí false.
- CLI: překlep v --audit (např. `nis`) neprošel žádnou větví, hasErrors
  zůstalo false a nástroj vypsal "prošla všemi EU audity" s exit 0 —
  v CI tiše propustil nasazení. Přidán allowlist typů auditu.
- CLI: --url se nevalidovalo a šlo přímo do page.goto(), takže
  `file:///etc/passwd` nebo interní adresa z CI runneru znamenaly čtení
  souborů / SSRF. Přidány rozlišené exit kódy (0/1/2/3) a --help.
- CLI: neúspěšný AI agent test bez nalezených bugů se hlásil jako PASS.
- slack-notifier.js importoval node-fetch, který NENÍ v package.json —
  fungovalo to jen díky hoistingu z firebase-admin. Odstraněno, přidán
  timeout.
- slack-verify.js: Math.abs(now - NaN) > 300 je false, takže nečíselný
  timestamp přeskočil celou kontrolu replay okna.
- Slack endpoint: globální express.json spolkl tělo dřív, než se dostal ke
  slovu express.raw, takže podpis nikdy neseděl a každý JSON požadavek
  dostal 401. Syrové tělo se ukládá přes `verify` callback.
- Dockerfile: kontejner běžel jako root, image byl v1.44 proti
  playwright ^1.60 v package.json (chybějící binárky prohlížečů),
  `npm install` místo `npm ci` a devDependencies v produkčním image.
  Přepsáno na multi-stage build s USER pwuser, HEALTHCHECK a
  `node server.js` místo `npm start` (npm jako PID 1 nepředává SIGTERM).
- .dockerignore nevylučoval firebase-credentials.json — servisní klíč
  Firebase se zapékal do image.
- docker-compose: chybělo env_file (kontejner běžel bez credentials),
  shm_size (Chromium v kontejneru padá) a limity paměti/CPU.
- /api/trigger-test obcházel stropy zavedené pro /api/run-test —
  bez clampu maxSteps a bez vynuceného headless.
- PATCH /api/monitors: `if (patch.url)` propustilo `url: ""` bez validace.
- screenshot.mjs zapisoval na absolutní cestu do JINÉHO projektu na disku
  autora. Parametrizováno.
- test-db-connector.js končil kódem 0, i když validace SQL selhala.
- firebase.json obsahoval neplatný top-level klíč "auth" (no-op).
- playwright.config.js: html reporter s default open:'on-failure'
  po selhání v CI nastartuje server a job visí.

ZÁVISLOSTI

- npm audit hlásil 17 zranitelností (1 kritickou, 7 high) — projekt skenuje
  CVE v knihovnách cizích webů, ale vlastní závislosti nekontroloval.
  `overrides` v package.json (tar, fast-xml-parser, brace-expansion,
  ip-address, uuid) je srazily na 6 low. `npm audit fix --force` se použít
  nedal, protože chtěl degradovat firebase-admin o major verzi.
- Přidán CI job `audit` a .github/dependabot.yml.

Testy: 110 backend + 20 frontend, vše zelené. ESLint 0 chyb.
EOF
```

## Commit 8 — zbylé nálezy a nesoulad dokumentace

```bash
git add server.js agent.js frontend/src README.md package.json
git commit -F- <<'EOF'
fix: doopravit zbylé nálezy, sjednotit dokumentaci s chováním

Backend:
- Slack notifikace o výpadku posílaly `result.responseTime`, ale checkPage
  i checkForm vracejí `durationMs` — v každé zprávě bylo "Odezva: undefinedms".
- hasElementValue() vracela pro checkboxy vždy true: <input type="checkbox">
  bez atributu value má el.value === 'on' i nezaškrtnutý. Větev "zaškrtni
  povinný checkbox" tak byla mrtvá. Rozhoduje `checked`.
- page.on('requestfailed') pushoval do bugs přímo, mimo addFinding, takže
  obcházel deduplikaci. Metoda se navíc hlásila natvrdo jako GET.
- /api/compare, /api/audit-translations a /api/trigger-test spouštěly
  Chromium bez semaforu — limit souběžnosti byl děravý.
- `await db.saveSession()` v /api/run-test bylo mimo try/catch. Express 4
  odmítnuté promise z async handleru nepředává do error middleware, takže
  selhání Firestore znamenalo request visící do timeoutu.
- unhandledRejection jen logoval, přestože komentář o pár řádků výš sliboval
  fail-fast. Sjednoceno do shutdownWithError().
- Pojistka v uncaughtException měla .unref(), takže ji event loop neudržel
  a nikdy se nevykonala — přesně naopak, než komentář tvrdil.
- Přidán graceful shutdown (SIGTERM/SIGINT): schedulerTimer se dřív jen
  přiřazoval a nikdy nerušil.
- reportLimiter klíčoval jen na `project`, což je neověřený vstup od anonyma
  — útočník tak mohl vyčerpat okno konkrétního zákazníka. Nově dvojice
  projekt+IP a druhá, volnější vrstva na projekt.
- /api/auraguard/sdk.js bez PUBLIC_BASE_URL v produkci vrací 503 místo toho,
  aby reflektoval hlavičku Host (fail-closed).
- analyze-security hlásí, kolik ID nebylo nalezeno — getAuraGuardEvents
  vrací jen posledních 500, takže starší ID tiše propadala.
- Artefakty (/api/screenshots, /api/videos) mají vlastní vyšší rate limit:
  session o padesáti krocích načte padesát obrázků najednou a obecných
  300/min by nestačilo. Chrání je capability token, ne limit.
- registrableDomain() vracela pro IP adresy poslední dva oktety, takže
  `1.2.3.4` a `9.9.3.4` vycházely jako stejná doména. IP se porovnávají celé.

Frontend:
- Auto-Heal měl handler i serverový endpoint, ale žádné tlačítko — funkce
  byla z UI nedostupná. Přidáno tlačítko u chybových událostí; autoHealPatch
  je nově mapa eventId -> patch (dřív jedna hodnota pro všechny události).
- selectedProjectId startoval jako '' a <select> neměl prázdnou option, takže
  UI ukazovalo první projekt, ale snippet měl prázdné data-project-id.
- Zobrazený a zkopírovaný SDK snippet se lišily (tlačítko vynechávalo
  data-gdpr-sentinel) — uživatel nasadil jinou konfiguraci, než jakou viděl.
  Nově jeden zdroj pravdy.
- Pole "URL adresa AI serveru" server od zavedení SSRF ochrany ignoruje,
  pokud není v ALLOWED_LLM_HOSTS. Doplněna vysvětlující poznámka —
  bez ní pole vypadalo funkčně, ale hodnota se tiše zahazovala.

Dokumentace a skripty:
- README popisoval chování, které po bezpečnostních změnách neplatí
  (volitelný LLM endpoint). Doplněna tabulka proměnných prostředí
  a návratových kódů CLI.
- `eval:llm` nepředával --strict, takže regrese modelu skončila exit 0
  a v CI se neprojevila.

Navíc opraveno na základě smoke testu proti živému webu:
- extractInteractiveElements registroval vnitřek SVG (<path>, <g>) jako
  klikatelný prvek: SVG elementy nejsou HTMLElement, takže je rychlá kontrola
  viditelnosti (el.offsetWidth === 0) propustila, a `cursor: pointer` dědí
  od tlačítka, ve kterém leží. Agent na <path> klikl, Playwright hlásil
  "element is not stable" -> FALEŠNÝ BUG na funkčním webu.
- Anycast CDN (Firebase, Cloudflare, Fastly, Vercel…) se geolokuje na
  nejbližší PoP, ne na místo uložení dat. Firebase hosting proto dostával
  "3 ze 3 serherů mimo EU/EHP" = červený GDPR verdikt. Nově neprůkazné.
- Seznam zemí se jmenoval "EEA", ale obsahoval jen 27 zemí EU — doplněny
  IS, LI, NO.
- scripts/smoke-test.mjs: ověření proti živému webu, které jednotkové testy
  udělat nemohou (běží proti mockům). Výstup odděluje kontroly NÁSTROJE
  (rozhodují o exit kódu) od nálezů na TESTOVANÉM WEBU — zelená fajfka
  nikdy neznamená "web je v pořádku".

Ověřeno: npm run test:smoke proti https://nexus-sync-8d50b.web.app/logout
prošel 24/24 kontrol nástroje.
EOF
```

---

## Známé zbytky (vědomě neopravené)

- `frontend/src/hooks/useAudits.js` je hotový a otestovaný, ale ještě
  **není zapojený** do App.jsx — ta stále drží 22 ručních `useState`.
  Je to připravený cíl pro pokračování refaktoru, ne mrtvý kód omylem.
- **Není otestované chování za běhu.** Všechny automatické testy běží proti
  mockům — Playwright, Firestore ani LLM se v nich reálně nespustí. Změny
  v agentovi (video `saveAs`, `context.close()`, navigační politika,
  checkbox predikát, opravy skenerů) jsou ověřené jen čtením a jednotkově.

  **Proto ho pusťte před nasazením:**

  ```bash
  cd /Users/zdenekdias/.gemini/antigravity/scratch/auratest-ai

  # jednorázově, pokud ještě nejsou stažené prohlížeče
  npx playwright install chromium

  # výchozí cíl je https://nexus-sync-8d50b.web.app/logout
  npm run test:smoke

  # nebo vlastní adresa
  npm run test:smoke -- https://nexus-sync-8d50b.web.app/logout
  ```

  `scripts/smoke-test.mjs` spustí agenta i všechny skenery proti živému webu
  a ověří přesně ty opravy, které jednotkově potvrdit nejdou. Používá
  `mode: 'monkey'`, takže nepotřebuje běžící LLM. Vypíše tabulku kontrol
  a skončí kódem 1, pokud některá selže.

  Sandbox, ve kterém jsem pracoval, nemá síť ani systémové knihovny pro
  Chromium (a bez roota je nedoinstaluju), takže skript je napsaný, ale
  **z mé strany nespuštěný**.
- `tests/e2e/` obsahuje jediný symbolický test a v CI se nespouští.
- `frontend/src/lib/api.js` zbyl jako prázdný soubor (sandbox mi nedovolil
  mazat) — **smažte ho**: `rm frontend/src/lib/api.js`
  Pozn.: `git rm` na něj nefunguje, protože ho git nikdy nesledoval.
- Auto-Heal (`handleAutoHeal`, `/api/auraguard/auto-heal`) existuje na
  serveru i v App.jsx, ale z UI se nedá spustit — chybí tlačítko.
- `db.getAuraGuardEvents` načítá všechny události a řadí je až v paměti.
  Patří tam `.orderBy('timestamp','desc').limit(500)` a odpovídající
  composite index ve `firestore.indexes.json`.
- Deduplikace událostí, WS klienti i rate limiting jsou per-proces —
  aplikace je fakticky single-instance. Pro škálování je potřeba Redis.

---

## Po checkoutu

Commit 6 přidává devDependencies (vitest, Testing Library, jsdom,
eslint-plugin-jsx-a11y), takže je potřeba:

```bash
npm run install:all
```

## Nové proměnné prostředí

Zavedené v commitu 2, všechny fail-closed — bez nastavení se dotčená
funkce vypne, místo aby zůstala otevřená:

| Proměnná | Účel | Bez ní |
|---|---|---|
| `ALLOWED_LLM_HOSTS` | allowlist LLM endpointů | použije se `LLM_HOST` / localhost |
| `LLM_HOST` | výchozí LLM endpoint | `http://localhost:11434` |
| `ALLOWED_DB_HOSTS` | allowlist DB pro zdroje překladů | DB zdroje překladů nefungují |
| `TRANSLATIONS_SQLITE_DIR` | kořen pro SQLite zdroje | kořen projektu |
| `PUBLIC_BASE_URL` | adresa v generovaném SDK | reflektuje se hlavička Host |
| `TRUST_PROXY` | za reverzní proxy | `req.ip` je IP proxy |
| `MAX_CONCURRENT_BROWSERS` | strop souběžných Chromium | 3 |
| `MAX_AGENT_STEPS` | strop kroků agenta | 50 |
| `EVENT_CACHE_MAX_ENTRIES` | strop deduplikační cache | 10000 |
| `LLM_TIMEOUT_MS` | timeout LLM volání | 60000 |
| `TRANSLATION_AUDIT_MAX_TEXTS` | strop textů na běh | 150 |
| `TRANSLATION_AUDIT_CONCURRENCY` | souběh LLM dotazů | 4 |
| `AURAGUARD_ROOT` | vynucení kořene projektu | hledá se package.json |
