# Podklad k rozhodnutí o Trati 2

Tenhle dokument nerozhoduje. Rozkládá tři otevřené otázky z `PLAN-NIS2.md`
(R1, R2, R5) na to, co se každou z nich vlastně volí, a co která odpověď
udělá s rozsahem práce. Bez nich nejde začít: úkol **N5** je blokuje a na
N5 visí **I1** a **I4**, tedy celý Epic I.

Ke každé otázce je i doporučení. Je moje, ne závazné, a u každého je
napsané, z čeho vychází — abys ho mohl odmítnout adresně.

---

## 0. Než se rozhodne: plán počítá práci, která je hotová

Milníková tabulka v `PLAN-NIS2.md` (sekce 5) je z doby před implementací
a nikdo ji od té doby nesrovnal se skutečností. Dva celé epiky už stojí
v produkci:

| Epic | Stav podle plánu | Skutečnost |
|---|---|---|
| **D — Doložitelnost** (D1–D5, 16 dnů) | milník M2, +9,5 týdne | **Hotovo a nasazeno.** `audit-ledger.js` (D1), registr pravidel (D2), řetězení hashem (D3), export spisu PDF+JSON (D4), `deploy/cleanup-artifacts.sh` + timer (D5). Navíc ukotvení otisku mimo systém, které v plánu vůbec není. |
| **S — Prohloubení skeneru** (S1–S4, 14 dnů) | milník M5, +18 týdnů | **Hotovo a nasazeno.** TLS do hloubky vč. šifrovacích sad a OCSP (S1), obsahové posouzení CSP (S2), příznaky cookies (S3), `sbom-fingerprint.js` místo nefunkčního SBOM (S4). |

Přepočet zbývající práce (odhady beru z plánu, nepřeceňoval jsem je):

| Milník | Obsah | Dnů | Kumulativně |
|---|---|---|---|
| M0 — Zadání ověřeno | N1–N5 | 5,5 | ~1,5 týdne |
| M1 — Incidenty | I1–I7 | 25 | ~6,5 týdne |
| ~~M2 — Doložitelnost~~ | — | — | **hotovo** |
| M3 — Registr aktiv | A1–A4 *(jen při R5 = ano)* | 12 | ~9 týdnů |
| M4 — Mapování | M1–M4 | 14 | ~11,5 týdne |
| ~~M5 — Hloubka skeneru~~ | — | — | **hotovo** |

**Věta „prodejná verze existuje po M1 + M2 (9,5 týdne)" už neplatí — M2
je hotové, takže je to 6,5 týdne.** A jak je vidět u R2, pro jednu ze
dvou možných odpovědí je prodejná verze v podstatě hotová dnes.

Dvě upřesnění, ať tabulka netvrdí víc, než je pravda:

- **Odhady jsem nepřehodnocoval.** Jsou z plánu, psané před implementací.
  Zkušenost z Epicu D byla, že se k práci přidávalo, ne ubíralo.
