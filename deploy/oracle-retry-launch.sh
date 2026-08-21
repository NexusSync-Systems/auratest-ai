#!/usr/bin/env bash
#
# Opakované pokusy o vytvoření Ampere A1 instance, dokud nebude volná kapacita.
#
# PROČ NE PŘES RESOURCE MANAGER
# Stack vygenerovaný konzolí má `availability_domain` napevno v `main.tf`.
# Opakovaný apply tedy pořád mlátí do jedné domény — a když je zrovna plná,
# nemá to jak vyjít. Přímé volání API umožní rotovat všechny domény v regionu
# a zkusit i menší tvar, což zvyšuje šanci násobně.
#
# CO TENHLE SKRIPT ZKOUŠÍ
# V jednom kole projde kombinace {AD-1, AD-2, AD-3} × {2 OCPU/12 GB,
# 1 OCPU/6 GB}. Šest pokusů za kolo místo jednoho.
#
# 1 OCPU / 6 GB je pořád v Always Free a na Chromium stačí — jen nastav
# v `.env` `MAX_CONCURRENT_BROWSERS=1`. Když nechceš menší tvar vůbec,
# spusť s `SMALL_FALLBACK=0`.
#
# KDE TO SPUSTIT
#   Cloud Shell: proces zemře se zavřením okna. Na běh bez dozoru použij
#   vlastní stroj:
#     brew install oci-cli && oci setup config
#     caffeinate -is nohup bash oracle-retry-launch.sh > ~/retry.log 2>&1 &
#
# POUŽITÍ
#   bash oracle-retry-launch.sh
#
set -o pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Hodnoty odečtené z Terraform plánu stacku instance-20260821-1402.
# Když zakládáš v jiné tenancy nebo regionu, přepiš je.
# ─────────────────────────────────────────────────────────────────────────────

COMPARTMENT_OCID="${COMPARTMENT_OCID:-ocid1.tenancy.oc1..aaaaaaaau72fezvgkvtbxalmwj2l3cd735u3tsh7pqq5afypawzcvg4gk6rq}"

# Veřejný subnet ve VCN auraguard-vcn.
SUBNET_OCID="${SUBNET_OCID:-ocid1.subnet.oc1.eu-frankfurt-1.aaaaaaaafx6zuehaa73sqj6btb4eonimrvbtdbinsemjv2miypiyzuwk4jcq}"

# Canonical Ubuntu 22.04, aarch64.
IMAGE_OCID="${IMAGE_OCID:-ocid1.image.oc1.eu-frankfurt-1.aaaaaaaao7qhcfyrevrv7qmvwi2rkyww3lidxgsq3br7gpr6tsq3xueqo5yq}"

# Veřejný SSH klíč. V Cloud Shellu soubor nemáš — proto i varianta inline.
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJatU+VxwfcOwXUzzlEbRnMEx000596o1wD13AQsFYFA auraguard}"

INSTANCE_NAME="${INSTANCE_NAME:-auraguard}"
SHAPE="VM.Standard.A1.Flex"
BOOT_VOLUME_GB="${BOOT_VOLUME_GB:-50}"

# Jak dlouho čekat mezi koly (sekundy). Pod minutu nechoď — Oracle
# při agresivním opakování odpovídá 429.
RETRY_INTERVAL="${RETRY_INTERVAL:-300}"

# Zkoušet i menší tvar? 1 = ano.
SMALL_FALLBACK="${SMALL_FALLBACK:-1}"

# ─────────────────────────────────────────────────────────────────────────────

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; RESET=$'\e[0m'
die() { echo "${RED}✘${RESET} $*" >&2; exit 1; }

command -v oci >/dev/null || die "OCI CLI není k dispozici. Spusť to v Cloud Shellu, nebo: brew install oci-cli"

KEY_FILE=$(mktemp)
printf '%s\n' "$SSH_PUBLIC_KEY" > "$KEY_FILE"

# Smyčka si píše vlastní PID.
#
# Hledat ji přes `pgrep -f oracle-retry-launch.sh` nejde: stejný řetězec mají
# v argumentech i `caffeinate` a obalový `bash -c`, takže jeden běh vypadá
# jako čtyři. Wrapper i status skript se proto ptají tohohle souboru.
LOOP_PID_FILE="${LOOP_PID_FILE:-$HOME/.auraguard-retry-loop.pid}"
echo $$ > "$LOOP_PID_FILE"
trap 'rm -f "$KEY_FILE" "$LOOP_PID_FILE"' EXIT

echo "▶ Zjišťuji availability domény"
AD_RAW=$(oci iam availability-domain list -c "$COMPARTMENT_OCID" \
    --query 'data[].name' --raw-output 2>&1)

# `mapfile` tu záměrně není: macOS dodává bash 3.2, kde neexistuje, a skript
# má běžet i pod systémovým /bin/bash — jinak by spadl až po ověření přístupu.
ADS=()
while IFS= read -r line; do
    [[ -n "$line" ]] && ADS+=("$line")
