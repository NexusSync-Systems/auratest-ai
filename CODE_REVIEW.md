# Code review — AuraGuard (auratest-ai)

Datum: 20. 8. 2026 · Rozsah: `server.js` (1113 ř.), `agent.js` (2249 ř.), `frontend/src/App.jsx` (2889 ř.), `db.js`, `db-connector.js`, `ssrf-guard.js`, `tests/`, CI.

---

## Souhrn

Projekt má dobré jádro: `ssrf-guard.js`, `slack-verify.js` a `validateReadOnlyQuery` jsou napsané správně a mají slušné testy. `firestore.rules` používá default-deny. Secrets (`.env`, `firebase-credentials.json`) **nejsou** a nikdy nebyly v git historii — ověřeno.

Problém je, že tyto obrany se **nepoužívají tam, kde by měly**. `assertPublicHttpUrl` je zavolán na 3 endpointech z ~15, které přijímají URL od uživatele. WebSocket nemá autentizaci. A frontend obsahuje tři `no-undef` chyby, které shodí přihlašovací obrazovku — ESLint je najde za dvě sekundy, ale CI ho nespouští.

Celkem: **6 kritických**, **11 vysokých**, ~25 středních zjištění.

---

## P0 — Rozbité věci (fix dnes, ~1 hodina)

### 1. Přihlašovací obrazovka spadne — `handleAuthSubmit` neexistuje
`frontend/src/App.jsx:1009` → `onSubmit={handleAuthSubmit}`, ale funkce se jmenuje `handleAuth` (ř. 691).
Bez error boundary to znamená bílou stránku pro každého nepřihlášeného uživatele, který otevře jinou záložku než `auraguard`.
**Fix:** přejmenovat.

### 2. Správa projektů a API klíčů nefunguje — `fetchProjects` neexistuje
`App.jsx:2369` a `2434`; definice je zakomentovaná na ř. 739 (`// fetchProjects(); // Placeholder`).
`projects` se nikdy nenaplní → seznam projektů je vždy prázdný, generátor SDK (ř. 2459) nefunguje.
**Fix:** doimplementovat `GET /api/projects` a zavolat v auth efektu.

### 3. „Uložit do cloudu" vždy selže — chybí Firestore pravidlo pro `/users`
`App.jsx:677` zapisuje do `users/{uid}`, ale `firestore.rules` nemá `match /users/{uid}` → default-deny.
```
match /users/{uid} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
  match /history/{doc} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
}
```

### 4. Zapnout ESLint v CI
`.github/workflows/ci.yml` nespouští lint. Kdyby spouštěl, chytil by #1 i #2.
Pozor: `eslint.config.js` má `ignores: ["frontend/dist/**"]` **uvnitř** objektu s `files`, takže se v flat configu neaplikuje globálně — `js.configs.recommended` dist stejně zlintuje a vyrobí 664 chyb. Ignore patří do samostatného objektu na začátku pole:
```js
export default [
  { ignores: ["frontend/dist/**", "node_modules/**", "adapters/**/.venv/**"] },
  js.configs.recommended,
  { /* ... */ }
];
```
Po této opravě: **3 errory + 36 warnings** v produkčním kódu. Přidat `npx eslint .` jako CI step.

Vedle toho: `frontend/dist/` je commitnutý v gitu → `git rm -r --cached frontend/dist` a přidat do `.gitignore`.

---

## P1 — Bezpečnost (kritické)

### 5. WebSocket nemá autentizaci → cross-tenant leak
`server.js:1052-1073` kontroluje jen *přítomnost* `sessionId`, ne token. A `sessionId` je `session_${Date.now()}` (`server.js:140`) — plně predikovatelné. Kdokoli se připojí na `/ws?sessionId=session_1755...` a čte živě kroky, screenshoty a bugy cizích testů.

Horší: `broadcastToAll` (`server.js:340-349`, voláno na 434, 444, 881) posílá **monitory a AuraGuard eventy všech uživatelů každému připojenému klientovi**.

