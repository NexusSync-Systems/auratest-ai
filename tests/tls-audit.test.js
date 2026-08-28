import tls from 'tls';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  PQC_GROUP,
  PROTOCOL_VERSIONS,
  classifyProtocols,
  classifyCertificate,
  classifyPqc,
  classifyCiphers,
  classifyChain,
  classifyOcsp,
  summarizeTls,
  probeLegacyVersion,
  inspectTls,
} from '../tls-audit.js';

/**
 * Testy TLS sondy.
 *
 * Klasifikační funkce se testují bez sítě. Sonda samotná se testuje proti
 * skutečnému TLS serveru na localhostu — jinak by šlo jen o kontrolu vlastních
 * domněnek o tom, jak se OpenSSL chová.
 */

describe('classifyProtocols — tři stavy, ne dva', () => {
  it('povolená zastaralá verze je prokázaná závada', () => {
    const r = classifyProtocols({
      'TLSv1': true, 'TLSv1.1': true, 'TLSv1.2': true, 'TLSv1.3': true,
    });
    expect(r.deprecated).toEqual(['TLSv1', 'TLSv1.1']);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/TLSv1 a TLSv1\.1/);
  });

  it('čistá konfigurace projde', () => {
    const r = classifyProtocols({
      'TLSv1': false, 'TLSv1.1': false, 'TLSv1.2': true, 'TLSv1.3': true,
    });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.refused).toEqual(['TLSv1', 'TLSv1.1']);
  });

  it('neotestovaná zastaralá verze dá null, ne true', () => {
    // Kdyby sonda vrátila false, tvrdili bychom výsledek testu, který
    // neproběhl. Přesně ta chyba, kvůli které tenhle modul vznikl.
    const r = classifyProtocols({
      'TLSv1': null, 'TLSv1.1': null, 'TLSv1.2': true, 'TLSv1.3': true,
    });
    expect(r.untested).toEqual(['TLSv1', 'TLSv1.1']);
    expect(r.ok).toBeNull();
    expect(r.ok).not.toBe(true);
    expect(r.notes[0]).toMatch(/nepodařilo otestovat/);
  });

  it('prokázaná závada přebije neprůkaznost', () => {
    const r = classifyProtocols({
      'TLSv1': true, 'TLSv1.1': null, 'TLSv1.2': true, 'TLSv1.3': false,
    });
    expect(r.ok).toBe(false);
  });

  it('chybějící TLS 1.3 je nález jen když bylo prokazatelně odmítnuto', () => {
    expect(classifyProtocols({ 'TLSv1.2': true, 'TLSv1.3': false }).issues)
      .toContain('Server nepodporuje TLS 1.3.');
    expect(classifyProtocols({ 'TLSv1.2': true, 'TLSv1.3': null }).issues)
      .not.toContain('Server nepodporuje TLS 1.3.');
  });
});

describe('classifyCertificate', () => {
  const now = new Date('2026-08-20T00:00:00Z');
  const base = {
    subject: { CN: 'example.com' },
    issuer: { CN: 'Example CA' },
    valid_from: 'Jun 1 00:00:00 2026 GMT',
    valid_to: 'Dec 1 00:00:00 2026 GMT',
    bits: 2048,
  };

  it('platný certifikát nemá nálezy', () => {
    const r = classifyCertificate(base, now);
    expect(r.ok).toBe(true);
    expect(r.daysRemaining).toBeGreaterThan(90);
  });

  it('chybějící certifikát je neprůkazné, ne selhání', () => {
    const r = classifyCertificate(null, now);
    expect(r.ok).toBeNull();
    expect(r.present).toBe(false);
  });

  it('pozná vypršelý certifikát', () => {
    const r = classifyCertificate({ ...base, valid_to: 'Jan 1 00:00:00 2026 GMT' }, now);
    expect(r.daysRemaining).toBeLessThan(0);
    expect(r.issues[0]).toMatch(/vypršel/);
  });

  it('varuje před brzkým vypršením', () => {
    const r = classifyCertificate({ ...base, valid_to: 'Aug 25 00:00:00 2026 GMT' }, now);
    expect(r.issues[0]).toMatch(/vyprší za \d+ dnů/);
  });

  it('pozná slabý RSA klíč', () => {
    const r = classifyCertificate({ ...base, bits: 1024 }, now);
    expect(r.issues.some((i) => /1024 bitů/.test(i))).toBe(true);
  });

  it('u EC certifikátu neaplikuje RSA limit', () => {
    // `bits` u EC znamená délku křivky, ne modulu — 256 je naprosto v pořádku.
    const r = classifyCertificate({ ...base, bits: 256, nistCurve: 'P-256' }, now);
    expect(r.issues.some((i) => /bitů/.test(i))).toBe(false);
  });

  it('pozná self-signed', () => {
    const r = classifyCertificate({ ...base, issuer: { CN: 'example.com' } }, now);
    expect(r.selfSigned).toBe(true);
  });
});

