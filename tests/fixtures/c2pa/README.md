# Skutečně podepsaný obrázek — co sem patří a proč

> **HOTOVO 18. 9. 2026.** Fixtury jsou podepsané `c2patool` 0.27.22
> (c2pa_rs 0.90.22) a náš čtenář na nich obstál. Vyšlo přitom najevo, že
> nástroj zapisuje `c2pa.actions.v2` a `claim_version: 2` — tvar, který
> jsem v hlavě neměl a v ručně psaných testech nikde není. Čtenář ho
> přesto našel, protože hledá značky kontejneru a identifikátor IPTC,
> ne konkrétní verzi schématu.
>
> Text níž zůstává jako návod pro případ, že bude potřeba fixtury
> přegenerovat nebo přidat další typ zdroje.

Testy C2PA běží proti bajtům, které jsem **napsal já** — tedy proti své
vlastní představě o tom, jak kontejner JUMBF v souboru vypadá. Hodnoty typu
zdroje už ověřené jsou (proti slovníku IPTC, viz
`tests/fixtures/iptc-digitalsourcetype.json`), ale **struktura kontejneru
ne**. Kdybych se v ní mýlil, testy to nechytí: mýlily by se stejně.

Chybí tu jediná věc, kterou to rozhodne — soubor podepsaný **někým jiným**.

## Co sem dát

Dva soubory, oba pojmenované přesně takhle:

| soubor | co to je |
|---|---|
| `podepsany-ai.jpg` | obrázek s manifestem C2PA, kde je typ zdroje `trainedAlgorithmicMedia` (vytvořeno generativní AI) |
| `podepsany-foto.jpg` | obrázek s manifestem, kde je typ zdroje `digitalCapture` (pořízeno fotoaparátem) |

Stačí i jeden; test se zapne pro ten, který najde. Soubory můžou být
velké — test čte jen prvních 64 kB, stejně jako skener.

## Jak je vyrobit

Nástrojem, který C2PA implementuje — tedy ne naším kódem. Referenční je
`c2patool` od Content Authenticity Initiative:

```bash
# podpis testovacím certifikátem, který nástroj přináší s sebou
c2patool vstup.jpg --config '{"claim_generator":"test","assertions":[
  {"label":"c2pa.actions","data":{"actions":[
    {"action":"c2pa.created","digitalSourceType":
     "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"}
  ]}}
]}' --output podepsany-ai.jpg --force
```

Druhá cesta: stáhnout obrázek z ukázek CAI nebo z generátoru, který
Content Credentials podepisuje (Adobe Firefly, Leica, některé Nikony).
Na původu nezáleží — záleží na tom, že podpis **nevznikl u nás**.

Co sem NEPATŘÍ: soubor, který bych vyrobil sám z popisu specifikace.
To by byl tentýž omyl znovu, jen v binární podobě.

## Pak

`tests/c2pa-realny-soubor.test.js` se zapne sám a řekne, jestli náš
čtenář na skutečném souboru obstojí. Když neobstojí, je to nález o našem
kódu — a přesně proto ta fixtura chybí jako jediná položka na seznamu.

---

## Jak vznikly ty současné

`_vstup.jpg` je obyčejný obrázek bez manifestu (nosič pixelů, 320×200).
Podpis na něj dal `c2patool`:

```bash
cd tests/fixtures/c2pa
c2patool _vstup.jpg --config '{"claim_generator":"test","assertions":[{"label":"c2pa.actions","data":{"actions":[{"action":"c2pa.created","digitalSourceType":"http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"}]}}]}' --output podepsany-ai.jpg --force
c2patool _vstup.jpg --config '{"claim_generator":"test","assertions":[{"label":"c2pa.actions","data":{"actions":[{"action":"c2pa.created","digitalSourceType":"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"}]}}]}' --output podepsany-foto.jpg --force
```

Nástroj hlásí `signingCredential.untrusted` — podepisuje vývojovým
certifikátem, který není v žádném úložišti důvěry. Pro náš účel to
nevadí: **podpis se stejně neověřuje** (viz hlavička `c2pa.js`), ověřuje
se, že manifest najdeme a přečteme z něj typ zdroje.