**Fix:**
- ověřit Firebase ID token při `upgrade`, porovnat `session.userId === decoded.uid`
- `sessionId` → `crypto.randomUUID()`
- mapa `userId → Set<ws>`, broadcastovat jen vlastníkovi

### 6. SSRF — `assertPublicHttpUrl` chybí na 12 endpointech
Použit je jen na `/api/trigger-test` (313), `/api/compare` (988) a `/api/audit-translations` (1013). Chybí na:

`run-test` (133) · `monitors` POST (503, persistentní SSRF přes scheduler) · `analyze-accessibility` (586) · `analyze-nis2` (599) · `analyze-green-gdpr` (612) · `analyze-cra` (625) · `chaos-test` (651) · `ai-act-audit` (674) · `cookie-audit` (686) · `cra-vuln-audit` (698) · `monitor-page` (710) · `monitor-form` (734)

Nejzávažnější je dvojice monitorů: `checkPage` (`agent.js:2164`) používá `redirect: 'follow'` a `target.expectedText` funguje jako **oracle na obsah odpovědi** — po znacích se dá vyčíst `http://169.254.169.254/latest/meta-data/`. `checkForm` (`agent.js:2213`) umí libovolnou HTTP metodu a tělo → POST na interní admin API.

**Fix:** vytáhnout do middleware `urlGuard` a aplikovat na všech 12. Pro `checkPage` navíc `redirect: 'manual'` + re-validace každého hopu, jinak jde guard obejít 302 přesměrováním.

### 7. SSRF přes `llmConfig.host` — libovolný POST na interní službu
`server.js:638` (`auto-heal`) a `server.js:134` (`run-test`) berou `host` z těla requestu; `queryLLM` (`agent.js:28`) na něj udělá `fetch(url, {method:'POST', body})`. Uživatel určuje cíl i tělo požadavku.
**Fix:** `host` nebrat z requestu — allowlist v env (`ALLOWED_LLM_HOSTS`).

### 8. `/api/audit-translations` — `translationSource` bez jakékoli validace
`server.js:1003` validuje `url`, ale `translationSource` předá rovnou do `fetchTranslations` (`db-connector.js:11`), kde podle `type`:
- `api` → `fetch(config.apiUrl, {headers})` s útočníkem zvolenými hlavičkami — SSRF bez kontroly
- `postgres`/`mysql` → `new Client({host: dbHost, port: dbPort})` — skenování interních portů, chybové hlášky se vracejí klientovi (`server.js:1047`)
- `sqlite` → `fs.existsSync(sqlitePath)` + otevření libovolného souboru — path traversal / oracle na existenci souborů
- `script` → `execAsync(cmd, {cwd: config.cwd})` — příkaz je na whitelistu, ale `cwd` je z uživatelského vstupu

**Fix:** `apiUrl` přes `assertPublicHttpUrl`; `dbHost` allowlist z env; `sqlitePath` omezit na dedikovaný adresář s kontrolou prefixu po `path.resolve`; `cwd` ignorovat.

### 9. Screenshoty a videa bez autentizace
`server.js:59, 65` — `express.static`. Názvy jsou `session_<timestamp>_step_N.png` (`agent.js:1164`), tedy uhodnutelné. Screenshoty typicky obsahují přihlášené obrazovky, protože `testLogin`/`testPassword` se do testu předávají (`server.js:169-170`).
**Fix:** route s `authenticateToken`, ověření vlastnictví session, `res.sendFile(name, {root: dir})` + regex `/^[\w.-]+\.(png|webm)$/`.

### 10. Code injection do generovaného Playwright skriptu
`agent.js:753-775`:
```js
script += `  await page.fill('[data-qa-id="${step.target}"]', '${step.value}');\n`;
```
`step.value` pochází z LLM / obsahu stránky, bez escapování. Hodnota `'); require('child_process').exec('...'); //` vyrobí spustitelný `.spec.ts` zapsaný na disk (ř. 1286) → RCE na vývojářském stroji nebo v CI, jakmile ho někdo spustí přes `npx playwright test`.
**Fix:** `JSON.stringify(step.value)` místo interpolace do apostrofů — platí i pro `target`, `startUrl` a `reasoning` v komentáři.

