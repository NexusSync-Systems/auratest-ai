# Plán: dotažení NIS2 modulu

Pracovní plán navazující na opravnou fázi (9 commitů, 130 testů zelených).
Cíl podle README: „chybí obal, dokumentace doložitelnosti a workflow hlášení
incidentu NÚKIB do 24 hodin".

> **Nejsem právník.** Tvrzení níž vycházejí z plného znění zákona
> č. 264/2025 Sb. (ověřeno, viz zdroje), ale výklad a aplikaci na konkrétní
> produkt je nutné probrat s právním zástupcem.

**Verze 2** — po ověření proti primárním zdrojům. Tři věci z první verze
se ukázaly jako nepřesné a jsou opravené: lhůty hlášení, příjemce hlášení
a termín. Změny jsou označené `[OPRAVENO]`.

---

## 1. Kde jsme a co to znamená

**Co NIS2 modul dnes umí:** zkontroluje šest HTTP hlaviček a TLS protokol.
Po opravách to dělá správně — dřív hlásil „zastaralý protokol" i u TLS 1.3
a po přesměrování nenačetl hlavičky vůbec.

**Co zákon vyžaduje.** § 14 vyjmenovává bezpečnostní opatření. Pro **režim
nižších povinností** jich je třináct:

> systém zajišťování minimální kybernetické bezpečnosti · požadavky na
> vrcholné vedení · řízení aktiv · řízení rizik · bezpečnost lidských zdrojů ·
> řízení kontinuity činností · řízení přístupu · řízení identit a jejich
> oprávnění · detekce a zaznamenávání kybernetických bezpečnostních událostí ·
> řešení kybernetických bezpečnostních incidentů · **bezpečnost komunikačních
> sítí** · **aplikační bezpečnost** · **kryptografické algoritmy**

Pro **režim vyšších povinností** je to 14 organizačních + 11 technických
opatření (§ 14 odst. 1).

**Kde do toho AuraGuard zapadá.** Tučně zvýrazněná tři opatření jsou jediná,
ke kterým dnešní skener umí přispět důkazem — a i tam jen pro webovou vrstvu.
Zbylých deset (u vyššího režimu dvacet dva) jsou organizační věci, které
žádný síťový skener nezměří: směrnice, role, školení, testy obnovy.

To je **zhruba 10–15 % rozsahu**, a ještě ne celé.

Z toho plynou dvě možné pozice produktu:

| | Pozice A: sběrač technických důkazů | Pozice B: nástroj pro řízení shody |
|---|---|---|
| Co dělá | Automatizuje důkazy pro tři technická opatření + workflow incidentů | Vede registr aktiv, opatření, důkazů a incidentů podle vyhlášky |
| Rozsah | ~15 % požadavků | ~80 %, zbytek je vždy na člověku |
| Práce | 4–6 týdnů | 4–6 měsíců |
| Riziko | Zákazník si koupí „NIS2 nástroj" a zjistí, že pokrývá zlomek | Konkurence etablovaných GRC hráčů, delší cesta k prvním penězům |

**Doporučení:** začít pozicí A, ale pojmenovat ji poctivě — „automatizovaný
sběr technických důkazů a workflow hlášení incidentů", ne „NIS2 compliance".

---

## 2. Co se ověřením změnilo

### `[OPRAVENO]` Lhůty nejsou 24 / 72 / 30

Zjednodušení „24/72/30", které koluje po článcích, neodpovídá § 16. Skutečný
model je stavový a **nelze ho naprogramovat jako tři pevné odpočty**:

| Krok | Lhůta | Od čeho běží | Komu | Kdy platí |
|---|---|---|---|---|
| Prvotní hlášení | do **24 h** | od **zjištění** incidentu | Úřad / Národní CERT | vždy |
| Vyjádření úřadu | do 24 h | od prvotního hlášení | ← přijde vám | vždy (§ 17 odst. 1) |
| Oznámení | do **72 h** | od **zjištění** (ne od hlášení!) | | **jen** u incidentů s významným dopadem |
| — výjimka | do **24 h** | od zjištění | | poskytovatelé služeb vytvářejících důvěru |
| Průběžná zpráva | bez zbytečného odkladu | **na výzvu** Úřadu/CERT | | jen na vyžádání |
| Závěrečná zpráva | do **30 dnů** | od **předložení oznámení**, ne od prvotního hlášení | | |
| — trvá-li incident | | průběžná zpráva, pak závěrečná do 30 dnů **od vyřešení** | | |

