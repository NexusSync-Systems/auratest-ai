# Ověření R2: zákazník, nebo dodavatel?

Podklad k rozhovoru, ne k rozhodnutí od stolu. R2 je nadřazená R1 i R5
(viz `ROZHODNUTI-NIS2.md`, sekce 4) a jako jediná z nich se nedá zodpovědět
z kódu — je to otázka trhu.

Cílem **není prodat**. Cílem je zjistit, jestli existuje opakující se
problém, který dnešní spis řeší. Když z rozhovorů vyjde, že ne, je to
dobrý výsledek: ušetří 25 dnů Epicu I stavěného pro nesprávného zákazníka.

---

## 1. Proč se ptát zrovna dodavatelů

Varianta **B (zákazník je dodavatel regulovaného subjektu)** je v produktu
z velké části hotová — Epic D i Epic S stojí v produkci. Varianta **A
(zákazník je regulovaný subjekt)** je 25 dnů práce daleko a stojí na
workflow incidentů, které zatím neexistuje.

Kdyby se ověřovala A, ptali bychom se na něco, co nemáme co ukázat. U B
máme hotový artefakt, takže rozhovor může být konkrétní: *tohle je výstup,
pomohl by vám?*

Slabý údaj ze stejného směru: v produkci je **nula aktivních monitorů**
(zjištěno 19. 9. 2026). Průběžný monitoring je ta část produktu, která
dává smysl hlavně u regulovaného subjektu. Nevyplývá z toho, že o něj
není zájem — produkt možná zatím nikdo nepoužívá ostře. Je to signál,
ne důkaz, a do rozhovoru ho netahat.

---

## 2. Koho oslovit

Firmy, které **dodávají službu nebo software regulovanému subjektu** podle
zákona o kybernetické bezpečnosti. Prakticky:

- SaaS a vývojářské firmy s klienty v energetice, zdravotnictví, dopravě,
  vodárenství, veřejné správě, bankovnictví
- provozovatelé webů a e-shopů pro takové klienty
- agentury, které dělají weby pro nemocnice, kraje, města

**Rozpoznávací znak:** dostali od svého zákazníka bezpečnostní dotazník
nebo přílohu ke smlouvě s požadavky na kyberbezpečnost. Kdo ho nedostal,
zatím do cílové skupiny nepatří — a to je samo o sobě odpověď.

Stačí **dvě až tři firmy**. Nejde o statistiku, jde o to, jestli problém
vůbec existuje a jak ho popisují vlastními slovy.

---

## 3. Co ukázat

**Jeden skutečný spis z produkce**, ne snímek obrazovky a ne slidy.
Vygeneruje se přes `/api/case-file` (v UI sekce Doložitelnost), za období,
jako PDF.

Spis má šest částí a u každé je při ukázce dobré vědět, co na ní může být
pro dodavatele cenné:

| Část spisu | Co z ní dodavatel má |
|---|---|
| **Souhrn** | Jedna strana pro jeho zákazníka, ne pro techniky. |
| **Neporušenost záznamu** | Řetězení hashem + ukotvení otisku mimo systém. Doklad, že se výsledky zpětně neupravovaly. |
| **Jednotlivé běhy** | Co se měřilo, kdy, s jakým výsledkem. Včetně neprůkazných. |
| **Co tímto spisem doloženo NENÍ** | Výslovný seznam hranic. Tohle ukázat jako první — viz níž. |
| **Znění použitých pravidel** | Podle čeho se měřilo, včetně věty „Neplyne z toho:" u každého pravidla. |
| **Verzování pravidel** | Po roce se dá doložit, co se tehdy testovalo. |

### Na co položit důraz

Na sekci **„Co tímto spisem doloženo NENÍ"** a na řádky `Neplyne z toho:`
u jednotlivých pravidel.

To není skromnost, to je test. Kdo dělá compliance doopravdy, ten ví, že
nástroj slibující „100 % shodu" je v jednání s auditorem k ničemu —
a právě přiznané hranice jsou to, co se dá podepsat. Jestli reakce na
tuhle sekci bude *„a nešlo by to napsat líp?"*, mluvíme s někým, kdo chce
razítko, ne důkaz. To je taky užitečné zjištění.

