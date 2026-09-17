#!/usr/bin/env node
/**
 * Vyrobí vzorky skutečných bundlů pro testy otisku knihoven.
 *
 * PROČ TO NENÍ RUČNĚ PSANÝ ŘETĚZEC V TESTU
 * Protože to jednou ručně psaný řetězec byl a stálo to revert celé dávky.
 * Signatury se hádaly proti představě o tom, jak bundle vypadá — vzory
 * `preactAttr` a `VERSION` v preactu neexistují, `timeFormat` je naopak
 * v d3-scale přítomný, takže rozlišovací důkaz misfiroval na tom souboru,
 * kvůli kterému vznikl. Testy přesto svítily zeleně.
 *
 * Potřebuje síť a esbuild. Výstup se ukládá gzipnutý do
 * `tests/fixtures/sbom/`; podrobnosti v tamním README.
 */
import { execFileSync } from 'child_process';
import { gzipSync } from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const KOREN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CIL = path.join(KOREN, 'tests', 'fixtures', 'sbom');

/** Verze se přibíjejí. Plovoucí rozsah by ze vzorku udělal pohyblivý cíl. */
const BALICKY = [
  'preact@10.29.8',
  'd3@7.9.0',
  'd3-scale@4.0.2',
  'react@19.3.0',
  'react-dom@19.3.0',
  '@preact/signals-react@3.12.0',
  'jquery@3.7.1',
  'lodash@4.18.1',
  'vue@3.5.42',
  'axios@1.20.0',
];

/** Aplikace, které se postaví esbuildem. Klíč = název vzorku. */
const APLIKACE = {
  'app-preact': {
    ext: 'jsx',
    kod: `import { h, render } from 'preact';
import { useState } from 'preact/hooks';
function App(){ const [n]=useState(0); return h('div',null,n); }
render(h(App), document.body);`,
  },
  'app-preact-compat': {
    ext: 'jsx',
    kod: `import React, { useState, render } from 'preact/compat';
function App(){ const [n]=useState(0); return React.createElement('div',null,n); }
render(React.createElement(App), document.body);`,
  },
  'app-react': {
    ext: 'jsx',
    kod: `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
function App(){ const [n]=useState(0); return React.createElement('div',null,n); }
createRoot(document.body).render(React.createElement(App));`,
  },
  // Knihovna PRO React, která má „preact" v názvu. Kvůli ní se nesmí
  // používat řetězec „preact" jako důkaz, že jde o Preact.
  'app-react-signals': {
    ext: 'jsx',
    kod: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { signal } from '@preact/signals-react';
import '@preact/signals-react/runtime';
const s = signal(0);
function App(){ return React.createElement('div',null,s.value); }
createRoot(document.body).render(React.createElement(App));`,
  },
  'app-d3scale': {
    ext: 'js',
    kod: `import { scaleLinear, scaleOrdinal, scaleTime } from 'd3-scale';
const x = scaleLinear().domain([0,1]).range([0,100]);
const c = scaleOrdinal(['a','b']);
const t = scaleTime().domain([new Date(), new Date()]);
document.body.textContent = String(x(0.5)) + c('a') + t(new Date());`,
  },
  'app-d3full': {
    ext: 'js',
    kod: `import * as d3 from 'd3';
d3.selectAll('div').data(d3.range(3)).enter();
const s = d3.scaleLinear(); document.body.textContent = String(s(1));`,
  },
};

/** Distribuce kopírované rovnou z balíčku (to, co servíruje CDN). */
const DISTRIBUCE = {
  'preact.min.js': 'preact/dist/preact.min.js',
  'd3-scale.min.js': 'd3-scale/dist/d3-scale.min.js',
  'dist-d3.min.js': 'd3/dist/d3.min.js',
  'dist-jquery.min.js': 'jquery/dist/jquery.min.js',
  'dist-lodash.min.js': 'lodash/lodash.min.js',
  'dist-vue.global.prod.js': 'vue/dist/vue.global.prod.js',
  'dist-axios.min.js': 'axios/dist/axios.min.js',
  'dist-react.production.js': 'react/cjs/react.production.js',
  'dist-react-dom.production.js': 'react-dom/cjs/react-dom.production.js',
};

function najdiEsbuild() {
  const kandidati = [
    path.join(KOREN, 'node_modules', '.bin', 'esbuild'),
    path.join(KOREN, 'frontend', 'node_modules', '.bin', 'esbuild'),
    process.env.ESBUILD_BINARY_PATH,
  ].filter(Boolean);
  const nalezeny = kandidati.find((p) => fs.existsSync(p));
  if (!nalezeny) throw new Error('esbuild se nenašel. Nastav ESBUILD_BINARY_PATH.');
  return nalezeny;
}

const esbuild = najdiEsbuild();
const prac = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-fixtures-'));
console.log(`Pracovní adresář: ${prac}`);

execFileSync('npm', ['init', '-y'], { cwd: prac, stdio: 'ignore' });
console.log(`Instaluji ${BALICKY.length} balíčků…`);
execFileSync('npm', ['i', '--silent', '--no-audit', '--no-fund', ...BALICKY], {
  cwd: prac,
  stdio: 'inherit',
});

fs.mkdirSync(CIL, { recursive: true });
const ulozeno = [];

for (const [nazev, { ext, kod }] of Object.entries(APLIKACE)) {
  const zdroj = path.join(prac, `${nazev}.${ext}`);
  const vystup = path.join(prac, `${nazev}.min.js`);
  fs.writeFileSync(zdroj, kod, 'utf8');
  execFileSync(esbuild, [
    zdroj,
    '--bundle',
    '--minify',
    '--format=iife',
    '--define:process.env.NODE_ENV="production"',
    '--loader:.jsx=jsx',
    '--jsx-factory=h',
    `--outfile=${vystup}`,
    '--log-level=error',
  ], { cwd: prac, stdio: 'inherit' });
  const obsah = fs.readFileSync(vystup);
  fs.writeFileSync(path.join(CIL, `${nazev}.min.js.gz`), gzipSync(obsah, { level: 9 }));
  ulozeno.push([`${nazev}.min.js`, obsah.length]);
}

for (const [nazev, relativni] of Object.entries(DISTRIBUCE)) {
  const zdroj = path.join(prac, 'node_modules', relativni);
  if (!fs.existsSync(zdroj)) {
    console.warn(`PŘESKOČENO (soubor v balíčku není): ${relativni}`);
    continue;
  }
  const obsah = fs.readFileSync(zdroj);
  fs.writeFileSync(path.join(CIL, `${nazev}.gz`), gzipSync(obsah, { level: 9 }));
  ulozeno.push([nazev, obsah.length]);
}

console.log('\nUloženo do tests/fixtures/sbom/:');
for (const [nazev, bajtu] of ulozeno) {
  console.log(`  ${nazev.padEnd(34)} ${(bajtu / 1024).toFixed(1)} kB`);
}
console.log('\nTeď spusť `npx jest tests/sbom-fixtures` — tabulka očekávaných');
console.log('výsledků je specifikace, vzorky jsou jen důkazní materiál.');
