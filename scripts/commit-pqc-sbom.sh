#!/usr/bin/env bash
#
# Commity pro fázi „nauč nástroj to, co tvrdil, že umí".
#
# Tři schopnosti, které nástroj deklaroval a neměl (post-kvantová kryptografie,
# reprodukovatelný chaos test, SBOM z bundlů), plus opravy nálezů ze dvou
# kontrolních vln.
#
# Pořadí je zvolené tak, aby po každém commitu prošly testy:
#   1–4  nové moduly i s testy (zatím nezapojené — samostatně smysluplné)
#   5    integrace do agent.js (tady se mění chování auditů)
#   6–10 bezpečnost, server, frontend, CLI, dokumentace
#   11–12 příprava nasazení (fáze 0 z PLAN-DEPLOY.md)
#
# Pozn.: agent.js, server.js a App.jsx nesou zároveň změny z přípravy
# nasazení — jeden soubor nejde rozdělit do dvou commitů bez `git add -p`.
# Popisy commitů 5, 7 a 8 to proto zmiňují.
#
# Spuštění:
#   cd /Users/zdenekdias/.gemini/antigravity/scratch/auratest-ai
#   bash scripts/commit-pqc-sbom.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ 1/12  modul pro měření TLS"
git add tls-audit.js tests/tls-audit.test.js
git commit -q -F - <<'MSG'
feat(tls): měřit post-kvantovou výměnu klíčů skutečným handshakem

Modul se jmenoval „NIS2 & Post-Quantum Cryptography", ale post-kvantová
odolnost se neměřila vůbec — `isQuantumSafe: false` byla konstanta
v odpovědi.

Nově se navazují skutečné TLS handshaky:

- Post-kvantová sonda nabídne serveru POUZE hybridní skupinu
  X25519MLKEM768 (ML-KEM-768 podle FIPS 203 + X25519). Projde-li
  handshake, server ji prokazatelně podporuje. Čtení vyjednané skupiny
  přes getEphemeralKeyInfo() nejde — u TLS 1.3 vrací Node prázdný objekt.

- Verze protokolu se testují každá zvlášť. TLS 1.0/1.1 se posílají ručně
  sestaveným ClientHellem po holém TCP socketu, protože je moderní OpenSSL
  odmítá už na straně KLIENTA. Vydávat „to neumí náš klient" za „server to
  odmítá" by znamenalo tvrdit výsledek testu, který neproběhl.

- Certifikát se čte z navázaného spojení: platnost, typ a délka klíče.

Všude platí tříhodnotový model. Síťová chyba, starý OpenSSL nebo useknutá
odpověď dávají `null` (netestováno), nikdy `false`. Warning-level alert
ani fatal alert jiný než protocol_version se nepočítá jako odmítnutí
verze — může jít o neshodu šifer.

Klasifikace je oddělená od síťové vrstvy, takže jde testovat bez otevírání
spojení; sonda samotná se testuje proti skutečnému TLS serveru
na localhostu.
MSG

echo "▶ 2/12  deterministický generátor"
git add seeded-random.js tests/seeded-random.test.js
git commit -q -F - <<'MSG'
feat(chaos): deterministický generátor pro reprodukovatelný chaos test

Injektáž poruch běžela na Math.random(). Když test spadl, nešlo ho
zopakovat — a co nejde zopakovat, nejde doložit ani opravit. Nařízení
DORA přitom v čl. 25 mluví o testování „na základě jasně definované
metodiky".

mulberry32 se seedem z FNV-1a hashe. Není to kryptografický generátor
a ani k tomu není určený; podstatné je, že stejný seed dá pokaždé stejnou
posloupnost.
MSG

echo "▶ 3/12  fingerprinting bundlů"
git add sbom-fingerprint.js tests/sbom-fingerprint.test.js
git commit -q -F - <<'MSG'
feat(sbom): sestavit SBOM z obsahu bundlů a ze source map

Detekce četla jen globální proměnné (window.jQuery, window._). Bundlovaná
aplikace (Vite, webpack, ESM) do window nevystaví nic, takže „softwarový
kusovník" moderního webu byl prázdný seznam.

