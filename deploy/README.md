# Nasazení — kontrolní seznam

> ## Současná produkce: Nexus
>
> Zbytek tohohle dokumentu popisuje zakládání instalace na Oracle Cloud.
> **Běžící produkce ale stojí jinde** — na Azure, a tenhle rozpor stál
> jednou hodinu hledání, protože skripty v `deploy/` mluví o účtu `ubuntu`
> a klíči `~/.ssh/auraguard`, které na Nexu neplatí.
>
> | | |
> |---|---|
> | Poskytovatel | Azure, předplatné NexusStack Production |
> | Skupina prostředků | `rg-signing`, oblast Sweden Central |
> | Veřejná IP | `4.223.166.194` |
> | Účet | `nexus` |
> | Systém | Ubuntu 24.04 |
> | Adresa | https://auraguard.nexusstack.eu |
>
> ```
> ssh -i ~/.ssh/nexus_hub_ed25519 nexus@4.223.166.194
> cd ~/auratest-ai && git pull && bash deploy/deploy.sh
> ```
>
> **Když se nedostaneš dovnitř:** v portálu Azure je u VM
> **Operations → Run command → RunShellScript**, což běží jako root i bez
> SSH. Tudy jde přidat veřejný klíč do `/home/nexus/.ssh/authorized_keys`.
> Tlačítko *Resetovat heslo nebo klíče* na téže VM selhává hláškou
> „Failed to generate public key file", takže na něj nespoléhej.
>
> Původní klíč z založení VM se jmenuje `generated-by-azure`
> (otisk `SHA256:jSD8D2v85Eik…`) a jeho soukromou půlku Azure ukázal jen
> jednou.

Krok za krokem od prázdného Oracle účtu k běžící instalaci. Odhad: jeden
odpolední blok. Souvislosti a zdůvodnění jsou v `../PLAN-DEPLOY.md`, tohle je
provozní postup.

Odškrtávej průběžně — kroky na sebe navazují a přeskočený se pozná až o dva
dál.

---

> **Zakládáš infrastrukturu poprvé?** Klikací postup konzolí krok za krokem
> je v [`oracle-manual.md`](oracle-manual.md). Pokud máš k dispozici
> OCI Console AI, hotový prompt je v
> [`oracle-console-ai-prompt.md`](oracle-console-ai-prompt.md).

## 1. Instance

- [ ] Účet na Oracle Cloud (Always Free, kartu chce jen k ověření)
- [ ] **Region volit podle dostupnosti kapacity Ampere A1**, ne podle latence.
      V populárních regionech bývá vyčerpaná; Frankfurt a Singapur bývají
      dostupnější než US East. Změna regionu je po vytvoření tenancy
      prakticky nevratná.
- [ ] Instance `VM.Standard.A1.Flex`, **2 OCPU / 12 GB**
      (od června 2026 je to strop Always Free, dřív 4 OCPU / 24 GB)
- [ ] Ubuntu 22.04 LTS — shoduje se se základem Playwright image
- [ ] Boot volume 50 GB
- [ ] **SSH klíč si ulož hned.** Oracle ho podruhé neukáže.
- [ ] Poznamenej si veřejnou IP

> Když kapacita není: chybová hláška zní „Out of host capacity". Zkoušej
> opakovaně (uvolňuje se nepravidelně), jiný availability domain, nebo přejdi
> na Cloud Run — fáze 2 v `PLAN-DEPLOY.md`.

## 2. Síť

Otevřít port musíš **na dvou místech**. Tohle je nejčastější místo, kde se
lidi zaseknou: v konzoli je pravidlo vidět, a přesto nic nejede.

- [ ] V konzoli Oracle → Security List → Ingress Rules: povolit TCP 80 a 443
- [ ] Na instanci povolit totéž v iptables:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

- [ ] **Port 3001 neotevírej.** `docker-compose.yml` ho váže na loopback,
      aplikace patří za proxy.

### IPv6 kontejner nemá — a je to vědomé

Ověřeno na produkci 18. 9. 2026:

```bash
docker compose exec auratest-ai node -e "require('dns').lookup('www.cloudflare.com',{all:true},(e,a)=>console.log(a))"
#   104.16.123.96 (v4), 2606:4700::6810:7b60 (v6)   ← DNS AAAA vrací
docker compose exec auratest-ai node -e "require('net').connect({host:'2606:4700::6810:7b60',port:443,family:6}).on('error',e=>console.log(e.code))"
#   ENETUNREACH                                     ← spojení neprojde
```

