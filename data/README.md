# Datové snímky

Sem patří data, ze kterých skener vychází a která **nejsou** kód: momentky
z vnějších zdrojů, u nichž záleží na tom, kdy vznikly.

## `cloud-ranges.json`

IP rozsahy zveřejněné poskytovateli cloudu (AWS, Azure, Google Cloud)
s regionem u každého rozsahu.

Obnovit:

```
npm run update:cloud-ranges
```

Skript potřebuje přístup na internet. Azure zveřejňuje soubor pod adresou
s datem, která se každé pondělí mění — skript zkusí několik posledních
pondělků, a když neuspěje, dá se soubor stáhnout ručně a předat přes
`--azure-file`.

### Proč se to commituje

Sken pak běží offline a je **reprodukovatelný**: týž audit dá stejný
výsledek i za rok. To záznam auditů vyžaduje. Kdyby se rozsahy stahovaly
během skenu, závisel by výsledek na tom, co zrovna bylo na internetu, a
nikdo by to nedoložil.

Soubor je velký (jednotky MB) a mění se řádově měsíčně. Je to cena za to,
že podklad k tvrzení o umístění serveru je součástí repozitáře a má datum.

### Když soubor chybí

Není to chyba. Sken sáhne po geolokační databázi a v textu u výsledku
uvede, že snímek k dispozici nebyl. U cloudových adres to ale znamená, že
rezidenci nepotvrdí — geolokační databáze u nich často neurčí nic.