Tři zdroje důkazu, od nejsilnějšího:

  1. source mapy — pole `sources` obsahuje cesty node_modules/<balíček>/,
     tedy přímý seznam závislostí tak, jak je viděl bundler
  2. verzní bannery v bundlu (/*! jQuery v3.6.0 …), které minifikace
     zachovává
  3. charakteristické řetězce běhového kódu

Každá položka nese `confidence` (version-detected / presence-only)
a `sources`. Rozpor mezi zdroji se zaznamená místo tichého výběru jedné
verze.

Vzory schválně NEčtou semver rozsahy z package.json ("react": "^18.2.0"
se resolvuje na něco jiného) a nespoléhají na obecná slova — „bootstrap"
je běžná součást webpack runtime a „axios" bývá v komentářích. Fantomová
položka v SBOM není neškodná: nedohledá se k ní verze, spadne mezi
neověřené a shodí celý výsledek na neprůkazný.

Stahování map je zastropované velikostí i počtem balíčků a čte se
streamem — mapu poskytuje skenovaná, tedy cizí strana.
MSG

echo "▶ 4/12  normalizace verze"
git add semver.js tests/semver.test.js
git commit -q -F - <<'MSG'
fix(cra): nedoplňovat chybějící patch verzi před dotazem do OSV

Z „2.6" se dělalo „2.6.0" a na tohle domyšlené číslo se ptalo OSV.
Nasazená 2.6.14 s opravenými CVE tak mohla dostat „FAIL: okamžitě
aktualizujte závislosti" — verdikt vyvozený z čísla, které si nástroj
vymyslel. Neověřená knihovna je lepší výsledek než vymyšlený verdikt.

Vlastní modul místo funkce v agent.js: testovat ji přes agent.js
znamenalo natáhnout do test workeru celý Playwright (19 s na suite
a varování o neukončeném workeru).
MSG

echo "▶ 5/12  integrace do skenerů"
git add agent.js
git commit -q -F - <<'MSG'
feat(audit): zapojit měření TLS, SBOM z bundlů a baseline chaos testu

NIS2/PQC
- isQuantumSafe se skutečně měří (tls-audit.js) místo natvrdo zapsaného
  false. Tři stavy: nasazeno / nenasazeno / neprůkazné.
- Hostname po přesměrování prochází SSRF guardem znovu. Původní kontrola
  platila jen pro zadanou URL, takže cizí web mohl přesměrováním donutit
  skener otevřít spojení na interní službu a její certifikát vrátit
  uživateli v odpovědi. Guard běží i před čtením hlaviček z odpovědi,
  protože přesměrování sleduje sám prohlížeč.
- Prokázaná závada v TLS shodí i celkový verdikt. Server s TLS 1.0
  a všemi šesti hlavičkami dostával „splněno" — pole se jmenuje
  isCompliant, ne headersComplete. TLS nálezy mají vlastní pole,
  aby je CLI nevypisovalo jako chybějící hlavičky.
- Hlavičky se posuzují podle hodnoty, ne podle přítomnosti:
  X-Frame-Options: ALLOWALL ani prázdná Permissions-Policy neochrání.
  CSP bez script-src i bez default-src o skriptech nic neříká.
- `secure` se odvozuje ze schématu finální URL. securityDetails() vrací
  null i u https odpovědi z cache, takže se u https webu hlásilo
  „běží to po čistém HTTP".
- Nedosažitelný server: summarizeTls vrací objekt s pqc: null, takže
  větev `!tls` ho nezachytila a padal TypeError — celý audit skončil
  výjimkou místo výsledku „neprůkazné".

CRA / SBOM
- Skripty se sbírají při načítání stránky a jejich obsah se prohledává.
  Source mapy se stahují s redirect: 'manual' — s výchozím 'follow'
  by cizí server odpověděl přesměrováním na 169.254.169.254 a obsah
  interní služby by skončil v reportu.
- Verdikt zohledňuje slepá místa: nepřečtené skripty, dosažený limit
  i rozpor verzí mezi zdroji shodí výsledek na neprůkazný. „PASS" jinak
  tvrdil úplnost, kterou sken nemá.
- Při rozporu verzí se do OSV ptáme na obě. Zeptat se jen na první
  znamenalo, že zranitelná druhá kopie projde bez kontroly.

DORA / chaos
- O každém požadavku rozhoduje hash ze seedu a URL. Sekvenční generátor
  by byl deterministický jen zdánlivě: čísla se konzumují v pořadí,
  v jakém požadavky dorazí, a to prohlížeč mezi běhy nedodrží.
- Přibyl baseline běh bez injektáže. Verdikt se počítá z rozdílu — bez
  toho dostala stránka, která hlásí chyby i za klidu, „rozpadla se pod
  injektovanými poruchami", tedy závěr o kauzalitě, která se neměřila.
- Po načtení DOMu se čeká, než injektované poruchy zapůsobí. Verdikt se
  počítal hned po domcontentloaded, tedy před dokončením fetch/XHR
  a před uplynutím 3s zdržení.
- Síťové hlášky, které prohlížeč zaloguje kvůli našemu abortu, se
  neúčtují aplikaci. Jinak by „odolná" u webu s deseti podzdroji nešlo
  dosáhnout vůbec.
- Pole injections je zastropované.

Příprava nasazení (PLAN-DEPLOY.md, fáze 0.3)
- Všech 11 volání chromium.launch() jde přes společné launchOptions(),
  které přidá argumenty z BROWSER_ARGS. Kontejnery s malým /dev/shm
  (Cloud Run) potřebují --disable-dev-shm-usage, jinak Chromium padá na
  „Target closed". Argumenty se berou výhradně z prostředí, nikdy
  z requestu — umí vypnout sandbox.
MSG

echo "▶ 6/12  SSRF guard"
git add ssrf-guard.js tests/ssrf-guard.test.js
git commit -q -F - <<'MSG'
fix(ssrf): opravit vyhodnocování IPv6 literálů

WHATWG URL vrací IPv6 hostname VČETNĚ hranatých závorek, takže
net.isIP() vracelo 0, literál spadl do DNS větve a celá logika
isBlockedV6 byla pro přímé literály mrtvá. Selhávalo to bezpečně, ale
náhodou — dns.lookup('[::1]') vždy skončí chybou — a legitimní IPv6 cíle
to blokovalo taky.

Odstranění závorek samo o sobě odkrylo skutečný bypass:
http://[::ffff:127.0.0.1]/ si URL znormalizuje na [::ffff:7f00:1], tedy
do hexa tvaru, a porovnání jen tečkového zápisu by loopback propustilo.
Adresa se proto rozvíjí na osm skupin a IPv4 se z ní čte binárně.

Pokryto: IPv4-mapped, IPv4-compatible, IPv4-translated, 6to4 (2002::/16
nese cílovou IPv4 uvnitř), NAT64, link-local, unique local, multicast,
dokumentační rozsah. Doplněno 192.88.99.0/24 (6to4 relay, RFC 7526).
Nerozluštitelná adresa se blokuje.
MSG

echo "▶ 7/12  server"
git add server.js
git commit -q -F - <<'MSG'
feat(api): seed pro chaos test a rozpoznání instalace bez LLM

Volitelné parametry auditů se berou z těla requestu podle allowlistu,
ne celé — jinak by šlo do agenta protlačit cokoli. Zatím jediný:
seed pro chaos-test, validovaný na typ i délku.

Příprava nasazení (PLAN-DEPLOY.md, fáze 0.1)
- ALLOWED_LLM_HOSTS= (prázdné) teď znamená VYPNUTO. V kódu `??` místo
  `||`, protože `||` by prázdný řetězec přepsalo výchozím localhostem
  a vypnout LLM by nešlo.
- Režimy závislé na modelu se odmítnou s HTTP 503 a srozumitelnou
  hláškou ještě PŘED založením session. Dřív běh došel až k volání
  na localhost:11434, spadl na odmítnutém spojení a uživatel dostal
  „fetch failed" — bez šance poznat, že jde o chybějící konfiguraci,
  ne o chybu testovaného webu. Navíc po sobě nechával session ve stavu
  „running".
- Nový endpoint GET /api/capabilities: co tahle konkrétní instalace umí.
  Bez autentizace, protože přihlašovací obrazovka to potřebuje vědět
  dřív, než se kdokoli přihlásí; nevrací hosty ani tokeny.
- Opraveno dvakrát zadrátované http://localhost:11434 mimo allowlist
  (CI endpoint a audit překladů) — obojí prochází sanitizeLlmConfig().
MSG

echo "▶ 8/12  frontend"
git add frontend/src/App.jsx frontend/src/components/print/PrintReport.jsx frontend/src/lib/compliance.js
git commit -q -F - <<'MSG'
feat(frontend): zobrazit naměřená data místo obecných formulek

- Karta „PQC (Kvantová bezpečnost)" ukazovala jen název protokolu
  a vydavatele certifikátu — o post-kvantové odolnosti neříkala nic,
  přestože se tak jmenovala. Nově zobrazuje změřený výsledek, testovanou
  skupinu, přijímané verze TLS a nálezy.
- Post-kvantová výměna klíčů má vlastní škálu (nasazeno / doporučeno
  nasadit / neprůkazné). Její absence není porušení předpisu; červené
  „Nesplněno" bylo přísnější než CLI, které u téhož čísla hlásí
  doporučení.
- SBOM ukazuje u každé položky zdroj a „verze neznámá" místo `v undefined`.
- Chaos test ukazuje seed, baseline a počet nových chyb; přibylo tlačítko
  pro zopakování se stejným seedem.
- handleRunChaosTest jako jediný handler nečistil předchozí výsledky,
  takže po samostatném spuštění zůstaly viset staré výsledky jiných
  auditů, případně proti jiné URL.
- Tiskový report už si neprotiřečí: pod řádkem se seedem stála poznámka,
  že výsledek není reprodukovatelný.

Příprava nasazení (PLAN-DEPLOY.md, fáze 0.1)
- UI si při startu načte /api/capabilities. Když instalace nemá jazykový
  model, výchozí režim se přepne na monkey a AI režimy se vůbec
  nenabídnou. Nabízet je znamená slíbit funkci, která skončí chybou
  spojení.
MSG

echo "▶ 9/12  CLI a smoke test"
git add bin/auraguard-cli.js scripts/smoke-test.mjs
git commit -q -F - <<'MSG'
feat(cli): vypsat výsledek TLS sondy a zdroj každé položky SBOM

- Post-kvantová výměna klíčů se hlásí jako PASS / DOPORUČENÍ /
  NEPRŮKAZNÉ, ne jako selhání.
- TLS nálezy se vypisují z vlastního pole. Dřív se mísily mezi chybějící
  hlavičky, takže CLI hlásilo „Chybí 1 bezpečnostních hlaviček —
  Chybí hlavička: Zastaralé verze TLS: TLSv1".
- U knihovny bez zjištěné verze se tiskne „verze neznámá" místo (null).

Smoke test ověřuje, že sonda vrátila tříhodnotový výsledek, že se
skripty skutečně stáhly a prohledaly a že se knihovna bez verze
nezapočítá mezi ověřené. Rozlišení „kontrola nástroje" vs. „nález na
webu" zůstává — o exit kódu rozhodují jen kontroly nástroje.
MSG

echo "▶ 10/12  dokumentace a testy"
git add README.md PLAN-NIS2.md tests/ai-act.test.js scripts/commit-pqc-sbom.sh
git commit -q -F - <<'MSG'
docs: sladit tvrzení README s tím, co nástroj skutečně měří

Tvrzení o post-kvantové kryptografii se stalo pravdivým, takže „PQC se
neměří" už neplatí. Zároveň přibyla omezení, která platit začala:
testuje se jedna konkrétní skupina, inline <script> bloky se neskenují,
verze se nečte z deklarovaných rozsahů v package.json a chybějící patch
verze se nedoplňuje.

Plán dotažení NIS2 modulu a testy tříhodnotového výsledku v CLI
z předchozí fáze.
MSG

echo "▶ 11/12  konfigurace nasazení"
git add Dockerfile docker-compose.yml .env.example
git commit -q -F - <<'MSG'
build: konfigurovatelný Firebase projekt a šablona proměnných

Dockerfile volal `npm run build` bez jediného ARG VITE_FIREBASE_*, takže
build sáhl po fallback hodnotách zadrátovaných ve
frontend/src/lib/firebase.js a nasazení se mlčky připnulo na jeden
konkrétní projekt. Není to únik — web config Firebase je veřejný
z principu a chrání ho Firestore rules — ale je to past: změna proměnné
za běhu se nikde neprojeví, protože Vite zapéká hodnoty do bundlu při
buildu.

Prázdná hodnota = fallback jako dřív, takže se nic nerozbilo.

Dál:
- .env.example se všemi proměnnými, u každé co dělá a jestli je povinná.
  Dosud existoval jen .env se Slack tokeny a nasazovalo se naslepo.
- Rotace logů v compose (10 MB × 5). Bez stropu roste log kontejneru
  donekonečna a 50GB disk se dá zaplnit rychleji, než by člověk čekal.
MSG

echo "▶ 12/12  testy a plán nasazení"
git add tests/capabilities.test.js PLAN-DEPLOY.md scripts/commit-pqc-sbom.sh deploy/
git commit -q -F - <<'MSG'
test: chování instalace bez jazykového modelu

Pokrývá rozlišení „vypnuto" od „nenastaveno" (prázdný řetězec vs.
chybějící proměnná), které režimy se bez modelu obejdou, a parsování
BROWSER_ARGS včetně přebytečných čárek — prázdný argument by Chromium
odmítlo spustit.

Plán nasazení: proč Oracle VM a ne serverless (Playwright potřebuje ~1 GB
RAM, tls-audit.js raw TCP sokety, chaos test až 70 s na request),
konkrétní kroky včetně pastí, na které se naráží — Oracle má restriktivní
iptables nad rámec Security Listu a Ampere A1 kapacita v populárních
regionech často není.

Adresář deploy/ s tím, co jde připravit dopředu:
- Caddyfile: HTTPS, WebSocket, timeouty 180 s (audity běží až 70 s,
  výchozích 30 by je useklo) a bezpečnostní hlavičky. Ty doplňuje proxy,
  protože je server sám nenastavoval — u nástroje, který cizím webům
  vytýká chybějící HSTS a CSP, je to nepříjemné.
- deploy.sh: ověří předpoklady a POČKÁ na zdravý stav. Mlčky „hotovo"
  u nefunkčního nasazení je horší než chyba.
- cleanup-artifacts.sh + systemd timer: retence artefaktů. Videa
  z Playwrightu jsou velká a 50GB disk se zaplní rychle. Zároveň
  technická část D5 z PLAN.md.
- README.md, oracle-manual.md, oracle-console-ai-prompt.md: postup
  konzolí i promptem, s tabulkou příznaků a příčin.
- oracle-retry-launch.sh: smyčka proti „Out of host capacity". Konzole po
  té chybě resetuje formulář (image se přepne zpátky na Oracle Linux),
  takže každý pokus znamená projít průvodce znovu. Resource Manager stack
  to řeší jen zpola — availability domain má zadrátovanou v main.tf, tedy
  mlátí pořád do jedné. Skript volá API přímo a rotuje {AD-1, AD-2, AD-3}
  × {2 OCPU/12 GB, 1 OCPU/6 GB}: šest pokusů za kolo místo jednoho.
  Kapacitní chybu a síťový timeout opakuje, chybu konfigurace nebo limit
  účtu zastaví — opakovat vadné OCID donekonečna nemá smysl.
- oracle-retry-apply.sh: totéž nad uloženým stackem, když někdo chce
  zůstat u Resource Manageru.
- oracle-retry-mac.sh: spuštění na macOS přes nohup + caffeinate, protože
  Cloud Shell session končí se zavřením okna a smyčka má běžet přes noc.

Tři pasti, na které se přitom narazilo a jsou v kódu okomentované:
`--wait-for-state RUNNING` drží spojení minuty a jeho timeout vypadá jako
chyba konfigurace; macOS má bash 3.2 bez `mapfile`; a `set -u` v Cloud
Shellu rozbije prompt, který se odkazuje na nenastavené $USER.

Dockerfile navíc kopíruje scripts/smoke-test.mjs do runtime image.
Bez toho by příkaz slibovaný v deploy/README.md skončil „Cannot find
module" — smoke test je jediný způsob, jak po nasazení ověřit PQC sondu
proti skutečnému serveru a SBOM z živých bundlů.
MSG

echo
echo "✔ Hotovo. Posledních 12 commitů:"
git log --oneline -12
echo
echo "Zbývá ověřit:"
echo "  npm test          # 258 testů"
echo "  npm run test:smoke -- https://nexus-sync-8d50b.web.app/logout"
