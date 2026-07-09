# AuraGuard - Komplexní uživatelská a technická dokumentace

**Verze:** 1.0 (Enterprise Edition)
**Zaměření:** Web QA, EU Compliance, Security, Uptime Monitoring

---

## 1. Úvod do systému

**AuraGuard** vznikl evolucí z projektu *AuraTest AI*. Zatímco původní verze se soustředila primárně na to, aby AI dokázala funkčně "proklikat" webovou stránku jako běžný uživatel a vygenerovala kód pro Microsoft Playwright, nová verze AuraGuard je stavěna jako **Gatekeeper pro CI/CD pipelines** (tzv. Compliance-as-a-Code). 

Dokáže během několika sekund či minut zjistit, zda je váš kód před nasazením na server vůbec legální podle nejnovějších směrnic EU a zda neobsahuje triviální, ale kritické bezpečnostní zranitelnosti.

---

## 2. Moduly a Funkce (Fáze 1 až 4)

### Fáze 1: AI QA Testing (Funkční testy)
- **Autonomní AI Prozkoumávač:** Zadáte URL a vyberete model (např. Apfel nebo Llama). AI model dostane volnou ruku, začne prozkoumávat DOM (HTML) vaší stránky, zkouší zadávat data do formulářů, naviguje přes tlačítka a hledá aplikační chyby. 
- **Sběr chyb:** Monitorují se síťové errory (HTTP 4xx, 5xx) a JavaScript chyby v konzoli.
- **Export do kódu:** Všechny kroky, které AI udělá, se zaznamenají a převedou na robustní TypeScript kód pro Playwright, který můžete spouštět každý den.

### Fáze 2: Evropské směrnice a Resilence
- **Evropský akt o přístupnosti (EAA):** Aplikace prožene web přes knihovnu `axe-core`, zkontroluje barevné kontrasty a dostupnost pro čtečky obrazovky. Pokuty za nerespektování EAA mohou být likvidační.
- **NIS2 a PQC (Kryptografie):** Ověřuje SSL/TLS certifikáty, nastavení HTTP hlaviček a hledá zmínky o Post-Quantum Cryptography připravenosti.
- **DORA Chaos Engineering:** Odolnostní test vkládající latenci (+1000 ms) do vybraných prvků stránky, simuluje tak výpadek serveru nebo slabé mobilní připojení.

### Fáze 3: Kybernetická bezpečnost a Ochrana soukromí
- **AI Act Scanner:** Hledá odchozí LLM volání (OpenAI, Gemini). Pokud je aplikace používá, prohledá DOM na přítomnost disclaimeru upozorňujícího uživatele na komunikaci s umělou inteligencí.
- **GDPR Cookie Auditor (ePrivacy):** Zcela autonomně navštíví aplikaci a po dobu 5 sekund absolutně ignoruje cookie lištu (nic nepotvrdí). Poté zkontroluje `localStorage` a aktivní Cookies. Pokud nalezne Google Analytics, Pixel nebo trackery, ihned nahlásí nesoulad s GDPR (Default by Design).
- **CRA Vulnerability Scanner (CVE OSV):** Vytvoří ze stránky SBOM (Softwarový kusovník) zjištěním použitých JavaScript frameworků a knihoven, který odešle proti gigantické open-source databázi Google OSV. Nahlásí každou knihovnu (např. jQuery 1.8), která má známé kybernetické díry (CVE).

### Fáze 4: Kontinuální Uptime & Form Monitoring
- **Test dostupnosti (HTTP):** Extrémně rychlý test (nepoužívá Playwright), který hlídá pouze HTTP 200 stav. Může běžet každou sekundu na pozadí a kontrolovat, zda web "žije".
- **Test formuláře:** Pošle statický HTTP POST požadavek do action-endpointu formuláře, aby potvrdil, že vám v noci neusnula databáze a poptávky skutečně procházejí.

---

## 3. Integrace přes CLI (CI/CD)

AuraGuard neobsahuje pouze hezké vizuální UI. Má vlastní nástroj pro běh v konzoli/terminálu.

**Instalace (globální):**
V kořenové složce projektu spusťte příkaz pro namapování binárky:
```bash
npm link
```

**Spuštění auditu pro všechny moduly:**
```bash
auraguard --url https://vase-aplikace.cz --audit all
```

**Jednotlivé parametry auditu:**
- `--audit eaa` (Přístupnost)
- `--audit nis2` (Kryptografie a bezpečnostní hlavičky)
- `--audit cra` (Vytvoření SBOM kusovníku)
- `--audit cve` (Kontrola CRA proti databázi zranitelností)
- `--audit ai` (Detekce LLM API a disclaimeru)
- `--audit gdpr` (Striktní Cookie test před souhlasem)

Pokud některý test neprojde (např. najde se zranitelnost), CLI vrátí `exit code 1`, což okamžitě zastaví nasazení aplikace (např. v GitLab CI/CD nebo GitHub Actions).

---

## 4. Lokální spuštění UI rozhraní

Pokud preferujete klikání, AuraGuard UI se spouští takto:

1. Nainstalujte všechny závislosti:
```bash
npm run setup
```
2. Zapněte server:
```bash
npm run dev
```
3. Přejděte na `http://localhost:3001`. V záložce s Ikonou štítu ("AuraGuard Audit") naleznete všechna spouštěcí tlačítka. Pro export všech výsledků naleznete ve spodní části UI tlačítko **Generovat Executive PDF Report**.

---
*Konec dokumentu*