Důsledek: Chromium vždy spadne na IPv4, takže větev pro rozsahy IPv6
v `cloud-ranges.js` se v tomhle nasazení **nikdy nespustí**. Kód je
správný a otestovaný, jen spí.

Na měřených webech to nic nekazí — rezidence se určí z adresy IPv4 a
report netvrdí víc, než co naměřil. Kdyby někdo IPv6 v Dockeru zapnul
(`daemon.json`: `ipv6`, `fixed-cidr-v6`, `ip6tables`), větev se
aktivuje sama; je to ale zásah do sítě serveru, ne úklid.

## 3. Doména

- [ ] A záznam na veřejnou IP instance
- [ ] Ověř, že se propsal: `dig +short auraguard.tvojedomena.cz`

> Musí platit **před** prvním startem Caddy. Bez toho neprojde ACME výzva
> a Caddy skončí chybou.

## 4. Systém

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu
```

- [ ] **Odhlas se a přihlas znovu**, jinak členství ve skupině `docker`
      neplatí a všechno poběží přes `sudo` (a vyrobí root-owned soubory
      v bind mountech)
- [ ] Ověř: `docker info` musí projít bez `sudo`

## 5. Aplikace

```bash
git clone <repo> ~/auratest-ai && cd ~/auratest-ai
cp .env.example .env
nano .env
```

Vyplnit minimálně:

- [ ] `ALLOWED_ORIGINS=https://auraguard.tvojedomena.cz`
- [ ] `PUBLIC_BASE_URL=https://auraguard.tvojedomena.cz`
- [ ] `ALLOWED_LLM_HOSTS=` — **prázdné = LLM vypnuté.** Řádek nechat, jen bez
      hodnoty. Smazat ho znamená LLM zapnout.
- [ ] `MAX_CONCURRENT_BROWSERS=2`
- [ ] Nahrát `firebase-credentials.json` do kořene projektu

```bash
bash deploy/deploy.sh
```

Skript ověří předpoklady, sestaví image pro správnou architekturu, nastartuje
a **počká, až se aplikace ohlásí jako zdravá**. Když se nerozjede, vypíše logy
a skončí chybou.

## 6. Proxy

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/auraguard.example.com/auraguard.tvojedomena.cz/' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

- [ ] Otevři `https://auraguard.tvojedomena.cz` — certifikát musí být platný

## 7. Úklid artefaktů

Videa z Playwrightu jsou velká. Bez tohohle se 50GB disk zaplní.

```bash
sudo cp deploy/auraguard-cleanup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now auraguard-cleanup.timer
systemctl list-timers auraguard-cleanup    # ověření
```

- [ ] Vyzkoušej naprázdno: `DRY_RUN=1 bash deploy/cleanup-artifacts.sh`

## 7b. Obnova snímku IP rozsahů

Rezidence dat se určuje z rozsahů, které zveřejňují AWS, GCP a Azure.
Snímek je v `data/cloud-ranges.json` a **stárne**: poskytovatelé rozsahy
vydávají průběžně (Azure týdenní soubory, AWS mění `createDate` řádově
denně). Po 90 dnech z něj `cloud-ranges.js` přestane určovat zemi a
rezidence vyjde jako neprůkazná — ne chybně, ale bez výsledku.

- [ ] Nainstalovat timer na týdenní obnovu:

```bash
sudo cp deploy/auraguard-ranges.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now auraguard-ranges.timer
systemctl list-timers auraguard-ranges.timer
```

- [ ] Ověřit, že obnova projde (trvá jednotky minut, stahuje ~25 MB):

```bash
sudo systemctl start auraguard-ranges.service
journalctl -u auraguard-ranges.service -n 20 --no-pager
```

- [ ] Zkontrolovat stáří snímku kdykoli později. **Pozor, co ten příkaz
      měří:** spouští nový proces, který soubor přečte z disku. Do opravy
      z 19. 9. 2026 proto dával uklidňující odpověď o svěžím souboru,
      zatímco běžící server měl v paměti starý. Dnes se cache klíčuje
      časem změny souboru, takže se obojí shoduje — a stárnoucí snímek
      se navíc ozve sám při startu serveru (varuje po 30 dnech):

