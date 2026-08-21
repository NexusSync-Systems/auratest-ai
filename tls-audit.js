/**
 * Skutečná analýza TLS vrstvy.
 *
 * Modul „NIS2 & Post-Quantum Cryptography" dřív jen přečetl název protokolu
 * z Playwrightu a vrátil `isQuantumSafe: false` natvrdo. Post-kvantová
 * odolnost se **neměřila vůbec** — byla to jen konstanta v odpovědi.
 *
 * Tady se místo toho dělají skutečné TLS handshaky:
 *
 *   • zvlášť pro každou verzi protokolu → co server doopravdy přijímá
 *   • s nabídkou POUZE hybridní post-kvantové skupiny X25519MLKEM768
 *     → když handshake projde, server ji podporuje
 *   • čtení certifikátu z navázaného spojení → platnost, typ a délka klíče
 *   • ruční ClientHello pro TLS 1.0/1.1 poslaný po holém TCP socketu
 *
 * Proč ruční ClientHello: moderní OpenSSL má TLS 1.0/1.1 vypnuté i na straně
 * KLIENTA, takže `tls.connect({ maxVersion: 'TLSv1' })` skončí chybou dřív, než
 * se vůbec někam připojí. Vydávat to za „server je odmítá" by znamenalo tvrdit
 * výsledek testu, který neproběhl. Ruční ClientHello po holém socketu obchází
 * politiku klienta úplně — čte se přímo odpověď serveru (ServerHello vs. alert).
 *
 * Proč probing a ne čtení vyjednané skupiny: Node u TLS 1.3 vrací
 * z `getEphemeralKeyInfo()` prázdný objekt (funguje jen pro TLS 1.2).
 * Ověřeno experimentálně proti lokálnímu serveru s OpenSSL 3.5.
 *
 * Vyžaduje OpenSSL 3.5+ (Node 22+) — starší build skupinu X25519MLKEM768
 * nezná a probing skončí jako `unknown`, ne jako `false`.
 *
 * Klasifikační logika je oddělená od síťové části, aby šla testovat
 * jednotkově bez otevírání spojení.
 */
import tls from 'tls';
import net from 'net';
import crypto from 'crypto';

/** Hybridní post-kvantová skupina, kterou OpenSSL 3.5 umí nabídnout. */
export const PQC_GROUP = 'X25519MLKEM768';

/** Verze protokolu, které testujeme zvlášť. */
export const PROTOCOL_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];

/** Verze, jejichž přijímání je dnes považováno za nedostatek. */
const DEPRECATED_VERSIONS = ['TLSv1', 'TLSv1.1'];

const DEFAULT_TIMEOUT_MS = parseInt(process.env.TLS_PROBE_TIMEOUT_MS, 10) || 8000;

/**
 * Chyby, které znamenají „nedostali jsme se k serveru".
 *
 * DNS výpadek ani nedostupný port o konfiguraci serveru nevypovídá nic.
 * Vracet po nich `false` by znamenalo tvrdit „server to nepodporuje" na
 * základě testu, který se k serveru vůbec nedostal.
 */
const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'timeout',
]);

/**
 * Chyby, které znamenají „TOHLE NEUMÍ NÁŠ KLIENT", ne „server to odmítl".
 *
 * Moderní OpenSSL má TLS 1.0/1.1 vypnuté i na straně klienta, takže sonda
 * skončí chybou dřív, než se vůbec někam připojí. Kdybychom to počítali jako
 * „server je nepřijímá", tvrdili bychom výsledek testu, který neproběhl —
 * přesně ta chyba, kvůli které tenhle modul vznikl.
 */
const CLIENT_LIMITATION_CODES = new Set([
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'ERR_CRYPTO_OPERATION_FAILED',
]);

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

// ─────────────────────────────────────────────────────────────────────────────
// Síťová část
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Jeden handshake. Vrací výsledek, nikdy nevyhazuje — selhání handshaku
 * je legitimní informace, ne chyba běhu.
 */
