import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ipv4ToInt, cidrToRange, lookupCloudIp, rangesSnapshot, clearCache,
  ipv6ToBigInt, cidr6ToRange, bigIntNaHex, maIpv6Rozsahy,
  stariSnimkuDnu, jeSnimekZastaraly, SNIMEK_MAX_STARI_DNU, odmapujIpv4, loadRanges, RANGES_FALLBACK, zkontrolujStariSnimku,
} from '../cloud-ranges.js';
import { regionCountry, knownRegionCount } from '../cloud-regions.js';

/**
 * Rozsahy zveřejněné poskytovatelem cloudu.
 *
 * Vzniklo to kvůli nálezu na vlastní infrastruktuře: geolokační databáze
 * u adresy serveru v Azure Sweden Central vracela Spojené státy, protože
 * rozsah 4.0.0.0/8 koupil Microsoft od AT&T a snímek databáze to nevěděl.
 * Rozsah od poskytovatele je proti tomu údaj od toho, kdo o umístění
 * rozhoduje.
 *
 * Testy běží nad vymyšleným snímkem, ne nad staženými daty — jinak by
 * závisely na síti a na tom, co poskytovatel zrovna publikuje.
 */

let SNIMEK;

const rozsah = (p, cidr, r, svc) => {
  const { start, end, bits } = cidrToRange(cidr);
  return { p, cidr, s: start, e: end, b: bits, r, svc };
};

const rozsah6 = (p, cidr, r, svc) => {
  const { start, end, bits } = cidr6ToRange(cidr);
  return { p, cidr, s6: bigIntNaHex(start), e6: bigIntNaHex(end), b: bits, r, svc };
};

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-ranges-'));
  SNIMEK = path.join(dir, 'cloud-ranges.json');
  fs.writeFileSync(SNIMEK, JSON.stringify({
    generatedAt: '2026-09-09T00:00:00.000Z',
    sources: [{ provider: 'azure', url: 'https://example/tags.json', snapshot: 'changeNumber 1' }],
    ranges: [
      // Široký blok pro celý region a v něm užší pro konkrétní službu —
      // přesně tak to poskytovatelé publikují.
      rozsah('azure', '4.223.0.0/16', 'swedencentral', 'AzureCloud'),
      rozsah('azure', '4.223.166.0/24', 'swedencentral', 'AzureCloud'),
      rozsah('azure', '20.50.0.0/16', 'westeurope', 'AzureCloud'),
      rozsah('azure', '13.107.42.0/24', '', 'AzureFrontDoor.Frontend'),
      // Prázdný region u BĚŽNÉ služby — Azure vlastnost `region` u části
      // značek neuvádí. Není to anycast a nesmí přebít regionální rozsah
      // téže šířky.
      rozsah('azure', '20.50.0.0/16', '', 'AzureMonitor'),
      // Anycast a regionální rozsah na TÉMŽE prefixu. Vyhrát musí anycast.
      rozsah('aws', '3.29.57.0/26', 'me-central-1', 'CLOUDFRONT_ORIGIN_FACING'),
      rozsah('aws', '3.29.57.0/26', 'GLOBAL', 'CLOUDFRONT'),
      // Velmi široký blok — kdysi se kvůli pevnému stropu při zpětném
      // průchodu vůbec nenašel.
      rozsah('azure', '100.64.0.0/10', 'westeurope', 'AzureCloud'),
      rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2'),
      rozsah('aws', '52.86.0.0/16', 'us-east-1', 'EC2'),
      rozsah('aws', '18.160.0.0/15', 'GLOBAL', 'CLOUDFRONT'),
      rozsah('gcp', '34.140.0.0/14', 'europe-west1', 'Google Cloud'),
      // Region, který v mapě není — musí dát neprůkazné, ne odhad.
      rozsah('aws', '99.99.0.0/16', 'xx-nikde-1', 'EC2'),
    ],
    ranges6: [
      // Skutečné prefixy ze snímků poskytovatelů, ne vymyšlené adresy.
      rozsah6('aws', '2a05:d018::/36', 'eu-west-1', 'EC2'),
      rozsah6('aws', '2a05:d018:76c:b800::/56', 'eu-west-1', 'S3'),
      rozsah6('aws', '2600:9000::/28', 'GLOBAL', 'CLOUDFRONT'),
      rozsah6('azure', '2603:1020:1000::/44', 'northeurope', 'AzureCloud'),
      rozsah6('gcp', '2600:1900:4000::/44', 'us-central1', 'Google Cloud'),
    ],
  }), 'utf8');
});

