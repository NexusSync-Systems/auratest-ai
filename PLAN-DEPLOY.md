# Plán nasazení AuraGuard

**Zadání:** soukromá ukázka / pilot, LLM zatím vypnutý (jen compliance skenery
a agent v režimu monkey), hlavní běh na Oracle Cloud VM, Cloud Run jako záloha.

---

## Proč zrovna tahle kombinace

AuraGuard není běžná webová aplikace. Tři vlastnosti určují, kde může běžet:

| Požadavek | Odkud plyne | Důsledek |
|---|---|---|
| ~1 GB RAM + 300 MB disku na Chromium | Playwright ve všech skenerech | Vyřazuje free tiery s 512 MB (Render, Koyeb) |
| Raw TCP sokety na libovolný port | `tls-audit.js` — `net.connect()`, `tls.connect({ ecdhCurve })`, ruční ClientHello | Vyřazuje celou edge/serverless větev (Workers, Vercel Edge, Deno Deploy) |
| Requesty až ~70 s | Chaos test dělá baseline i chaos běh, každý s 30s timeoutem + 5s pozorováním | Vyřazuje platformy s limitem 10–60 s |
| Perzistentní WebSocket | `ws` v `server.js` — živé logy agenta | Serverless jen s výhradami |

Oracle VM splní všechno bez kompromisu a existující `docker-compose.yml` se
použije skoro beze změn. Cloud Run splní taky, ale za cenu úprav (artefakty do
Cloud Storage, `/dev/shm`, strop 60 min na WebSocket) — proto jako záloha, ne
jako hlavní běh.

---

## Fáze 0 — co je potřeba opravit PŘED nasazením

**STAV: hotovo.** Popis níž zůstává jako záznam, proč se to dělalo.

Tohle nebyla vylepšení, ale věci, které by nasazení rozbily. Vyplynuly
z průzkumu repozitáře, ne z obecné metodiky.

### 0.1 Bez Ollamy skončí agent chybou, ne degradací

`server.js:322` nastavuje `DEFAULT_LLM_HOST` na `http://localhost:11434`.
Když se rozhodne LLM nenasazovat, každé volání agenta v LLM režimu skončí
odmítnutým spojením a uživatel dostane chybu bez vysvětlení.

**✅ Hotovo.** `ALLOWED_LLM_HOSTS=` (prázdné) teď znamená VYPNUTO — v kódu
`??` místo `||`, protože `||` by prázdný řetězec přepsalo výchozím
localhostem. Server režimy závislé na modelu odmítne s HTTP 503 a
srozumitelnou hláškou **ještě před založením session**, takže po sobě
nenechá mrtvý záznam ve stavu „running". Přibyl endpoint `GET
/api/capabilities`; frontend si podle něj přepne výchozí režim na `monkey`
a AI volby vůbec nenabídne.

Cestou se našlo **dvakrát zadrátované `http://localhost:11434`** mimo
allowlist (CI endpoint a audit překladů) — obojí teď prochází
`sanitizeLlmConfig()`.

### 0.2 Frontend se v Dockeru buildí bez konfigurace Firebase

`Dockerfile` volá `npm run build`, ale nedeklaruje žádné `ARG VITE_FIREBASE_*`.
Build tedy sáhne po fallback hodnotách zadrátovaných ve
`frontend/src/lib/firebase.js:9-14`, což je konkrétní projekt
`auratest-ai-86058`.

Není to únik tajemství — web config Firebase je veřejný z principu a chrání ho
Firestore rules, ne utajení. Je to ale past: nasazení se mlčky připne na tenhle
projekt a případná změna se nikde neprojeví.

**Řešení:** doplnit do `Dockerfile` build argumenty a předat je do `npm run build`:

```dockerfile
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
RUN cd frontend && npm run build
```

**✅ Hotovo.** `ARG VITE_FIREBASE_*` v `Dockerfile`, předané přes
`build.args` v `docker-compose.yml`. Prázdná hodnota = fallback jako dřív,
takže se nic nerozbilo.

### 0.3 Chybí `.env.example`

V repozitáři je `.env` se Slack tokeny, ale žádná šablona. Kdokoli (včetně tebe
za tři měsíce) nasazuje naslepo a zjistí chybějící proměnnou až za běhu.

**✅ Hotovo.** `.env.example` se všemi proměnnými, u každé co dělá a jestli
je povinná. Ověřeno, že `.env` i `firebase-credentials.json` jsou
v `.gitignore` a že v gitu neleží nic citlivého.

Křížová kontrola proti kódu odhalila, že jsem do šablony napsal
`BROWSER_ARGS`, **kterou kód vůbec neznal**. Místo smazání jsem ji
doimplementoval — pro Cloud Run je potřeba
(`--disable-dev-shm-usage`) a plán s ní počítá. Všech 11 volání
`chromium.launch()` teď jde přes společné `launchOptions()`. Argumenty se
berou výhradně z prostředí, nikdy z requestu: umí vypnout sandbox.