- **I3 je v plánu postavené na Slacku** („Slack notifikace v projektu
  existuje"). Slack je mimo rozsah. I3 tedy potřebuje jiný kanál
  (e-mail), jinak se ty 3 dny nedají počítat jako odhad.

---

## 1. R1 — vyšší, nebo nižší režim?

### Co se rozhoduje

Pro který režim se staví workflow incidentu a proti které sadě opatření
§ 14 se měří pokrytí. Není to jen štítek: podle § 15 odst. 1 a 2 jde
o **jiného příjemce, jiný kanál a jiný rozsah hlášených incidentů**.

### Co každá odpověď znamená

| | Nižší režim | Vyšší režim |
|---|---|---|
| Hlásí se | Národnímu CERT | Úřadu |
| Které incidenty | jen ty s **významným dopadem** na regulovanou službu (§ 15 odst. 3) | všechny s původem v kyberprostoru, u nichž nelze vyloučit úmysl |
| Náhradní kanály (§ 16/4) | vlastní | vlastní, jiné |
| Opatření § 14 | podle plánu 13 | podle plánu 25 |

### Dopad na rozsah

- **I4 (směrování, 2 dny)** — adresa, kanál i náhradní cesta jsou u obou
  režimů jiné. Dělat oba znamená obě sady, ne jednu s přepínačem.
- **I1 (stavový model, 4 dny)** — u nižšího režimu je před hlášením navíc
  brána „má to významný dopad?". U vyššího se hlásí i bez ní. To je jiný
  stavový diagram, ne konfigurace.
- **Epic M (14 dnů)** — počet opatření řídí velikost M1 (model), M2
  (přehled pokrytí) i M3 (nahrávání dokumentů k neměřitelným opatřením).
  Při 25 opatřeních místo 13 poroste hlavně M3, kde je práce na každé
  opatření zvlášť.
- **Obojí zároveň:** +2 dny na I4, složitější I1 a sjednocení sady opatření
  na 25. Hrubě +1 až 1,5 týdne k M1 a M4.

### Co tuhle otázku zatím blokuje

**Čísla 13 a 25 nejsou ověřená.** Pocházejí z plánu, ne z vyhlášky —
a právě to má udělat **N2** (projít 409/2025 a 410/2025) a potvrdit **N3**
(právník). Rozhodovat R1 podle nich dřív, než N2 doběhne, by bylo
rozhodnutí na základě čísla, které jsme si nezkontrolovali. To je přesně
ta chyba, kterou u skenerů celou dobu vymetáme.

### Doporučení

**Nižší režim, ale směrování držet v datech, ne ve větvení kódu.**

Proč nižší: nižší laťka a širší trh, jak píše plán. Proč datově:
R3 je rozhodnuté na „jen připravit, neodesílat". Směrování tedy
prakticky znamená, jaká adresa a jaký kanál se vytisknou do podání —
a to je tabulka, ne logika. Když se to takhle postaví, je vyšší režim
později přidání řádků, ne přepis I4. Rozdíl v I1 (ta brána významného
dopadu) tím nezmizí, ale je to jeden přechod navíc, ne druhý model.

Potvrdit až po N2.

---

## 2. R2 — je zákazník regulovaný subjekt, nebo jeho dodavatel?

### Co se rozhoduje

Kdo se přihlásí do nástroje. Tohle je z těch tří otázek zdaleka
nejtěžší a je **nadřazená oběma zbylým** — viz sekce 4.

### Co každá odpověď znamená

**A) Zákazník je regulovaný subjekt.** Platí plán, jak je napsaný.
Nástroj mu pomáhá plnit vlastní povinnosti: hlášení incidentů (Epic I),
registr aktiv (Epic A), doložení opatření § 14 (Epic M). Zbývá **25 dnů
na Epic I**, než vznikne něco prodejného.

**B) Zákazník je dodavatel regulovaného subjektu.** Řeší § 14/1/a/7
(*řízení dodavatelů*) z druhé strany: nehlásí Úřadu, ale **dokládá svým
zákazníkům**, že jeho služba je v pořádku. Výstupem není podání, ale
důkazní balík.

### Dopad na rozsah — tady je ten rozdíl největší

| | A) zákazník | B) dodavatel |
|---|---|---|
| Epic I (workflow incidentu) | **jádro produktu**, 25 dnů | z velké části odpadá — dodavatel Úřadu nehlásí |
| Epic A (registr aktiv § 12) | v úvaze, 12 dnů | **odpadá** — § 12 je povinnost regulovaného subjektu |
| Epic M (mapování na § 14) | ano, 14 dnů | ano, ale úžeji — jen opatření, která se dodavatele týkají |
| Epic D (doložitelnost) | podpůrné | **jádro produktu — a je hotové** |
| Epic S (hloubka skeneru) | podpůrné | **jádro produktu — a je hotové** |

**To je věc, kvůli které tenhle dokument nejvíc stojí za přečtení:
pro odpověď B je produkt v podstatě postavený.** Neměnný řetězený
záznam, verzovaná pravidla, export spisu do PDF i JSON, ukotvení otisku
mimo systém, TLS a CSP do hloubky — to všechno je přesně ten důkazní
balík, který dodavatel potřebuje ukázat zákazníkovi. Chybí k tomu spíš
obal (komu se spis posílá, jak se sdílí) než další epiky.

Pro odpověď A je nejbližší prodejná verze 6,5 týdne daleko.

### Proti „oběma"

Jiný kupující, jiný prodejní příběh, jiný důvod platit. Sdílená část je
přesně D + S, tedy to hotové. Dělat obojí naráz znamená stavět Epic I
i obal pro dodavatele současně, s jedním nedoděláno pořád.

### Doporučení

Nemám na to data, která by to rozhodla — je to otázka trhu, ne kódu, a
do ní nevidím. Co z kódu plyne:

**Nejkratší cesta k prvním penězům vede přes B, protože B stojí na tom,
co je hotové.** Jestli je tam trh, nevím. Dá se to ověřit dřív a levněji
než 25 dnů implementace: vzít dnešní export spisu, ukázat ho dvěma třem
firmám, které dodávají regulovanému subjektu, a zeptat se, jestli by
tímhle uměly odpovědět na dotazník od svého zákazníka.

To je práce na dny, ne na týdny, a odpoví na R2 doloženě. Odpověď na R2
pak určí R1 i R5.