function handshake(hostname, port, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // socket už je zavřený
      }
      resolve(result);
    };

    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      socket = tls.connect(
        {
          host: hostname,
          port,
          // SNI jen pro doménu — u IP adresy to RFC 6066 zakazuje a Node varuje.
          ...(isIpLiteral(hostname) ? {} : { servername: hostname }),
          rejectUnauthorized: false, // neplatný certifikát je NÁLEZ, ne důvod skončit
          ...options,
        },
        () => {
          clearTimeout(timer);
          const cert = socket.getPeerCertificate(true);
          done({
            ok: true,
            protocol: socket.getProtocol(),
            cipher: socket.getCipher(),
            authorized: socket.authorized,
            authorizationError: socket.authorizationError?.message || socket.authorizationError || null,
            certificate: cert && Object.keys(cert).length ? cert : null,
          });
        }
      );
      socket.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, reason: err.code || 'handshake_failed', message: err.message });
      });
    } catch (err) {
      // Neznámý název skupiny hází synchronně (ERR_CRYPTO_OPERATION_FAILED).
      clearTimeout(timer);
      done({ ok: false, reason: 'unsupported_option', message: err.message });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ruční ClientHello pro zastaralé verze
// ─────────────────────────────────────────────────────────────────────────────

/** Verze, které vlastní klient odmítne — musí se poslat ručně. */
const LEGACY_VERSION_CODES = { 'TLSv1': 0x0301, 'TLSv1.1': 0x0302 };

/**
 * Cipher suites nabízené v ručním ClientHellu.
 *
 * Schválně obsahují i staré RSA/CBC sady. Kdybychom nabídli jen moderní,
 * server by mohl spojení odmítnout kvůli šifrám — a my bychom to spletli
 * s odmítnutím kvůli verzi protokolu.
 */
const LEGACY_CIPHER_SUITES = [
  0xc014, 0xc013, 0xc00a, 0xc009, 0x0035, 0x002f, 0x000a, 0x0005, 0x0004, 0x009c, 0x009d,
];

/** TLS alert description 70 = protocol_version. */
const ALERT_PROTOCOL_VERSION = 70;

/**
 * Strop na odpověď serveru při ručním ClientHellu.
 *
 * K rozhodnutí stačí prvních 11 bajtů. Bez stropu by cizí server mohl
 * posílat data donekonečna a buffer by rostl bez omezení.
 */
const MAX_HELLO_RESPONSE_BYTES = 4096;

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/** Sestaví syrový ClientHello pro danou verzi protokolu. */
function buildClientHello(version, hostname) {
  const body = [
    u16(version),
    crypto.randomBytes(32),          // client_random
    Buffer.from([0x00]),             // prázdné session_id
    u16(LEGACY_CIPHER_SUITES.length * 2),
    Buffer.concat(LEGACY_CIPHER_SUITES.map(u16)),
    Buffer.from([0x01, 0x00]),       // compression: null
  ];

  const extensions = [];
  if (hostname && !isIpLiteral(hostname)) {
    const host = Buffer.from(hostname, 'ascii');
    const sni = Buffer.concat([u16(host.length + 3), Buffer.from([0x00]), u16(host.length), host]);
    extensions.push(Buffer.concat([u16(0x0000), u16(sni.length), sni]));
  }
  const groups = Buffer.concat([u16(6), u16(0x0017), u16(0x0018), u16(0x0019)]);
  extensions.push(Buffer.concat([u16(0x000a), u16(groups.length), groups]));
  extensions.push(Buffer.concat([u16(0x000b), u16(2), Buffer.from([0x01, 0x00])]));
  const sigAlgs = Buffer.concat([u16(8), u16(0x0401), u16(0x0501), u16(0x0201), u16(0x0403)]);
  extensions.push(Buffer.concat([u16(0x000d), u16(sigAlgs.length), sigAlgs]));

  const extBuf = Buffer.concat(extensions);
  const hsBody = Buffer.concat([...body, u16(extBuf.length), extBuf]);
  const handshakeMsg = Buffer.concat([
    Buffer.from([0x01, (hsBody.length >> 16) & 0xff, (hsBody.length >> 8) & 0xff, hsBody.length & 0xff]),
    hsBody,
  ]);
  return Buffer.concat([Buffer.from([0x16]), u16(version), u16(handshakeMsg.length), handshakeMsg]);
}

/**
 * Zjistí, jestli server přijímá zastaralou verzi protokolu.
 *
 * Vrací `supported: true` jen když server odpoví ServerHellem s touto verzí,
 * `false` při alertu nebo zavření spojení, `null` když se odpověď nepodařilo
 * přečíst (timeout, síťová chyba) — tedy netestováno.
 */
export function probeLegacyVersion(hostname, port, versionName, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const version = LEGACY_VERSION_CODES[versionName];
  if (version === undefined) {
    return Promise.resolve({ supported: null, reason: 'unknown_version' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    let socket;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // už zavřený
      }
      resolve(result);
    };

    const timer = setTimeout(() => done({ supported: null, reason: 'timeout' }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      socket = net.connect({ host: hostname, port });
    } catch (err) {
      // Např. ERR_SOCKET_BAD_PORT hází synchronně. Kontrakt téhle funkce je,
      // že nikdy nevyhodí — výsledek je informace, ne chyba běhu.
      return done({ supported: null, reason: err.code || 'connect_failed' });
    }

    socket.on('connect', () => {
      try {
        socket.write(buildClientHello(version, hostname));
      } catch (err) {
        done({ supported: null, reason: err.code || 'write_failed' });
      }
    });

    socket.on('data', (chunk) => {
      // Strop na buffer: nepřátelský server může posílat data po jednom bajtu
      // donekonečna. K rozhodnutí stačí prvních 11 bajtů.
      if (buf.length < MAX_HELLO_RESPONSE_BYTES) {
        buf = Buffer.concat([buf, chunk]);
      }
      if (buf.length < 5) return;

      const recordType = buf[0];
      if (recordType === 0x15) {
        // Alert record: [5] = level (1 warning, 2 fatal), [6] = description.
        if (buf.length < 7) return; // ještě nemáme obojí
        const level = buf[5];
        const description = buf[6];

        // Warning-level alert handshake neukončuje (např. unrecognized_name).
        // Považovat ho za odmítnutí verze by bylo tvrzení navíc.
        if (level !== 2) {
          return done({ supported: null, reason: `warning_alert_${description}` });
        }
        // Fatal alert jiný než protocol_version může znamenat neshodu šifer,
        // ne odmítnutí verze — o verzi pak nevíme nic.
        if (description !== ALERT_PROTOCOL_VERSION) {
          return done({ supported: null, reason: `fatal_alert_${description}` });
        }
        return done({ supported: false, reason: 'protocol_version_alert' });
      }
      if (recordType !== 0x16) {
        // Něco jiného než TLS — na tenhle port se odpovídat nemá.
        return done({ supported: null, reason: `unexpected_record_0x${recordType.toString(16)}` });
      }
      // ServerHello: verze je na offsetu 9 (5 record + 4 handshake header).
      if (buf.length < 11) return;
      const negotiated = buf.readUInt16BE(9);
      done({
        supported: negotiated === version,
        negotiated: `0x${negotiated.toString(16)}`,
      });
    });

    // Síťová chyba = k serveru jsme se nedostali → netestováno, ne „odmítl".
    socket.on('error', (err) => done({ supported: null, reason: err.code || 'socket_error' }));
    socket.on('end', () => {
      // Zavřel BEZ jediného bajtu = odmítl. Zavřel uprostřed odpovědi =
      // odpověď přišla, jen neúplná — o podpoře verze pak nevíme nic.
      if (buf.length === 0) return done({ supported: false, reason: 'closed_without_response' });
      done({ supported: null, reason: `truncated_response_${buf.length}B` });
    });
  });
}

/**
 * Kompletní sonda TLS vrstvy.
 *
 * @param {string} hostname  MUSÍ být předem ověřený SSRF guardem
 * @param {number} port
 */
export async function inspectTls(hostname, port = 443) {
  // Základní spojení — z něj bereme certifikát a vyjednané parametry.
  const base = await handshake(hostname, port);

  // Verze protokolu. Zastaralé jdou ručním ClientHellem (klient je neumí),
  // moderní přes tls.connect s min=max.
  const versionResults = await Promise.all(
    PROTOCOL_VERSIONS.map(async (version) => {
      if (LEGACY_VERSION_CODES[version] !== undefined) {
        const r = await probeLegacyVersion(hostname, port, version);
        return [version, r.supported];
      }
      const r = await handshake(hostname, port, { minVersion: version, maxVersion: version });
      if (r.ok) return [version, true];
      // null = netestováno (klient to neumí, nebo jsme se k serveru nedostali)
      if (CLIENT_LIMITATION_CODES.has(r.reason) || NETWORK_ERROR_CODES.has(r.reason)
          || r.reason === 'unsupported_option') {
        return [version, null];
      }
      return [version, false];
    })
  );
  const protocols = Object.fromEntries(versionResults);

  // Post-kvantová skupina: nabídneme JEN ji. Projde-li handshake, server ji umí.
  const pqcProbe = await handshake(hostname, port, { ecdhCurve: PQC_GROUP });
  let pqcSupported;
  if (pqcProbe.ok) {
    pqcSupported = true;
  } else if (
    pqcProbe.reason === 'unsupported_option'
    // ERR_CRYPTO_OPERATION_FAILED chodí podle buildu synchronně i asynchronně;
    // bez téhle větve se „tohle neumí náš klient" hlásilo jako „server odmítl".
    || CLIENT_LIMITATION_CODES.has(pqcProbe.reason)
    || NETWORK_ERROR_CODES.has(pqcProbe.reason)
  ) {
    // Starý OpenSSL nebo nedostupný server — netestováno, ne „nepodporuje".
    pqcSupported = null;
  } else {
    // Server odpověděl a handshake s touhle skupinou odmítl. To je měření.
    pqcSupported = false;
  }

  return {
    reachable: base.ok,
    negotiated: base.ok
      ? { protocol: base.protocol, cipher: base.cipher?.name, cipherVersion: base.cipher?.version }
      : null,
    certificate: base.certificate,
    authorized: base.ok ? base.authorized : null,
    authorizationError: base.ok ? base.authorizationError : (base.message || base.reason),
    protocols,
    pqc: {
      group: PQC_GROUP,
      supported: pqcSupported,
      probeReason: pqcProbe.ok ? null : (pqcProbe.reason || null),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Klasifikace (bez sítě, testovatelná jednotkově)
// ─────────────────────────────────────────────────────────────────────────────

/** Přijímá server zastaralé verze protokolu? */
export function classifyProtocols(protocols = {}) {
  const entries = Object.entries(protocols);
  const enabled = entries.filter(([, v]) => v === true).map(([k]) => k);
  const refused = entries.filter(([, v]) => v === false).map(([k]) => k);
  // Verze, které jsme kvůli omezení klienta vůbec neotestovali.
  const untested = entries.filter(([, v]) => v === null).map(([k]) => k);

  const deprecated = enabled.filter((v) => DEPRECATED_VERSIONS.includes(v));
  const hasModern = protocols['TLSv1.3'] === true || protocols['TLSv1.2'] === true;

  const issues = [];
  const notes = [];

  if (deprecated.length) {
    issues.push(`Server stále přijímá ${deprecated.join(' a ')} — zastaralé a v EU normách nepřijatelné.`);
  }
  if (protocols['TLSv1.3'] === false) {
    issues.push('Server nepodporuje TLS 1.3.');
  }
  if (!hasModern && protocols['TLSv1.2'] === false && protocols['TLSv1.3'] === false) {
    issues.push('Server nepřijímá TLS 1.2 ani 1.3.');
  }

  const untestedDeprecated = untested.filter((v) => DEPRECATED_VERSIONS.includes(v));
  if (untestedDeprecated.length) {
    notes.push(
      `${untestedDeprecated.join(' a ')} se nepodařilo otestovat (server neodpověděl na ClientHello). `
      + 'Nelze proto tvrdit, že je server odmítá.'
    );
  }

  return {
    enabled,
    refused,
    untested,
    deprecated,
    // false = prokázaná závada, null = nemáme dost dat na verdikt
    ok: deprecated.length > 0 ? false : (hasModern && untested.length === 0 ? true : null),
    issues,
    notes,
  };
}

/** Rozbor certifikátu ze spojení. */
export function classifyCertificate(cert, now = new Date()) {
  if (!cert) {
    // Text jde do `notes`, ne do `issues`. Kdyby šel do `issues`, summarizeTls
    // by ho započítal jako prokázanou závadu (`ok: false`) — tedy neprovedené
    // měření převlečené za nález.
    return {
      present: false,
      ok: null,
      issues: [],
      notes: ['Certifikát se nepodařilo načíst (typicky obnovená TLS session) — jeho platnost se neověřovala.'],
    };
  }

  const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
  const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
  const daysRemaining = validTo && !Number.isNaN(validTo.getTime())
    ? Math.floor((validTo - now) / 86400000)
    : null;

  const issues = [];
  if (daysRemaining !== null) {
    if (daysRemaining < 0) issues.push(`Certifikát vypršel před ${Math.abs(daysRemaining)} dny.`);
    else if (daysRemaining < 14) issues.push(`Certifikát vyprší za ${daysRemaining} dnů.`);
  }
  if (validFrom && !Number.isNaN(validFrom.getTime()) && validFrom > now) {
    issues.push('Certifikát ještě není platný.');
  }

  // Délka klíče: `bits` u RSA, u EC se uvádí křivka.
  const keyBits = typeof cert.bits === 'number' ? cert.bits : null;
  const curve = cert.asn1Curve || cert.nistCurve || null;
  // U EC certifikátu je `bits` délka křivky (256 = P-256), ne modulu.
  // Node pole s křivkou ne vždy vyplní, takže se to pozná i podle typu klíče
  // nebo podle typicky eliptických délek. Bez toho se P-256 hlásilo jako
  // „RSA klíč má jen 256 bitů" — prokázaná závada vyvozená z chybějícího pole.
  const ecLike = Boolean(curve)
    || /^(?:id-)?ecPublicKey$|^EC$/i.test(cert.pubkey?.type || cert.type || '')
    || (keyBits !== null && [224, 256, 320, 384, 512, 521].includes(keyBits));
  if (keyBits !== null && !ecLike && keyBits < 2048) {
    issues.push(`RSA klíč má jen ${keyBits} bitů (minimum je 2048).`);
  }

  const subjectCn = cert.subject?.CN || null;
  const issuerCn = cert.issuer?.CN || null;
  const selfSigned = Boolean(subjectCn && issuerCn && subjectCn === issuerCn);
  if (selfSigned) issues.push('Certifikát je podepsaný sám sebou.');

  // Když se platnost ani délka klíče nedaly přečíst, není co prohlásit
  // za v pořádku. `true` znamená „ověřeno", ne „nic mě nenapadlo".
  const notes = [];
  if (daysRemaining === null) notes.push('Datum platnosti certifikátu se nepodařilo přečíst.');
  if (keyBits === null) notes.push('Délku klíče certifikátu se nepodařilo přečíst.');

  let certOk;
  if (issues.length > 0) certOk = false;
  else if (notes.length > 0) certOk = null;
  else certOk = true;

  return {
    present: true,
    subject: subjectCn,
    issuer: issuerCn,
    notes,
    validFrom: cert.valid_from || null,
    validTo: cert.valid_to || null,
    daysRemaining,
    keyBits,
    curve,
    selfSigned,
    ok: certOk,
    issues,
  };
}

/**
 * Post-kvantová připravenost.
 *
 * `null` znamená, že sonda proběhnout nemohla (starý OpenSSL bez ML-KEM) —
 * to je NEPRŮKAZNÉ, ne „nepodporuje".
 */
export function classifyPqc(pqc = {}) {
  if (pqc.supported === true) {
    return {
      supported: true,
      status: 'pass',
      rationale: `Server přijal hybridní post-kvantovou výměnu klíčů ${pqc.group}. Provoz je chráněný i proti útoku „sesbírej teď, dešifruj později".`,
    };
  }
  if (pqc.supported === false) {
    return {
      supported: false,
      status: 'fail',
      rationale: `Server nepřijal ${pqc.group}. Zaznamenaný provoz půjde zpětně dešifrovat, až bude k dispozici dostatečně velký kvantový počítač. Testovala se tahle jedna skupina — jinou post-kvantovou server podporovat může.`,
    };
  }
  // Neprůkazné má dvě různé příčiny a poradit „aktualizujte Node" someone,
  // ke komu se sonda vůbec nedostala, je zavádějící.
  const networkFailure = pqc.probeReason && NETWORK_ERROR_CODES.has(pqc.probeReason);
  return {
    supported: null,
    status: 'inconclusive',
    probeReason: pqc.probeReason || null,
    rationale: networkFailure
      ? `Sonda se k serveru nedostala (${pqc.probeReason}), takže o podpoře ${pqc.group} nelze říct nic.`
      : `Sondu nešlo provést — tenhle build Node/OpenSSL skupinu ${pqc.group} nezná. Vyžaduje OpenSSL 3.5+ (Node 22+).`,
  };
}

/** Souhrn nad dílčími klasifikacemi. */
export function summarizeTls(inspection, now = new Date()) {
  if (!inspection.reachable) {
    return {
      ok: null,
      protocols: null,
      certificate: null,
      pqc: null,
      issues: [`TLS spojení se nepodařilo navázat: ${inspection.authorizationError || 'neznámý důvod'}.`],
      notes: [],
      rating: 'NEPRŮKAZNÉ: TLS vrstvu se nepodařilo prozkoumat.',
    };
  }

  const protocols = classifyProtocols(inspection.protocols);
  const certificate = classifyCertificate(inspection.certificate, now);
  const pqc = classifyPqc(inspection.pqc);

  const issues = [...protocols.issues, ...certificate.issues];
  const notes = [...(protocols.notes || []), ...(certificate.notes || [])];
  if (!inspection.authorized && inspection.authorizationError) {
    issues.push(`Certifikát neprošel ověřením: ${inspection.authorizationError}`);
  }

  // Tři stavy, ne dva:
  //   false = něco je prokazatelně špatně
  //   null  = sonda neproběhla celá, na verdikt to nestačí
  //   true  = ověřeno bez nálezu
  // PQC do verdiktu nevstupuje — chybějící post-kvantová výměna klíčů je
  // dnes doporučení, ne závada.
  let ok;
  if (issues.length > 0 || protocols.ok === false || certificate.ok === false) {
    ok = false;
  } else if (protocols.ok === null || certificate.ok === null) {
    ok = null;
  } else {
    ok = true;
  }

  // Rating se řídí verdiktem `ok`, ne jen počtem nálezů. Dřív mohl objekt
  // současně nést `ok: null` a text „TLS konfigurace v pořádku" — a člověk
  // si přečte ten text.
  let rating;
  if (ok === false) {
    rating = `NALEZENO ${issues.length} ${issues.length === 1 ? 'problém' : 'problémů'} v TLS konfiguraci.`;
  } else if (ok === null) {
    rating = 'NEPRŮKAZNÉ: část TLS konfigurace se nepodařilo ověřit.';
  } else if (pqc.supported === true) {
    rating = 'TLS konfigurace bez nálezu, včetně hybridní post-kvantové výměny klíčů.';
  } else if (pqc.supported === false) {
    rating = 'TLS konfigurace bez nálezu. Post-kvantová výměna klíčů zatím není nasazená.';
  } else {
    rating = 'TLS konfigurace bez nálezu. Post-kvantovou výměnu klíčů se nepodařilo ověřit.';
  }

  return { ok, protocols, certificate, pqc, issues, notes, rating };
}
