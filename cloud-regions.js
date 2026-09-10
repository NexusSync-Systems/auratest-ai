/**
 * Převod názvu cloudového regionu na zemi.
 *
 * PROČ TO STOJÍ ZA VLASTNÍ SOUBOR
 * Tohle je místo, kde vzniká důkazní tvrzení. Když nástroj napíše
 * „server je v Irsku", opírá se právě o tenhle převod — o to, že region
 * `eu-west-1` znamená datové centrum v Irsku. Zdrojem je dokumentace
 * poskytovatele, ne odhad z názvu.
 *
 * PROČ SE NEHÁDÁ ZE ZEMĚPISNÉHO PREFIXU
 * Nabízelo by se číst prefix: `eu-` je Evropa, `us-` Amerika. Jenže
 * „Evropa" není země a GDPR se ptá na zemi, respektive na to, jestli je
 * v EHP. `eu-west-1` je Irsko, `eu-west-2` Londýn — tedy Spojené
 * království, které v EHP NENÍ. Kdo by to odvodil z prefixu, vyrobil by
 * falešné „v pořádku" u přenosu do třetí země. Proto výčet.
 *
 * ROZDÍL PROTI NÁZVU, KTERÝ ZEMI OBSAHUJE
 * Něco jiného je identifikátor, do kterého poskytovatel jméno země přímo
 * napsal: `germanywc`, `norwaye`, `switzerlandn`, `eusc-de-east-1`. Tam
 * se nic neodvozuje ze zeměpisné oblasti — čte se to, co poskytovatel
 * sám pojmenoval. Azure má dva německé regiony a oba jsou v Německu, tedy
 * i kdyby se pletlo, KTERÝ z nich to je, ZEMĚ zůstává správná. A o zemi
 * tu jde.
 *
 * Tyhle položky jsou níž označené, protože Microsoft zkrácené tvary ve
 * svém seznamu regionů neuvádí — v datech o rozsazích je ale používá
 * výhradně je, plné názvy se tam nevyskytují vůbec.
 *
 * NEZNÁMÝ REGION DÁVÁ `null`
 * Poskytovatelé regiony přidávají. Region, který tu není, znamená
 * neprůkazné, ne odhad. Doplnit ho je práce na pár minut; špatný odhad
 * v dokumentu pro úřad se opravuje hůř.
 *
 * ZDROJE
 *   AWS   — docs.aws.amazon.com/global-infrastructure
 *   Azure — learn.microsoft.com/azure/reliability/regions-list
 *   GCP   — cloud.google.com/about/locations
 */

/** AWS: kód regionu → ISO kód země. */
const AWS = {
  // Evropa
  'eu-west-1': 'IE',      // Irsko
  'eu-west-2': 'GB',      // Londýn — mimo EHP!
  'eu-west-3': 'FR',      // Paříž
  'eu-central-1': 'DE',   // Frankfurt
  'eu-central-2': 'CH',   // Curych — mimo EHP!
  'eu-north-1': 'SE',     // Stockholm
  'eu-south-1': 'IT',     // Milán
  'eu-south-2': 'ES',     // Španělsko
  // Severní a Jižní Amerika
  'us-east-1': 'US', 'us-east-2': 'US', 'us-west-1': 'US', 'us-west-2': 'US',
  'us-gov-east-1': 'US', 'us-gov-west-1': 'US',
  'ca-central-1': 'CA', 'ca-west-1': 'CA',
  'sa-east-1': 'BR',
  'mx-central-1': 'MX',
  // Asie a Tichomoří
  // `ap-east-2` je Tchaj-pej, ne Hongkong — ověřeno v tabulce regionů AWS.
  // Původně tu bylo HK odvozené z podobnosti s `ap-east-1`, což je přesně
  // ten druh domněnky, který tenhle soubor zakazuje.
  'ap-east-1': 'HK', 'ap-east-2': 'TW',
  'ap-south-1': 'IN', 'ap-south-2': 'IN',
  'ap-northeast-1': 'JP', 'ap-northeast-2': 'KR', 'ap-northeast-3': 'JP',
  'ap-southeast-1': 'SG', 'ap-southeast-2': 'AU', 'ap-southeast-3': 'ID',
  'ap-southeast-4': 'AU', 'ap-southeast-5': 'MY',
  'ap-southeast-6': 'NZ',   // Nový Zéland — v tabulce regionů AWS
  'ap-southeast-7': 'TH',
  // Blízký východ a Afrika
  'me-south-1': 'BH', 'me-central-1': 'AE',
  'il-central-1': 'IL',
  'af-south-1': 'ZA',
  'cn-north-1': 'CN', 'cn-northwest-1': 'CN',
  // Evropský suverénní cloud. Kód regionu nese zemi přímo („de").
  'eusc-de-east-1': 'DE',
  // Zemi nese `us` v názvu; v tabulce regionů AWS tenhle kód není.
  'us-south-1': 'US',
};

