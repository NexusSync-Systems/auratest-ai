import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ipv4ToInt, cidrToRange, lookupCloudIp, rangesSnapshot, clearCache,
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
    // Tyhle nikde doložené nejsou a jméno země v sobě nenesou. Odhadnout
    // u evropského regionu zemi by znamenalo tvrdit něco o EHP bez
    // podkladu.
    expect(regionCountry('gcp', 'europe-west15')).toBeNull();
    expect(regionCountry('gcp', 'asia-southeast3')).toBeNull();
    expect(regionCountry('aws', 'me-west-1')).toBeNull();
    expect(regionCountry('aws', 'sa-west-1')).toBeNull();
    expect(regionCountry('azure', 'northeurope2')).toBeNull();
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
