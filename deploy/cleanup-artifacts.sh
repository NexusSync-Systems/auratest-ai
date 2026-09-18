#!/usr/bin/env bash
#
# Úklid artefaktů: screenshoty, videa a vygenerované skripty.
#
# Bez tohohle rostou donekonečna. Videa z Playwrightu jsou z nich největší
# položka.
#
# CO TENHLE SKRIPT NEUKLÍZÍ — a proč to tu stojí
# Původní věta tvrdila, že „jeden běh agenta o deseti krocích umí zabrat
# desítky MB". Naměřeno 2026-09-18: šest videí dohromady 8,5 MB, tedy asi
# 1,4 MB na běh; celý úklid uvolnil 15 MB. Disk byl přitom na 78 %.
#
# Místo brala BUILD CACHE DOCKERU — 19,75 GB, z toho 12,6 GB uvolnitelných.
# Roste s každým sestavením image a sama se neuklízí. Po `docker builder
# prune -f` spadl disk na 37 %.
#
# Tenhle skript je tedy retenční politika, ne nástroj na uvolnění místa.
# Když je disk plný, začni u `docker system df`.
#
# Zároveň je to technická část retenční politiky (D5 z PLAN.md): u nástroje,
# který zpracovává obsah cizích webů, není „mažeme, až dojde místo" obhajitelné
# jako politika.
#
# Použití:
#   bash deploy/cleanup-artifacts.sh              # smaže starší než RETENTION_DAYS
#   RETENTION_DAYS=3 bash deploy/cleanup-artifacts.sh
#   DRY_RUN=1 bash deploy/cleanup-artifacts.sh    # jen vypíše, nemaže
#
# Instalace jako denní úloha:
#   sudo cp deploy/auraguard-cleanup.timer  /etc/systemd/system/
#   sudo cp deploy/auraguard-cleanup.service /etc/systemd/system/
#   sudo systemctl enable --now auraguard-cleanup.timer
#
set -euo pipefail
cd "$(dirname "$0")/.."

RETENTION_DAYS="${RETENTION_DAYS:-7}"
DRY_RUN="${DRY_RUN:-0}"

# Adresáře odpovídají paths.js. AURAGUARD_ROOT umí kořen přesunout jinam.
ROOT="${AURAGUARD_ROOT:-.}"
DIRS=("$ROOT/screenshots" "$ROOT/videos" "$ROOT/generated-scripts")

echo "Úklid artefaktů starších než ${RETENTION_DAYS} dní"
[[ "$DRY_RUN" == "1" ]] && echo "(DRY RUN — nic se nemaže)"
echo

total_files=0
total_bytes=0

for dir in "${DIRS[@]}"; do
    if [[ ! -d "$dir" ]]; then
        echo "  ·  $dir — neexistuje, přeskakuji"
        continue
    fi

    # `-type f` schválně: adresáře se nemažou, Playwright si je vytváří sám
    # a jejich zmizení za běhu by mu vadilo.
    mapfile -t old < <(find "$dir" -type f -mtime "+${RETENTION_DAYS}" -print 2>/dev/null || true)

    if [[ ${#old[@]} -eq 0 ]]; then
        echo "  ·  $(basename "$dir") — nic ke smazání"
        continue
    fi

    bytes=0
    for f in "${old[@]}"; do
        size=$(stat -c%s "$f" 2>/dev/null || echo 0)
        bytes=$((bytes + size))
    done

    printf "  →  %-18s %4d souborů, %s\n" \
        "$(basename "$dir")" "${#old[@]}" "$(numfmt --to=iec --suffix=B "$bytes" 2>/dev/null || echo "${bytes} B")"

    if [[ "$DRY_RUN" != "1" ]]; then
        printf '%s\0' "${old[@]}" | xargs -0 rm -f
    fi

    total_files=$((total_files + ${#old[@]}))
    total_bytes=$((total_bytes + bytes))
done

echo
if [[ "$DRY_RUN" == "1" ]]; then
    echo "Ke smazání: ${total_files} souborů, $(numfmt --to=iec --suffix=B "$total_bytes" 2>/dev/null || echo "${total_bytes} B")"
else
    echo "Smazáno: ${total_files} souborů, $(numfmt --to=iec --suffix=B "$total_bytes" 2>/dev/null || echo "${total_bytes} B")"
fi

# Kolik místa zbývá.
df -h "$ROOT" | tail -1 | awk '{print "Volno na disku: " $4 " z " $2 " (" $5 " zaplněno)"}'

# Když je pořád plno, artefakty to nebyly.
#
# Bez téhle věty vypadá výstup jako „uklizeno, hotovo" i ve chvíli, kdy se
# uvolnily megabajty proti gigabajtovému problému — a člověk jde pryč
# s pocitem, že to vyřešil.
USE_PCT="$(df --output=pcent "$ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
if (( USE_PCT >= 70 )); then
    echo
    echo "Disk je pořád na ${USE_PCT} %. Artefakty tedy nejsou hlavní spotřebitel —"
    echo "podívej se na build cache Dockeru, ta roste s každým sestavením:"
    echo "  docker system df"
    echo "  docker builder prune -f"
fi