Tři důsledky pro implementaci:

1. **72 h se počítá od zjištění, ne od podání.** Když někdo podá prvotní
   hlášení 20. hodinu, na oznámení mu zbývají 52 hodiny, ne 72.
2. **Existuje čekací stav.** Po prvotním hlášení má úřad 24 h na vyjádření,
   zda má incident významný dopad na kybernetický prostor státu (§ 16 odst. 2).
   Teprve to určí, jestli 72h a 30d fáze vůbec nastanou.
3. **Průběžná zpráva se nepodává automaticky**, ale na výzvu. Odpočet na ni
   nedává smysl.

### `[OPRAVENO]` Příjemce se liší podle režimu

§ 15 odst. 1 a 2: **vyšší režim hlásí Úřadu, nižší režim Národnímu CERT.**
To nejsou jen jiné adresy — je to jiná datová schránka, jiný e-mail
i jiný rozsah hlášených incidentů:

- **vyšší režim:** všechny incidenty s původem v kyberprostoru, u nichž nelze
  vyloučit úmyslné zavinění
- **nižší režim:** jen ty, které mají navíc **významný dopad** na poskytování
  regulované služby (§ 15 odst. 3)

Náhradní kanály při nedostupnosti Portálu (§ 16 odst. 4) jsou taky odlišné.

### `[OPRAVENO]` Termín není 1. 1. 2027 pro všechny

§ 13 odst. 4 a § 15 odst. 4: povinnosti se plní **nejpozději do 1 roku ode
dne doručení rozhodnutí o registraci** regulované služby. Není to jeden
společný termín — každý zákazník má vlastní, odvozený od své registrace.

Zákon je účinný od 1. 11. 2025, ohlášení do 60 dnů od splnění podmínek
(§ 6 odst. 1). Datum 1. 1. 2027 z README je potřeba dohledat — pravděpodobně
jde o přechodná ustanovení pro subjekty spadající pod starý zákon.

**Dopad na produkt:** není to jednorázová vlna k jednomu datu, ale průběžná
poptávka. To je pro SaaS lepší zpráva než deadline, ale marketingový argument
„stihněte 1. 1. 2027" nefunguje plošně.

### `[ZODPOVĚZENO] R4 — staré XML schéma je nepoužitelné`

§ 16 odst. 5: „Obsahové náležitosti, **formát** a způsob hlášení … stanoví
Úřad **vyhláškou**." Repozitář `NUKIB/hlaseniKBI` (v1.0, leden 2016) odkazuje
na § 32 vyhlášky 82/2018 Sb., tedy na zrušenou úpravu. **Nestavět na něm.**

Existuje samostatná vyhláška o Portálu NÚKIB a podpůrný materiál ke hlášení
incidentů (v1.2, 8. 6. 2026). Zbývá dohledat, zda vyhláška definuje strojově
zpracovatelný formát, nebo jen obsahové náležitosti formuláře.

### § 12 — registr aktiv je zákonná povinnost

Nečekaný nález, který dává produktu jasnou funkci. § 12 vyžaduje:

- určit všechna **primární aktiva**
- posoudit, která souvisejí s regulovanou službou
- u těch určit **podpůrná aktiva**
- **evidovat** aktiva ve stanoveném rozsahu **i ta vyjmutá, včetně důvodů**
- pravidelně přezkoumávat a aktualizovat

To je databázová evidence s auditní stopou — přesně to, co umíme postavit,
a zákazník to musí mít tak jako tak.

---

## 3. Rozhodnutí, která zbývají

| # | Otázka | Stav |
|---|---|---|
| R1 | Cílíme na vyšší, nebo nižší režim? | **Otevřené.** Nižší režim má 13 opatření místo 25 a hlásí méně incidentů — nižší laťka, širší trh. Doporučuju začít tam. |
| R2 | Je zákazník regulovaný subjekt, nebo jeho dodavatel? | **Otevřené.** Dodavatelé řeší „řízení dodavatelů" (§ 14/1/a/7) z druhé strany — jiný produkt. |
| R3 | Odesílat hlášení, nebo jen připravit? | **Doporučení: jen připravit.** § 16 odst. 4 předpokládá podání přes Portál pod identitou poskytovatele. Odesílání jeho jménem je odpovědnost navíc při minimu přidané hodnoty. |
| R4 | Je XML schéma platné? | **Zodpovězeno: ne.** Viz výš. |
| R5 | *Nové:* je registr aktiv (§ 12) součást produktu? | **Otevřené.** Rozšiřuje záběr, ale je to zákonná povinnost každého zákazníka a přirozený nosič pro důkazy ze skeneru. |