beforeEach(() => clearCache());

describe('převod adres', () => {
  it('ipv4ToInt', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295);
    // 4·2²⁴ + 223·2¹⁶ + 166·2⁸ + 194
    expect(ipv4ToInt('4.223.166.194')).toBe(81766082);
  });

  it('nesmyslnou adresu odmítne', () => {
    for (const v of ['256.1.1.1', '1.2.3', 'text', '', null, '::1']) {
      expect(ipv4ToInt(v)).toBeNull();
    }
  });

  it('cidrToRange aplikuje masku', () => {
    // `1.2.3.5/24` znamená `1.2.3.0/24`; zápis s bity za maskou je
    // v datech poskytovatelů běžný.
    expect(cidrToRange('1.2.3.5/24')).toEqual(cidrToRange('1.2.3.0/24'));
    expect(cidrToRange('1.2.3.0/24').end - cidrToRange('1.2.3.0/24').start).toBe(255);
  });

  it('vadný zápis odmítne', () => {
    for (const v of ['1.2.3.0/33', '1.2.3.0/-1', '1.2.3.0', 'x/24', null]) {
      expect(cidrToRange(v)).toBeNull();
    }
  });
});

describe('vyhledání adresy', () => {
  it('adresa vlastního serveru se pozná i se zemí', () => {
    // Přesně ten případ, kvůli kterému modul vznikl. Geolokační databáze
    // u téhle adresy tvrdí US; poskytovatel říká Sweden Central.
    const r = lookupCloudIp('4.223.166.194', SNIMEK);
    expect(r.provider).toBe('azure');
    expect(r.region).toBe('swedencentral');
    expect(r.country).toBe('SE');
    expect(r.anycast).toBe(false);
  });

  it('vyhraje nejužší rozsah, ne první nalezený', () => {
    // Adresa leží v /16 i v /24 zároveň; ten užší nese přesnější údaj.
    expect(lookupCloudIp('4.223.166.194', SNIMEK).prefix).toBe('4.223.166.0/24');
    expect(lookupCloudIp('4.223.10.1', SNIMEK).prefix).toBe('4.223.0.0/16');
  });

  it('pozná AWS i Google', () => {
    expect(lookupCloudIp('52.30.1.1', SNIMEK).country).toBe('IE');
    expect(lookupCloudIp('52.86.1.1', SNIMEK).country).toBe('US');
    expect(lookupCloudIp('34.140.1.1', SNIMEK).country).toBe('BE');
  });

  it('anycast služba zemi neurčuje', () => {
    // CloudFront i Front Door odpovídají z nejbližšího uzlu — region
    // v datech neříká, kde data leží.
    const cf = lookupCloudIp('18.160.1.1', SNIMEK);
    expect(cf.anycast).toBe(true);
    expect(cf.country).toBeNull();

    const fd = lookupCloudIp('13.107.42.1', SNIMEK);
    expect(fd.anycast).toBe(true);
    expect(fd.country).toBeNull();
  });

  it('neznámý region dá zemi null, ne odhad', () => {
    const r = lookupCloudIp('99.99.1.1', SNIMEK);
    expect(r.provider).toBe('aws');
    expect(r.region).toBe('xx-nikde-1');
    expect(r.country).toBeNull();
  });

  it('adresa mimo všechny rozsahy nic nevrátí', () => {
    expect(lookupCloudIp('195.113.144.194', SNIMEK)).toBeNull();
  });

  it('IPv6 a nesmysly nespadnou', () => {
    for (const v of ['2a01:4f8::1', 'text', '', null, undefined]) {
      expect(lookupCloudIp(v, SNIMEK)).toBeNull();
    }
  });

  it('chybějící snímek není chyba', () => {
    // Repozitář musí jít naklonovat a spustit i bez staženého snímku.
    expect(lookupCloudIp('4.223.166.194', '/neexistuje/nikde.json')).toBeNull();
  });
});

describe('doložitelnost snímku', () => {
  it('vrací datum, zdroje i počet', () => {
    const s = rangesSnapshot(SNIMEK);
    expect(s.generatedAt).toBe('2026-09-09T00:00:00.000Z');
    expect(s.count).toBe(13);
    expect(s.sources[0].provider).toBe('azure');
  });
});

