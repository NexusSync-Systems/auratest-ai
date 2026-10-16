# Sandbox E2B — přehrání vygenerovaných testů mimo server

Stav: **krok 1 (vývoj na plánu Hobby)**. Modul je hotový a pokrytý testy,
do agenta ani do API zatím zapojený není.

## Proč

Agent ukládá do `generated-scripts/` spustitelný `.spec.ts`. Jeho obsah
pochází z LLM a z testované stránky. Dosud ho uživatel pouštěl u sebe
(`npx playwright test`), tedy cizí kód na svém stroji nebo v CI. `jsLiteral`
v `agent.js` brání vložení kódu přes hodnoty kroků, ale druhá vrstva obrany
je kód vůbec nespouštět vedle tajemství a vnitřní sítě.

[E2B](https://e2b.dev) spustí příkaz v microVM (Firecracker), které vznikne
za ~1 s a po běhu se zahodí.

## Co je hotové

| Soubor | Co dělá |
|---|---|
| `sandbox.js` | `spustVSandboxu({ soubory, prikaz, timeoutMs, envs })` → `{ stav, exitCode, stdout, stderr, trvaniMs, duvod }` |
| `sandbox-overeni.js` | `overSkriptVSandboxu(spec)` — přehraje vygenerovaný test proti jeho cíli |
| `scripts/sandbox-overeni.mjs` | CLI: `--smoke` nebo cesta k `.spec.ts` |
| `tests/sandbox.test.js` | 28 testů s podvrženým SDK, skutečné E2B nevolá |

Zásady modulu:

- **Bez sandboxu se nic nespouští lokálně.** Vypnuto, chybí klíč, chybí SDK,
  výpadek služby → `neprůkazné`. Žádný fallback na `child_process`.
- **Do sandboxu nejde `process.env`.** Jen výslovné `envs` (u přehrání `CI=1`).
  Klíč slouží jen k přihlášení SDK a z chybových hlášek se maskuje.
- **Tři stavy:** exit 0 = splněno, nenulový = nesplněno, nic se nezměřilo =
  neprůkazné.
- **Sandbox se vždy zabije** (`finally`) — platí se za každou sekundu.
- **Cíl musí být veřejný.** `localhost` nebo vnitřní adresa by ze sandboxu
  znamenala jiný stroj → neprůkazné (kontrola přes `assertPublicHttpUrl`).

Co výsledek **neznamená**: „splněno" říká jen, že vygenerovaný test proti
cíli prošel. Není to verdikt o webu.

## Zprovoznění (krok 1)

1. Založit účet na <https://e2b.dev> (plán **Hobby**: zdarma, jednorázový
   kredit 100 USD, sandbox max. 1 h, 20 souběžných).
2. V konzoli vytvořit API klíč a vložit ho do `.env` (ne do `.env.example`):
   ```
   SANDBOX_PROVIDER=e2b
   E2B_API_KEY=…
   ```
3. Nainstalovat SDK: `npm install e2b`
4. Ověřit spojení: `node scripts/sandbox-overeni.mjs --smoke`
   (čeká se `✅ splněno` a verze Node.js ze sandboxu).
5. Přehrát vygenerovaný test proti **veřejnému** webu:
   `node scripts/sandbox-overeni.mjs generated-scripts/<soubor>.spec.ts`
   Na šabloně `base` se Playwright a Chromium instalují při každém běhu
   (1–2 minuty navíc). Pokud instalace systémových knihoven (`--with-deps`)
   v šabloně `base` selže, je to signál pro krok 2 níž.

Exit kód CLI: 0 = splněno, 1 = nesplněno, 2 = neprůkazné.

## Data a region

- Hobby běží v **US regionu** (`e2b.app`). EU cluster je od plánu **Pro**
  (150 USD/měs.) a zapíná ho podpora E2B (doména → `E2B_DOMAIN`).
- Pro vývoj na Hobby používat jen **vlastní nebo veřejné testovací weby**
  a skripty bez osobních údajů. Vygenerovaný skript obsahuje URL, selektory
  a hodnoty zadané do formulářů.
- Před prvním zákazníkem: přejít na Pro + EU, uzavřít DPA s E2B
  (vzor v trust centru, trust.e2b.dev) a uvést E2B mezi subdodavateli.

## Cena (ceník k 10/2026)

Platí se za sekundu běhu: 1 vCPU 0,000014 USD/s, 1 GiB RAM 0,0000045 USD/s.
Výchozí sandbox (2 vCPU, 4 GiB) ≈ 0,17 USD/h. Přehrání testu na `base`
(~3 min s instalací) ≈ 0,01 USD.

## Další kroky

2. Vlastní šablona z `mcr.microsoft.com/playwright:v1.60.0-jammy` (stejný
   obraz jako v `Dockerfile`) → odpadne instalace při každém běhu.
3. Zapojení do běhu agenta: po vygenerování skriptu volitelně přehrát
   v sandboxu a výsledek zapsat do spisu jako samostatné měření
   (ne do verdiktu webu).
4. Při objemu nebo požadavku zákazníka na data u sebe: E2B Embed
   (open source, Apache-2.0) na vlastním x86 serveru s KVM — stejné API,
   jen jiná `E2B_DOMAIN`.
