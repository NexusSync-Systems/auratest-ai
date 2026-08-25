#!/usr/bin/env bash
#
# Nasazení AuraGuard na server. Idempotentní — dá se pouštět opakovaně.
#
#   ssh ubuntu@<ip>
#   cd ~/auratest-ai && bash deploy/deploy.sh
#
# Co dělá: ověří předpoklady, sestaví image, nastartuje a POČKÁ, až se
# aplikace ohlásí jako zdravá. Když se nerozjede, vypíše logy a skončí
# nenulovým kódem — mlčky „hotovo" u nefunkčního nasazení je horší než chyba.
#
set -euo pipefail
cd "$(dirname "$0")/.."

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
ok()   { echo "${GREEN}  ✔${RESET} $*"; }
warn() { echo "${YELLOW}  !${RESET} $*"; }
die()  { echo "${RED}  ✘${RESET} $*" >&2; exit 1; }

echo "▶ Kontrola předpokladů"

command -v docker >/dev/null || die "Docker není nainstalovaný."
docker compose version >/dev/null 2>&1 || die "Chybí plugin 'docker compose' (v2)."
ok "Docker je k dispozici"

# Bez tohohle běží každý docker příkaz přes sudo a compose si vyrobí
# root-owned soubory v bind mountech.
docker info >/dev/null 2>&1 || die "Uživatel nemá přístup k Docker daemonu. Spusť: sudo usermod -aG docker \$USER, pak se odhlas a přihlas."
ok "Uživatel má přístup k Docker daemonu"

[[ -f .env ]] || die "Chybí .env. Vyjdi z šablony: cp .env.example .env"
ok ".env existuje"

# Firebase Auth je jediný způsob přihlášení — bez klíče se nikdo nepřihlásí.
if [[ ! -f firebase-credentials.json ]]; then
    die "Chybí firebase-credentials.json. Bez něj neběží přihlášení ani ukládání výsledků."
fi
ok "firebase-credentials.json existuje"

# Proměnné, bez kterých se aplikace chová špatně, ale nespadne — tedy ty,
# jejichž chybění se pozná až za provozu.
for var in ALLOWED_ORIGINS PUBLIC_BASE_URL; do
    if ! grep -qE "^${var}=.+" .env; then
        warn "${var} není v .env vyplněné — CORS a odkazy na artefakty nebudou fungovat správně."
    fi
done

# Architektura: image se musí shodovat se strojem.
ARCH="$(uname -m)"
case "$ARCH" in
    aarch64|arm64) PLATFORM="linux/arm64" ;;
    x86_64|amd64)  PLATFORM="linux/amd64" ;;
    *) die "Neznámá architektura: $ARCH" ;;
esac
ok "Architektura: $ARCH → $PLATFORM"

# Chromium potřebuje víc paměti, než se na první pohled zdá. Compose má
# mem_limit 2g; pod 4 GB RAM celkem to bude na hraně.
TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if (( TOTAL_MB > 0 && TOTAL_MB < 4096 )); then
    warn "Stroj má jen ${TOTAL_MB} MB RAM. Playwright si na jeden běh vezme ~1–2 GB — čekej zabité kontejnery."
else
    ok "Paměť: ${TOTAL_MB} MB"
fi

# Volné místo: artefakty (videa!) rostou rychle.
FREE_GB="$(df -BG --output=avail . 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
if (( FREE_GB > 0 && FREE_GB < 10 )); then
    warn "Volno jen ${FREE_GB} GB. Pusť deploy/cleanup-artifacts.sh a zkontroluj rotaci logů."
else
    ok "Volné místo: ${FREE_GB} GB"
fi

