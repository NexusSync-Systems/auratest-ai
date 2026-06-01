# AuraTest AI 🤖

Moderní AI agent pro autonomní testování webových aplikací pomocí Playwrightu a umělé inteligence (Apfel / Llama3). Nástroj si web sám prozkoumá, objeví případné chyby (funkční i vizuální) a na konci vám naservíruje statistiky načítání a kompletní skript Playwrightu pro zopakování testu.

---

## 🚀 Jak to rozběhnout za 2 minuty (Bez Dockeru)

Pokud nemáte nebo nechcete používat Docker, aplikace jde velice jednoduše nastartovat. Stačí mít nainstalované [Node.js](https://nodejs.org/) (ideálně verzi 18+).

### 1. Instalace
Otevřete si v této složce terminál a spusťte tento jediný příkaz:
```bash
npm run setup
```
*(Tento příkaz se postará úplně o všechno: stáhne knihovny pro backend, knihovny pro frontend a nakonec na pozadí stáhne samotný prohlížeč od Microsoftu pro automatické testování).*

### 2. Spuštění
Aplikaci pak spustíte už jen příkazem:
```bash
npm run dev
```

Hotovo! Můžete si otevřít prohlížeč na **http://localhost:3001** a začít testovat. V pravém panelu v aplikaci vyplníte jako poskytovatele modelu "Apfel" s vaší API URL adresou, nebo lokální Ollamu.

## 🍏 Jak nastavit Apfel jako chytřejší mozek
Zatímco bezplatná lokální Ollama je skvělá na experimenty, nasazení opravdového cloudového LLM (např. přes Apfel) dodá testům vysokou stabilitu.
1. Získejte svůj API klíč pro Apfel a zjistěte si Base URL, kam posílat requesty. (Přečtěte si [Oficiální dokumentaci k nasazení Apfel](https://apfel.ai/docs)).
2. Pokud používáte Apfel s OpenAI kompatibilním rozhraním, stačí v pravém panelu aplikace AuraTest zvolit jako Poskytovatele **Apfel / OpenAI Compatible**.
3. Do políčka Host URL zadejte vaši URL, typicky: `https://api.apfel.ai/v1/chat/completions` (nebo podobnou, viz. dokumentace vašeho Apfel serveru).
4. *(Pokud Apfel vyžaduje autentizaci přes Bearer Token, je zapotřebí jej předat v UI, nebo nastavit přes systémovou proměnnou `OPENAI_API_KEY` na hostitelském serveru).*

---

## 🐳 Rozběhnutí přes Docker
Pokud máte nainstalovaný Docker a nechcete řešit ani Node.js instalaci, aplikace má připravené kompletní kontejnery:

```bash
# Pro první vytvoření aplikace (stáhne se Playwright Ubuntu image, může to trvat pár minut):
docker compose build

# Pro samotné spuštění (kdykoliv):
docker compose up
```

Vygenerované Playwright skripty a chybové screenshoty se budou i při použití Dockeru automaticky propisovat přímo k vám na disk (do složek `screenshots/` a `generated-scripts/`).

---

## 📋 Vlastnosti a funkce
- **Autonomní Smoke Testy:** AI samo prokliká veřejnou část webu, zkusí se zalogovat a prošmejdí interní sekci. Následně nahlásí logické chyby.
- **Detekce chyb v síti a v konzoli:** Monitoruje "červené errory" z API backendu a loguje je do finální zprávy.
- **Export (Playwright skript):** Během klikání si AI zaznamenává své kroky a vygeneruje statický, profesionální kód, který si můžete vzít do vaší aplikace (TypeScript Playwright).
- **CI/CD Endpoint:** Přístupno skrz `POST /api/trigger-test` pro automatizované nasazení (např. přes GitHub Actions). Zkuste si ho a pošlete tělo requestu.
