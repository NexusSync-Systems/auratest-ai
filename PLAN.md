# Plán pokračování — dvě tratě

Nahrazuje `PLAN-NIS2.md` (ten smažte: `rm PLAN-NIS2.md`).

Navazuje na opravnou fázi (9 commitů, 130 testů zelených, smoke test proti
živému webu 24/24).

> **Nejsem právník.** Tvrzení o legislativě vycházejí z primárních zdrojů
> (plné znění zákona 264/2025 Sb., text čl. 50 AI Actu, materiály Komise
> a NÚKIB — viz zdroje), ale výklad a aplikaci na produkt je nutné probrat
> s právním zástupcem.

---

## 1. Proč dvě tratě

Ověření odhalilo, že AI Act a NIS2 mají **úplně jiný profil**, přestože se
v produktu tváří jako dva rovnocenné moduly:

| | **Trať 1 — AI Act čl. 50** | **Trať 2 — NIS2** |
|---|---|---|
| Právní účinnost | **od 2. 8. 2026, tedy teď** | od 1. 11. 2025, ale lhůty běží individuálně |
| Kdo je povinný | kdokoli, kdo provozuje chatbota nebo generativní AI | jen registrované regulované služby (~6 000 subjektů v ČR) |
| Termín zákazníka | jednotný, už nastal | 1 rok od doručení registračního rozhodnutí — každý jiný |
| Co dnes máme | funkční skener, po opravách nelže | skener 6 hlaviček = ~10 % rozsahu |
| Kolik z povinnosti pokryjeme | **podstatnou část** povinnosti 1 a část povinnosti 2 | ~15 % opatření |
| Práce do prodejné verze | **4–5 týdnů** | 9–10 týdnů |
| Velikost trhu | celá EU, každý web s AI prvkem | ČR, ~6 000 subjektů |

Rozdíl je natolik zásadní, že mít jeden společný plán zamlžoval to podstatné:
**AI Act je rychlejší, širší a právně účinný právě teď.** NIS2 je větší
projekt s průběžnou poptávkou.

Zároveň mají **společný základ** — doložitelnost. Ta se vyplatí postavit
jednou a použít dvakrát.

---

## 2. Sdílený základ — Epic D: doložitelnost

Bez tohohle je každý report jen screenshot. Zákazník musí při kontrole
prokázat *co* bylo změřeno, *kdy*, a že s tím nikdo později nehýbal.
Platí pro obě tratě stejně.

| # | Úkol | Odhad |
|---|---|---|
| D1 | Neměnný záznam auditu: běh skeneru s časovým razítkem, verzí nástroje, verzí pravidel a hashem výsledku. Zápis jen přidáváním. | 4 dny |
| D2 | Verzování pravidel (`ai-act.cl50.chatbot.v1`), aby šlo po roce doložit, co přesně se tehdy testovalo. | 3 dny |
| D3 | Řetězení záznamů hashem předchozího — prokazatelná neporušenost historie. | 2 dny |
| D4 | Export spisu: PDF + strojově čitelný JSON za období, včetně neprůkazných výsledků a jejich odůvodnění. `[Z: D1, D2]` | 5 dnů |
| D5 | Retenční politika pro screenshoty, videa a záznamy. Dnes rostou neomezeně. | 2 dny |

**Odhad: 3,5 týdne.**

---

## 3. Trať 1 — AI Act, článek 50

### Co článek 50 vyžaduje

Čtyři samostatné povinnosti:

| # | Povinnost | Koho se týká | Umíme testovat zvenčí? |
|---|---|---|---|
| 1 | AI systém interagující s člověkem musí uživatele informovat, že mluví s AI | poskytovatel | **ano, dobře** |
| 2 | Syntetický obsah (audio, obraz, video, text) musí být označený **strojově čitelně** a detekovatelně | poskytovatel | **částečně** — přes C2PA / Content Credentials v metadatech |
| 3 | Rozpoznávání emocí a biometrická kategorizace — informovat dotčené osoby | provozovatel | těžko |
| 4 | Deepfakes a AI-generovaný obsah — zveřejnit, že jde o umělý obsah | provozovatel | těžko |

Technické standardy pro označování (povinnost 2) vznikají přes **Kodex
správné praxe k transparentnosti obsahu generovaného AI** a navazující
normalizaci. To je věc, kterou je potřeba sledovat — viz A1.

### Co dnes skener umí a kde má díry

Po opravách detekuje volání AI API z prohlížeče a hledá upozornění regexem
se slovními hranicemi. Dřív matchoval `'ai'` uvnitř slova „email", takže
neprošel nikdy nikdo. Když nic nenajde, vrací **neprůkazné**, ne „splňuje".

Díry:
- **server-side AI je neviditelné** — proto tolik neprůkazných výsledků
- **neumí povinnost 2** — nekontroluje označení syntetického obsahu
- **nerozlišuje čtyři situace** čl. 50, hlásí jen jeden souhrnný výsledek

### Úkoly

