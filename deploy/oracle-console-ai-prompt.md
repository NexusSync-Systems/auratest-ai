# Prompt pro OCI Console AI

Console AI je konverzační rozhraní v konzoli Oracle Cloud (od července 2026
v preview). Umí zdroje i vytvářet — každou změnu ale musíš ručně schválit
a běží pod tvými IAM oprávněními.

**Kde:** konzole OCI → ikona Console AI v horní liště.

Prompt je **anglicky** schválně: rozhraní je na angličtinu stavěné a názvy
zdrojů (`VM.Standard.A1.Flex`, `Always Free`) jsou stejně anglicky.

---

## Prompt — zkopíruj celé

```
Create an Always Free eligible setup for a Docker web application. I need:

1. A VCN named "auraguard-vcn" with CIDR 10.0.0.0/16, an internet gateway,
   and a public regional subnet 10.0.1.0/24 with a route rule 0.0.0.0/0 to
   the internet gateway.

2. Security list ingress rules on that subnet, all stateful, source 0.0.0.0/0:
   - TCP port 22  (SSH)
   - TCP port 80  (HTTP, needed for Let's Encrypt ACME challenge)
   - TCP port 443 (HTTPS)
   Do NOT open any other port. Keep the default egress rule.

3. A compute instance named "auraguard":
   - Shape VM.Standard.A1.Flex with 2 OCPUs and 12 GB memory
     (this is the Always Free maximum for Ampere A1)
   - Image: Canonical Ubuntu 22.04 LTS, aarch64 build
   - Boot volume 50 GB
   - Placed in the public subnet above, with a public IPv4 address assigned
   - My SSH public key for user "ubuntu"

Confirm everything stays within the Always Free tier and show me the
estimated monthly cost before creating anything. If Ampere A1 capacity is
unavailable in this region, tell me instead of silently switching to a paid
shape.
```

---

## Co po něm zkontrolovat

Console AI ti dá změny ke schválení. Než klikneš, projdi tohle — jsou to
věci, na kterých se nasazení buď zasekne, nebo tě začne stát peníze:

- [ ] **Tvar je `VM.Standard.A1.Flex`, ne `VM.Standard.E*`.**
      E-tvary jsou x86 a **placené**. Když Ampere kapacita není, je to
      nejpravděpodobnější tichá záměna.
- [ ] **2 OCPU / 12 GB.** Víc už do Always Free nespadá (do června 2026 to
      bylo 4/24, pak Oracle limit půlil).
- [ ] **Image je aarch64.** Na A1 nic jiného nepoběží.
- [ ] **Odhad ceny je 0.** Cokoli jiného znamená, že něco vypadlo z Always Free.
- [ ] **Otevřené jsou jen porty 22, 80 a 443.** Port 3001 tam být nesmí —
      aplikace poslouchá na loopbacku a patří za proxy.
- [ ] Instance má **veřejnou IPv4**.

## Co Console AI udělat NEMŮŽE

Tohle zůstává na tobě, protože je to mimo dosah OCI API:

1. **Pravidla iptables uvnitř instance.** Ubuntu image od Oracle má vlastní
   restriktivní firewall nad rámec Security Listu. Bez tohohle kroku porty
   nefungují, přestože je v konzoli pravidlo vidět — a hledá se to blbě:

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

2. **DNS A záznam** na veřejnou IP. Musí platit **před** prvním startem Caddy,
   jinak neprojde ACME výzva.

3. **Vlastní nasazení aplikace** — od kroku 4 v `deploy/README.md`.

---

## Když Console AI není k dispozici

Je v preview, takže nemusí být ve tvém regionu ani v tenancy. Deterministická
náhrada je **Cloud Shell** (ikona `>_` v konzoli, běží v prohlížeči a má OCI
CLI už nastavené):

```bash
# Zjisti si OCID kompartmentu a vlož ho níž
oci iam compartment list --all --query "data[?name=='<jméno>'].id" --raw-output

# Dostupné Ampere tvary a jestli je kapacita
oci compute shape list -c <compartment-ocid> --query "data[?shape=='VM.Standard.A1.Flex']"

# OCID obrazu Ubuntu 22.04 pro aarch64
oci compute image list -c <compartment-ocid> \
  --operating-system "Canonical Ubuntu" \
  --operating-system-version "22.04" \
  --shape VM.Standard.A1.Flex \
  --query "data[0].id" --raw-output
```

Zbytek (VCN, subnet, instance) se přes CLI klikne o dost pracněji než
v konzoli. Pokud Console AI nemáš, doporučuju to prostě naklikat podle
kroků 1–3 v `deploy/README.md` — je to jednorázová práce na deset minut.

---

## Poznámka k „Out of host capacity"

Nejčastější zádrhel u Always Free. Ampere A1 se uvolňuje nepravidelně, takže:

- zkoušej opakovaně, klidně obden
- zkus jiný availability domain ve stejném regionu
- **nepřepínej na placený tvar jen proto, aby to prošlo** — proto je ta věta
  v promptu

Když kapacita nebude vůbec, je připravená záložní cesta: Cloud Run,
fáze 2 v `PLAN-DEPLOY.md`.