describe('classifyCertificate — neprovedené měření není nález', () => {
  const now = new Date('2026-08-20T00:00:00Z');

  it('nepřečtený certifikát dá poznámku, ne nález', () => {
    // Regrese: text šel do `issues`, takže summarizeTls ho započítal jako
    // prokázanou závadu (`ok: false`). Neprovedené měření se tak převléklo
    // za změřenou závadu.
    const r = classifyCertificate(null, now);
    expect(r.ok).toBeNull();
    expect(r.issues).toEqual([]);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('nepřečtená platnost dá ok: null, ne true', () => {
    const r = classifyCertificate({
      subject: { CN: 'a.cz' }, issuer: { CN: 'CA' }, bits: 2048,
    }, now);
    expect(r.ok).toBeNull();
    expect(r.notes.join(' ')).toMatch(/platnosti/i);
  });

  it('EC certifikát bez pole s křivkou se nehlásí jako slabý RSA klíč', () => {
    // Node `asn1Curve`/`nistCurve` ne vždy vyplní. P-256 má bits: 256,
    // což vypadalo jako „RSA klíč má jen 256 bitů" — prokázaná závada
    // vyvozená z chybějícího pole.
    const r = classifyCertificate({
      subject: { CN: 'a.cz' }, issuer: { CN: 'CA' },
      valid_from: 'Jun 1 00:00:00 2026 GMT', valid_to: 'Dec 1 00:00:00 2026 GMT',
      bits: 256,
    }, now);
    expect(r.issues.some((i) => /bitů/.test(i))).toBe(false);
  });

  it('slabý RSA klíč se pozná dál', () => {
    const r = classifyCertificate({
      subject: { CN: 'a.cz' }, issuer: { CN: 'CA' },
      valid_from: 'Jun 1 00:00:00 2026 GMT', valid_to: 'Dec 1 00:00:00 2026 GMT',
      bits: 1024,
    }, now);
    expect(r.issues.some((i) => /1024 bitů/.test(i))).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe('classifyPqc', () => {
  it('podpora = pass', () => {
    const r = classifyPqc({ supported: true, group: PQC_GROUP });
    expect(r.status).toBe('pass');
  });

  it('odmítnutí = fail se zmínkou o "sesbírej teď, dešifruj později"', () => {
    const r = classifyPqc({ supported: false, group: PQC_GROUP });
    expect(r.status).toBe('fail');
    expect(r.rationale).toMatch(/zpětně dešifrovat/);
  });

  it('starý OpenSSL = neprůkazné, ne "nepodporuje"', () => {
    const r = classifyPqc({ supported: null, group: PQC_GROUP });
    expect(r.status).toBe('inconclusive');
    expect(r.status).not.toBe('fail');
    expect(r.rationale).toMatch(/OpenSSL 3\.5/);
  });

  it('nedostupný server neradí aktualizovat Node', () => {
    // Neprůkazné má dvě příčiny. Radit upgrade OpenSSL někomu, ke komu se
    // sonda vůbec nedostala, je zavádějící.
    const r = classifyPqc({ supported: null, group: PQC_GROUP, probeReason: 'ECONNREFUSED' });
    expect(r.status).toBe('inconclusive');
    expect(r.rationale).not.toMatch(/OpenSSL/);
    expect(r.rationale).toMatch(/nedostala/);
  });

  it('odmítnutí se vztahuje jen k otestované skupině', () => {
    // Server může podporovat SecP256r1MLKEM768 nebo starší draft.
    // Rozsah tvrzení musí odpovídat rozsahu sondy.
    const r = classifyPqc({ supported: false, group: PQC_GROUP });
    expect(r.rationale).toMatch(/tahle jedna skupina|jednu skupinu/i);
  });
});

describe('summarizeTls', () => {
  const reachable = {
    reachable: true,
    authorized: true,
    authorizationError: null,
    certificate: {
      subject: { CN: 'a.cz' }, issuer: { CN: 'CA' },
      valid_from: 'Jun 1 00:00:00 2026 GMT', valid_to: 'Dec 1 00:00:00 2026 GMT', bits: 2048,
    },
    protocols: { 'TLSv1': false, 'TLSv1.1': false, 'TLSv1.2': true, 'TLSv1.3': true },
    pqc: { group: PQC_GROUP, supported: false },
    // Bez těchhle sond by verdikt zůstal neprůkazný — a to je správně:
    // sken, u kterého část kontrol neproběhla, nesmí vyjít jako v pořádku.
    ciphers: { noForwardSecrecy: false, sha1Mac: false, tripleDes: false },
    ocspStapled: true,
  };
  const now = new Date('2026-08-20T00:00:00Z');

  it('nedostupný server je neprůkazný, ne nevyhovující', () => {
    const r = summarizeTls({ reachable: false, authorizationError: 'ECONNREFUSED' }, now);
    expect(r.ok).toBeNull();
    expect(r.rating).toMatch(/NEPRŮKAZNÉ/);
  });

  it('chybějící PQC není závada, jen doporučení', () => {
    const r = summarizeTls(reachable, now);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.rating).toMatch(/Post-kvantová výměna klíčů zatím není nasazená/);
  });

  it('rating si neprotiřečí s verdiktem', () => {
    // Regrese: objekt mohl současně nést `ok: null` a text „TLS konfigurace
    // v pořádku". Člověk si přečte ten text.
    const inconclusive = summarizeTls({
      ...reachable,
      protocols: { ...reachable.protocols, 'TLSv1': null, 'TLSv1.1': null },
    }, now);
    expect(inconclusive.ok).toBeNull();
    expect(inconclusive.rating).toMatch(/NEPRŮKAZNÉ/);
    expect(inconclusive.rating).not.toMatch(/v pořádku/i);
  });

  it('nepřečtený certifikát shodí verdikt na null, ne na false', () => {
    const r = summarizeTls({ ...reachable, certificate: null }, now);
    expect(r.ok).toBeNull();
    expect(r.issues).toEqual([]);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('neprůkazné verze protokolu shodí celkové ok na null', () => {
    const r = summarizeTls({
      ...reachable,
      protocols: { ...reachable.protocols, 'TLSv1': null, 'TLSv1.1': null },
    }, now);
    expect(r.ok).toBeNull();
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('neověřený certifikát je nález', () => {
    const r = summarizeTls({
      ...reachable, authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
    }, now);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /nepodařilo ověřit/.test(i))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sonda proti skutečnému serveru
// ─────────────────────────────────────────────────────────────────────────────

/** Spustí TLS server na náhodném portu localhostu. */
function startServer(options) {
  return new Promise((resolve, reject) => {
    const server = tls.createServer({ ...FIXTURE, ...options }, (socket) => socket.end());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

// Certifikát pro testovací servery. Generuje se jednou pro celý soubor,
// aby v repozitáři neležel soukromý klíč.
let FIXTURE;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraguard-tls-'));
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  FIXTURE = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}, 30000);

describe('probeLegacyVersion — ruční ClientHello', () => {
  it('pozná server, který TLS 1.0 skutečně přijímá', async () => {
    // Node/OpenSSL by TLS 1.0 odmítl už na straně klienta, proto ruční
    // ClientHello po holém TCP socketu.
    const server = await startServer({
      minVersion: 'TLSv1', maxVersion: 'TLSv1.2', ciphers: 'DEFAULT:@SECLEVEL=0',
    });
    try {
      const r = await probeLegacyVersion('127.0.0.1', server.address().port, 'TLSv1');
      expect(r.supported).toBe(true);
      expect(r.negotiated).toBe('0x301');
    } finally {
      await close(server);
    }
  }, 30000);

  it('pozná server, který TLS 1.0 odmítá', async () => {
    const server = await startServer({ minVersion: 'TLSv1.2' });
    try {
      const r = await probeLegacyVersion('127.0.0.1', server.address().port, 'TLSv1');
      expect(r.supported).toBe(false);
      expect(r.reason).toBe('protocol_version_alert');
    } finally {
      await close(server);
    }
  }, 30000);

  it('port, který nemluví TLS, je neprůkazný', async () => {
    // Odpověď v čistém HTTP: ani ServerHello, ani alert. Vydávat to za
    // „server verzi odmítl" by bylo tvrzení bez podkladu.
    const sockets = new Set();
    const plain = net.createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise((r) => plain.listen(0, '127.0.0.1', r));
    try {
      const res = await probeLegacyVersion('127.0.0.1', plain.address().port, 'TLSv1');
      expect(res.supported).toBeNull();
      expect(res.reason).toMatch(/unexpected_record/);
    } finally {
      // Bez tohohle čeká server.close() na dobíhající spojení donekonečna.
      for (const s of sockets) s.destroy();
      await new Promise((r) => plain.close(r));
    }
  }, 30000);

  it('neznámou verzi nevymýšlí', async () => {
    const r = await probeLegacyVersion('127.0.0.1', 1, 'TLSv1.3');
    expect(r.supported).toBeNull();
    expect(r.reason).toBe('unknown_version');
  });
});

describe('inspectTls proti skutečnému serveru', () => {
  it('změří verze protokolu i certifikát', async () => {
    const server = await startServer({ minVersion: 'TLSv1.2' });
    try {
      const ins = await inspectTls('127.0.0.1', server.address().port);
      expect(ins.reachable).toBe(true);
      expect(ins.protocols['TLSv1.2']).toBe(true);
      expect(ins.protocols['TLSv1.3']).toBe(true);
      // Zastaralé verze musí být prokazatelně odmítnuté, ne "netestováno".
      expect(ins.protocols['TLSv1']).toBe(false);
      expect(ins.protocols['TLSv1.1']).toBe(false);
      expect(ins.certificate.subject.CN).toBe('localhost');

      const summary = summarizeTls(ins);
      expect(summary.protocols.untested).toEqual([]);
      expect(summary.protocols.deprecated).toEqual([]);
      // Self-signed certifikát MUSÍ být nález.
      expect(summary.certificate.selfSigned).toBe(true);
      expect(summary.ok).toBe(false);
    } finally {
      await close(server);
    }
  }, 60000);

  it('pozná server, který post-kvantovou skupinu odmítá', async () => {
    const server = await startServer({ minVersion: 'TLSv1.2', ecdhCurve: 'X25519' });
    try {
      const ins = await inspectTls('127.0.0.1', server.address().port);
      // Buď false (změřeno), nebo null (tenhle build OpenSSL skupinu nezná).
      // Nikdy true — server ji nenabízí.
      expect(ins.pqc.supported).not.toBe(true);
      expect(ins.pqc.group).toBe(PQC_GROUP);
    } finally {
      await close(server);
    }
  }, 60000);

  it('nedostupný port vrátí reachable: false místo výjimky', async () => {
    const ins = await inspectTls('127.0.0.1', 1);
    expect(ins.reachable).toBe(false);
    expect(summarizeTls(ins).ok).toBeNull();
  }, 30000);

  it('když se k serveru nedostaneme, netvrdí "nepodporuje"', async () => {
    // Nedostupný server nevypovídá o své konfiguraci nic. Kdyby se tohle
    // vrátilo jako `false`, report by hlásil chybějící post-kvantovou
    // ochranu u serveru, se kterým jsme nikdy nemluvili.
    const ins = await inspectTls('127.0.0.1', 1);
    expect(ins.pqc.supported).toBeNull();
    expect(ins.pqc.supported).not.toBe(false);
    for (const version of PROTOCOL_VERSIONS) {
      expect(ins.protocols[version]).toBeNull();
    }
  }, 30000);
});

describe('Rozsah sondy', () => {
  it('testuje všechny čtyři verze protokolu', () => {
    expect(PROTOCOL_VERSIONS).toEqual(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);
  });
});

describe('sady šifer (S1)', () => {
  test('všechny slabé skupiny odmítnuty → bez nálezu', () => {
    const r = classifyCiphers({ noForwardSecrecy: false, sha1Mac: false, tripleDes: false });
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(0);
    // Seznam je uzavřený a report to musí říct.
    expect(r.rationale).toMatch(/uzavřený seznam|neplyne, že přijímá jen ty nejlepší/);
  });

  test('přijatá slabá sada je nález s vysvětlením proč', () => {
    const r = classifyCiphers({ noForwardSecrecy: true, sha1Mac: false, tripleDes: false });
    expect(r.ok).toBe(false);
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].message).toMatch(/dříve odposlechnutý provoz/);
  });

  test('netestovaná skupina není odmítnutá skupina', () => {
    // Novější OpenSSL slabé sady odmítá i na straně klienta. Vydávat
    // neschopnost klienta za odmítnutí serverem by znamenalo tvrdit
    // výsledek testu, který neproběhl.
    const r = classifyCiphers({ noForwardSecrecy: false, sha1Mac: false, tripleDes: null });
    expect(r.ok).toBeNull();
    expect(r.untested).toHaveLength(1);
    expect(r.rationale).toMatch(/Netestováno/);
  });

  test('žádná sonda neproběhla → neprůkazné', () => {
    expect(classifyCiphers({}).ok).toBeNull();
  });
});

describe('řetěz důvěry a OCSP (S1)', () => {
  test('ověřený řetěz přiznává, proti čemu se ověřoval', () => {
    const r = classifyChain({ reachable: true, authorized: true });
    expect(r.ok).toBe(true);
    // Kořeny Node ≠ kořeny prohlížeče. Bez téhle výhrady by report tvrdil
    // víc, než změřil.
    expect(r.rationale).toMatch(/neshodují s úložištěm/);
  });

  test('neověřený řetěz nese důvod', () => {
    const r = classifyChain({
      reachable: true,
      authorized: false,
      authorizationError: 'self signed certificate',
    });
    expect(r.ok).toBe(false);
    expect(r.rationale).toMatch(/self signed/);
  });

  test('nedostupný server → neprůkazné, ne nález', () => {
    expect(classifyChain({ reachable: false }).ok).toBeNull();
  });

  test('chybějící stapling se označuje jako doporučení, ne vada', () => {
    const r = classifyOcsp({ reachable: true, ocspStapled: false });
    expect(r.ok).toBe(false);
    expect(r.rationale).toMatch(/[Nn]ení to porušení předpisu/);
  });

  test('neověřený stapling je neprůkazný', () => {
    expect(classifyOcsp({ reachable: true, ocspStapled: null }).ok).toBeNull();
    expect(classifyOcsp({ reachable: false }).ok).toBeNull();
  });
});