| # | Úkol | Odhad |
|---|---|---|
| A1 | Sledovat stav Kodexu správné praxe k označování AI obsahu a normalizace. Zjistit, jaký formát označení se ustaluje (C2PA?). | 1 den |
| A2 | Rozdělit výsledek na čtyři povinnosti čl. 50 zvlášť, každou s vlastním stavem `splněno` / `nesplněno` / `neprůkazné` / `netýká se`. Dnes je to jedno číslo. | 3 dny |
| A3 | **Detekce chatbota z UI**, ne jen ze síťových volání: widgety (Intercom, Drift, Tidio, Crisp), `role="log"` + textarea, typické DOM vzory. Tím se výrazně sníží počet neprůkazných výsledků u server-side integrací. `[Z: A2]` | 5 dnů |
| A4 | Kvalita upozornění, ne jen jeho existence: je viditelné **před** zahájením interakce? Není schované v patičce nebo v podmínkách? Čl. 50 chce informování „nejpozději při první interakci". `[Z: A3]` | 4 dny |
| A5 | Kontrola označení syntetického obsahu: číst C2PA / Content Credentials z obrázků na stránce, hlásit neoznačené. `[Z: A1]` | 5 dnů |
| A6 | Report pro čl. 50: co bylo detekováno, jak, a co nástroj prokázat nemůže. Navázaný na D1–D4. `[Z: D4, A2]` | 3 dny |

**Odhad: 4,5 týdne** (bez Epic D).

### Proč to považuju za prioritu

1. **Právní opora je účinná teď.** Digital Omnibus (nařízení 2026/1744,
   v platnosti od 27. 7. 2026) odložil vysoce rizikové systémy na prosinec
   2027 a srpen 2028, ale **článek 50 odložen nebyl**.
2. **Konkurence se pravděpodobně přeorientovala** na odložený high-risk termín.
3. **Trh je řádově širší** než NIS2 — netýká se jen registrovaných subjektů,
   ale každého, kdo má na webu chatbota.
4. **Skener už existuje** a po opravách nelže. Stavíme na hotovém.

---

## 4. Trať 2 — NIS2

Podrobnosti včetně ověřeného znění § 12–17 jsou v předchozí verzi plánu;
tady je zkrácený souhrn s tím podstatným.

### Tři věci, které se ověřením opravily

**Lhůty nejsou 24/72/30.** § 16 popisuje stavový model:

| Krok | Lhůta | Od čeho | Kdy platí |
|---|---|---|---|
| Prvotní hlášení | 24 h | od **zjištění** | vždy |
| Vyjádření úřadu | 24 h | od hlášení | přijde vám |
| Oznámení | 72 h | od **zjištění**, ne od hlášení | jen u významného dopadu |
| Průběžná zpráva | bez odkladu | **na výzvu** | jen na vyžádání |
| Závěrečná zpráva | 30 dnů | od **předložení oznámení** | |

Kdo podá prvotní hlášení 20. hodinu, má na oznámení 52 hodin, ne 72.

**Příjemce se liší podle režimu** (§ 15): vyšší režim hlásí **Úřadu**, nižší
režim **Národnímu CERT** — jiná datová schránka, jiný rozsah incidentů.

**Termín není 1. 1. 2027 pro všechny** (§ 13/4, § 15/4): jeden rok od
doručení registračního rozhodnutí. Poptávka je průběžná, ne nárazová.

### Úkoly

| # | Úkol | Odhad |
|---|---|---|
| N1 | Dohledat vyhlášku podle § 16 odst. 5 — definuje strojový formát podání, nebo jen obsah formuláře? (XML schéma `NUKIB/hlaseniKBI` z 2016 je **zastaralé**, odkazuje na zrušenou vyhlášku 82/2018.) | 1 den |
| N2 | Projít vyhlášky 409/2025 a 410/2025, u každého opatření § 14 označit: měřitelné automaticky / doložitelné dokumentem / jen lidským posouzením. | 3 dny |
| N3 | Kontrola N2 právníkem. | externí |
| I1 | Stavový model incidentu podle § 16 včetně čekání na vyjádření úřadu. `[Z: N2]` | 4 dny |
| I2 | Odpočty odvozené od **zjištění**, ne od podání. Fáze 72 h a 30 dnů se aktivují až podle posouzení. `[Z: I1]` | 4 dny |
| I3 | Upozornění před vypršením (12 h, 4 h, 1 h). Slack v projektu existuje. `[Z: I2]` | 3 dny |
| I4 | Směrování podle režimu: vyšší → Úřad, nižší → Národní CERT, včetně náhradních kanálů § 16 odst. 4. `[Z: N2]` | 2 dny |
| I5 | Formulář s náležitostmi § 16 odst. 1 a 3, předvyplněný z telemetrie. `[Z: N1]` | 5 dnů |
| I6 | Export podání ve formátu z N1 + validace. `[Z: I5]` | 3 dny |
| I7 | Návrh incidentu z telemetrie. **Návrh, ne automat** — posouzení musí zůstat na člověku. `[Z: I1]` | 4 dny |

**Odhad: 6 týdnů** (bez Epic D).

### Volitelné rozšíření