---

## 4. Epiky a úkoly

Odhady pro jednoho vývojáře na plný úvazek. `[Z]` = závislost.

### Epic N — Ověření zadání

| # | Úkol | Odhad |
|---|---|---|
| N1 | Dohledat vyhlášku podle § 16 odst. 5 a zjistit, zda definuje strojový formát podání, nebo jen obsah formuláře. Ověřit u NÚKIB (`cert.incident@nukib.cz`). | 1 den |
| N2 | Projít vyhlášky 409/2025 a 410/2025. U každého opatření z § 14 označit: měřitelné automaticky / doložitelné dokumentem / jen lidským posouzením. | 3 dny |
| N3 | Nechat N2 zkontrolovat právníkem se specializací na kyberbezpečnost. | externí |
| N4 | Dohledat původ data 1. 1. 2027 z README — přechodná ustanovení, nebo omyl? | 0,5 dne |
| N5 | Rozhodnout R1, R2, R5. | 1 den |

### Epic I — Workflow incidentu

Nejvyšší hodnota: tvrdý zákonný termín, viditelný přínos, a model lhůt je
netriviální, takže se na něm dá odlišit.

| # | Úkol | Odhad |
|---|---|---|
| I1 | Stavový model incidentu podle § 16: `zjištěn` → `prvotní hlášení podáno` → `čeká na vyjádření úřadu` → `významný dopad ano/ne` → `oznámení podáno` → `uzavřen`. Časové razítko každého přechodu. `[Z: N5]` | 4 dny |
| I2 | Odpočty odvozené od **zjištění**, ne od podání. Fáze 72 h a 30 dnů se aktivují až podle výsledku posouzení. Zvláštní režim pro služby vytvářející důvěru (24 h). `[Z: I1]` | 4 dny |
| I3 | Upozornění před vypršením (12 h, 4 h, 1 h). Slack notifikace v projektu existuje. `[Z: I2]` | 3 dny |
| I4 | Směrování podle režimu: vyšší → Úřad, nižší → Národní CERT. Včetně náhradních kanálů podle § 16 odst. 4 (e-mail, datová schránka). `[Z: N5]` | 2 dny |
| I5 | Formulář s obsahovými náležitostmi podle § 16 odst. 1 a 3, předvyplněný z telemetrie. `[Z: N1]` | 5 dnů |
| I6 | Export podání ve formátu z N1 + validace před stažením. `[Z: I5]` | 3 dny |
| I7 | Návrh incidentu z telemetrie: výpadek nebo vlna chyb nabídne založení. **Návrh, ne automat** — posouzení, zda jde o kybernetický bezpečnostní incident, musí zůstat na člověku. `[Z: I1]` | 4 dny |

### Epic D — Doložitelnost

Bez tohohle je report jen screenshot.

| # | Úkol | Odhad |
|---|---|---|
| D1 | Neměnný záznam auditu: běh skeneru s časovým razítkem, verzí nástroje, verzí pravidel a hashem výsledku. Jen přidávání. | 4 dny |
| D2 | Verzování pravidel (`nis2.hsts.v2`), aby šlo po roce doložit, co se tehdy testovalo. | 3 dny |
| D3 | Řetězení záznamů hashem předchozího — prokazatelná neporušenost historie. | 2 dny |
| D4 | Export spisu: PDF + JSON za období, včetně neprůkazných výsledků a jejich odůvodnění. `[Z: D1, D2]` | 5 dnů |
| D5 | Retenční politika pro screenshoty, videa a záznamy. Dnes rostou neomezeně. | 2 dny |

### Epic A — Registr aktiv podle § 12 *(nové, závisí na R5)*

| # | Úkol | Odhad |
|---|---|---|
| A1 | Model: primární aktivum → souvisí s regulovanou službou (ano/ne/nevyhodnoceno) → podpůrná aktiva. Podle § 12 odst. 4 platí, že neposouzené aktivum **je** ve stanoveném rozsahu. `[Z: R5]` | 4 dny |
| A2 | Evidence vyjmutých aktiv včetně důvodu vyjmutí (§ 12 odst. 3). | 2 dny |
| A3 | Připomínka přezkumu (§ 12 odst. 5) a historie změn rozsahu. | 3 dny |
| A4 | Napojení: monitorovaná webová aplikace = technické aktivum, výsledky skenerů = důkaz k němu. `[Z: A1, D1]` | 3 dny |