describe('mapa regionů', () => {
  it('evropský region neznamená automaticky EHP', () => {
    // Nejnebezpečnější past celého převodu: `eu-west-2` je Londýn a
    // `europe-west2` taky. Odvozovat zemi z prefixu „eu-" by u přenosu
    // do Spojeného království vyrobilo falešné „v pořádku".
    expect(regionCountry('aws', 'eu-west-2')).toBe('GB');
    expect(regionCountry('gcp', 'europe-west2')).toBe('GB');
    expect(regionCountry('azure', 'uksouth')).toBe('GB');
    expect(regionCountry('azure', 'switzerlandnorth')).toBe('CH');
    expect(regionCountry('aws', 'eu-central-2')).toBe('CH');
  });

  it('skutečné evropské regiony sedí', () => {
    expect(regionCountry('aws', 'eu-west-1')).toBe('IE');
    expect(regionCountry('aws', 'eu-north-1')).toBe('SE');
    expect(regionCountry('azure', 'swedencentral')).toBe('SE');
    expect(regionCountry('azure', 'westeurope')).toBe('NL');
    expect(regionCountry('gcp', 'europe-west1')).toBe('BE');
  });

  it('velikost písmen nerozhoduje', () => {
    expect(regionCountry('azure', 'SwedenCentral')).toBe('SE');
    expect(regionCountry('AWS', 'EU-WEST-1')).toBe('IE');
  });

  it('neznámý region ani poskytovatel nedají odhad', () => {
    expect(regionCountry('aws', 'neexistuje')).toBeNull();
    expect(regionCountry('nikdo', 'eu-west-1')).toBeNull();
    expect(regionCountry(null, null)).toBeNull();
  });

  it('mapa není prázdná', () => {
    expect(knownRegionCount()).toBeGreaterThan(100);
  });
});

describe('globální rozsahy a zkrácené názvy', () => {
  it('region „GLOBAL" znamená anycast, ne neznámou zemi', () => {
    // Rozdíl je v příčině: tady nejde o mezeru v naší tabulce, ale o to,
    // že takový rozsah žádné konkrétní místo nemá.
    expect(regionCountry('aws', 'GLOBAL')).toBeNull();
    expect(regionCountry('gcp', 'global')).toBeNull();
  });

  it('identifikátory Azure mají zemi tam, kde ji nesou v názvu', () => {
    // Dřív tu stálo porovnání dvou položek TÉŽE mapy — test, který nemohl
    // selhat, ať byla mapa jakákoli, a neověřoval nic. Ověřovat se má
    // hodnota, ne shoda s jinou hodnotou z téhož zdroje.
    expect(regionCountry('azure', 'germanywc')).toBe('DE');
    expect(regionCountry('azure', 'germanyn')).toBe('DE');
    expect(regionCountry('azure', 'norwaye')).toBe('NO');
    expect(regionCountry('azure', 'centralfrance')).toBe('FR');
    // Švýcarsko v EHP NENÍ — chyba tímhle směrem by zamlčela přenos
    // do třetí země.
    expect(regionCountry('azure', 'switzerlandn')).toBe('CH');
    expect(regionCountry('azure', 'switzerlandw')).toBe('CH');
  });

  it('ap-east-2 je Tchaj-wan, ne Hongkong', () => {
    // Původně tu bylo HK odvozené z podobnosti s `ap-east-1`. Dokumentace
    // AWS uvádí Asia Pacific (Taipei). Verdikt o EHP se tím nemění, ale
    // zpráva pro úřad tvrdila nesprávnou zemi — a tvrzení o zemi je jádro
    // celého výstupu.
    expect(regionCountry('aws', 'ap-east-1')).toBe('HK');
    expect(regionCountry('aws', 'ap-east-2')).toBe('TW');
  });

  it('ap-southeast-6 je Nový Zéland, ne neznámý region', () => {
    // Tenhle test dřív tvrdil opak a tím mezeru v mapě povyšoval na záměr.
    // Region je přitom v dokumentaci AWS a ve snímku má 62 rozsahů —
    // adresa v něm propadala na geolokaci, která ji řadila do Polska.
    expect(regionCountry('aws', 'ap-southeast-6')).toBe('NZ');
  });

  it('regiony bez doloženého umístění zůstávají neprůkazné', () => {
    // Tyhle v dokumentaci poskytovatele NEJSOU (ověřeno 18. 9. 2026)
    // a jméno země v sobě nenesou. Odhadnout u evropského regionu zemi
    // by znamenalo tvrdit něco o EHP bez podkladu.
    expect(regionCountry('gcp', 'europe-west15')).toBeNull();
    expect(regionCountry('aws', 'me-west-1')).toBeNull();
    expect(regionCountry('aws', 'sa-west-1')).toBeNull();
    expect(regionCountry('azure', 'northeurope2')).toBeNull();
  });

  it('asia-southeast3 UŽ doložený je — Bangkok', () => {
    // TENHLE TEST TVRDIL OPAK, a měl pravdu jen do chvíle, než se to
    // dohledalo. Cementoval mezeru („zemi neznáme") jako pravidlo
    // („zemi nemá"), což jsou dvě různé věci — a ta záměna je přesně
    // to, čemu se celý nástroj vyhýbá.
    //
    // „asia-southeast3-a  Bangkok, Thailand, APAC" — tabulka zón,
    // https://cloud.google.com/compute/docs/regions-zones
    expect(regionCountry('gcp', 'asia-southeast3')).toBe('TH');
  });
});