/** Azure: název regionu (malými písmeny) → ISO kód země. */
const AZURE = {
  // Evropa
  'northeurope': 'IE',        // Irsko
  'westeurope': 'NL',         // Nizozemsko
  'swedencentral': 'SE', 'swedensouth': 'SE',
  'germanywestcentral': 'DE', 'germanynorth': 'DE',
  'francecentral': 'FR', 'francesouth': 'FR',
  'norwayeast': 'NO', 'norwaywest': 'NO',
  'switzerlandnorth': 'CH', 'switzerlandwest': 'CH',   // mimo EHP!
  'uksouth': 'GB', 'ukwest': 'GB',                     // mimo EHP!
  'polandcentral': 'PL',
  'italynorth': 'IT',
  'spaincentral': 'ES',
  'austriaeast': 'AT',
  'belgiumcentral': 'BE',
  'denmarkeast': 'DK',
  'finlandcentral': 'FI',
  'greececentral': 'GR',
  // Amerika
  'eastus': 'US', 'eastus2': 'US', 'westus': 'US', 'westus2': 'US',
  'westus3': 'US', 'centralus': 'US', 'northcentralus': 'US',
  'southcentralus': 'US', 'westcentralus': 'US',
  'canadacentral': 'CA', 'canadaeast': 'CA',
  'brazilsouth': 'BR', 'brazilsoutheast': 'BR',
  'mexicocentral': 'MX',
  'chilecentral': 'CL',
  // Asie a Tichomoří
  'eastasia': 'HK', 'southeastasia': 'SG',
  'japaneast': 'JP', 'japanwest': 'JP',
  'koreacentral': 'KR', 'koreasouth': 'KR',
  'australiaeast': 'AU', 'australiasoutheast': 'AU',
  'australiacentral': 'AU', 'australiacentral2': 'AU',
  'centralindia': 'IN', 'southindia': 'IN', 'westindia': 'IN', 'jioindiawest': 'IN',
  'indonesiacentral': 'ID', 'malaysiawest': 'MY', 'newzealandnorth': 'NZ',
  'taiwannorth': 'TW',
  // Blízký východ a Afrika
  'uaenorth': 'AE', 'uaecentral': 'AE',
  'qatarcentral': 'QA',
  'israelcentral': 'IL',
  'southafricanorth': 'ZA', 'southafricawest': 'ZA',

  // ── Identifikátory ze značek služeb ───────────────────────────────────
  //
  // V datech o rozsazích Azure používá VÝHRADNĚ tyhle tvary; plné názvy
  // ze seznamu regionů (`germanywestcentral`, `norwayeast`…) se v nich
  // nevyskytují vůbec. Bez nich by celá evropská infrastruktura Azure
  // mimo Irsko, Nizozemsko a Švédsko vyšla jako neprůkazná.
  //
  // Microsoft je ve svém seznamu regionů neuvádí, takže korespondence
  // s konkrétním regionem není doložená. Doložená je ale ZEMĚ, a ta tu
  // rozhoduje: identifikátor jméno země obsahuje a Azure nemá dva regiony
  // téhož jména v různých zemích.
  'germanyn': 'DE', 'germanywc': 'DE',
  'centralfrance': 'FR', 'southfrance': 'FR',
  'norwaye': 'NO', 'norwayw': 'NO',
  'switzerlandn': 'CH', 'switzerlandw': 'CH',   // mimo EHP!
  'brazilne': 'BR', 'brazilse': 'BR',
  'chilec': 'CL',
  'indiasouthcentral': 'IN', 'jioindiacentral': 'IN',
  'malaysiasouth': 'MY',
  'israelnorthwest': 'IL',
  'taiwannorthwest': 'TW',
  // Regiony ve Spojených státech — zemi nese `us` v samotném názvu.
  'eastus3': 'US', 'northeastus5': 'US', 'southcentralus2': 'US',
  'southeastus': 'US', 'southeastus3': 'US', 'southeastus5': 'US',
  'southwestus': 'US',
  // EUAP = program včasných aktualizací, běží v amerických regionech.
  'centraluseuap': 'US', 'eastus2euap': 'US',
  'usstagec': 'US', 'usstagee': 'US',
};

