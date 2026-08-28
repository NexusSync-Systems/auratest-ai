# Tajemství a konfigurace

Přehled toho, co se kde nastavuje, aby AuraGuard běžel. Rozdělené podle
místa, kam hodnota patří — protože to jsou tři různá místa s různým
režimem ochrany a plete se to.

---

## 1. GitHub Actions — **žádná tajemství nepotřebuje**

Workflow `.github/workflows/ci.yml` neodkazuje na jediný `secrets.*`.
Dělá čtyři věci — lint, testy, `npm audit`, build frontendu — a ani jedna
nesahá na Firebase, Slack ani na produkci.

Je to záměr, ne opomenutí. Workflow běží i na pull requesty, tedy
potenciálně s kódem, který nepsal nikdo z firmy. Kdyby měl přístup
k tajemství, stačilo by poslat PR, který ho vypíše do logu. Proto má
workflow taky `permissions: contents: read` — nemůže do repozitáře
zapisovat.

**Do repozitáře tedy žádné secrets nastavovat nemusíš.**

Kdybychom někdy přidali automatické nasazení z Actions, teprve pak by
přibylo (a chtělo by to `environment` s ruční aprobací):

| Secret | K čemu |
|---|---|
| `SSH_HOST`, `SSH_USER`, `SSH_KEY` | přístup na Nexus |

Frontendové `VITE_FIREBASE_*` mezi secrets nepatří ani tehdy. Vite je
zapéká do bundlu, takže je stejně vydáme každému návštěvníkovi — web
config Firebase je veřejný z principu a chrání ho Firestore rules, ne
utajení. Uložit je mezi secrets by budilo dojem, že je něco chrání.

---

## 2. Server (Nexus) — soubor `.env` vedle `docker-compose.yml`

Vyjdi ze šablony: `cp .env.example .env`. `deploy.sh` při startu ověří,
že to podstatné je vyplněné, a jinak nasazení zastaví.

### Povinné v produkci

| Proměnná | Poznámka |
|---|---|
| `NODE_ENV=production` | jinak zůstanou zapnuté vývojové úlevy |
| `PORT=3001` | port uvnitř kontejneru |
| `TRUST_PROXY=1` | **za Caddy musí být 1.** Jinak je `req.ip` vždycky adresa proxy, takže rate limiting počítá všechny návštěvníky jako jednoho |
| `ALLOWED_ORIGINS` | odkud smí chodit prohlížeč; bez toho CORS propustí cokoli |
| `PUBLIC_BASE_URL` | základ odkazů na screenshoty a videa v reportech |

### Povinné, pokud nechceš mít registraci otevřenou všem

| Proměnná | Poznámka |
|---|---|
| `ALLOWED_EMAILS` | čárkou oddělené adresy |
| `ALLOWED_EMAIL_DOMAINS` | domény bez zavináče; oba seznamy se sjednocují |

Registrace ve Firebase je otevřená — kdokoli, kdo najde adresu, si účet
založí. Kontrola je až v ověřovacím middlewaru na serveru. `deploy.sh`
nasazení zastaví, když ani jedna proměnná není vyplněná; vědomé
otevření se potvrzuje `ALLOW_ANY_EMAIL=true`.

### Není v `.env` — samostatný soubor

`firebase-credentials.json` vedle `docker-compose.yml`. Je to servisní
klíč pro `firebase-admin` (Auth + Firestore), čte ho `db.js`. Do gitu
nepatří a `deploy.sh` mu nastavuje práva `600`. Bez něj neběží přihlášení
ani ukládání výsledků.

### Volitelné — funkce, které se bez hodnoty tiše vypnou

| Proměnná | Co se stane bez ní |
|---|---|
| `ALLOWED_LLM_HOSTS` | **prázdná hodnota = LLM vypnuté.** Předpisové skeny na modelu nezávisí a jedou v plném rozsahu; vypnou se jen agentní režimy |
| `LLM_HOST`, `LLM_TIMEOUT_MS` | výchozí `http://localhost:11434`, 120 s |
| `ALLOWED_DB_HOSTS` | prázdné = skenování databází vypnuté |
| `TRIGGER_TEST_SECRET` | prázdné = endpoint pro spuštění testu z venku je vypnutý |
| `SLACK_COMPLIANCE_BOT_TOKEN` + `SLACK_COMPLIANCE_SIGNING_SECRET` | hlášení o shodě se přeskočí |
| `SLACK_UPTIME_BOT_TOKEN` + `SLACK_UPTIME_SIGNING_SECRET` | hlášení o dostupnosti se přeskočí |
| `SLACK_AI_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL` | ostatní hlášení |
| `ANCHOR_SLACK_CHANNEL` | **viz níže** — má důsledek na důkazní hodnotu |
| `ANCHOR_INTERVAL_MS` | výchozí 24 h |

### Volitelné — ladění zátěže

`MAX_CONCURRENT_BROWSERS` (2), `BROWSER_SLOT_MAX_HOLD_MS` (300000),
`MAX_AGENT_STEPS` (50), `TLS_PROBE_TIMEOUT_MS` (8000),
`MAX_C2PA_SAMPLES` (10), `TRANSLATION_AUDIT_MAX_TEXTS` (200),
`TRANSLATION_AUDIT_CONCURRENCY` (3), `EVENT_CACHE_MAX_ENTRIES` (1000),
`BROWSER_ARGS`, `AURAGUARD_ROOT`.

---

## 3. Ukotvení otisku — jediná volitelná proměnná s právním dopadem

`ANCHOR_SLACK_CHANNEL` vypadá jako další nastavení Slacku, ale není.

Řetězení otisků odhalí zásah doprostřed historie. Useknutí konce
neodhalí — zbylý řetěz je po odstranění posledních položek dokonale
konzistentní. Vyloučit to jde jedině tak, že otisk hlavy pravidelně
opustí systém.

Bez odchozího kanálu zůstane kotva ve stavu `internal-only` a spis ji
**nepočítá za doklad**, protože kopie uložená vedle záznamu je pod
stejnou rukou jako záznam sám.

Když Slack nepoužíváte, uložte otisk ručně jinam a potvrďte to:

```
node scripts/anchor-ledger.mjs --check --saved "e-mail"
```

Je to prohlášení provozovatele, ne měření — nástroj nemá jak ověřit, že
se to opravdu stalo, a spis to tak i uvede.
