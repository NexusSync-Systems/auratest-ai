#!/usr/bin/env node
/**
 * Ověření sandboxu E2B z příkazové řádky.
 *
 * Použití:
 *   node scripts/sandbox-overeni.mjs --smoke
 *       Spustí v sandboxu `node --version` — ověří klíč, síť a SDK.
 *   node scripts/sandbox-overeni.mjs generated-scripts/test-XXXX.spec.ts
 *       Přehraje vygenerovaný Playwright test v sandboxu.
 *
 * Exit: 0 = splněno, 1 = nesplněno, 2 = neprůkazné (nic se nezměřilo).
 *
 * Konfigurace v `.env`: SANDBOX_PROVIDER=e2b a E2B_API_KEY (viz .env.example
 * a docs/SANDBOX-E2B.md). Klíč se nikdy nevypisuje.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spustVSandboxu, sandboxConfig, SANDBOX_STAV } from '../sandbox.js';
import { overSkriptVSandboxu } from '../sandbox-overeni.js';

const KOREN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { [SANDBOX_STAV.SPLNENO]: 0, [SANDBOX_STAV.NESPLNENO]: 1, [SANDBOX_STAV.NEPRUKAZNE]: 2 };
const POPIS = {
  [SANDBOX_STAV.SPLNENO]: '✅ splněno',
  [SANDBOX_STAV.NESPLNENO]: '❌ nesplněno',
  [SANDBOX_STAV.NEPRUKAZNE]: '⚠️  neprůkazné',
};

function vypis(v) {
  console.log(`\nVýsledek: ${POPIS[v.stav] || v.stav}`);
  if (v.cil) console.log(`Cíl:      ${v.cil}`);
  if (v.exitCode !== null && v.exitCode !== undefined) console.log(`Exit kód: ${v.exitCode}`);
  if (v.trvaniMs) console.log(`Trvání:   ${(v.trvaniMs / 1000).toFixed(1)} s`);
  if (v.duvod) console.log(`Důvod:    ${v.duvod}`);
  if (v.stdout?.trim()) console.log(`\n--- stdout ---\n${v.stdout.trim()}`);
  if (v.stderr?.trim()) console.log(`\n--- stderr ---\n${v.stderr.trim()}`);
}

const arg = process.argv[2];
if (!arg || arg === '--help' || arg === '-h') {
  console.log('Použití: node scripts/sandbox-overeni.mjs --smoke | <cesta k .spec.ts>');
  process.exit(2);
}

const cfg = sandboxConfig();
console.log(`Provider: ${cfg.provider} · šablona: ${cfg.template} · klíč: ${cfg.klicNastaven ? 'nastaven' : 'CHYBÍ'} · internet: ${cfg.internet ? 'ano' : 'ne'}`);

let vysledek;
if (arg === '--smoke') {
  vysledek = await spustVSandboxu({ prikaz: 'node --version && uname -sr && whoami', timeoutMs: 60_000 });
} else {
  const soubor = path.resolve(process.cwd(), arg);
  if (!fs.existsSync(soubor)) {
    console.error(`Soubor neexistuje: ${arg}`);
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(KOREN, 'package.json'), 'utf8'));
  const verze = pkg.devDependencies?.['@playwright/test'] || pkg.dependencies?.playwright;
  vysledek = await overSkriptVSandboxu(fs.readFileSync(soubor, 'utf8'), { verzePlaywright: verze });
}

vypis(vysledek);
process.exit(EXIT[vysledek.stav] ?? 2);
