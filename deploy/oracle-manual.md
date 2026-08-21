# Oracle Cloud — ruční postup konzolí

Klikací varianta pro případ, že Console AI není k dispozici. Zabere zhruba
15 minut. Hodnoty jsou konkrétní — opisuj je, ne odhaduj.

Konzole: https://cloud.oracle.com

---

## Krok 1 — SSH klíč (udělej PŘED vytvářením instance)

Na svém Macu:

```bash
ssh-keygen -t ed25519 -C "auraguard" -f ~/.ssh/auraguard
cat ~/.ssh/auraguard.pub          # tohle budeš vkládat do konzole
```

Klíč vytvoř dopředu. Oracle sice umí vygenerovat vlastní, ale privátní část
nabídne ke stažení jen jednou a při zavření okna je nenávratně pryč.

---

## Krok 2 — Síť (VCN)

**Menu ☰ → Networking → Virtual Cloud Networks → Start VCN Wizard**

- [ ] Zvol **„Create VCN with Internet Connectivity"** → Start VCN Wizard
- [ ] VCN Name: `auraguard-vcn`
- [ ] Compartment: root (nebo vlastní, pak si ho pamatuj)
- [ ] VCN CIDR Block: `10.0.0.0/16`
- [ ] Public Subnet CIDR Block: `10.0.1.0/24`
- [ ] Private Subnet CIDR Block: nech výchozí, používat ho nebudeme
- [ ] Next → Create

Wizard založí VCN, internet gateway, route table i subnety najednou. Ručně
skládat to nemusíš.

---

## Krok 3 — Otevřít porty v Security Listu

**Networking → VCN `auraguard-vcn` → Security Lists → „Default Security List
for auraguard-vcn" → Add Ingress Rules**

Přidej **dvě** pravidla (port 22 tam wizard dal sám):

| | Pravidlo 1 | Pravidlo 2 |
|---|---|---|
| Stateless | ne (nechat odškrtnuté) | ne |
| Source Type | CIDR | CIDR |
| Source CIDR | `0.0.0.0/0` | `0.0.0.0/0` |
| IP Protocol | TCP | TCP |
| Destination Port Range | `80` | `443` |

- [ ] Port 80 přidán — **nutný i když web pojede jen na HTTPS**, Let's Encrypt
      přes něj dělá ACME výzvu
- [ ] Port 443 přidán
- [ ] **Port 3001 NEPŘIDÁVAT** — aplikace poslouchá na loopbacku a chodí se
      k ní přes proxy

---

## Krok 4 — Instance

**Menu ☰ → Compute → Instances → Create Instance**

### Jméno a umístění
- [ ] Name: `auraguard`
- [ ] Compartment: stejný jako VCN

### Image and shape → tlačítko „Edit"

**Image:**
- [ ] Change Image → **Canonical Ubuntu** → verze **22.04**
- [ ] Zkontroluj, že se u obrazu píše **aarch64**. Když ne, vybral jsi x86
      variantu a na Ampere nepojede.

**Shape:**
- [ ] Change Shape → záložka **Ampere** → `VM.Standard.A1.Flex`
- [ ] Number of OCPUs: **2**
- [ ] Amount of Memory (GB): **12**
- [ ] U tvaru musí svítit zelený štítek **„Always Free-eligible"**

> Ampere záložka může být prázdná nebo hlásit nedostupnost. To je ta známá
> kapacitní potíž — viz oddíl „Když kapacita není" dole. **Nepřepínej na
> tvar VM.Standard.E*, ty jsou placené.**

### Networking
- [ ] VCN: `auraguard-vcn`
- [ ] Subnet: **public** subnet
- [ ] **Assign a public IPv4 address: ANO** (bez toho se na server nedostaneš)

### SSH keys
- [ ] „Paste public keys" → vlož obsah `~/.ssh/auraguard.pub`

### Boot volume
- [ ] Specify a custom boot volume size: **50** GB
- [ ] Ostatní nech výchozí

### Před kliknutím na Create
- [ ] Odhad ceny dole musí být **0** (nebo „Always Free")
- [ ] Create

Instance naběhne za 1–2 minuty. **Poznamenej si veřejnou IP** z detailu.

---

## Krok 5 — První přihlášení a firewall

```bash
ssh -i ~/.ssh/auraguard ubuntu@<veřejná-ip>
```

Hned po přihlášení otevři porty i uvnitř systému:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

**Tohle je nejčastější místo, kde se lidi zaseknou.** Ubuntu image od Oracle
má vlastní restriktivní iptables nad rámec Security Listu. Pravidlo je
v konzoli vidět, port je „otevřený", a stejně nic nejede.

Ověření, že to platí:

```bash
sudo iptables -L INPUT -n --line-numbers | head -12
```

Mezi prvními řádky musí být `ACCEPT tcp dpt:80` a `dpt:443` — a **nad**
případným pravidlem `REJECT`. Pořadí rozhoduje.

---

## Krok 6 — DNS

U svého registrátora:

- [ ] A záznam `auraguard` (nebo jak chceš) → veřejná IP instance
- [ ] Ověř z Macu: `dig +short auraguard.tvojedomena.cz`

Musí vracet tu IP **předtím**, než poprvé spustíš Caddy. Bez toho neprojde
ACME výzva a Caddy skončí chybou.

---

## Krok 7 — Dál podle `deploy/README.md`

Od kroku 4 („Systém") tam pokračuje instalace Dockeru, aplikace a proxy.

---

## Když kapacita není

Chybová hláška zní **„Out of host capacity"** nebo je Ampere záložka prázdná.
Ampere A1 se v Always Free uvolňuje nepravidelně.

Co pomáhá:

- **Zkoušej opakovaně**, klidně obden a v jinou denní dobu
- **Jiný availability domain** ve stejném regionu (AD-1 / AD-2 / AD-3,
  pokud je jich víc)
- **Menší instance:** 1 OCPU / 6 GB projde snáz než 2/12. Na Chromium to
  stačí, jen dej `MAX_CONCURRENT_BROWSERS=1`.

Co **nedělat**: přepnout na `VM.Standard.E2/E3/E4` a spol. Vypadají podobně,
ale jsou placené a účet se ti tiše překlopí.

Když kapacita nebude vůbec, je připravená záložní cesta — Cloud Run,
fáze 2 v `PLAN-DEPLOY.md`.

---

## Rychlá kontrola, že je vše správně

Po kroku 5, ještě než jdeš dál:

```bash
# architektura — musí být aarch64
uname -m

# paměť — musí sedět s tím, co jsi nastavil
free -g

# disk
df -h /

# je port zvenčí vidět? (spusť NA MACU, ne na serveru)
nc -zv <veřejná-ip> 22
```
