#!/usr/bin/env bash
#
# Opakované spouštění Terraform apply nad uloženým stackem, dokud se
# neuvolní kapacita Ampere A1.
#
# PROČ TOHLE
# Konzole po chybě „Out of host capacity" resetovala celý formulář (image se
# přepnul zpátky na Oracle Linux), takže každý pokus znamenal projít průvodce
# znovu. Uložený stack tenhle problém řeší — konfigurace je zamrzlá — ale
# pořád po tobě chce klikat Actions → Apply a čekat na výsledek.
#
# Tenhle skript to dělá za tebe: spustí apply, počká na výsledek, a když
# selže na kapacitě, zkusí to za chvíli znovu. Ostatní chyby ho zastaví,
# protože opakovat vadnou konfiguraci nemá smysl.
#
# KDE TO SPUSTIT
#   Cloud Shell v konzoli Oracle (ikona `>_` vpravo nahoře). Má OCI CLI
#   předinstalované a přihlášené. Session ale skončí s odhlášením — proces
#   nepřežije zavření okna. Pro běh bez dozoru spusť skript na vlastním
#   stroji (`brew install oci-cli && oci setup config`).
#
# POUŽITÍ
#   bash oracle-retry-apply.sh ocid1.ormstack.oc1.eu-frankfurt-1.aaaaa...
#
#   OCID stacku najdeš v konzoli: Developer Services → Resource Manager →
#   Stacks → tvůj stack → General information → OCID (tlačítko Copy).
#
# POZOR NA `set -u`
#   Záměrně tu NENÍ. Cloud Shell má v konfiguraci promptu odkaz na `$USER`,
#   která v tom prostředí není nastavená — kdyby někdo obsah skriptu vložil
#   přímo do promptu místo do souboru, `set -u` mu rozbije celou session.
set -o pipefail

STACK_OCID="${1:-}"

# Jak dlouho čekat mezi pokusy (sekundy). Pod minutu nechoď — Oracle
# při agresivním opakování začne odpovídat 429.
RETRY_INTERVAL="${RETRY_INTERVAL:-300}"

# Jak často se ptát na stav běžícího jobu (sekundy).
POLL_INTERVAL="${POLL_INTERVAL:-20}"

# Kolik pokusů maximálně. 0 = donekonečna.
MAX_ATTEMPTS="${MAX_ATTEMPTS:-0}"

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; RESET=$'\e[0m'
die() { echo "${RED}✘${RESET} $*" >&2; exit 1; }

[[ -n "$STACK_OCID" ]] || die "Chybí OCID stacku.

Použití:
  bash oracle-retry-apply.sh <stack-ocid>

OCID najdeš: Developer Services → Resource Manager → Stacks → tvůj stack"

command -v oci >/dev/null || die "OCI CLI není k dispozici. Spusť to v Cloud Shellu."

# Ověřit, že stack existuje a je přístupný — lepší selhat teď než po hodině.
STACK_NAME=$(oci resource-manager stack get --stack-id "$STACK_OCID" \
    --query 'data."display-name"' --raw-output 2>/dev/null) \
    || die "Stack se nepodařilo načíst. Zkontroluj OCID a region."

echo "▶ Stack: ${STACK_NAME}"
echo "  Interval mezi pokusy: ${RETRY_INTERVAL}s"
[[ "$MAX_ATTEMPTS" -gt 0 ]] && echo "  Maximum pokusů: ${MAX_ATTEMPTS}"
echo "  Ukončíš přes Ctrl+C. Rozdělaný job doběhne sám."
echo

# Počkat, až job doběhne, a vrátit jeho koncový stav.
#
# `--wait-for-state` u `job create-apply-job` NEEXISTUJE — s ním příkaz
# spadne na neznámý přepínač, skript pak nedostane OCID jobu a chybová
# hláška se ztratí. Proto se pollujeme sami.
wait_for_job() {
    local job_id="$1" state
    while true; do
        state=$(oci resource-manager job get --job-id "$job_id" \
            --query 'data."lifecycle-state"' --raw-output 2>/dev/null)
        case "$state" in
            ACCEPTED|IN_PROGRESS|CANCELING) sleep "$POLL_INTERVAL" ;;
            "") sleep "$POLL_INTERVAL" ;;   # dočasný výpadek API, ne konec
            *) echo "$state"; return 0 ;;
        esac
    done
}

attempt=0
while true; do
    attempt=$((attempt + 1))
    if [[ "$MAX_ATTEMPTS" -gt 0 && "$attempt" -gt "$MAX_ATTEMPTS" ]]; then
        echo
        echo "${YELLOW}Vyčerpán limit ${MAX_ATTEMPTS} pokusů. Kapacita se neuvolnila.${RESET}"
        echo "Zvaž Cloud Run — fáze 2 v PLAN-DEPLOY.md."
        exit 2
    fi

    printf '[%s] pokus %d — spouštím apply ... ' "$(date +%H:%M:%S)" "$attempt"

    JOB_ID=$(oci resource-manager job create-apply-job \
        --stack-id "$STACK_OCID" \
        --execution-plan-strategy AUTO_APPROVED \
        --query 'data.id' --raw-output 2>&1)

    if [[ "$JOB_ID" != ocid1.ormjob* ]]; then
        echo "${RED}NEPODAŘILO SE ZALOŽIT JOB${RESET}"
        echo
        echo "$JOB_ID" | tail -25
        echo
        die "Apply se nespustil. Obvyklý důvod: nad stackem už jeden job běží."
    fi

    JOB_STATE=$(wait_for_job "$JOB_ID")

    if [[ "$JOB_STATE" == "SUCCEEDED" ]]; then
        echo "${GREEN}HOTOVO${RESET}"
        echo
        echo "${GREEN}✔ Instance vytvořena.${RESET}"
        echo
        echo "Veřejnou IP najdeš v konzoli: Compute → Instances → auraguard"
        echo
        echo "Pak pokračuj podle deploy/README.md od kroku 5:"
        echo "  ssh -i ~/.ssh/auraguard ubuntu@<ip>"
        exit 0
    fi

    # Zjistit důvod selhání z logu jobu.
    LOG=$(oci resource-manager job get-job-logs --job-id "$JOB_ID" 2>/dev/null)

    if echo "$LOG" | grep -qi "out of.*capacity\|OutOfCapacity"; then
        echo "${YELLOW}kapacita není${RESET}"
    else
        echo "${RED}CHYBA (${JOB_STATE})${RESET}"
        echo
        echo "${DIM}--- posledních 25 řádků logu ---${RESET}"
        echo "$LOG" | tail -25
        echo "${DIM}--------------------------------${RESET}"
        echo
        echo "Job: $JOB_ID"
        die "Tohle není kapacitní problém. Oprav stack a spusť skript znovu."
    fi

    echo "        ${DIM}čekám ${RETRY_INTERVAL}s${RESET}"
    sleep "$RETRY_INTERVAL"
done
