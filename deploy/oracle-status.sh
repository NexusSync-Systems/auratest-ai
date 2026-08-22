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
# PID si zapisuje sama smyčka. `pgrep -f` na jméno skriptu nejde použít —
# stejný řetězec mají v argumentech i `caffeinate` a obalový `bash -c`,
# takže jeden běh vypadá jako čtyři.
LOOP_PID_FILE="$HOME/.auraguard-retry-loop.pid"
LOOP_PID=$(cat "$LOOP_PID_FILE" 2>/dev/null)

if [[ "$LOOP_PID" =~ ^[0-9]+$ ]] && kill -0 "$LOOP_PID" 2>/dev/null; then
    # etime = jak dlouho proces žije; užitečnější než čas startu
    UPTIME=$(ps -o etime= -p "$LOOP_PID" 2>/dev/null | tr -d ' ')
    echo "${GREEN}běží${RESET} (PID $LOOP_PID, ${UPTIME:-?})"
else
    echo "${RED}neběží${RESET} — spusť: bash deploy/oracle-retry-mac.sh"
fi

# Nezávislá kontrola na osiřelé běhy.
#
# PID soubor zná jen tu poslední smyčku — starší běh, který přežil vadný
# `--stop`, do něj nikdy nezapsal. Hledat proces podle jména ale není
# přímočaré, protože stejnou příkazovou řádku mají tři další věci:
#
#   1. `caffeinate` a obalový `bash -c` — mají jméno skriptu v argumentech
#   2. každé `$(oci ...)` — bash pro command substitution forkne podproces
#      s IDENTICKOU příkazovou řádkou
#
# První dva vyřadí grep. Ten třetí ne — pozná se podle rodiče: podproces
# má za rodiče tu smyčku, samostatný běh nikoli.
ALL_LOOPS=$(ps -axo pid=,ppid=,command= 2>/dev/null \
    | grep 'oracle-retry-launch\.sh' \
    | grep -v -e ' -c ' -e 'caffeinate' -e 'grep' \
    | awk '{pid[$1]=$2} END {for (p in pid) if (!(pid[p] in pid)) print p}')
LOOP_COUNT=$(echo "$ALL_LOOPS" | grep -cE '^[0-9]+$')

if [[ "$LOOP_COUNT" -gt 1 ]]; then
    echo "          ${RED}POZOR: běží ${LOOP_COUNT} smyček (PID $(echo "$ALL_LOOPS" | tr '\n' ' '))${RESET}"
    echo "          ${YELLOW}Navzájem si drží rezervaci kvóty a Oracle je pak škrtí (429).${RESET}"
    echo "          Ukliď: pkill -f oracle-retry-launch.sh && bash deploy/oracle-retry-mac.sh"
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
