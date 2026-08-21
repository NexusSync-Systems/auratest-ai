#!/usr/bin/env bash
#
# Spustí `oracle-retry-launch.sh` na Macu tak, aby běžel i po zavření
# terminálu, a upozorní tě, až instance vznikne.
#
# PROČ NE CLOUD SHELL
# Cloud Shell není server — se zavřením okna skončí session i proces. Tohle
# je jediná varianta, která opravdu běží přes noc.
#
# CO TO UDĚLÁ
#   1. Ověří, že je OCI CLI nainstalované a nakonfigurované (a když ne,
#      přesně řekne co doplnit — místo aby to spadlo za hodinu).
#   2. Spustí smyčku na pozadí přes `nohup`, takže přežije zavření terminálu.
#   3. `caffeinate` drží Mac vzhůru, jinak by po uspání smyčka stála.
#   4. Až instance naběhne, pošle systémovou notifikaci a pípne.
#
# POUŽITÍ
#   bash deploy/oracle-retry-mac.sh          # spustí na pozadí
#   bash deploy/oracle-retry-mac.sh --stop   # zastaví
#   tail -f ~/auraguard-retry.log            # sleduje průběh
#
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$SCRIPT_DIR/oracle-retry-launch.sh"
LOG_FILE="$HOME/auraguard-retry.log"
PID_FILE="$HOME/.auraguard-retry.pid"

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; RESET=$'\e[0m'
die() { echo "${RED}✘${RESET} $*" >&2; exit 1; }
ok()  { echo "${GREEN}✔${RESET} $*"; }

# Zdrojem pravdy je PID, který si smyčka sama zapíše.
#
# Dvě slepé uličky, kterými to prošlo:
#   1. Ukládat PID `caffeinate` nestačí — `--stop` zabil obal a vnitřní bash
#      se smyčkou běžel dál. Dvě smyčky střílející naráz si navzájem drží
#      rezervaci kvóty a vyrábějí „service limits exceeded" i 429.
#   2. Hledat proces přes `pgrep -f oracle-retry-launch.sh` taky ne — stejný
#      řetězec mají v argumentech `caffeinate` i obalový `bash -c`, takže
#      jeden běh vypadal jako čtyři.
LOOP_PID_FILE="$HOME/.auraguard-retry-loop.pid"

running_pids() {
    local p
    for f in "$LOOP_PID_FILE" "$PID_FILE"; do
        [[ -f "$f" ]] || continue
        p=$(cat "$f" 2>/dev/null)
        [[ "$p" =~ ^[0-9]+$ ]] && kill -0 "$p" 2>/dev/null && echo "$p"
    done
}

# ── zastavení ────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
    PIDS=$(running_pids | sort -u)

    if [[ -z "$PIDS" ]]; then
        echo "${YELLOW}Nic neběží.${RESET}"
        rm -f "$PID_FILE" "$LOOP_PID_FILE"
        exit 0
    fi

    for p in $PIDS; do
        kill "$p" 2>/dev/null && echo "  ukončen PID $p"
    done
    sleep 2

    # Co nepovolilo po TERM, dostane KILL. Osiřelá smyčka je horší
    # než tvrdé ukončení — tichého duplicitního běhu si nikdo nevšimne.
    for p in $(running_pids); do
        kill -9 "$p" 2>/dev/null && echo "  vynuceně ukončen PID $p"
    done

    rm -f "$PID_FILE" "$LOOP_PID_FILE"
    ok "Zastaveno."
    exit 0
fi

# ── předpoklady ──────────────────────────────────────────────────────────────
[[ "$(uname)" == "Darwin" ]] || die "Tenhle wrapper je pro macOS. Na Linuxu spusť rovnou:
  nohup bash $LAUNCHER > $LOG_FILE 2>&1 &"

[[ -f "$LAUNCHER" ]] || die "Nenašel jsem $LAUNCHER"

if ! command -v oci >/dev/null; then
    die "OCI CLI není nainstalované:
  brew install oci-cli"
fi

if [[ ! -f "$HOME/.oci/config" ]]; then
    die "OCI CLI není nakonfigurované. Spusť:
  oci setup config

Průvodce se zeptá na:
  • User OCID    — konzole → Profile (vpravo nahoře) → My profile → OCID
  • Tenancy OCID — konzole → Profile → Tenancy → OCID
  • Region       — eu-frankfurt-1
  • Generate a new API key? → Y

Na konci vypíše cestu k veřejnému klíči (obvykle ~/.oci/oci_api_key_public.pem).
Jeho OBSAH vlož v konzoli do:
  Profile → My profile → API keys → Add API key → Paste a public key"
fi

# Ověřit, že přihlášení opravdu funguje. Konfigurační soubor může existovat
# a přesto být nepoužitelný — klíč nemusí být v konzoli nahraný.
echo "▶ Ověřuji přístup k OCI …"
WHO=$(oci iam region list --query 'data[0].name' --raw-output 2>&1) || die \
"OCI CLI je nakonfigurované, ale volání selhalo:

$(printf '%s' "$WHO" | tail -10)

Nejčastější příčina: veřejný klíč není nahraný v konzoli
(Profile → My profile → API keys → Add API key)."
ok "Přístup funguje."

ALREADY=$(running_pids)
if [[ -n "$ALREADY" ]]; then
    die "Už běží (PID $(echo "$ALREADY" | tr '\n' ' ')). Zastavíš přes:
  bash $0 --stop"
fi

# ── spuštění ─────────────────────────────────────────────────────────────────

# Log se PŘIDÁVÁ, nepřepisuje. Když smyčka spadne a ty ji pustíš znovu,
# potřebuješ vidět i to, co jí předcházelo — jinak diagnostikuješ naslepo.
{
    echo
    echo "════════════════════════════════════════════════════════════════"
    echo "  spuštěno $(date '+%Y-%m-%d %H:%M:%S')"
    echo "════════════════════════════════════════════════════════════════"
} >> "$LOG_FILE"

# `caffeinate -is` drží systém vzhůru po dobu běhu podřízeného procesu.
# Bez toho Mac usne a smyčka se zastaví přesně ve chvíli, kdy se kapacita
# nejspíš uvolňuje — v noci.
nohup caffeinate -is bash -c "
    bash '$LAUNCHER'
    status=\$?
    if [[ \$status -eq 0 ]]; then
        osascript -e 'display notification \"Instance běží. Detaily v ~/auraguard-retry.log\" with title \"AuraGuard: Oracle hotovo\" sound name \"Glass\"' 2>/dev/null
    else
        osascript -e 'display notification \"Smyčka skončila s chybou \$status\" with title \"AuraGuard: Oracle selhal\" sound name \"Basso\"' 2>/dev/null
    fi
    exit \$status
" >> "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"

sleep 3
echo
ok "Běží na pozadí, PID $(cat "$PID_FILE")"
echo
echo "  Průběh:   ${DIM}tail -f $LOG_FILE${RESET}"
echo "  Zastavit: ${DIM}bash $0 --stop${RESET}"
echo
echo "${DIM}--- zatím v logu ---${RESET}"
tail -15 "$LOG_FILE" 2>/dev/null
