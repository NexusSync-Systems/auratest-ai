# Skutečně podepsaný obrázek — co sem patří a proč

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