### 11. Testovací credentials unikají do LLM a do artefaktů
`agent.js:817-820` vkládá `testLogin`/`testPassword` přímo do system promptu posílaného na `llmConfig.host` (= hodnota z HTTP requestu, viz #7). Heslo pak končí i v `stepData.value` (ř. 1204) → DB + WebSocket broadcast, a v generovaném skriptu na disku (ř. 764).

`pii-redactor.js` v repu existuje, ale v `agent.js` se **nepoužívá vůbec**.

**Fix:** do promptu posílat placeholder (`{{TEST_PASSWORD}}`), nahradit až v `page.fill()`. Ve `stepData`, skriptu a lozích maskovat přes `redactEventData`.

### 12. SSRF přes LLM-řízenou navigaci
`agent.js:1231` — agent naviguje na URL, kterou vybral LLM na základě obsahu testované stránky. Sanitizace (ř. 574) povolí jakékoli absolutní `http(s)://`. Prompt injection na testované stránce → agent naviguje na cloud metadata endpoint, udělá screenshot a text pošle zpět do promptu i reportu.
**Fix:** allowlist originů odvozený ze startovní URL + `assertPublicHttpUrl` na každý hop + `context.route()` blokující požadavky mimo allowlist.

---

## P2 — Bezpečnost (vysoké)

| # | Zjištění | Místo |
|---|---|---|
| 13 | **Mass assignment** — `db.updateMonitor(req.params.id, req.body)` bez filtru → uživatel přepíše `userId` a ukradne cizí monitor | `server.js:531` |
| 14 | **Žádný rate limiting** nikde. Nejbolestivější u veřejného `/api/auraguard/report` (819, neomezené zápisy do Firestore) a u audit endpointů (každý request = Chromium) | celý `server.js` |
| 15 | **Origin check obcházitelný** — když útočník `Origin` nepošle, kontrola se celá přeskočí (`&& origin`); `startsWith` propustí `example.com.evil.com` | `server.js:829-834` |
| 16 | **Neomezený počet Chromium instancí** — `maxSteps` bez horní hranice (`server.js:167`), `headless` volitelné klientem (166) | `server.js`, `agent.js` |
| 17 | **`uncaughtException` jen loguje, proces běží dál** — anti-pattern, zůstávají viselé browsery | `server.js:17-19` |
| 18 | **Timing-unsafe porovnání** trigger secretu — správný vzor je přímo v repu (`slack-verify.js:49`) | `server.js:300` |
| 19 | **Reflexe `Host` hlavičky** do generovaného SDK → přesměrování telemetrie zákazníků; endpoint navíc bez auth | `server.js:897` |
| 20 | **`analyze-security` bez ověření vlastnictví** — funguje jako neomezený LLM proxy + prompt injection přes `events[].data.message`, jehož výstup se zobrazí jako bezpečnostní doporučení. Komentář na ř. 570 to sám přiznává | `server.js:568-579` |
| 21 | **Interní chybové zprávy klientovi** (`details: err.message`) — Firestore/pg/mysql chyby prozradí hostnames a cesty | `server.js:1102` |
| 22 | **`recentEventsCache` roste bez limitu** — TTL se kontroluje jen při čtení; útočník na veřejném endpointu vygeneruje neomezeně klíčů → OOM | `server.js:816` |
| 23 | **Path traversal ve jménu screenshotu** — `sessionId` u monitorů pochází z DB | `agent.js:1164` |

---

## P3 — Compliance skenery dávají špatné výsledky

Toto je pro produkt prodávaný jako compliance nástroj nejzávažnější kategorie — reporty jsou dnes v několika modulech prokazatelně nesprávné.

### 24. NIS2/PQC — `securityDetails()` je Promise, nikdy se nečeká
`agent.js:1661`:
```js
securityDetails = response.securityDetails();   // vrací Promise<SecurityDetails|null>
...
const pqc = { secure: !!securityDetails, protocol: securityDetails ? securityDetails.protocol : 'None', ... }
```
Důsledky:
- `pqc.secure` je **vždy `true`**, i na čistém HTTP
- `pqc.protocol` je `undefined` → žádná větev neprojde → **každý web včetně TLS 1.3 dostane hlášku „Zastaralý protokol! Okamžitě aktualizujte konfiguraci serveru kvůli zranitelnosti."**
- `subjectName`/`issuer` jsou v reportu `[object Promise]`

Druhá chyba tamtéž (ř. 1658): hlavičky se berou jen když `response.url() === url`. Po redirectu (`http→https`, `www.`) se URL neshodne → `headers` zůstane `null` → **všechny NIS2 kontroly (HSTS, CSP, XFO, XCTO) hlásí `false`**.

**Fix:**
```js
const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
const headers = response.headers();
const sec = await response.securityDetails();
```
Navíc: kontroly jsou jen `!!header`. `Strict-Transport-Security: max-age=0` projde jako PASS, CSP s `unsafe-inline *` projde jako PASS, chybějící `X-Frame-Options` je FAIL i tam, kde je moderní `frame-ancestors 'none'`.

### 25. AI Act — substring `'ai'` znamená 100% false negative
`agent.js:1995`:
```js
const hasDisclaimer = ... || pageText.includes('ai') || ...
```
`'ai'` je podřetězec slov **email, detail, main, mail, fair, retail**. Prakticky každá stránka projde jako `isCompliant: true` → skener nikdy nic nenajde.
**Fix:** regex se slovními hranicemi `\b(ai|umělá inteligence|generativní|vygenerováno AI)\b`. Detekce je navíc omezena na 4 hostnames volané z prohlížeče — většina AI integrací běží server-side. Výsledek prezentovat jako indikátor, ne jako „PASS: splňuje AI Act" — takové tvrzení je právně neobhajitelné.

### 26. CRA/SBOM — prázdný SBOM se hlásí jako PASS
`agent.js:1835-1871` detekuje 7 knihoven přes globální proměnné na `window`. Bundlovaná aplikace (Vite/webpack, ESM, tree-shaking) do `window` neexportuje nic → `sbom: []` → `auditCRAVulnerabilities` vrátí `isCompliant: true, rating: 'Nejsou detekovány žádné knihovny.'`

To je nejnebezpečnější typ false negative: „vše v pořádku", protože skener nic neviděl.

Návazné chyby v OSV dotazu (ř. 2093):
- React má verzi `'detekováno (přes DevTools)'`, filtr kontroluje jen rovnost s `'detekováno'` → neprojde → `.replace(/[^0-9.]/g,'')` udělá `''`
- Vue `'3.x'` → `'3.'` (neplatná verze)
- `'vue.js'` a `'next.js'` nejsou npm názvy (správně `vue`, `next`)
- Selhání OSV (`!response.ok`) se tiše ignoruje → opět PASS

**Fix:** fingerprinting načtených `.js` assetů (Retire.js signature DB); mapa `displayName → npmName`; při prázdném SBOM vracet `isCompliant: null` + `rating: 'INCONCLUSIVE'`.

### 27. GDPR cookie audit — nevidí HttpOnly cookies
`agent.js:2031` používá `document.cookie`, které **HttpOnly cookies nevidí** — tedy právě server-side tracking. Allowlist má 3 prefixy (`_ga`, `_fbp`, `_hj`); chybí `_gid`, `_gcl_au`, `_uetsid`, `_clck`, `IDE`, `li_sugr`, `_ttp`, `_scid`. `c.includes('_ga')` matchuje i hodnotu cookie, ne jen název.
**Fix:** `await context.cookies()` + monitoring `page.on('request')` proti blocklistu (EasyPrivacy) + sessionStorage.

### 28. EAA/axe — chybí filtr tagů, zahazuje se `incomplete`
`agent.js:1619` — `new AxeBuilder({page}).analyze()` bez `.withTags([...])` běží i `best-practice` pravidla → nálezy, které nejsou porušením WCAG 2.1 AA / EN 301 549. `results.incomplete` se zahazuje.
```js
.withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','EN-301-549'])
```

### 29. Chaos test hlásí vlastní latenci jako pád aplikace
`agent.js:1900` — test injektuje 3s latenci u ~20 % requestů; když se kvůli tomu překročí 30s timeout, výsledek je `pageCrashed = true` → „Failed (Fragile)". `Math.random()` není seedovaný → nereprodukovatelné výsledky.

### 30. `getGridEnergyStatus` je `Math.random()` prezentovaný jako fakt
`agent.js:1960-1974` — `renewablePercentage: Math.floor(Math.random() * 20) + 10`, servírováno přes `/api/auraguard/grid-status`. V compliance produktu je to zavádějící.
**Fix:** napojit ENTSO-E / Electricity Maps, nebo endpoint explicitně označit `"simulated": true` a zobrazit to v UI.

### 31. Data residency z IP geolokace
`agent.js:1729-1794` — `geoip-lite` má zastaralou vestavěnou DB a anycast CDN (Cloudflare, Fastly) se geolokuje na PoP, ne na místo uložení dat. Web hostovaný v EU za Cloudflare dostane `usesUSServers: true`. Seznam `euCountries` (ř. 1762) má 27 zemí EU, ale komentář říká „EEA" — chybí IS, LI, NO.

---

## P4 — Správnost a robustnost

| # | Zjištění | Místo |
|---|---|---|
| 32 | **`queryLLM` může vrátit `undefined`** — po vyčerpání 12 pokusů smyčka doběhne bez `return`/`throw`; volající pak dělá `responseText.replace()` → `TypeError` | `agent.js:26-104` |
| 33 | **Žádný timeout na LLM fetch** — chybí `AbortController`; zaseknuté spojení × 12 retry = neomezená session | `agent.js:28, 58, 118, 139` |
| 34 | **`hasElementValue()` a `isDisabledElement()` vždy vrací `false`** — `extractInteractiveElements` (ř. 201) `value` ani `disabled` neextrahuje. Celá logika „nepřepisuj vyplněné pole" a „nekliknej na disabled" je mrtvá | `agent.js:295, 311` |
| 35 | **Předčasný `finish`** — `isCompletionContext` matchuje i `goal`, což je uživatelský text obvykle obsahující „dokončení"/"complete" → test skončí v prvním kroku | `agent.js:353` |
| 36 | **Long tasks počítány jako bugy** — `success: bugs.length === 0`, ale observer loguje varování při každém tasku > 100 ms → prakticky každá reálná aplikace je `success: false` | `agent.js:1062, 1087` |
| 37 | **Anti-loop blokuje `wait` a `scroll` natrvalo** — klíč `akce:target` přes celou historii; fallback pak alternuje scroll down/up až do `maxSteps` | `agent.js:677` |
| 38 | **Fire-and-forget `db.saveSession`** bez `await`/`.catch()` — překrývající se zápisy celého pole `steps` mohou ztratit kroky; kvadratický objem dat do Firestore | `server.js:192, 229, 414` |
| 39 | **Scheduler: překryv tiků + neatomická rezervace** — `setInterval` s async callbackem; read-then-write místo transakce → monitor se spustí dvakrát | `server.js:352-452` |
| 40 | **`context.close()` se nevolá** — Playwright finalizuje video až při zavření kontextu; spoléhat na `browser.close()` dává useknuté soubory | `agent.js:1270-1302` |
| 41 | **`process.cwd()` vs `__dirname`** — `agent.js` zapisuje do `cwd`, `server.js` servíruje z `__dirname` → 404 na screenshoty při spuštění z jiného adresáře | `agent.js:1165` vs `server.js:55` |
| 42 | **Memory leak `requestStartTimes`** — `delete()` jen při response; abortované requesty zůstanou. Klíč je URL → paralelní requesty na stejnou URL se přepíší | `agent.js:1120` |
| 43 | **Kvadratická paměť ve `steps`** — každý krok kopíruje kompletní `consoleLogs` a `bugs` | `agent.js:1206` |
| 44 | **`auditTranslations`: N+1 LLM volání** bez limitu a timeoutu — 500 textů = 500 sekvenčních dotazů; spadne na vnořeném i18n JSONu (`val.trim is not a function`, ř. 1464) | `agent.js:1476-1568` |
| 45 | **Jeden `wsRef` pro dvě spojení** — první spuštění testu natrvalo zabije globální AuraGuard stream; není reconnect | `App.jsx:744, 805` |
| 46 | **WS se nezavírá při unmountu** — v `React.StrictMode` dvě paralelní spojení → duplicitní eventy | `App.jsx:714-772` |
| 47 | **Chybí Error Boundary** — konkrétní kandidáti na pád: `v.nodes[0].failureSummary.replace()` (1497), `greenResult.green.rating.includes()` (1572) | `main.jsx` |
| 48 | **Výsledky AI Act a DORA Chaos se nikdy nezobrazí** — chybí v podmínce na ř. 1461 a v `isAnyAuditLoading` (1064); `chaosResult` je podle ESLintu nepoužitá proměnná | `App.jsx` |
| 49 | **5 handlerů nikdy nezapne loading flag**, jen ho vypíná | `App.jsx:446, 463, 480, 497, 513` |
| 50 | **Slack webhook z prohlížeče + falešný úspěch** — Slack neposílá CORS hlavičky, request vždy selže, ale `catch` zobrazí „Report odeslán (Simulace)". Webhook je navíc v klientském kódu | `App.jsx:530-548` |
| 51 | **Hardcoded `http://localhost:3001`** u videa | `App.jsx:1395` |
| 52 | **`window.fetch` monkey-patch** — globální mutace z React komponenty; maskuje bug, že 11 handlerů posílá `Bearer ${user.token}`, přičemž Firebase `User` vlastnost `.token` nemá | `App.jsx:654-671` |

---

## P5 — Architektura

### 53. Tři monolity: 1113 + 2249 + 2889 řádků
`App.jsx` má **99 `useState`, 0 `useMemo`, 0 `useCallback`** — každý stisk klávesy re-renderuje celý strom včetně vždy namontované tiskové sekce (~230 ř. JSX).

Nejvíc vrátí investice: 22 dvojic `xLoading`/`xResult` nahradit jedním `useReducer` se stavem `audits: Record<AuditId, {status, data, error}>`. To systémově vyřeší #48 i #49 — přidání auditu už nepůjde zapomenout zapojit do `clearAllResults` a `isAnyAuditLoading`.

Návrh členění je v příloze na konci.

### 54. Osm identických copy-paste handlerů
`server.js:586-708` — `analyze-accessibility`, `analyze-nis2`, `analyze-green-gdpr`, `analyze-cra`, `chaos-test`, `ai-act-audit`, `cookie-audit`, `cra-vuln-audit` mají stejnou strukturu. **To je také důvod, proč u všech osmi chybí SSRF kontrola** (#6) — přidávaly se kopírováním.
```js
const AUDITS = { accessibility: auditAccessibility, nis2: auditNIS2AndPQC, /* ... */ };
app.post('/api/auraguard/audit/:kind', authenticateToken, urlGuard, async (req, res, next) => {
  const fn = AUDITS[req.params.kind];
  if (!fn) return res.status(404).json({ error: 'Neznámý typ auditu.' });
  try { res.json(await fn(req.safeUrl)); } catch (e) { next(e); }
});
```
Jedno místo = jedna SSRF kontrola, jeden rate limit.

### 55. Devětkrát stejný Playwright boilerplate
`agent.js` — 9 funkcí opakuje launch/newContext/newPage + `finally { browser.close() }`, každá s jinými timeouty a `waitUntil`. Helper `withPage(url, opts, fn)` ušetří ~120 řádků a **centralizuje SSRF kontrolu na jedno místo**.

### 56. In-memory stav nepřežije restart a neškáluje
`sessions` (`server.js:76`, mrtvý kód — zapisuje se, nikdy nečte), `wsClients` (78), `recentEventsCache` (816) jsou per-proces. Při dvou instancích za LB visí WS klient na instanci A, ale test běží na B → zpráva nedojde. Scheduler navíc běží v každé instanci. Aplikace je dnes fakticky single-instance.

### 57. Dvě verze SDK vedle sebe
`server.js:890-974` generuje SDK v template stringu; `public/sdk/auraguard.js` je druhá kopie.

### 58. Mrtvý kód
- `server.js:852-861` — deduplikační notifikace přes `req.app.locals.wss`, které se nikde nenastavuje; `ws.projectId` taky ne. No-op.
- `agent.js:991-994` — `try { extractedReasoning = "..." } catch(e) {}` bezpodmínečně přepíše zprávu s `err.message`.
- `agent.js:1262-1268` — `if (typeof bugs !== 'undefined')` na `const` ve stejném scope.

---

## P6 — Testy a CI

**CI záměrně spouští 2 ze 7 testovacích souborů:**
```yaml
# Zaměřeno na bezpečnostní moduly, aby CI zůstalo zelené.
- run: npx jest tests/ssrf-guard.test.js tests/slack-verify.test.js
```
CI, které vynechává padající testy, není CI. `utils.test.js` (479 ř. kvalitních testů), `server.test.js`, `auraguard-hub.test.js`, `monitoring.test.js` a `pii-redactor.test.js` se nikdy nespustí a mohou tiše hnít.

Kvalita existujících testů je přitom nadprůměrná: `ssrf-guard.test.js` (13 reálných bypass vektorů), `slack-verify.test.js` (HMAC + replay), `utils.test.js` (24 case pro `sanitizeActionResponse`).

**Největší díra: autentizace je ve všech server testech vymockovaná** (`tests/server.test.js:13`, `auraguard-hub.test.js:66` — pass-through, který vždy nastaví `req.user`). Neexistuje test, že:
- neautentizovaný request dostane 401
- podvržený token je odmítnut
- uživatel A nevidí data uživatele B

Pro job pojmenovaný „Bezpečnostní testy" je to zásadní. Netestováno je 22 z ~29 endpointů, včetně všech 8 audit endpointů — takže **není ověřeno, že audit endpointy vůbec volají SSRF guard** (modul je otestovaný izolovaně, integrace není).

Dále chybí: lint step, build frontendu, `npm audit`, Dependabot, jakýkoli frontend test (bug #1 by chytil jediný render test), E2E job.

Drobnost: `tests/auraguard-hub.test.js:5-11` — `monitors`/`projects` se neresetují mezi testy, testy jsou závislé na pořadí. A mockování `fs` přímým přiřazením (ř. 86-100) prosákne do dalších souborů, když test uprostřed vyhodí.

> Pozn.: `npx jest` se mi v sandboxu nepodařilo spustit (resolver nenašel `babel-jest/build/index.js`, přestože soubor existuje — nejspíš artefakt mountu). Stav testů jsem tedy neověřoval spuštěním, jen čtením.

---

## P7 — Přístupnost

`grep -c "aria-\|role=" App.jsx` → **0**. Aplikace, která překládá axe pravidla `label`, `button-name` a `page-has-heading-one` (App.jsx:98-110), tato pravidla sama porušuje.

- Na obrazovce **není žádný `<h1>`** — jediný je v `.print-only`, který má `display:none`
- **~22 `<label>` bez `htmlFor`** (z 51 labelů má `htmlFor` jen 21) — včetně přihlašovacího formuláře
- Záložky inspektoru (1695) a položky historie (1125) jsou `<div onClick>` — nefokusovatelné, bez klávesnice
- `<a href="#" onClick>` místo `<button>` (1053)
- Žádné `:focus-visible` styly pro `.btn`, `.nav-item`
- Stav sdělený pouze barvou (status-dot, badge Aktivní/Neaktivní)
- Spinner bez `role="status"`/`aria-live`
- 31× `alert()`/`confirm()`
- `<video>` bez `<track>` a `aria-label`

**Doporučení:** `eslint-plugin-jsx-a11y` do configu a spustit vlastní EAA audit proti `localhost:3000`. Dogfooding tady bude přesvědčivější než marketing.

Vedlejší ironie: aplikace auditující data residency načítá fonty z Google Fonts (US endpoint).

---

## Doporučené pořadí

| Fáze | Co | Odhad |
|---|---|---|
| **1. Dnes** | #1-4: `handleAuthSubmit`, `fetchProjects`, `/users` v rules, ESLint do CI (+ oprava `ignores`) | 1 h |
| **2. Tento týden** | #5-12: WS auth, `urlGuard` na 12 endpointů, `llmConfig.host` allowlist, `translationSource`, chráněné screenshoty, `JSON.stringify` v codegenu, credentials pryč z promptu | 2-3 dny |
| **3. Validita produktu** | #24-26: NIS2 `await securityDetails()` + hlavičky z `goto()`, AI Act `\bai\b`, CRA „prázdný SBOM ≠ PASS". Zavést status `INCONCLUSIVE` napříč skenery | 1-2 dny |
| **4. Stabilita** | #13-23, #32-52: rate limiting, mass assignment, Error Boundary, WS refy, timeouty na LLM, mrtvé predikáty | 3-5 dní |
| **5. Testy** | Test autentizace a multi-tenant izolace, integrační test SSRF guardu na audit endpointech, `npm test` v CI | 2-3 dny |
| **6. Refaktor** | #53-58: `withPage` helper, tabulka auditů, rozbití `App.jsx`, `useReducer` pro audity, `lib/api.js` | průběžně |
| **7. A11y** | `eslint-plugin-jsx-a11y` + vlastní EAA audit | 1-2 dny |

Fáze 3 bych osobně nepodřazoval fázi 2 — pokud se produkt prodává na NIS2 a zákazník dostane report tvrdící „zastaralý protokol" o serveru s TLS 1.3, je to reputační i obchodní riziko srovnatelné s bezpečnostní dírou.

---

## Příloha: návrh členění

**`agent.js` → `agent/`**
```
llm/client.js          queryLLM + jednotná retry/timeout/parse vrstva   (10-154)
llm/prompts.js         system/user prompty                              (891-964, 1497-1544, 1587-1597, 1807-1820)
browser/session.js     withPage() helper — centrální SSRF kontrola
browser/extract.js     extractInteractiveElements, extractPageTexts     (160-228, 696-748)
agent/policy.js        sanitizeActionResponse + predikáty               (230-690)
agent/runner.js        runAutonomousTest, determineNextAction           (812-1303)
codegen/playwright.js  generatePlaywrightScript                         (753-775)
audits/{a11y,nis2,gdpr-cookies,cra-sbom,ai-act,green,chaos}.js          (1609-2141)
monitoring/http.js     checkPage, checkForm                             (2147-2249)
config/constants.js    magic numbers (0.81 g CO2/MB, 100ms, 1500ms, ...)
```

**`server.js` → `routes/`**
```
routes/{sessions,monitors,projects,auraguard,slack}.js
middleware/url-guard.js
ws/server.js
scheduler/index.js     (spouštět jen když process.env.ROLE === 'scheduler')
```

**`App.jsx` → `frontend/src/`**
```
components/tabs/{AgentRunner,Compare,TranslationAudit,Settings,AuraGuardHub}.jsx
components/audit/AuditResults.jsx    (1478-1676)
components/print/PrintReport.jsx     (2656-2885, lazy)
hooks/{useAuth,useWebSocket,useAudits,useGridStatus}.js
lib/api.js                           (nahradí window.fetch override)
constants/testTypes.js               (69-110)
```

---

## Co je udělané dobře

Aby review nevyznělo jednostranně:

- `ssrf-guard.js` — CIDR kontrola všech resolvovaných IP včetně IPv4-mapped IPv6, blokace CGNAT a metadata endpointu. Napsané správně.
- `slack-verify.js` — HMAC s `timingSafeEqual` a replay ochranou. Vzor, který by se měl použít i na `server.js:300`.
- `validateReadOnlyQuery` — odstranění komentářů před kontrolou, blokace stacked queries.
- `firestore.rules` — default-deny + owner check (chybí jen `/users`).
- Secrets nejsou a nikdy nebyly v git historii.
- `tests/utils.test.js` — 24 case pro `sanitizeActionResponse` včetně edge cases. Kvalitní práce.