```bash
cd ~/auratest-ai && docker compose exec auratest-ai node -e "
import('./cloud-ranges.js').then(m=>console.log('stáří:', m.stariSnimkuDnu(), 'dnů | zastaralý:', m.jeSnimekZastaraly()));"
```

> `data/` se montuje jako **bind svazek**, takže nový snímek zůstane
> i po zahození kontejneru. Obraz si přes `COPY data ./data` nese vlastní
> kopii dál — svazek ji vždy zastíní, takže v provozu přes compose
> rozhoduje soubor na hostiteli.
>
> **Živý snímek není verzovaný.** V gitu je jen
> `data/cloud-ranges.vychozi.json` pro čerstvý klon; `loadRanges` na něj
> spadne, dokud živý soubor neexistuje. Kdyby byl verzovaný ten živý,
> byla by pracovní kopie na produkci po první obnově trvale špinavá,
> `git pull` by odmítl přepsat 15MB lokální změnu a obvyklá reakce
> (`git checkout -- data/`) by potichu vrátila STARŠÍ snímek.
>
> Aby obnovu viděla i **běžící** aplikace, drží `loadRanges` cache podle
> času změny souboru. Do opravy z 19. 9. 2026 se snímek načetl při prvním
> skenu a držel se do restartu procesu — týdenní obnova tím byla
> k ničemu a příkaz na zjištění stáří (spouští nový proces) dával
> uklidňující odpověď, která o stavu serveru nevypovídala.

---

## 8. Ověření naostro

Tohle je jediná část, kterou nešlo ověřit předem — sandbox nemá DNS ani
prohlížeč.

- [ ] **Které prohlížeče na ARM existují.** Playwright na arm64 historicky
      nedodával všechny a dokumentace o tom mlčí:

```bash
docker compose exec auratest-ai npx playwright install --dry-run
```

- [ ] **PQC sonda proti serveru, který hybridní skupinu umí.** Cloudflare ji
      nasazenou má, takže tady musí vyjít „nasazeno":

```bash
docker compose exec auratest-ai node scripts/smoke-test.mjs https://www.cloudflare.com
```

- [ ] **Kompletní smoke test proti vlastnímu cíli:**

```bash
docker compose exec auratest-ai node scripts/smoke-test.mjs https://nexus-sync-8d50b.web.app/logout
```

> Výstup má dva oddíly. ✅/❌ jsou kontroly **nástroje** a řídí exit kód;
> ⚠️/· jsou nálezy na **testovaném webu** a exit kód neovlivňují. Zelená tedy
> znamená „skener funguje", ne „web je v pořádku".

- [ ] **Chaos test s baseline** — ověř, že `baseline.consoleErrors` je
      vyplněné a `newConsoleErrors` dává smysl. Bez baseline běhu je verdikt
      neprůkazný, což je správně, ale znamená to, že se baseline nepovedl.
- [ ] Přihlášení přes Firebase funguje
- [ ] Živé logy agenta (WebSocket) se streamují

## 9. Provoz

- [ ] Restart po rebootu: `sudo systemctl enable docker`
      (`restart: unless-stopped` v compose se postará o zbytek)
- [ ] Rotace logů kontejneru — už je v `docker-compose.yml` (10 MB × 5)
- [ ] Rotace logů Caddy — už je v `Caddyfile` (10 MiB × 5)

---

## Když se něco nedaří

| Příznak | Nejpravděpodobnější příčina |
|---|---|
| Port nejde otevřít, přestože je v Security Listu | Chybí iptables pravidlo na instanci (krok 2) |
| Caddy nezíská certifikát | DNS se ještě nepropsalo, nebo A záznam míří jinam |
| „Out of host capacity" | Ampere A1 v regionu není — zkoušej opakovaně nebo jiný AD |
| Chromium padá na „Target closed" | Malý `/dev/shm`. Compose dává 1 GB; jinde nastav `BROWSER_ARGS=--disable-dev-shm-usage` |
| „Executable doesn't exist" | Verze Playwright image nesedí s balíčkem v `package.json` |
| Kontejner běží, ale healthcheck selhává | `docker compose logs --tail 40` — obvykle chybí `firebase-credentials.json` |
| Audit vrací 503 „nemá nakonfigurovaný jazykový model" | Očekávané chování při `ALLOWED_LLM_HOSTS=`. Použij režim monkey nebo smoke_test. |
| Disk plný | `bash deploy/cleanup-artifacts.sh` a zkontroluj, že timer běží |

