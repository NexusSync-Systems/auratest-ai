# AuraGuard 🛡️ (dříve AuraTest AI)

AuraGuard je absolutní evropská špička v **Compliance-as-a-Code** a automatizovaném QA testování. Kombinuje sílu umělé inteligence (LLM), Playwrightu a expertních statických analyzátorů k tomu, aby vaše webové aplikace splňovaly přísné technické, bezpečnostní a evropské normy ještě před nasazením do produkce (CI/CD) i dlouho po něm.

---

## 🚀 Fáze 1: Jádro a AI Testing (Původní funkce)
Původní jádro systému se soustředí na funkční testování webu "lidským způsobem".
- **Autonomní AI Playwright Agent**: AI (např. přes model Llama 3 nebo Apfel) projde vaši aplikaci, "kliká" na tlačítka, hledá chyby a vygeneruje čistý Playwright skript pro opakovatelné testy.
- **Monitoring sítě a konzole**: Sleduje selhání HTTP požadavků (500/404) a JS errory v konzoli přímo během běhu.

## 🇪🇺 Fáze 2: Evropské směrnice & Resilence
Nástroj se transformoval na ochránce evropské byrokracie a spolehlivosti.
- **Evropský akt o přístupnosti (EAA)**: Integrovaný Axe-Core skener testuje kontrast, aria-labels a celkovou webovou přístupnost aplikací pro hendikepované (povinné v EU).
- **NIS2 & Post-Quantum Cryptography**: Ověřuje připravenost aplikace na tvrdou bezpečnost, např. analyzuje zabezpečení TLS/SSL vrstvy.
- **DORA Chaos Engineering**: Vkládá do sítě šumy a zpoždění (např. +1000ms na každé API volání) pro otestování frontendové odolnosti, jak vyžaduje nařízení DORA.
- **Green-Aware Computing**: Optimalizační widget a backend endpoint varují před deployem v době špičky nebo ve chvíli, kdy elektrická síť využívá příliš mnoho fosilních paliv.

## 🏛️ Fáze 3: Kybernetická bezpečnost a Ochrana dat
Plní další kritické body nutné k provozu webových služeb.
- **AI Act Scanner**: Hledá odchozí LLM volání z aplikace a zjišťuje, zda je koncový uživatel transparentně informován, že s ním komunikuje AI.
- **Striktní GDPR Cookie Auditor**: Tvrdý ePrivacy test – robot navštíví aplikaci a ignoruje cookie lištu. Pokud se před odsouhlasením naláduje Google Analytics nebo Meta Pixel do `localStorage` nebo cookies, systém zablokuje nasazení.
- **Cyber Resilience Act (CRA) Scanner**: Generuje frontendový SBOM (seznam závislostí) a pinguje centrální Google OSV.dev (CVE) databázi. Nenechá projít jedinou známou veřejnou zranitelnost.
- **Executive PDF Report**: Pomocí Print CSS exportuje celou záložku Audit do čistého PDF pro auditní orgány nebo management.

## 🟢 Fáze 4: Kontinuální Uptime & Form Monitoring
Slouží k provoznímu hlídání. Funguje bez těžkopádného Playwrightu, aby mohl aplikace kontrolovat bleskovou rychlostí každou minutu.
- **On-Demand Page Monitor**: Bleskově kontroluje HTTP odpovědi (status = 200, doba odezvy) bez stahování JS balastu.
- **Form Monitor**: Odesílá naprosto čisté HTTP POST/GET requesty simulující kontaktní/login formulář a ověřuje chování cílového serveru. Ujistí se, že "formuláře stále odesílají" bez nutnosti spouštět plný test.

---

## 💻 Integrace do CI/CD (AuraGuard CLI)

Aplikace poskytuje vlastní bashový/CMD nástroj, kterým zablokujete pipeline v případě nesplnění legislativy.

```bash
# Nainstalování lokálního balíčku
npm link

# Spuštění testu proti produkci nebo staging serveru
auraguard --url https://mojeaplikace.cz --audit all

# Můžete volit i dílčí audity
auraguard --url https://mojeaplikace.cz --audit nis2
auraguard --url https://mojeaplikace.cz --audit cra
auraguard --url https://mojeaplikace.cz --audit eaa
auraguard --url https://mojeaplikace.cz --audit ai
auraguard --url https://mojeaplikace.cz --audit gdpr
auraguard --url https://mojeaplikace.cz --audit cve
```

Pokud jakýkoliv modul nahlásí kritickou nesrovnalost s legislativou, `auraguard` vrací `exit code 1` a úspěšně shodí např. GitHub Actions.

---

## 🛠 Jak to rozběhnout lokálně

**1. Instalace**
```bash
npm run setup
```
*(Zajistí Node.js závislosti i stažení Playwright prohlížečů).*

**2. Start (React + Node)**
```bash
npm run dev
```

**3. Otevřít prohlížeč**
Běžte na **http://localhost:3001** a začněte testovat. Pro AI funkce zadejte URL svého LLM providera v pravém panelu, případně prozkoumejte **novou záložku Audit (Ikona štítu)**.

---
*Vyvinuto s podporou AI (Apfel / Gemini) v rámci transformace testování na Compliance-as-a-Code.*