/** GCP: název regionu → ISO kód země. */
const GCP = {
  // Evropa
  'europe-west1': 'BE',       // Belgie
  'europe-west2': 'GB',       // Londýn — mimo EHP!
  'europe-west3': 'DE',       // Frankfurt
  'europe-west4': 'NL',       // Nizozemsko
  'europe-west6': 'CH',       // Curych — mimo EHP!
  'europe-west8': 'IT',
  'europe-west9': 'FR',
  'europe-west10': 'DE',
  'europe-west12': 'IT',
  'europe-north1': 'FI',
  'europe-north2': 'SE',
  'europe-central2': 'PL',
  'europe-southwest1': 'ES',
  // Amerika
  'us-central1': 'US', 'us-east1': 'US', 'us-east4': 'US', 'us-east5': 'US',
  'us-west1': 'US', 'us-west2': 'US', 'us-west3': 'US', 'us-west4': 'US',
  'us-south1': 'US',
  'northamerica-northeast1': 'CA', 'northamerica-northeast2': 'CA',
  'northamerica-south1': 'MX',
  'southamerica-east1': 'BR', 'southamerica-west1': 'CL',
  // Asie a Tichomoří
  'asia-east1': 'TW', 'asia-east2': 'HK',
  'asia-northeast1': 'JP', 'asia-northeast2': 'JP', 'asia-northeast3': 'KR',
  'asia-south1': 'IN', 'asia-south2': 'IN',
  'asia-southeast1': 'SG', 'asia-southeast2': 'ID',
  'australia-southeast1': 'AU', 'australia-southeast2': 'AU',
  // Blízký východ a Afrika
  'me-west1': 'IL', 'me-central1': 'QA', 'me-central2': 'SA',
  'africa-south1': 'ZA',
  // Google je na stránce s lokalitami neuvádí, ale v rozsazích jsou.
  // Zemi nese `us` v názvu — stejná úvaha jako u ostatních poskytovatelů.
  'us-central2': 'US', 'us-east7': 'US', 'us-west8': 'US',
};

const MAPY = { aws: AWS, azure: AZURE, gcp: GCP };

/**
 * Země, ve které region leží.
 *
 * @param {string} provider 'aws' | 'azure' | 'gcp'
 * @param {string} region název regionu tak, jak ho uvádí poskytovatel
 * @returns {string|null} ISO kód země, nebo `null` když region neznáme
 */
export function regionCountry(provider, region) {
  const mapa = MAPY[String(provider || '').toLowerCase()];
  if (!mapa) return null;
  const klic = String(region || '').toLowerCase().trim();
  return mapa[klic] ?? null;
}

/** Kolik regionů umíme převést — pro kontrolu úplnosti snímku. */
export function knownRegionCount() {
  return Object.values(MAPY).reduce((n, m) => n + Object.keys(m).length, 0);
}

export const REGION_MAPS = MAPY;
