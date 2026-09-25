# CLAUDE.md – AuraGuard / AuraTest AI (auratest-ai)

Kontext pro Clauda při práci na tomto repu. Stav a plán jsou v `README.md`, `PLAN.md` (dvě tratě: AI Act čl. 50 a NIS2), `PLAN-DEPLOY.md`, `CODE_REVIEW.md` a `ROZHODNUTI-NIS2.md`.

## Co to je
Nástroj pro compliance-as-a-code a automatizované QA webu: LLM + Playwright + statické analyzátory sbírají technické důkazy o webové aplikaci (EAA/WCAG přes axe-core, bezpečnostní hlavičky a TLS, post-kvantová výměna klíčů, chaos test, AI Act, NIS2).
Node.js (ESM) + Express (`server.js`), frontend v `frontend/`, lokální LLM přes Ollama (`auauratesting-gemma`, Gemma 2 2B), fine-tuning přes MLX na Macu.
Repo: `NexusSync-Systems/auratest-ai`, hlavní větev `master`.

## Zásady výsledků (jádro produktu)
- Tři stavy: **splněno / nesplněno / neprůkazné**. Když kontrolu nejde zvenčí provést nebo se nepovedla, je výsledek **neprůkazný**, nikdy tiché „splněno“ ani „nepodporuje“.
- Netvrdit víc, než kód měří: technický indikátor není posouzení shody (NIS2 většinou vyžaduje organizační opatření). README i výstupy musí odpovídat kódu. Několik commitů opravovalo přesně tohle.
- Kauzalitu dokládat měřením (např. chaos test počítá verdikt z rozdílu proti baseline, deterministicky ze seedu).
- Legislativní tvrzení opírat o primární zdroj a u výkladu uvádět, že nejde o právní radu.

## Bezpečnost nástroje
Nástroj skenuje cizí weby, proto platí: SSRF ochrana (`ssrf-guard.js`, `safe-fetch.js`), ochrana proti prompt injection v agentovi (`prompt-safety.js`, `agent-injection.test.js`), limity agenta, redakce PII (`pii-redactor.js`) a access control. Tyto vrstvy nikdy neobcházej. Nové síťové volání vede přes `safe-fetch`.
Řetěz důkazů (`audit-ledger.js`, `ledger/`) je neměnný. **Testy nesmí zapisovat do skutečného ledgeru.** Kvůli tomu už jednou padalo CI.

## Ověření změn
```bash
npm test               # jest (tests/*.test.js)
npm run test:smoke     # smoke test
npm run frontend:test && npm run build
npm run eval:llm:offline   # eval LLM bez modelu
```
CI (`.github/workflows/ci.yml` na `master`): eslint, check:runtime, jest, `npm audit --omit=dev --audit-level=high`, frontend testy a build.
Jest přes most k Macu nefunguje (FUSE mount). Plnou sadu spouští Zdeněk lokálně nebo CI.

## LLM a fine-tuning
Eval sada `adapters/auauratesting-gemma/eval-cases.jsonl`, skripty `tools/llm-eval/`, trénink MLX (`finetune:mlx:*`), generování a skórování (`eval:mlx:*`). Běží jen na Macu (Metal). Výstupy tréninku a `.venv` jsou v `.gitignore`. Skill `llm-eval-harness`.

## Tajemství
`.env` a `firebase-credentials.json` jsou v `.gitignore`. Nikdy je necommituj, necituj ani nekopíruj. `.env.example` drž aktuální.

## Git
Commit z cloud sandboxu nejde (mount nepovoluje mazání v `.git` a zůstane lock). Postup pro Zdeňka se zapisuje do `COMMITS.md`, commit dělá on na Macu.
Commit message česky, jako věta popisující opravený problém (např. „Plánovač neuplatňoval pojistku proti chybějícímu modelu“).