---

## 3. R5 — je registr aktiv (§ 12) součástí produktu?

### Co se rozhoduje

Jestli nástroj vede evidenci aktiv zákazníka, nebo zůstane u měření.

### Proč to sedí k tomu, co už umíme

Podle § 12 odst. 4 platí, že **neposouzené aktivum je ve stanoveném
rozsahu**. To je fail-closed — přesně to pravidlo, na kterém stojí celý
nástroj (`null` je neprůkazné, nikdy tiché „splněno"). Registr postavený
takhle by byl konzistentní s tím, co už v produktu je, ne cizí těleso.

Druhý argument z plánu: registr je *přirozený nosič pro důkazy ze
skeneru*. To je úkol **A4** — monitorovaná webová aplikace je technické
aktivum a výsledky skenerů jsou důkaz k němu.

### Dopad na rozsah

| Úkol | Co je to | Dnů |
|---|---|---|
| A1 | model aktiv vč. pravidla § 12/4 | 4 |
| A2 | evidence vyjmutých aktiv a důvodů (§ 12/3) | 2 |
| A3 | připomínka přezkumu (§ 12/5), historie rozsahu | 3 |
| A4 | napojení skeneru: aplikace = aktivum, nález = důkaz | 3 |
| | **celkem** | **12 dnů ≈ 2,5 týdne** |

Neblokuje nic jiného. Epic M z něj těží, ale bez něj se obejde.

### Argument proti

Sekce 1 plánu staví tyhle dvě pozice proti sobě: **A — sběrač technických
důkazů** (~15 % požadavků, 4–6 týdnů) a **B — nástroj pro řízení shody**
(~80 %, 4–6 měsíců, konkurence etablovaných GRC hráčů). Registr aktiv je
krok směrem k B. A2 a A3 jsou čistá evidence — zapsat, proč je aktivum
vyjmuté, a připomenout přezkum. Na tom nic neumíme líp než tabulka.

### Doporučení

**Ano, ale jen A1 + A4 (7 dnů). A2 a A3 odložit, dokud o ně někdo
nepožádá.**

Důvod: A4 je jediná část, která dělá registr *náš* — spojuje aktivum
s naměřeným důkazem, což tabulka neumí. A1 je k tomu nutný základ.
A2 a A3 jsou bookkeeping; než je někdo bude chtít, zvládne je v Excelu,
a my se zatím nepohneme o 5 dnů blíž ke GRC nástroji, kterým být
nechceme.

**Pozor na závislost:** při R2 = dodavatel je R5 automaticky *ne*. § 12
je povinnost regulovaného subjektu, ne jeho dodavatele. R5 se tedy má
rozhodovat až po R2.

---

## 4. Pořadí, v jakém se to má rozhodnout

Plán je uvádí jako tři rovnocenné řádky tabulky. Nejsou:

```
R2 (zákazník × dodavatel)
 │
 ├─ B = dodavatel  ──►  R1 nehraje roli (nehlásí Úřadu)
 │                      R5 = ne (§ 12 se ho netýká)
 │                      → zbývá obal nad hotovým D + S
 │
 └─ A = zákazník   ──►  R1 (režim)  ── čeká na N2/N3 ──►  I1, I4
                        R5 (registr aktiv) ──►  Epic A
```

Takže: **R2 první**, a to doloženě, ne od stolu. Pak teprve R1 (po N2)
a R5.

---

## 5. Co tím zůstává otevřené

Aby dokument netvrdil víc, než na co mám podklad:

1. **N2 a N3 nejsou hotové.** Počet opatření (13 / 25) i výklad § 12
   a § 15 beru z plánu. Před závazným rozhodnutím R1 to chce vyhlášku
   a právníka — plán to sám označuje jako riziko *„nesprávný výklad
   vyhlášky → Epic M postavený špatně"*.
2. **Odhady jsou původní.** Nepřepočítával jsem je, jen sečetl. U Epicu D
   se skutečnost od odhadu lišila směrem nahoru.
3. **Retence se netýká záznamu.** `cleanup-artifacts.sh` uklízí
   screenshoty, videa a vygenerované skripty. Samotný řetěz auditů se
   nemaže záměrně — smazáním by se přerušil a spis by přestal být
   doložitelný. Jestli to obstojí proti zásadě minimalizace podle GDPR,
   rozhodnuté není. Do žádné z těchto tří otázek to nepatří, ale dřív
   nebo později se někdo zeptá.
4. **I3 je psané na Slack**, který je mimo rozsah. Než se M1 začne
   počítat jako 25 dnů, potřebuje I3 jiný kanál.