# Adresáře pro artefakty musí existovat a patřit uživateli z kontejneru.
#
# Kontejner běží jako `pwuser` (UID 1000), ne jako root — viz Dockerfile.
# Když adresáře předem neexistují, Docker je při bind mountu založí jako
# root:root a aplikace do nich nezapíše. Projeví se to až za běhu jako
# „EACCES: permission denied" u screenshotů a videí, tedy dávno po tom, co
# nasazení nahlásí úspěch.
echo
echo "▶ Adresáře pro artefakty a záznam auditů"
CONTAINER_UID=1000
for d in screenshots videos generated-scripts ledger; do
    mkdir -p "$d"
    OWNER="$(stat -c '%u' "$d" 2>/dev/null || echo '?')"
    if [[ "$OWNER" != "$CONTAINER_UID" ]]; then
        if sudo chown -R "${CONTAINER_UID}:${CONTAINER_UID}" "$d" 2>/dev/null; then
            ok "$d — vlastník opraven na UID ${CONTAINER_UID}"
        else
            warn "$d patří UID ${OWNER}, kontejner běží jako ${CONTAINER_UID}. Sprav ručně:
       sudo chown -R ${CONTAINER_UID}:${CONTAINER_UID} $d"
        fi
    else
        ok "$d"
    fi
done

echo
echo "▶ Sestavení image (${PLATFORM})"
# --platform explicitně: kdyby se stavělo na jiné architektuře, vznikl by
# image, který na cíli poběží leda přes emulaci, případně vůbec.
DOCKER_DEFAULT_PLATFORM="$PLATFORM" docker compose build --pull
ok "Image sestaven"

echo
echo "▶ Start"
docker compose up -d
ok "Kontejner spuštěn"

echo
echo "▶ Čekání na zdravý stav (max 120 s)"
# Healthcheck v Dockerfile má start-period 20 s, takže hned po startu je stav
# "starting". Čeká se na "healthy", ne jen na běžící proces — kontejner může
# běžet a aplikace přitom být rozbitá.
CONTAINER="$(docker compose ps -q auratest-ai)"
[[ -n "$CONTAINER" ]] || die "Kontejner se nenastartoval. Podívej se na: docker compose logs"

for i in $(seq 1 40); do
    STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
    case "$STATUS" in
        healthy)
            ok "Aplikace je zdravá"
            break
            ;;
        unhealthy)
            echo
            echo "${RED}Aplikace se rozjela, ale healthcheck selhal. Posledních 40 řádků logu:${RESET}"
            docker compose logs --tail 40
            die "Nasazení selhalo."
            ;;
    esac
    sleep 3
    [[ $i -eq 40 ]] && { docker compose logs --tail 40; die "Aplikace se do 120 s neohlásila jako zdravá."; }
done

echo
echo "▶ Ověření konfigurace za běhu"

# Co instalace umí — hlavně jestli sedí očekávání ohledně LLM.
CAPS="$(docker compose exec -T auratest-ai node -e "
fetch('http://127.0.0.1:3001/api/capabilities')
  .then(r => r.json())
  .then(d => console.log(JSON.stringify(d)))
  .catch(e => { console.error(e.message); process.exit(1); })
" 2>/dev/null || echo '{}')"

if [[ "$CAPS" == *'"llmConfigured":false'* ]]; then
    ok "LLM vypnuté — dostupné jsou režimy monkey a smoke_test + všechny compliance skenery"
elif [[ "$CAPS" == *'"llmConfigured":true'* ]]; then
    ok "LLM nakonfigurované — dostupné jsou i AI režimy"
else
    warn "Endpoint /api/capabilities neodpověděl podle očekávání: ${CAPS}"
fi

echo
echo "${GREEN}✔ Nasazeno.${RESET}"
echo
echo "Zbývá ověřit naostro (v sandboxu to nešlo — chybí DNS i prohlížeč):"
echo "  docker compose exec auratest-ai npx playwright install --dry-run"
echo "      → které prohlížeče jsou na téhle architektuře reálně k dispozici"
echo "  docker compose exec auratest-ai node scripts/smoke-test.mjs https://www.cloudflare.com"
echo "      → PQC sonda proti serveru, který hybridní skupinu umí"
echo
echo "  docker compose exec auratest-ai node scripts/verify-ledger.mjs"
echo "      → neporušenost záznamu auditů (D1–D3)"
echo
echo "Logy:    docker compose logs -f"
echo "Restart: docker compose restart"