### Co neslibovat

- Že spis pokrývá NIS2 jako celek. Pokrývá tři technická opatření z § 14.
- Že z něj plyne shoda. Plyne z něj, co bylo změřeno.
- Workflow incidentů. Neexistuje.
- Registr aktiv. Neexistuje a možná nebude (R5).

---

## 4. Tři otázky

Položit v tomhle pořadí. První dvě **před** ukázkou spisu, třetí po ní.

### Otázka 1 — existuje ten problém?

> „Dostali jste od některého zákazníka bezpečnostní dotazník nebo přílohu
> ke smlouvě s požadavky na kyberbezpečnost? Jak často to chodí a kdo to
> u vás vyplňuje?"

**Co se tím zjišťuje:** jestli je poptávka vůbec reálná a jak je bolestivá.
Nechat mluvit; neptat se na nástroj.

Dobré doplňující otázky, když se rozpovídá: Jak dlouho to trvá? Co je na
tom nejhorší? Stalo se někdy, že jste kvůli tomu nedostali zakázku?

### Otázka 2 — jak to řeší dnes?

> „Když po vás zákazník chce doložit, že váš web nebo služba je
> v pořádku — co mu pošlete?"

**Co se tím zjišťuje:** existuje-li náhrada, kterou jim to musí přebít.
Odpovědi typu „vyplníme Excel podle svého nejlepšího vědomí" nebo
„objednáme jednorázový pentest za X" jsou přesně ten prostor, kde
opakovatelný doložený sken dává smysl. Odpověď „máme ISO 27001, to jim
stačí" naopak znamená, že prostor není.

### Otázka 3 — po ukázce spisu

> „Kdyby vám tohle přišlo automaticky každý měsíc, dalo by se tím na ten
> dotazník odpovědět? Co by v tom muselo být navíc, aby to stačilo?"

**Co se tím zjišťuje:** vzdálenost mezi hotovým produktem a použitelným
produktem. Odpověď na druhou půlku otázky je cennější než na první —
je to rovnou seznam práce.

---

## 5. Jak číst odpovědi

| Signál | Čte se jako |
|---|---|
| Dotazníky chodí opakovaně a vyplňuje je někdo draho placený | **B** — problém existuje a stojí peníze |
| „Pošleme, co máme" + rozpaky | **B** — náhrada je slabá |
| Po ukázce jmenují 2–3 konkrétní chybějící věci | **B**, a rovnou víme co |
| „Tohle by nám stačilo" bez výhrad | opatrně — buď to nečetli, nebo jim to je jedno |
| „Máme ISO/SOC 2, dotazníky neřešíme" | ne-B; u větších firem očekávat často |
| Baví je spíš průběžné hlídání webu než doložení | **A** — a pak má smysl Epic I |
| Chtějí razítko, vadí jim přiznané hranice | ani A ani B — tenhle produkt pro ně není |

**Rozhodovací pravidlo:** když ze tří rozhovorů aspoň dva ukážou na B
a jmenují konkrétní chybějící věci, R2 = dodavatel a Epic I se odkládá.
Když ani jeden, R2 zůstává otevřená a ověřuje se varianta A — jenže tam
není co ukázat, takže to bude rozhovor o hypotéze, ne o artefaktu.

---

## 6. Co je potřeba připravit

1. **Spis z reálného auditu**, ne z ukázkových dat. Klidně audit vlastního
   webu — na formě a důvěryhodnosti záleží víc než na tom, čí web to je.
2. **Zkontrolovat, že ve spisu nejsou cizí data.** Spis se staví z běhů
   vlastníka, ale před ukázkou třetí straně to chce ověřit očima.
3. Nic víc. Žádné slidy.

---

## 7. Co tenhle podklad nezodpoví

- **Cenu.** Kolik za to kdo dá, se z těchhle tří otázek nepozná. Na to je
  jiný rozhovor a je předčasný.
- **Jestli je trh dost velký.** Tři rozhovory řeknou, jestli problém
  existuje, ne kolik firem ho má.
- **R1 a R5.** Ty se rozhodují až po R2 a R1 navíc čeká na N2.