/**
 * Nálezy z recenze nového modulu.
 *
 * Všechny tři vznikly tím, že o výsledku rozhodovalo pořadí prvků v poli
 * nebo pevný strop — tedy náhoda, ne pravidlo.
 */
describe('rozhodovat musí pravidlo, ne pořadí v poli', () => {
  it('anycast na témže prefixu přebije regionální údaj', () => {
    // Ověřeno nad skutečným snímkem: ve 120 bodech dostala adresa krytá
    // službou CloudFront zemi, protože při shodě šířky vyhrál ten rozsah,
    // na který se narazilo dřív.
    const r = lookupCloudIp('3.29.57.5', SNIMEK);
    expect(r.anycast).toBe(true);
    expect(r.country).toBeNull();
  });

  it('rozsah bez regionu nepřebije ten s regionem', () => {
    // Ve 3 510 bodech vyhrála prázdná varianta a adresa se vrátila jako
    // „běží za CDN" — nezměřené tvrzení o topologii sítě u služby, která
    // CDN není.
    const r = lookupCloudIp('20.50.1.1', SNIMEK);
    expect(r.anycast).toBe(false);
    expect(r.region).toBe('westeurope');
    expect(r.country).toBe('NL');
  });

  it('velmi široký blok se najde i tak', () => {
    // Pevný strop 4000 položek při zpětném průchodu už dnes nestačil —
    // u bloku 20.192.0.0/10 je potřeba 5479 kroků. Adresy v něm vycházely
    // jako nenalezené. Hledá se nově podle největšího rozsahu ve snímku.
    const r = lookupCloudIp('100.90.1.1', SNIMEK);
    expect(r).not.toBeNull();
    expect(r.country).toBe('NL');
  });
});

/**
 * IPv6.
 *
 * Modul uměl jen IPv4 a komentář to přiznával jako omezení. Jenže to
 * omezení není neutrální: Chromium na dvoustohovém stroji volí IPv6
 * (Happy Eyeballs), takže `response.serverAddr()` vrátí IPv6 a korekce
 * podle rozsahů poskytovatele se neuplatní ANI JEDNOU. Verdikt pak stojí
 * na geolokační databázi — na zdroji, jehož selhávání u cloudových adres
 * je důvodem existence celého modulu.
 */
