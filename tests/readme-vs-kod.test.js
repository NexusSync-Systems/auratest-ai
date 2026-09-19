/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import {
  INTENZITA_CELKEM_KWH_NA_GB,
  UHLIKOVA_INTENZITA_G_NA_KWH,
  EMISNI_FAKTOR_G_NA_GB,
} from '../green-model.js';

/**
 * README proti kódu.
 *
 * PROČ TENHLE TEST EXISTUJE
 * V README stálo přes rok „koeficientem 0,81 g CO₂/MB". `green-model.js`
 * přitom ve vlastním komentáři vysvětluje, že `0,81` NENÍ gram na megabajt,
 * ale `0,81 kWh/GB` ze SWDM v3 — tedy spotřeba energie na gigabajt. Kód se
 * opravil na SWDM v4, README ne, a rozdíl byl zhruba 5,5násobek.
 *
 * U nástroje, jehož jediný prodejní argument je „netvrdíme víc, než jsme
 * změřili", je nepravdivé číslo ve vlastním README horší než chyba v kódu:
 * kód opravil test, README nehlídalo nic.
 *
 * Tenhle test hlídá jen čísla, která se dají svázat s konstantou v kódu.
 * Ostatní tvrzení v README (právní termíny, popisy modulů) nijak vázaná
 * nejsou a kontrolují se dál jen čtením — to je vědomá mezera, ne přehlédnutí.
 */

const README = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

/**
 * README bez značek citace a se sjednocenými mezerami.
 *
 * Tohle NENÍ kosmetika. První verze testu hledala vzory přímo v `README`
 * a na mutaci „vrať plošné datum 1. 1. 2027" NEZAREAGOVALA: hledaný text
 * je uvnitř blokové citace, kde každý řádek začíná `> `, a `\s*` znak `>`
 * nepokrývá. Test tedy hlídal řetězec, který v té podobě nikdy nevznikne.
 *
 * Odhalila to až mutační zkouška — a jen proto, že se u ní ověřovalo, že
 * se zápis do souboru opravdu provedl. Mutace, u které se nezkontroluje,
 * že se zapsala, je totéž jako žádná.
 */
const TEXT = README.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');

describe('README nesmí tvrdit jiná čísla než kód', () => {
  it('uvádí emisní faktor, který odpovídá konstantě v green-model.js', () => {
    // 148.2 gCO2e/GB — kdyby se model změnil, musí se změnit i README.
    expect(EMISNI_FAKTOR_G_NA_GB).toBeCloseTo(148.2, 1);
    expect(TEXT).toContain('148,2 gCO₂e/GB');
  });

  it('uvádí energetickou intenzitu a uhlíkovou intenzitu z kódu', () => {
    expect(INTENZITA_CELKEM_KWH_NA_GB).toBeCloseTo(0.3, 3);
    expect(UHLIKOVA_INTENZITA_G_NA_KWH).toBe(494);
    expect(TEXT).toContain('0,300 kWh/GB');
    expect(TEXT).toContain('494 gCO₂e/kWh');
  });

  it('starý koeficient smí stát jen ve vysvětlení, proč byl chybný', () => {
    // PRVNÍ VERZE TOHOTO TESTU BYLA K NIČEMU. Hledala `koeficientem 0,81`
    // a povolovala výskyt, pokud se do 300 znaků objevilo „jednotková
    // chyba". Mutace „Koeficientem 0,81 g CO₂/MB" jím prošla: velké
    // písmeno obešlo první vzor a vysvětlivka o kus dál legitimizovala
    // druhý. Výjimka postavená na blízkosti textu neváže nic.
    //
    // Proto se teď kontroluje KAŽDÝ výskyt čísla a musí stát přesně za
    // větou, která ho označuje za chybu. Nové tvrzení tudy neprojde.
    // Druhá verze („každý výskyt musí stát za větou Dřív tu stálo") byla
    // zase moc úzká: výskyty jsou legitimně DVA — citace a vysvětlení,
    // proč je chybná. Test tehdy shodil i nezmutovaný README.
    //
    // Proto se oba přípustné kontexty pojmenovávají a hlídá se jejich
    // počet. Jakákoli třetí zmínka čísla test shodí, ať je formulovaná
    // jakkoli — a kdo ji přidá vědomě, musí sem sáhnout taky.
    const vsechny = [...TEXT.matchAll(/0,81/g)].length;
    const citace = [...TEXT.matchAll(/Dřív tu stálo „0,81 g CO₂\/MB/g)].length;
    const vysvetleni = [...TEXT.matchAll(/`0,81` je `kWh\/GB`/g)].length;

    expect(citace).toBe(1);
    expect(vysvetleni).toBe(1);
    expect(vsechny).toBe(2);
  });

  it('jmenuje verzi modelu, podle které se počítá', () => {
    // Bez verze je číslo neověřitelné — stejný důvod, proč ji nese `scope`
    // u každého výsledku.
    expect(TEXT).toContain('Sustainable Web Design Model v4');
  });
});

describe('README nesmí tvrdit plošný termín NIS2', () => {
  it('neuvádí 1. 1. 2027 jako konec přechodného období pro všechny', () => {
    // § 13 odst. 4 a § 15 odst. 4: povinnosti se plní do 1 roku od doručení
    // rozhodnutí o registraci — u každého subjektu jindy. Plošné datum bylo
    // marketingové tvrzení, které si vlastní plán (PLAN-NIS2.md §2) vyvrátil.
    expect(TEXT).not.toMatch(/přechodné období končí/);
  });

  it('uvádí místo toho odvození od rozhodnutí o registraci', () => {
    expect(TEXT).toContain('rozhodnutí o registraci');
  });
});
