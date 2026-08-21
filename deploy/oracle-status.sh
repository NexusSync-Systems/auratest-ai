#!/usr/bin/env bash
#
# Kde na tom jsme? Jeden pohled místo tří příkazů.
#
# Odpovídá na tři otázky, které se při čekání na kapacitu ptáš pořád dokola:
#   1. Běží ještě smyčka, nebo tiše umřela?
#   2. Nevznikla už instance?
#   3. Co dělala v posledních pokusech?
#
# POUŽITÍ
#   bash deploy/oracle-status.sh
#
set -o pipefail

LOG_FILE="$HOME/auraguard-retry.log"
PID_FILE="$HOME/.auraguard-retry.pid"
COMPARTMENT_OCID="${COMPARTMENT_OCID:-ocid1.tenancy.oc1..aaaaaaaau72fezvgkvtbxalmwj2l3cd735u3tsh7pqq5afypawzcvg4gk6rq}"
INSTANCE_NAME="${INSTANCE_NAME:-auraguard}"

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; RESET=$'\e[0m'

# ── 1. běží smyčka? ──────────────────────────────────────────────────────────
printf 'Smyčka:   '
# Ptáme se procesů, ne PID souboru — ten po osiřelém běhu lže.
PIDS=$(pgrep -f "[o]racle-retry-launch.sh" 2>/dev/null)
COUNT=$(echo "$PIDS" | grep -cE '^[0-9]+$')

if [[ "$COUNT" -eq 0 ]]; then
    echo "${RED}neběží${RESET} — spusť: bash deploy/oracle-retry-mac.sh"
elif [[ "$COUNT" -eq 1 ]]; then
    # etime = jak dlouho proces žije; užitečnější než čas startu
    UPTIME=$(ps -o etime= -p "$PIDS" 2>/dev/null | tr -d ' ')
    echo "${GREEN}běží${RESET} (PID $PIDS, ${UPTIME:-?})"
else
    # Víc než jedna smyčka si navzájem drží rezervaci kvóty a vyrábí
    # falešné „service limits exceeded". Není to kosmetická vada.
    echo "${RED}BĚŽÍ ${COUNT}× SOUČASNĚ${RESET} (PID $(echo "$PIDS" | tr '\n' ' '))"
    echo "          ${YELLOW}Zastav vše a spusť jednu:${RESET}"
    echo "          bash deploy/oracle-retry-mac.sh --stop && bash deploy/oracle-retry-mac.sh"
fi

# ── 2. existuje instance? ────────────────────────────────────────────────────
printf 'Instance: '
if command -v oci >/dev/null; then
    INFO=$(oci compute instance list -c "$COMPARTMENT_OCID" \
        --display-name "$INSTANCE_NAME" \
        --query 'data[?"lifecycle-state"!=`TERMINATED`].{s:"lifecycle-state",id:id}' \
        --output json 2>/dev/null)
    STATE=$(printf '%s' "$INFO" | grep -oE '"s": "[A-Z]+"' | head -1 | cut -d'"' -f4)
    ID=$(printf '%s' "$INFO" | grep -oE 'ocid1\.instance\.[a-z0-9._-]+' | head -1)

    if [[ -z "$STATE" ]]; then
        echo "${YELLOW}zatím žádná${RESET}"
    else
        IP=$(oci compute instance list-vnics --instance-id "$ID" \
            --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
        echo "${GREEN}${STATE}${RESET}   IP: ${IP:-zjišťuje se}"
        [[ -n "$IP" ]] && echo "          ssh -i ~/.ssh/auraguard ubuntu@${IP}"
    fi
else
    echo "${DIM}OCI CLI není k dispozici${RESET}"
fi

# ── 3. poslední pokusy ───────────────────────────────────────────────────────
echo
if [[ -f "$LOG_FILE" ]]; then
    TOTAL=$(grep -cE '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' "$LOG_FILE" 2>/dev/null || echo 0)
    echo "${DIM}Pokusů celkem: ${TOTAL}. Posledních 8:${RESET}"
    grep -E '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]|^ +kolo bez' "$LOG_FILE" | tail -8
else
    echo "${DIM}Log ${LOG_FILE} zatím neexistuje.${RESET}"
fi