- **Registr aktiv podle § 12** (~2,5 týdne): zákon vyžaduje evidovat primární
  i podpůrná aktiva včetně vyjmutých s důvodem. Zákazník to musí mít tak jako
  tak a je to přirozený nosič pro důkazy ze skeneru.
- **Mapování na opatření § 14** (~2,5 týdne): přehled pokrytí se stavem
  `mimo dosah nástroje` — bez procentuálního skóre shody.
- **Prohloubení skeneru** (~3 týdny): TLS do hloubky, kvalita CSP, bezpečnost
  cookies, fingerprinting knihoven místo prázdného SBOM.

---

## 5. Doporučené pořadí

```
Epic D (3,5 týdne)  →  Trať 1 AI Act (4,5 týdne)  →  Trať 2 NIS2 (6 týdnů)
     sdílený základ         prodejné za 8 týdnů         prodejné za 14 týdnů
```

**Proč D první:** obě tratě ji potřebují a bez ní je report jen obrázek.
Postavit ji dvakrát by stálo víc než ji postavit jednou dopředu.

**Proč AI Act před NIS2:** kratší cesta k hotovému produktu, právní opora
účinná právě teď, širší trh a stavíme na existujícím skeneru.

**Alternativa, pokud je NIS2 zákaznicky vázaný** (máte konkrétního zájemce
s běžící lhůtou): prohodit tratě. Ale pak doporučuju aspoň A2 z první tratě
udělat hned — rozdělení výsledku na čtyři povinnosti je tři dny práce a bez
něj AI Act report tvrdí věci, které neunese.

---

## 6. Rizika

| Riziko | Dopad | Co s tím |
|---|---|---|
| **Špatně naprogramované lhůty NIS2** | Zákazník zmešká zákonnou lhůtu kvůli nám. Nejhorší scénář. | I2 musí mít vlastní testovací sadu s hraničními případy. Do UI napsat, že odpočet je pomůcka, ne právní záruka. |
| **Tvrdit shodu, kterou nástroj neumí doložit** | Reputační i právní. Přesně ta chyba, kterou jsme opravovali u skenerů (prázdný SBOM = „PASS"). | Kategorie `mimo dosah nástroje` je povinná. Žádné procento shody. |
| **Standard označování AI obsahu se teprve ustaluje** | A5 může být postavené na formátu, který se změní. | A1 to má zmapovat dřív. Držet formát v datech, ne v kódu. |
| **Formát podání NÚKIB se změní vyhláškou** | Export přestane platit. | Verzovat formát stejně jako pravidla skeneru (D2). |
| **Aplikace je single-instance** | WS klienti, deduplikace i rate limiting jsou per-proces. | Před prvním větším zákazníkem doplnit Redis (~1 týden, není v odhadech). |
| **Testy běží proti mockům** | Playwright, Firestore ani LLM se v nich nespustí. | `npm run test:smoke` před každým nasazením. |

---

## 7. Co v plánu není

- **Technický dluh** (`useAudits` nezapojený, Firestore index, rozdělení
  `App.jsx`). V `COMMITS.md`, sekce „Známé zbytky". Neblokuje ani jednu trať.
- **Osud EAA modulu** — produktové rozhodnutí mimo tenhle dokument.
- **Vysoce rizikové systémy AI Actu** — odloženo na 2. 12. 2027 (Annex III)
  a 2. 8. 2028 (Annex I). Je to příští velká vlna, ale ne teď.

---

## Zdroje

**AI Act:**
- [Článek 50 — plné znění](https://artificialintelligenceact.eu/article/50/)
- [Transparency obligations under Article 50 — FAQ Evropské komise](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act)
- [Kodex správné praxe k transparentnosti obsahu generovaného AI](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content)
- [EU Digital Omnibus on AI Enters Into Force (K&L Gates, 31. 7. 2026)](https://www.klgates.com/EU-Digital-Omnibus-on-AI-Enters-Into-Force-7-31-2026)
- [Transparency Obligations Are Now in Force (Goodwin, 8/2026)](https://www.goodwinlaw.com/en/insights/publications/2026/08/alerts-technology-dpc-eu-ai-act-transparency-obligations-now-in-force)

**NIS2:**
- [Zákon č. 264/2025 Sb. — plné znění](https://ceskezakony.cz/zakon/264-2025) — § 12, § 14, § 15, § 16, § 17
- [Vyhláška č. 409/2025 Sb. — vyšší povinnosti](https://www.ceskezakony.cz/zakon/409-2025)
- [Vyhláška č. 410/2025 Sb. — nižší povinnosti](https://www.ceskezakony.cz/zakon/410-2025)
- [Portál NÚKIB — hlášení incidentu](https://portal.nukib.gov.cz/chci-vyridit/hlaseni-kybernetickeho-bezpecnostniho-incidentu)
- [Podpůrný materiál NÚKIB v1.2 (8. 6. 2026)](https://portal.nukib.gov.cz/storage/uploads/2026/06/08/podpurny-material-ke-hlaseni-incidentu_v1-2_uid_6a267e393778b.pdf)
- [NUKIB/hlaseniKBI — XML schéma z 2016, **zastaralé**](https://github.com/NUKIB/hlaseniKBI)