### Epic M — Mapování měření na opatření

| # | Úkol | Odhad |
|---|---|---|
| M1 | Model: opatření § 14 ↔ kontroly nástroje ↔ důkazy. `[Z: N2]` | 3 dny |
| M2 | Přehled pokrytí se stavy `měřeno automaticky` / `doloženo dokumentem` / `nedoloženo` / **`mimo dosah nástroje`**. Poslední kategorie je pro důvěryhodnost klíčová. `[Z: M1]` | 4 dny |
| M3 | Nahrávání dokumentů k opatřením, která měřit nelze. `[Z: M1]` | 4 dny |
| M4 | Report připravenosti. **Bez procentuálního skóre shody** — svádělo by k tvrzení, které nástroj neunese. `[Z: M2, M3]` | 3 dny |

### Epic S — Prohloubení skeneru

Až nakonec. Rozšiřovat měření dřív, než je jasné, k čemu se mapuje, je práce
naslepo. Mapuje se na tři opatření § 14 odst. 2: bezpečnost komunikačních
sítí, aplikační bezpečnost, kryptografické algoritmy.

| # | Úkol | Odhad |
|---|---|---|
| S1 | TLS do hloubky: šifrovací sady, platnost a řetěz certifikátu, TLS 1.0/1.1, OCSP stapling. → *kryptografické algoritmy* | 4 dny |
| S2 | Kvalita CSP: `frame-ancestors`, `object-src`, `base-uri`, reporting. → *aplikační bezpečnost* | 3 dny |
| S3 | Bezpečnost cookies: `Secure`, `HttpOnly`, `SameSite`. Data už máme z GDPR auditu. → *aplikační bezpečnost* | 2 dny |
| S4 | Zranitelné komponenty: dnes CRA skener nesestaví SBOM u bundlovaných aplikací. Nahradit fingerprintingem JS assetů (Retire.js). → *aplikační bezpečnost* | 5 dnů |

---

## 5. Milníky

| Milník | Obsah | Kumulativně |
|---|---|---|
| **M0 — Zadání ověřeno** | N1–N5 | +1,5 týdne |
| **M1 — Incidenty** | I1–I7 | +6,5 týdne |
| **M2 — Doložitelnost** | D1–D5 | +9,5 týdne |
| **M3 — Registr aktiv** | A1–A4 *(pokud R5 = ano)* | +12 týdnů |
| **M4 — Mapování** | M1–M4 | +15 týdnů |
| **M5 — Hloubka skeneru** | S1–S4 | +18 týdnů |

`[OPRAVENO]` Pořadí je jiné než v první verzi — workflow incidentů je teď
první. Důvod: lhůty běží od doručení registračního rozhodnutí zákazníka,
takže poptávka je průběžná, ne nárazová. Nemá smysl optimalizovat na jedno
datum; má smysl mít nejdřív hotovou tu část, která má tvrdý zákonný termín
a nejvyšší viditelnou hodnotu.

Prodejná verze existuje po **M1 + M2 (9,5 týdne)**. Registr aktiv a mapování
jsou rozšíření, ne podmínka.

---

## 6. Rizika