describe('IPv6', () => {
  describe('převod adresy', () => {
    it('plný i zkrácený zápis dají totéž', () => {
      const plny = ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001');
      expect(ipv6ToBigInt('2001:db8::1')).toBe(plny);
      expect(plny).toBe(0x20010db8000000000000000000000001n);
    });

    it('krajní hodnoty', () => {
      expect(ipv6ToBigInt('::')).toBe(0n);
      expect(ipv6ToBigInt('::1')).toBe(1n);
      expect(ipv6ToBigInt('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'))
        .toBe((1n << 128n) - 1n);
    });

    it('hranaté závorky z URL a zónu z linkové adresy odřízne', () => {
      expect(ipv6ToBigInt('[2001:db8::1]')).toBe(ipv6ToBigInt('2001:db8::1'));
      expect(ipv6ToBigInt('fe80::1%eth0')).toBe(ipv6ToBigInt('fe80::1'));
    });

    it('koncovku v zápisu IPv4 převede', () => {
      // ::ffff:1.2.3.4 — adresa IPv4 namapovaná do IPv6.
      expect(ipv6ToBigInt('::ffff:1.2.3.4')).toBe(0xffff01020304n);
    });

    it('vadný zápis odmítne, nedopočítává', () => {
      for (const v of [
        '2001:db8::1::2',      // dvě zkrácení — nejednoznačné
        '2001:db8:0:0:0:0:1',  // sedm skupin bez `::`
        'gggg::1',             // nešestnáctkové
        '12345::1',            // skupina delší než čtyři znaky
        '1.2.3.4', 'text', '', null, undefined,
      ]) {
        expect(ipv6ToBigInt(v)).toBeNull();
      }
    });

    it('`::` musí zkracovat aspoň jednu skupinu', () => {
      // Osm skupin a k tomu `::` — zápis je neplatný a dopočítat ho
      // znamená vymyslet adresu, která v něm není.
      expect(ipv6ToBigInt('1:2:3:4:5:6:7:8::')).toBeNull();
    });
  });

  describe('rozklad CIDR', () => {
    it('maskuje bity za prefixem', () => {
      // AWS i Azure publikují prefixy s nenulovými bity za maskou.
      const r = cidr6ToRange('2a05:d018:76c:b8ff::/56');
      expect(r.start).toBe(ipv6ToBigInt('2a05:d018:76c:b800::'));
      expect(r.end).toBe(ipv6ToBigInt('2a05:d018:76c:b8ff:ffff:ffff:ffff:ffff'));
    });

    it('/0 i /128', () => {
      expect(cidr6ToRange('::/0')).toEqual({ start: 0n, end: (1n << 128n) - 1n, bits: 0 });
      const jedna = cidr6ToRange('2001:db8::1/128');
      expect(jedna.start).toBe(jedna.end);
    });

    it('nesmysl odmítne', () => {
      for (const v of ['2001:db8::/129', '2001:db8::/-8', '2001:db8::', '1.2.3.0/24', '']) {
        expect(cidr6ToRange(v)).toBeNull();
      }
    });
  });

  describe('vyhledání ve snímku', () => {
    it('adresa v regionálním rozsahu dostane zemi', () => {
      const v = lookupCloudIp('2603:1020:1000::5', SNIMEK);
      expect(v.provider).toBe('azure');
      expect(v.region).toBe('northeurope');
      expect(v.country).toBe('IE');
      expect(v.anycast).toBe(false);
    });

    it('užší rozsah přebíjí širší, stejně jako u IPv4', () => {
      const v = lookupCloudIp('2a05:d018:76c:b800::1', SNIMEK);
      expect(v.prefix).toBe('2a05:d018:76c:b800::/56');
      expect(v.country).toBe('IE');
    });

    it('anycast nedostane zemi', () => {
      const v = lookupCloudIp('2600:9000:1234::1', SNIMEK);
      expect(v.anycast).toBe(true);
      expect(v.country).toBeNull();
    });

    it('adresa mimo všechny rozsahy je nenalezená', () => {
      expect(lookupCloudIp('2001:db8::1', SNIMEK)).toBeNull();
    });

    it('IPv4 a IPv6 se nepletou', () => {
      // Kdyby se obě rodiny držely v jednom poli, porovnání `Number`
      // s `BigInt` by tiše selhalo nebo by adresa dostala cizí region.
      expect(lookupCloudIp('4.223.166.194', SNIMEK).region).toBe('swedencentral');
      expect(lookupCloudIp('2603:1020:1000::5', SNIMEK).region).toBe('northeurope');
    });
  });

  it('snímek hlásí, jestli IPv6 vůbec obsahuje', () => {
    expect(maIpv6Rozsahy(SNIMEK)).toBe(true);
    expect(rangesSnapshot(SNIMEK).count6).toBe(5);
  });

  it('starý snímek bez klíče ranges6 se načte a přizná, že IPv6 nezná', () => {
    // Snímek v repozitáři je zatím starého tvaru a regeneruje ho člověk.
    // Modul na něm nesmí spadnout — a hlavně nesmí tvrdit, že IPv6 pokrývá.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-stary-'));
    const soubor = path.join(dir, 'cloud-ranges.json');
    fs.writeFileSync(soubor, JSON.stringify({
      generatedAt: '2026-01-01T00:00:00.000Z',
      sources: [],
      ranges: [rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2')],
    }), 'utf8');

    clearCache();
    expect(maIpv6Rozsahy(soubor)).toBe(false);
    expect(lookupCloudIp('2603:1020:1000::5', soubor)).toBeNull();
    // IPv4 funguje dál beze změny.
    expect(lookupCloudIp('52.30.1.1', soubor).country).toBe('IE');
  });
});

/**
 * STÁŘÍ SNÍMKU.
 *
 * Kontrolovala se jen existence. Když snímek BYL, ale byl starý, vyslovil
 * se verdikt „server v EU/EHP" nebo „mimo EU/EHP" se stejnou jistotou
 * jako nad čerstvými daty. Zastaralý snímek přitom selhává dvěma způsoby
 * a ten druhý je tichý:
 *   • nový rozsah v něm chybí → adresa spadne na geolokaci, tedy na
 *     zdroj, kvůli kterému tenhle modul vznikl,
 *   • rozsah mezitím přešel do jiného regionu → vyjde CIZÍ ZEMĚ, a to
 *     s plnou jistotou.
 *
 * Práh 90 dnů je odvozený ze snímku samotného: Azure publikuje
 * `ServiceTags_Public_RRRRMMDD.json` týdně, AWS mění `createDate`
 * řádově denně. Devadesát dnů je tedy kolem třinácti zmeškaných revizí.
 */
describe('stáří snímku', () => {
  const DEN = 86400000;
  const kdy = (iso) => Date.parse(iso);

  it('čerstvý snímek verdikt nese', () => {
    // SNIMEK má generatedAt 2026-09-09.
    const ted = kdy('2026-09-20T00:00:00Z');
    expect(stariSnimkuDnu(SNIMEK, ted)).toBe(11);
    expect(jeSnimekZastaraly(SNIMEK, ted)).toBe(false);
  });

  it('přesně na prahu ještě prochází', () => {
    const ted = kdy('2026-09-09T00:00:00.000Z') + SNIMEK_MAX_STARI_DNU * DEN;
    expect(stariSnimkuDnu(SNIMEK, ted)).toBe(SNIMEK_MAX_STARI_DNU);
    expect(jeSnimekZastaraly(SNIMEK, ted)).toBe(false);
  });

  it('den za prahem už ne', () => {
    const ted = kdy('2026-09-09T00:00:00.000Z') + (SNIMEK_MAX_STARI_DNU + 1) * DEN;
    expect(jeSnimekZastaraly(SNIMEK, ted)).toBe(true);
  });

  it('snímek BEZ data je zastaralý, ne čerstvý', () => {
    // Neposouditelný podklad nesmí nést tvrzení o rezidenci.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-bezdata-'));
    const soubor = path.join(dir, 'cloud-ranges.json');
    fs.writeFileSync(soubor, JSON.stringify({
      sources: [],
      ranges: [rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2')],
    }), 'utf8');
    clearCache();
    expect(stariSnimkuDnu(soubor)).toBeNull();
    expect(jeSnimekZastaraly(soubor)).toBe(true);
  });

  it('prázdný snímek NENÍ zastaralý — to je jiná situace', () => {
    // „Snímek není k dispozici" má vlastní hlášku; prohlásit ho navíc za
    // zastaralý by čtenáři naservírovalo dvě různá vysvětlení téhož.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-prazdny-'));
    const soubor = path.join(dir, 'cloud-ranges.json');
    fs.writeFileSync(soubor, JSON.stringify({ sources: [], ranges: [] }), 'utf8');
    clearCache();
    expect(jeSnimekZastaraly(soubor)).toBe(false);
  });

  it('datum v budoucnosti nedá záporné stáří', () => {
    const ted = kdy('2026-01-01T00:00:00Z');
    expect(stariSnimkuDnu(SNIMEK, ted)).toBe(0);
    expect(jeSnimekZastaraly(SNIMEK, ted)).toBe(false);
  });
});

/**
 * ADRESA IPv4 ZAPSANÁ JAKO IPv6.
 *
 * `::ffff:4.223.166.194` je podle RFC 4291 §2.5.5.2 tentýž hostitel jako
 * `4.223.166.194`. Podle dvojtečky by se ale hledala mezi rozsahy IPv6,
 * kde prefixy `::ffff:/96` nikdo nepublikuje — výsledek `null`, a adresa
 * by spadla na geolokační databázi, tedy na zdroj, kvůli kterému tenhle
 * modul vznikl. Nález z kontrolní vlny.
 */
describe('IPv4 mapovaná do IPv6', () => {
  it('tečkový i šestnáctkový zápis vedou na týž region', () => {
    // 4.223.166.194 = 0x04DFA6C2
    const tecka = lookupCloudIp('4.223.166.194', SNIMEK);
    expect(tecka.region).toBe('swedencentral');
    expect(lookupCloudIp('::ffff:4.223.166.194', SNIMEK).region).toBe('swedencentral');
    expect(lookupCloudIp('::ffff:4df:a6c2', SNIMEK).region).toBe('swedencentral');
  });

  it('odmapuje jen prefix ::ffff:/96, nic jiného', () => {
    expect(odmapujIpv4('::ffff:4.223.166.194')).toBe('4.223.166.194');
    expect(odmapujIpv4('::ffff:4df:a6c2')).toBe('4.223.166.194');
    // Sousední prefix NENÍ mapovaná adresa.
    expect(odmapujIpv4('::fff0:1')).toBe('::fff0:1');
    // Skutečná adresa IPv6 se nemění.
    expect(odmapujIpv4('2603:1020:1000::5')).toBe('2603:1020:1000::5');
    // Tečkový zápis projde beze změny.
    expect(odmapujIpv4('4.223.166.194')).toBe('4.223.166.194');
  });

  it('skutečná adresa IPv6 se nesmí hledat mezi rozsahy IPv4', () => {
    // Opačný směr téže chyby.
    expect(lookupCloudIp('2603:1020:1000::5', SNIMEK).provider).toBe('azure');
    expect(lookupCloudIp('2a05:d018::1', SNIMEK).country).toBe('IE');
  });
});

/**
 * OBNOVA SNÍMKU MUSÍ BÝT VIDĚT BEZ RESTARTU.
 *
 * Nález z kontrolní vlny. Cache byla klíčovaná jen jménem souboru,
 * takže se snímek načetl při prvním skenu a držel se do restartu
 * procesu. Týdenní obnova přes systemd timer tím byla k ničemu: soubor
 * na disku svěží, běžící kontejner pracoval se starým. Tři komentáře
 * přitom tvrdily, že „běžící aplikace ho vidí hned".
 */
describe('cache snímku respektuje změnu souboru', () => {
  it('novější soubor se načte znovu, ne z paměti', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-cache-'));
    const soubor = path.join(dir, 'cloud-ranges.json');
    const zapis = (ranges) => fs.writeFileSync(soubor, JSON.stringify({
      generatedAt: '2026-09-19T00:00:00.000Z', sources: [], ranges,
    }), 'utf8');

    clearCache();
    zapis([rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2')]);
    expect(rangesSnapshot(soubor).count).toBe(1);

    // Obnova: jiný obsah, novější čas změny. BEZ clearCache().
    zapis([
      rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2'),
      rozsah('azure', '4.223.0.0/16', 'swedencentral', 'AzureCloud'),
    ]);
    const pozdeji = new Date(Date.now() + 2000);
    fs.utimesSync(soubor, pozdeji, pozdeji);

    expect(rangesSnapshot(soubor).count).toBe(2);
    // A nová adresa se skutečně najde — nejen že se změnil počet.
    expect(lookupCloudIp('4.223.1.1', soubor).region).toBe('swedencentral');
  });

  it('nezměněný soubor se ze souboru nečte znovu', () => {
    // Cache má pořád smysl: snímek má 15 MB a čte se při každém skenu.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-cache2-'));
    const soubor = path.join(dir, 'cloud-ranges.json');
    fs.writeFileSync(soubor, JSON.stringify({
      generatedAt: '2026-09-19T00:00:00.000Z', sources: [],
      ranges: [rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2')],
    }), 'utf8');

    clearCache();
    const prvni = loadRanges(soubor);
    expect(loadRanges(soubor)).toBe(prvni); // TOTOŽNÝ objekt, ne kopie
  });
});

/**
 * VÝCHOZÍ vs. ŽIVÝ SNÍMEK.
 *
 * Živý snímek přepisuje týdenní obnova, takže verzovaný být nesmí:
 * pracovní kopie na produkci by byla trvale špinavá, `git pull` by
 * odmítl přepsat lokální změnu a obvyklá reakce (`git checkout -- data/`)
 * by potichu vrátila STARŠÍ commitnutý snímek. Verzovaný je proto jen
 * výchozí snímek, aby čerstvý klon nezůstal bez rozsahů.
 */
describe('zdroj snímku', () => {
  it('čerstvý klon má rozsahy z výchozího snímku', () => {
    // Na čerstvém klonu živý soubor neexistuje. Tady sáhneme po tom,
    // co v repozitáři JE, a ověříme, že se z něj dá číst.
    clearCache();
    expect(fs.existsSync(RANGES_FALLBACK)).toBe(true);
    const zRepozitare = rangesSnapshot(RANGES_FALLBACK);
    expect(zRepozitare.count).toBeGreaterThan(1000);
    expect(zRepozitare.generatedAt).toBeTruthy();
  });

  it('výchozí snímek NENÍ prázdný ani zkušební', () => {
    // Kdyby se do repozitáře dostal osekaný soubor, čerstvý klon by
    // mlčky spadl na geolokaci — tedy na zdroj, kvůli kterému tenhle
    // modul vznikl.
    clearCache();
    expect(lookupCloudIp('4.223.166.194', RANGES_FALLBACK)?.country).toBe('SE');
  });

  it('když živý snímek existuje, má přednost', () => {
    // Nelze to zkoušet přes RANGES_FILE (závisí na stroji), takže se
    // testuje pravidlo: explicitně zadaná cesta se respektuje.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-zdroj-'));
    const zivy = path.join(dir, 'cloud-ranges.json');
    fs.writeFileSync(zivy, JSON.stringify({
      generatedAt: '2026-09-19T00:00:00.000Z', sources: [],
      ranges: [rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2')],
    }), 'utf8');
    clearCache();
    expect(rangesSnapshot(zivy).count).toBe(1);
  });
});

/**
 * VAROVÁNÍ O STÁRNOUCÍM SNÍMKU.
 *
 * Na selhání týdenní obnovy se jinak nepřijde: timer má
 * `Persistent=true`, takže po chybě tiše zkusí znovu, a v repozitáři
 * není `OnFailure=` ani napojení na hlášení. Viditelný důsledek by
 * přišel až po 90 dnech, a i to jen jako CHYBĚJÍCÍ výsledek u rezidence.
 * Nález z kontrolní vlny.
 */
describe('varování o stárnoucím snímku', () => {
  const snimekSDatem = (isoDatum) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-vek-'));
    const soubor = path.join(dir, 'cloud-ranges.json');
    fs.writeFileSync(soubor, JSON.stringify({
      generatedAt: isoDatum, sources: [],
      ranges: [rozsah('aws', '52.30.0.0/16', 'eu-west-1', 'EC2')],
    }), 'utf8');
    clearCache();
    return soubor;
  };
  const dnuZpet = (n) => new Date(Date.now() - n * 86400000).toISOString();

  it('čerstvý snímek mlčí', () => {
    const hlasky = [];
    expect(zkontrolujStariSnimku((m) => hlasky.push(m), snimekSDatem(dnuZpet(3))))
      .toBe('v-poradku');
    expect(hlasky).toHaveLength(0);
  });

  it('po 30 dnech se ozve, i když verdikt ještě platí', () => {
    // Čtyři zmeškané obnovy. Na výpadek jednoho týdne to nereaguje,
    // na rozbitou úlohu ano — a zbývá dvouměsíční rezerva.
    const hlasky = [];
    expect(zkontrolujStariSnimku((m) => hlasky.push(m), snimekSDatem(dnuZpet(45))))
      .toBe('stárne');
    expect(hlasky[0]).toMatch(/45 dnů/);
    expect(hlasky[0]).toMatch(/auraguard-ranges\.timer/);
  });

  it('po prahu řekne, že rezidence UŽ nevychází', () => {
    const hlasky = [];
    expect(zkontrolujStariSnimku((m) => hlasky.push(m), snimekSDatem(dnuZpet(120))))
      .toBe('zastaraly');
    expect(hlasky[0]).toMatch(/UŽ NEVYCHÁZÍ/);
  });

  it('snímek bez data se taky ozve', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-vek2-'));
    const soubor = path.join(dir, 'cloud-ranges.json');
    fs.writeFileSync(soubor, JSON.stringify({ sources: [], ranges: [] }), 'utf8');
    clearCache();
    const hlasky = [];
    expect(zkontrolujStariSnimku((m) => hlasky.push(m), soubor)).toBe('bez-data');
    expect(hlasky[0]).toMatch(/neuvádí datum/);
  });
});