done < <(printf '%s' "$AD_RAW" | grep -oE '[A-Za-z0-9]+:[A-Z0-9-]+')

if [[ ${#ADS[@]} -eq 0 ]]; then
    echo
    printf '%s' "$AD_RAW" | tail -10
    echo
    die "Nepodařilo se načíst availability domény. Zkontroluj COMPARTMENT_OCID."
fi
printf '  nalezeno %d: %s\n' "${#ADS[@]}" "${ADS[*]}"

# Ověřit, že účet A1 příděl vůbec má. Bez tohohle by smyčka běžela dny
# proti limitu, který je natvrdo nula — a hlásila by přitom „plno", což
# svádí k závěru, že jde jen o kapacitu.
echo "▶ Ověřuji příděl Ampere A1"
A1_LIMIT=$(oci limits value list --all \
    --compartment-id "$COMPARTMENT_OCID" \
    --service-name compute \
    --query 'data[?name==`standard-a1-core-regional-count`].value | [0]' \
    --raw-output 2>/dev/null)
if [[ "$A1_LIMIT" == "0" ]]; then
    die "Účet má regionální příděl A1 jader nastavený na 0.
Opakovat nemá smysl — požádej o navýšení v konzoli
(Limits, Quotas and Usage), nebo přejdi na Cloud Run."
fi
printf '  regionální limit: %s jader\n' "${A1_LIMIT:-neznámý}"

# Kombinace tvarů, od většího k menšímu.
SHAPES=("2 12")
[[ "$SMALL_FALLBACK" == "1" ]] && SHAPES+=("1 6")

echo
echo "▶ Zkouším ${SHAPE}"
printf '  tvary:'; for s in "${SHAPES[@]}"; do printf ' %s OCPU/%s GB,' ${s}; done; echo
echo "  Interval mezi koly: ${RETRY_INTERVAL}s. Ukončíš přes Ctrl+C."
echo

attempt=0
while true; do
    for spec in "${SHAPES[@]}"; do
        read -r OCPUS MEMORY_GB <<< "$spec"
        for ad in "${ADS[@]}"; do
            attempt=$((attempt + 1))
            printf '[%s] %-3d %s  %sc/%sg ... ' \
                "$(date +%H:%M:%S)" "$attempt" "${ad##*:}" "$OCPUS" "$MEMORY_GB"

            # Než střelíme znovu, ověřit, že instance mezitím nevznikla.
            #
            # Když volání spadne na síťový timeout, nevíme, jestli Oracle
            # požadavek nepřijal — odpověď se prostě nevrátila. Bez téhle
            # kontroly by smyčka jela dál a do rána vyrobila hromadu
            # instancí, o kterých neví.
            EXISTING=$(oci compute instance list -c "$COMPARTMENT_OCID" \
                --display-name "$INSTANCE_NAME" \
                --query 'data[?"lifecycle-state"!=`TERMINATED` && "lifecycle-state"!=`TERMINATING`].id' \
                --raw-output 2>/dev/null | grep -oE 'ocid1\.instance\.[a-z0-9._-]+' | head -1)
            if [[ -n "$EXISTING" ]]; then
                echo "${GREEN}UŽ EXISTUJE${RESET}"
                IP=$(oci compute instance list-vnics --instance-id "$EXISTING" \
                    --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
                echo
                echo "${GREEN}✔ Instance ${INSTANCE_NAME} už běží (nebo se zakládá).${RESET}"
                echo "  Veřejná IP: ${IP:-zjisti v konzoli}"
                echo "  ssh -i ~/.ssh/auraguard ubuntu@${IP:-<ip>}"
                exit 0
            fi

            # `--wait-for-state RUNNING` tu ZÁMĚRNĚ není. Waiter drží spojení
            # klidně sedm minut a nakonec spadne na „connection to endpoint
            # timed out" — což vypadá jako chyba konfigurace, i když se
            # instance mezitím možná založila. Kapacitní chyba přitom přijde
            # okamžitě už při samotném LaunchInstance, takže čekat na RUNNING
            # není k ničemu; stav si dopollujeme sami, až launch projde.
            OUTPUT=$(oci compute instance launch \
                --compartment-id "$COMPARTMENT_OCID" \
                --availability-domain "$ad" \
                --display-name "$INSTANCE_NAME" \
                --image-id "$IMAGE_OCID" \
                --shape "$SHAPE" \
                --shape-config "{\"ocpus\":${OCPUS},\"memoryInGBs\":${MEMORY_GB}}" \
                --subnet-id "$SUBNET_OCID" \
                --assign-public-ip true \
                --boot-volume-size-in-gbs "$BOOT_VOLUME_GB" \
                --ssh-authorized-keys-file "$KEY_FILE" \
                2>&1)
            STATUS=$?

            if [[ $STATUS -eq 0 ]]; then
                INSTANCE_ID=$(printf '%s' "$OUTPUT" \
                    | grep -oE 'ocid1\.instance\.[a-z0-9._-]+' | head -1)
                echo "${GREEN}ZALOŽENO${RESET} — čekám na RUNNING"

                # Kapacita může chybět i po přijetí požadavku — instance pak
                # projde PROVISIONING a skončí TERMINATED. To bereme jako
                # „plno" a jedeme dál, ne jako fatální chybu.
                state=""
                for _ in $(seq 1 60); do
                    state=$(oci compute instance get --instance-id "$INSTANCE_ID" \
                        --query 'data."lifecycle-state"' --raw-output 2>/dev/null)
                    case "$state" in
                        RUNNING|TERMINATED|TERMINATING) break ;;
                        *) sleep 10 ;;
                    esac
                done

                if [[ "$state" != "RUNNING" ]]; then
                    echo "        ${YELLOW}instance skončila ve stavu ${state:-neznámý} — beru jako plno${RESET}"
                else
                    IP=$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" \
                        --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
                    echo
                    echo "${GREEN}✔ Instance běží — ${OCPUS} OCPU / ${MEMORY_GB} GB v ${ad##*:}${RESET}"
                    echo "  Veřejná IP: ${IP:-zjisti v konzoli}"
                    echo
                    echo "  ssh -i ~/.ssh/auraguard ubuntu@${IP:-<ip>}"
                    echo "  Pak pokračuj podle deploy/README.md od kroku 5."
                    [[ "$OCPUS" == "1" ]] && \
                        echo "  ${YELLOW}Menší tvar → dej v .env MAX_CONCURRENT_BROWSERS=1${RESET}"
                    exit 0
                fi

            # Rozlišit „není kapacita" od skutečné chyby v konfiguraci —
            # opakovat donekonečna špatně vyplněný OCID nemá smysl.
            elif printf '%s' "$OUTPUT" | grep -qi "out of.*capacity\|OutOfCapacity"; then
                echo "${YELLOW}plno${RESET}"
            elif printf '%s' "$OUTPUT" | grep -qi "timed out\|TimeoutError\|ConnectTimeout"; then
                # Síťový výpadek na tvé straně. Opakovat je správně —
                # zastavit smyčku kvůli vypadlé Wi-Fi by bylo hloupé.
                echo "${YELLOW}timeout sítě${RESET}"
            elif printf '%s' "$OUTPUT" | grep -qi "TooManyRequests\|429"; then
                # Oracle škrtí. Není to chyba konfigurace ani vyčerpaná
                # kvóta — jen jsme se ptali moc často. Odpověď je počkat
                # déle, ne skončit.
                echo "${YELLOW}Oracle škrtí (429), čekám dvojnásobek${RESET}"
                sleep $((RETRY_INTERVAL * 2))
            elif printf '%s' "$OUTPUT" | grep -qi "LimitExceeded\|service limits were exceeded\|quota"; then
                # „Service limits exceeded" NENÍ spolehlivý důvod k zastavení.
                # Oracle tuhle hlášku vrací i když je kvóta prokazatelně
                # volná — nejspíš na ni chvíli drží rezervaci po požadavcích,
                # které spadly na timeout. Místo věštění z textu chyby se
                # zeptáme, kolik jader je skutečně použitých.
                USED=$(oci limits resource-availability get \
                    --compartment-id "$COMPARTMENT_OCID" \
                    --service-name compute \
                    --limit-name standard-a1-core-count \
                    --availability-domain "$ad" \
                    --query 'data.used' --raw-output 2>/dev/null)

                if [[ "$USED" =~ ^[1-9] ]]; then
                    echo "${RED}LIMIT${RESET}"
                    echo
                    echo "Kvóta je skutečně vyčerpaná: použito ${USED} jader z A1 přídělu,"
                    echo "ale žádná instance jménem ${INSTANCE_NAME} neexistuje."
                    echo "Podívej se, co ji drží:"
                    echo "  oci compute instance list -c $COMPARTMENT_OCID --output table"
                    echo
                    die "Zastavuji — opakovat by nemělo smysl."
                fi

                echo "${YELLOW}kvóta dočasně blokovaná${RESET}"
                echo "        ${DIM}(použito ${USED:-0} jader — rezervace po timeoutu, čekám déle)${RESET}"
                sleep "$RETRY_INTERVAL"
            else
                echo "${RED}CHYBA${RESET}"
                echo
                printf '%s' "$OUTPUT" | tail -20
                echo
                die "Tohle není kapacitní problém — oprav konfiguraci a spusť znovu."
            fi
        done
    done

    echo "        ${DIM}kolo bez úspěchu, čekám ${RETRY_INTERVAL}s${RESET}"
    sleep "$RETRY_INTERVAL"
done
