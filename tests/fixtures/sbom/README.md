# Vzorky skutečných bundlů pro otisk knihoven

## Proč jsou tady

Signatury v `sbom-fingerprint.js` rozhodují o tom, co se napíše do soupisu
komponent — a z každé položky se odvozuje dotaz do OSV na zranitelnosti.
Falešná položka tedy nevyrobí jen chybný řádek, ale i **nález o zranitelnosti
balíčku, který zákazník nepoužívá**.

Předchozí pokus o opravu falešných položek (commit 64005ab, revertovaný
v 38ef9f6) selhal přesně proto, že se testoval proti **ručně psaným
řetězcům**. Vypadaly jako bundle, ale nebyly jím:

* `preactAttr` — vzor, který v preactu vůbec neexistuje
* `timeFormat` jako důkaz „tohle není d3-scale" — přitom `d3-scale` na
  `d3-time-format` závisí a volá ho ve `scaleTime`
* `VERSION` v distribuci preactu — není tam
* `"preact"` jako vylučující důkaz — sedí i na `@preact/signals-react`,
  což je knihovna PRO React

Zelená sada testů tvrdila, že vada je opravená. Na skutečném souboru
opravená nebyla. Sada testovala představu o tom, jak bundle vypadá.

**Proto se signatury smí měnit jen proti těmhle souborům.**

## Co to je

Skutečné distribuce z npm a skutečné aplikační bundly postavené esbuildem
(`--bundle --minify --format=iife`, `NODE_ENV=production`). Uložené
gzipnuté, protože jde o desítky až stovky kilobajtů.

Verze, ze kterých vzorky vznikly:

| balíček | verze |
|---|---|
| preact | 10.29.8 |
| d3 | 7.9.0 |
| d3-scale | 4.0.2 |
| react / react-dom | 19.3.0 |
| @preact/signals-react | 3.12.0 |
| jquery | 3.7.1 |
| lodash | 4.18.1 |
| vue | 3.5.42 |
| axios | 1.20.0 |

### Jednotlivé vzorky

| soubor | co dokládá |
|---|---|
| `app-preact.min.js` | aplikace na Preactu — řetězec „preact" v bundlu NEPŘEŽIJE |
| `app-preact-compat.min.js` | `preact/compat` — sdílí s Reactem `react.element`, tudy vznikal falešný „React" |
| `app-react.min.js` | kontrolní vzorek: skutečný React + react-dom |
| `app-react-signals.min.js` | React + `@preact/signals-react` — obsahuje řetězec „preact", ale Preact tam NENÍ |
| `app-d3scale.min.js` | aplikace jen s `d3-scale` |
| `app-d3full.min.js` | aplikace s kompletním `d3` |
| `d3-scale.min.js` | distribuce `d3-scale` z CDN — obsahuje `timeFormat` (tranzitivní závislost) |
| `dist-d3.min.js` | distribuce kompletního `d3` z CDN |
| `preact.min.js` | distribuce preactu z CDN |
| `dist-*.js` | kontrolní vzorky, aby zúžení neumlčelo pravdivé nálezy |

## Jak je vyrobit znovu

```
node scripts/build-sbom-fixtures.mjs
```

Skript potřebuje síť a esbuild. Verze zvyšuj vědomě: nová verze knihovny
může mít jiné vnitřní názvy, a pak je potřeba znovu ověřit, co ještě
signatury poznají. Tabulku očekávaných výsledků drží
`tests/sbom-fixtures.test.js` — ta je specifikací, ne vzorky samotné.