### 0.4 Ověřit, že Playwright image existuje pro ARM

Oracle Always Free je ARM (Ampere A1). Playwright publikuje multi-arch images,
takže `docker pull` by měl vzít arm64 variantu sám — ale je to potřeba ověřit
pro konkrétní `v1.60.0-jammy`, ne předpokládat.

```bash
docker manifest inspect mcr.microsoft.com/playwright:v1.60.0-jammy \
  | grep -A2 '"architecture"'
```

Pokud arm64 chybí, jsou dvě cesty: povýšit Playwright na verzi, která ho má
(pozor — verze image **musí** odpovídat balíčku, jinak „Executable doesn't
exist"), nebo vzít x86 Oracle instanci (1/8 OCPU, 1 GB RAM — na Chromium málo)
a přesunout hlavní běh na Cloud Run.

**✅ Ověřeno — arm64 existuje.** V registru MCR jsou vedle holého tagu
i explicitní varianty `v1.60.0-jammy-arm64` a `v1.60.0-noble-arm64`
(kontrolní neexistující tag vrací 404, takže je to skutečný signál).
Holý tag je multi-arch manifest, `docker pull` na A1 vybere arm64 sám.

Dvě věci ale hlídej:

- Když stavíš image na Macu nebo v x86 CI a pushuješ na A1, buduj
  s `--platform linux/arm64`, jinak vznikne amd64 image.
- Po nasazení ověř v kontejneru na A1, které prohlížeče jsou reálně
  k dispozici (`npx playwright install --dry-run`). Playwright na arm64
  historicky nedodával všechny; dokumentace o tom mlčí a **tohle jsem
  neověřil**.

---

## Fáze 1 — Oracle Cloud VM (hlavní běh)

### 1.1 Instance

- Tvar `VM.Standard.A1.Flex`, **2 OCPU / 12 GB** (od června 2026 je to strop
  Always Free — dřív to byly 4 OCPU / 24 GB).
- Ubuntu 22.04 LTS — shoduje se se základem Playwright image.
- Boot volume 50 GB (Always Free dává 200 GB celkem).
- **Region podle dostupnosti kapacity, ne podle latence.** Ampere A1 bývá
  v populárních regionech vyčerpaná; Frankfurt a Singapur bývají dostupnější
  než US East. Region jde po vytvoření tenancy změnit jen složitě, takže tohle
  rozhodnutí je prakticky nevratné.
- Uložit si SSH klíč. Oracle ho podruhé neukáže.

### 1.2 Systém

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker ubuntu       # odhlásit a znovu přihlásit
```

Oracle má ve výchozím stavu **restriktivní iptables** nad rámec Security Listu.
Bez tohohle kroku porty prostě nefungují a hledá se to špatně:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

V Security Listu v konzoli Oracle otevřít 80 a 443. **Port 3001 neotevírat** —
`docker-compose.yml` ho váže na loopback (`127.0.0.1:3001:3001`) právě proto,
že aplikace patří za proxy.

### 1.3 Reverzní proxy a HTTPS

Caddy, protože vyřídí certifikát sám a konfigurace je čtyři řádky:

```
auraguard.tvojedomena.cz {
    reverse_proxy 127.0.0.1:3001
}
```

WebSocket Caddy proxuje bez extra konfigurace. Doména musí mít A záznam na
veřejnou IP instance ještě před prvním startem, jinak Let's Encrypt neprojde.

### 1.4 Konfigurace aplikace

```bash
NODE_ENV=production
PORT=3001
TRUST_PROXY=1                                   # už je v compose
ALLOWED_ORIGINS=https://auraguard.tvojedomena.cz
PUBLIC_BASE_URL=https://auraguard.tvojedomena.cz
ALLOWED_LLM_HOSTS=                              # LLM vypnuto (viz 0.1)
MAX_CONCURRENT_BROWSERS=2                       # 12 GB / ~2 GB na běh
```

`firebase-credentials.json` nahrát na server a **nekopírovat do image** —
compose ho montuje read-only, což je správně.

### 1.5 Ověření

Po startu projet reálný smoke test, ne jen „stránka se načetla":

```bash
docker compose up -d
docker compose logs -f                # počkat na healthcheck
npm run test:smoke -- https://nexus-sync-8d50b.web.app/logout
```

Smoke test rozlišuje kontroly nástroje (✅/❌, řídí exit kód) od nálezů na
testovaném webu (⚠️/·). Zelená znamená „skener funguje", ne „web je v pořádku".

Zvlášť ověřit dvě věci, které jinde v testech ověřit nejde:

- **PQC sonda** proti serveru, který hybridní skupinu umí (`www.cloudflare.com`)
  a proti tomu, který ne. V sandboxu to nešlo — chybí DNS.
- **`/dev/shm`** — compose dává 1 GB; při „Target closed" nebo pádech Chromia
  během chaos testu je to první podezřelý.

---

## Fáze 2 — Cloud Run (záloha a CI)

Smysl: nezávislost na dostupnosti Ampere kapacity a možnost pouštět audity
z CI, aniž by běžela VM. Free tier: 2 mil. requestů, 360 000 vCPU-s
a 180 000 GiB-s měsíčně, trvale.

Nasadit **stejný image**, ale se čtyřmi úpravami:

1. **Artefakty.** `screenshots/`, `videos/` a `generated-scripts/` jsou na
   Cloud Run efemérní — po restartu instance zmizí a mezi instancemi se
   nesdílejí. Buď je nechat jako dočasné (u ukázky přijatelné), nebo přepsat
   `paths.js` na Cloud Storage.
2. **`/dev/shm`.** Chromium bez něj padá. Na Cloud Run se řeší přes
   `--memory=2Gi` a spuštění Chromia s `--disable-dev-shm-usage`
   (`BROWSER_ARGS` je už v kódu jako proměnná).
3. **Firebase credentials.** Není kam montovat soubor — buď Secret Manager,
   nebo přepsat `db.js:8` na Application Default Credentials, což je na GCP
   čistší.
4. **Timeout a souběh.** `--timeout=300 --concurrency=1 --min-instances=0`.
   Souběh 1 proto, že jeden běh Playwrightu si vezme skoro celou paměť.

```bash
gcloud run deploy auraguard \
  --source . --region europe-west3 \
  --memory 2Gi --cpu 2 --timeout 300 --concurrency 1 \
  --execution-environment gen2 \
  --set-env-vars NODE_ENV=production,TRUST_PROXY=1
```

`gen2` je nutné — Chromium potřebuje syscally, které gen1 nemá.

**Co na Cloud Run nepoběží dobře:** živé logy agenta přes WebSocket (strop
60 min, škálování na nulu spojení zabíjí) a plánované audity, pokud se
spoléhají na běžící proces. Pro CLI běhy z CI to nevadí.

---

## Fáze 3 — provoz

U soukromé ukázky stačí minimum, ale tyhle tři věci bych nevynechal:

- ~~**Rotace logů.**~~ ✅ Doplněno do `docker-compose.yml` (10 MB × 5 souborů).
- **Úklid artefaktů.** Videa z Playwrightu jsou velká. Cron, který maže
  `screenshots/`, `videos/` a `generated-scripts/` starší než 7 dní.
- **Restart po rebootu.** `restart: unless-stopped` v compose už je; ověřit, že
  `docker.service` je `enabled`.

Monitoring a zálohy plán vědomě neřeší — u soukromé ukázky je to práce navíc
bez užitku. Až přibudou reální uživatelé, přidat: zálohu Firestore, alerting na
healthcheck a rate limiting na proxy (v aplikaci `rateLimit()` je, ale proxy
odchytí i to, co se k aplikaci nemá dostat vůbec).

---

## Rizika

| Riziko | Dopad | Co s tím |
|---|---|---|
| Ampere A1 kapacita není v žádném dostupném regionu | Fáze 1 nejde spustit | Proto je Cloud Run v plánu — přehodit pořadí fází |
| Playwright image nemá arm64 | Fáze 1 nejde spustit | Ověřit v kroku 0.4 **jako první** |
| Oracle recykluje nečinné Always Free instance | Výpadek ukázky | Držet instanci vytíženou (plánované audity), nebo přijmout |
| Chromium vyčerpá paměť při souběžných auditech | Zabitý kontejner | `MAX_CONCURRENT_BROWSERS=2`, `mem_limit: 2g` už v compose |
| Skener je otevřená brána do sítě VM | SSRF na interní služby | `ssrf-guard.js` blokuje privátní rozsahy včetně `169.254.169.254`, což je i metadata endpoint Oracle. Ověřeno testy. |

---

## Co plán vědomě neřeší

- **Doložitelnost auditů** — neměnný záznam, časová razítka, verzování pravidel.
  To je obsah `PLAN-NIS2.md` (epic D), ne nasazení.
- **Vlastní doména a branding** — až bude co ukazovat.
- **Škálování** — jedna instance zvládne jednotky souběžných auditů; pro pilot
  s několika lidmi to stačí s rezervou.

---

## Pořadí a odhad

| Krok | Odhad |
|---|---|
| ~~0.1–0.4 Opravy před nasazením~~ | ✅ hotovo |
| 1.1–1.2 Instance a systém | ~1 h |
| 1.3–1.4 Proxy, doména, konfigurace | ~1 h |
| 1.5 Ověření a smoke test | ~1 h |
| Fáze 2 Cloud Run | ~2–3 h |
| Fáze 3 Provoz | ~1 h |

Fáze 1 tedy zabere jeden odpolední blok. Fáze 2 se dá odložit — dává smysl až
ve chvíli, kdy budeš chtít pouštět audity z CI, nebo až Oracle poprvé zlobí.