---

## Záloha řetězu důkazů

`ledger/audit-ledger.jsonl` je **jediná kopie doložitelnosti**. Je
v `.gitignore` a montuje se bind mountem z disku jedné VM. Ztráta toho
disku znamená ztrátu všeho, čím se dokládá, že audity proběhly — a to je
podle `OVERENI-R2.md` hlavní důvod, proč by si produkt někdo koupil.

**Ukotvení otisku to nezachrání.** Kotva dokazuje, že se řetěz nezměnil.
Neobnoví ho.

### Instalace

Cíl musí ležet na **jiném svazku** než `ledger/`. Skript to kontroluje
přes `st_dev` a jinak odmítne pracovat: kopie vedle originálu chrání
před smazáním omylem, ne před ztrátou disku.

```bash
# 1) Připoj druhý svazek, např. /mnt/zalohy
# 2) Uprav Environment=CIL= v auraguard-zaloha.service podle skutečné cesty
sudo cp deploy/auraguard-zaloha.service /etc/systemd/system/
sudo cp deploy/auraguard-zaloha.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now auraguard-zaloha.timer
systemctl list-timers auraguard-zaloha.timer
```

Ruční spuštění a suchý běh:

```bash
docker compose exec auratest-ai node scripts/zaloha-ledgeru.mjs --cil /mnt/zalohy/auraguard --suchy
docker compose exec auratest-ai node scripts/zaloha-ledgeru.mjs --cil /mnt/zalohy/auraguard
```

### Návratové kódy

| Kód | Význam |
|---|---|
| 0 | Záloha hotová, řetěz neporušený |
| 1 | Chyba: nedostupný cíl, chybějící řetěz, **cíl na stejném svazku** |
| 2 | Záloha hotová, ale **řetěz neprošel kontrolou** — vyžaduje pozornost |

Kód 2 **není** důvod zálohu zahodit. Porušený řetěz se zálohuje taky,
protože je to důkaz o tom, že k porušení došlo; výsledek kontroly jde do
`manifest.json`.

### Obnova

Záloha, kterou nikdo nikdy nezkusil obnovit, není záloha. Postup:

```bash
# 1) Ověř snímek DŘÍV, než cokoli přepíšeš
docker compose exec auratest-ai node scripts/zaloha-ledgeru.mjs \
  --overit /mnt/zalohy/auraguard/auraguard-ledger-2026-09-19T16-07-30-472Z

# 2) Zastav aplikaci, aby do řetězu nikdo nezapisoval
docker compose stop auratest-ai

# 3) Odlož současný stav — NEPŘEPISUJ ho, může být potřeba
mv ledger ledger.pred-obnovou-$(date +%F-%H%M)

# 4) Nakopíruj snímek
mkdir -p ledger
cp /mnt/zalohy/auraguard/auraguard-ledger-<razitko>/audit-ledger.jsonl ledger/
cp /mnt/zalohy/auraguard/auraguard-ledger-<razitko>/anchors.jsonl      ledger/ 2>/dev/null || true
sudo chown -R nexus:nexus ledger

# 5) Nastartuj a ověř řetěz z aplikace
docker compose start auratest-ai
curl -s localhost:3001/api/health >/dev/null && echo "běží"
# v UI: sekce Doložitelnost → ověření řetězu
```

**Po obnově je řetěz kratší** než před havárií — chybí záznamy pořízené
mezi poslední zálohou a výpadkem. To se nedá zamluvit a do spisu to patří:
`manifest.json` nese otisk hlavy a počet záznamů, podle kterých jde přesně
doložit, který stav se obnovil.

### Co tím doděláno NENÍ

- **Zálohy Firestore.** Session, monitory a projekty jsou v Firestore
  a tenhle skript se jich netýká. Řetěz bez session se obnovit dá (spis
  pozná, že session chybí), obráceně to ale znamená audity bez důkazu.
- **Kopie mimo lokalitu.** Druhý svazek na téže VM ochrání před selháním
  disku, ne před ztrátou celého stroje nebo regionu.
- **Šifrování snímků.** Záloha obsahuje adresy auditovaných webů zákazníků.
