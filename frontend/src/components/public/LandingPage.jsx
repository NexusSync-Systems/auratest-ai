import { Shield, Activity, Globe, FileText, Lock, AlertTriangle } from 'lucide-react';

/**
 * Veřejná úvodní stránka.
 *
 * Cizí návštěvník dřív viděl jen přihlašovací kartu bez vysvětlení, co to je.
 *
 * Text je psaný tak, aby si po přečtení nikdo nemyslel víc, než nástroj umí.
 * Oddíl „Co vědomě netvrdí" tu není ze skromnosti — je to hlavní vlastnost
 * produktu. Skener, který na neprůkazný výsledek napíše „splněno", je
 * v compliance nebezpečnější než žádný skener.
 */

const REGULATIONS = [
  {
    icon: Shield,
    name: 'NIS2 a post-kvantová kryptografie',
    ref: 'směrnice EU 2022/2555, zák. 264/2025 Sb.',
    what:
      'Navazuje skutečné TLS spojení a zjišťuje, jestli server přijímá hybridní ' +
      'výměnu klíčů X25519MLKEM768 (ML-KEM-768 podle FIPS 203). Verze protokolu ' +
      'se testují každá zvlášť, TLS 1.0 a 1.1 ručně sestaveným ClientHellem — ' +
      'moderní OpenSSL je odmítá už na straně klienta a vydávat to za odmítnutí ' +
      'serverem by znamenalo tvrdit výsledek testu, který neproběhl.',
  },
  {
    icon: FileText,
    name: 'Kybernetická odolnost (CRA)',
    ref: 'nařízení EU 2024/2847',
    what:
      'Sestavuje soupis komponent přímo z obsahu doručených bundlů a ze source map, ' +
      'ne z domněnek. Nalezené verze se dotazují do databáze zranitelností OSV. ' +
      'Knihovna bez zjistitelné verze se nepočítá jako ověřená.',
  },
  {
    icon: Activity,
    name: 'AI Act, článek 50',
    ref: 'nařízení EU 2024/1689',
    what:
      'Čtyři povinnosti transparentnosti zvlášť: informování o komunikaci s AI, ' +
      'strojově čitelné označení syntetického obsahu, rozpoznávání emocí ' +
      'a zveřejnění u deepfaků. Poslední dvě externím skenem posoudit nelze — ' +
      'a nástroj to říká místo aby je odškrtl.',
  },
  {
    icon: Globe,
    name: 'Přístupnost (EAA) a GDPR',
    ref: 'směrnice EU 2019/882, nařízení 2016/679',
    what:
      'WCAG 2.1 AA přes axe-core včetně položek, které vyžadují ruční posouzení. ' +
      'Cookies a trackery načtené před udělením souhlasu. Rezidence dat podle ' +
      'geolokace serverů, s výhradou u anycast CDN, kde geolokace nevypovídá ' +
      'o tom, kde data leží.',
  },
];

const LIMITS = [
  'Externí sken nevidí do serverové části. Řadu povinností proto nelze potvrdit ani vyvrátit — takový výsledek je označený jako neprůkazný, ne jako splněný.',
  'Geolokace IP adresy neurčuje, kde jsou data uložena. U anycast CDN je údaj orientační a report to uvádí.',
  'Nález nástroje není právní posouzení. Nahrazuje první čtení, ne odpovědnou osobu.',
  'Verze knihovny zjištěná z bundlu je odhad z otisku. Bez ní se do databáze zranitelností nedotazujeme a knihovna zůstane neověřená.',
];

export default function LandingPage({ onLogin, onSample }) {
  return (
    <div className="public-page">
      <header className="public-hero">
        <div className="public-logo">
          <Shield size={28} />
          <span>AuraGuard</span>
        </div>
        <h1>Compliance audit webových aplikací podle předpisů EU</h1>
        <p className="public-lead">
          Automatický sken, který měří to, co se změřit dá — a u zbytku to řekne
          nahlas místo aby si domýšlel závěr.
        </p>
        <div className="public-actions">
          <button type="button" className="btn btn-primary" onClick={onSample}>
            Ukázkový report
          </button>
          <button type="button" className="btn btn-secondary" onClick={onLogin}>
            Přihlásit se
          </button>
        </div>
      </header>

      <section className="public-section">
        <h2>Co nástroj měří</h2>
        <div className="public-grid">
          {REGULATIONS.map(({ icon: Icon, name, ref, what }) => (
            <article key={name} className="public-card">
              <h3>
                <Icon size={18} aria-hidden="true" /> {name}
              </h3>
              <p className="public-card-ref">{ref}</p>
              <p>{what}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="public-section public-section-limits">
        <h2>
          <AlertTriangle size={20} aria-hidden="true" /> Co vědomě netvrdí
        </h2>
        <p className="public-lead">
          Každý výsledek má tři možné stavy: splněno, porušeno, a{' '}
          <strong>neprůkazné</strong>. Ten třetí je tu záměrně — skener, který
          na neověřený stav napíše „v pořádku", je horší než žádný.
        </p>
        <ul className="public-limits">
          {LIMITS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </section>

      <section className="public-section">
        <h2>
          <Lock size={20} aria-hidden="true" /> Spuštění skenu vyžaduje účet
        </h2>
        <p>
          Sken navazuje spojení na zadanou adresu a drží prohlížeč po dobu běhu.
          Veřejný formulář by z nástroje udělal otevřenou bránu pro skenování
          cizích webů z naší infrastruktury, proto je za přihlášením.
        </p>
        <div className="public-actions">
          <button type="button" className="btn btn-primary" onClick={onLogin}>
            Přihlásit se
          </button>
        </div>
      </section>

      <footer className="public-footer">
        <p>
          AuraGuard — nástroj pro QA a compliance audit. Výstupy jsou podklad
          pro posouzení, ne právní stanovisko.
        </p>
      </footer>
    </div>
  );
}