| Riziko | Dopad | Co s tím |
|---|---|---|
| **Tvrdit shodu, kterou nástroj neumí doložit** | Reputační i právní. Přesně ta chyba, kterou jsme opravovali u skenerů (prázdný SBOM = „PASS"). | Kategorie `mimo dosah nástroje` v M2 je povinná. Žádné procento shody. |
| **Špatně naprogramované lhůty** | Zákazník zmešká zákonnou lhůtu kvůli našemu nástroji. Nejhorší možný scénář. | I2 musí mít vlastní testovací sadu s časovými scénáři včetně hraničních případů. Do UI napsat, že odpočet je pomůcka, ne právní záruka. |
| **Formát podání se změní vyhláškou** | Export přestane platit. | Držet formát v datech, ne v kódu. Verzovat ho stejně jako pravidla skeneru (D2). |
| **Nesprávný výklad vyhlášky** | Epic M postavený špatně. | N3 — kontrola právníkem před implementací. |
| **Aplikace je single-instance** | WS klienti, deduplikace i rate limiting jsou per-proces. | Před prvním větším zákazníkem doplnit Redis (~1 týden, není v odhadech výš). |
| **Testy běží proti mockům** | Playwright, Firestore ani LLM se v nich nespustí. | `npm run test:smoke` před každým nasazením. |

---

## 7. Mimo plán, ale důležité: AI Act modul je aktuální

První verze plánu tvrdila, že datum 2. 8. 2026 „už je za námi" a je otázka,
jestli nezmizel prodejní argument. **To bylo špatně.**

Ověřený stav k srpnu 2026:

- **Digital Omnibus** (nařízení EU 2026/1744) vstoupil v platnost 27. 7. 2026
- Povinnosti pro **vysoce rizikové systémy** odloženy: Annex III na
  **2. 12. 2027**, Annex I na **2. 8. 2028**
- **Článek 50 — transparentnost — platí od 2. 8. 2026 a odložen NEBYL**

Článek 50 požaduje, aby poskytovatel chatbotů a generativní AI **sdělil
uživateli, že komunikuje s AI**, a aby syntetický obsah byl označený.

To je přesně to, co AuraGuard AI Act skener testuje. Takže:

1. Modul má **právní oporu účinnou právě teď**, ne v budoucnu.
2. Povinnost se **netýká jen vysoce rizikových systémů** — platí pro každý
   systém ve čtyřech situacích článku 50, tedy na mnohem širší trh.
3. Konkurence se pravděpodobně přeorientovala na odložený high-risk termín.

Stojí za zvážení, jestli není AI Act rychlejší cesta k prvním penězům než
NIS2 — skener už existuje a po opravách nelže. Chybí mu doložitelnost
(Epic D), která je stejně sdílená s NIS2.

---

## 8. Co v plánu záměrně není

- **Technický dluh** (`useAudits` nezapojený, Firestore index, rozdělení
  `App.jsx`). Popsané v `COMMITS.md`, sekce „Známé zbytky". Neblokuje NIS2.
- **Osud EAA modulu.** Udržovat, utlumit, nebo nechat jako doplněk je
  produktové rozhodnutí mimo tenhle dokument.

---

## Zdroje

Primární:
- [Zákon č. 264/2025 Sb., o kybernetické bezpečnosti — plné znění](https://ceskezakony.cz/zakon/264-2025) — § 12 (stanovený rozsah), § 14 (seznam opatření), § 15 (kdo co hlásí), § 16 (postup a lhůty), § 17 (vyjádření úřadu)
- [Vyhláška č. 409/2025 Sb. — režim vyšších povinností](https://www.ceskezakony.cz/zakon/409-2025)
- [Vyhláška č. 410/2025 Sb. — režim nižších povinností](https://www.ceskezakony.cz/zakon/410-2025)

NÚKIB:
- [Portál NÚKIB — hlášení incidentu](https://portal.nukib.gov.cz/chci-vyridit/hlaseni-kybernetickeho-bezpecnostniho-incidentu)
- [Podpůrný materiál ke hlášení incidentů v1.2 (8. 6. 2026)](https://portal.nukib.gov.cz/storage/uploads/2026/06/08/podpurny-material-ke-hlaseni-incidentu_v1-2_uid_6a267e393778b.pdf)
- [Videopřednáška k vyhlášce 409/2025 — vyšší režim](https://portal.nukib.gov.cz/storage/uploads/2026/01/12/videoprednaska_vyssi-rezim_uid_6965022193e33.pdf)
- [NUKIB/hlaseniKBI — XML schéma v1.0 z 2016, **zastaralé**](https://github.com/NUKIB/hlaseniKBI)

AI Act:
- [EU Digital Omnibus on AI Enters Into Force (K&L Gates, 31. 7. 2026)](https://www.klgates.com/EU-Digital-Omnibus-on-AI-Enters-Into-Force-7-31-2026)
- [EU AI Act Transparency Obligations Are Now in Force (Goodwin, 8/2026)](https://www.goodwinlaw.com/en/insights/publications/2026/08/alerts-technology-dpc-eu-ai-act-transparency-obligations-now-in-force)
- [Článek 50 — praktický průvodce](https://artificialintelligenceact.eu/transparency-rules-article-50/)
- [EU AI Act Omnibus Agreement — odložené termíny (Gibson Dunn)](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/)
