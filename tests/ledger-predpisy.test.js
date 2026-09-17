import {
  PREDPISY_OTISKU,
  AKTUALNI_PREDPIS,
  AKTUALNI_SCHEMA_OTISKU,
  auditResultOf,
  overOtisk,
  digestOf,
} from '../audit-ledger.js';

/**
 * Předpisy otisku výsledku.
 *
 * VZNIKLO Z PROVOZNÍHO NÁLEZU: 45 ze 48 záznamů nesouhlasilo a spis je
 * tiskl jako „Otisk souhlasí: NE", tedy jako manipulaci se záznamem.
 * Žádná manipulace se nestala — předpis se třikrát změnil a pole `schema`
 * přitom celou dobu hlásilo `1`. Byla to konstanta, která nezaznamenávala
 * nic.
 *
 * Testy níž jsou pojistka proti opakování: přibíjejí sadu klíčů ke každému
 * předpisu, takže změna bez přidání nové verze shodí sadu tady — ne až
 * v zákazníkově spisu.
 */

/** Session, která protne obě větve (agentní běh i předpisová kontrola). */
const bezneBehy = {
  agentni: {
    status: 'completed',
    bugs: ['n'], warnings: ['w'], runErrors: [],
    summary: 's', steps: [{ step: 1, action: 'click', screenshot: '/x.png' }],
    preConsent: { cookies: ['a'] }, cookieBanner: { clicked: true },
    ukonceni: 'limit-kroku', nerozhodnutychKroku: 1, nezmerenoBlokaci: 0,
    modelObservations: ['m'], runNotes: ['r'],
  },
  kontrola: {
    status: 'completed', kind: 'compliance-scan',
    bugs: [], warnings: [], runErrors: [],
    auditSlug: 'analyze-nis2', verdict: 'findings', ruleRefs: ['nis2.headers.hsts.v1'],
    checks: [{ key: 'k', ruleRef: 'r', ok: false, rationale: 'proč', label: 'popisek' }],
    summary: 's', steps: [],
  },
};

/**
 * Sada klíčů, kterou KAŽDÝ předpis produkuje. Přibitá schválně.
 *
 * Změna kteréhokoli řádku znamená, že se změnil předpis — a pak se MUSÍ
 * přidat nový záznam do `PREDPISY_OTISKU`, ne upravit stávající. Staré
 * předpisy jsou historická fakta o tom, co se tehdy počítalo; přepsat je
 * znamená ztratit možnost ověřit záznamy z té doby.
 */
const KLICE = {
  '2026-08-25': {
    agentni: ['bugs', 'runErrors', 'status', 'steps', 'summary', 'warnings'],
    kontrola: ['bugs', 'runErrors', 'status', 'steps', 'summary', 'warnings'],
  },
  '2026-08-28': {
    agentni: ['bugs', 'runErrors', 'status', 'steps', 'summary', 'warnings'],
    kontrola: ['auditSlug', 'bugs', 'checks', 'kind', 'ruleRefs', 'runErrors',
      'status', 'steps', 'summary', 'verdict', 'warnings'],
  },
  '2026-09-10': {
    agentni: ['bugs', 'cookieBanner', 'preConsent', 'runErrors', 'status',
      'steps', 'summary', 'warnings'],
    kontrola: ['auditSlug', 'bugs', 'checks', 'cookieBanner', 'kind', 'preConsent',
      'ruleRefs', 'runErrors', 'status', 'steps', 'summary', 'verdict', 'warnings'],
  },
  '2026-09-17': {
    agentni: ['bugs', 'cookieBanner', 'modelObservations', 'nerozhodnutychKroku',
      'nezmerenoBlokaci', 'preConsent', 'runErrors', 'runNotes', 'status',
      'steps', 'summary', 'ukonceni', 'warnings'],
    kontrola: ['auditSlug', 'bugs', 'checks', 'cookieBanner', 'kind',
      'modelObservations', 'nerozhodnutychKroku', 'nezmerenoBlokaci', 'preConsent',
      'ruleRefs', 'runErrors', 'runNotes', 'status', 'steps', 'summary',
      'ukonceni', 'verdict', 'warnings'],
  },
};

describe('předpisy otisku jsou přibité', () => {
  it('seznam předpisů odpovídá seznamu přibitých sad klíčů', () => {
    expect(PREDPISY_OTISKU.map((p) => p.id)).toEqual(Object.keys(KLICE));
  });

  describe.each(PREDPISY_OTISKU)('$id', (predpis) => {
    it.each(['agentni', 'kontrola'])('sada klíčů u %s běhu se nezměnila', (druh) => {
      expect(Object.keys(predpis.sestav(bezneBehy[druh])).sort())
        .toEqual(KLICE[predpis.id][druh]);
    });
  });

  it('artefakty se do otisku nepočítají v žádném předpisu', () => {
    // Cesta ke screenshotu se mění a otisk by pak nesouhlasil
    // u nezměněného výsledku.
    for (const p of PREDPISY_OTISKU) {
      const kroky = p.sestav(bezneBehy.agentni).steps;
      for (const k of kroky) expect(k).not.toHaveProperty('screenshot');
    }
  });

  it('každý předpis dává jiný otisk téže session', () => {
    // Kdyby dva dávaly stejný, jeden z nich by byl zbytečný — a hlavně by
    // ověření nedokázalo rozlišit, kterým z nich záznam vznikl.
    const otisky = PREDPISY_OTISKU.map((p) => digestOf(p.sestav(bezneBehy.kontrola)));
    expect(new Set(otisky).size).toBe(PREDPISY_OTISKU.length);
  });

  it('nejstarší předpis NEZÁVISÍ na výsledku předpisové kontroly', () => {
    // Tohle je ta ověřená vada, kvůli které 13 různých skenů mělo týž
    // otisk. Test ji drží zaznamenanou: předpis z 25. 8. `checks` opravdu
    // ignoroval a ověření se s tím musí umět vypořádat.
    const prvni = PREDPISY_OTISKU[0];
    const a = digestOf(prvni.sestav({ ...bezneBehy.kontrola, checks: [{ key: 'x', ok: true }] }));
    const b = digestOf(prvni.sestav({ ...bezneBehy.kontrola, checks: [{ key: 'y', ok: false }] }));
    expect(a).toBe(b);
  });

  it('aktuální předpis je poslední a jeho číslo je zapsané', () => {
    expect(AKTUALNI_PREDPIS).toBe(PREDPISY_OTISKU[PREDPISY_OTISKU.length - 1]);
    expect(AKTUALNI_SCHEMA_OTISKU).toBe(AKTUALNI_PREDPIS.schema);
  });

  it('auditResultOf vybírá nejnovější předpis daného čísla', () => {
    expect(digestOf(auditResultOf(bezneBehy.kontrola, 1)))
      .toBe(digestOf(PREDPISY_OTISKU.find((p) => p.id === '2026-09-10').sestav(bezneBehy.kontrola)));
    expect(digestOf(auditResultOf(bezneBehy.kontrola, 2)))
      .toBe(digestOf(PREDPISY_OTISKU.find((p) => p.id === '2026-09-17').sestav(bezneBehy.kontrola)));
  });
});

describe('overOtisk — manipulaci tvrdíme jen tam, kde je podložená', () => {
  const zaznam = (over) => ({ sessionId: 's', resultDigest: 'x', ...over });

  it('otisk z KTERÉHOKOLI historického předpisu se ověří', () => {
    for (const p of PREDPISY_OTISKU) {
      const r = zaznam({ schema: 1, resultDigest: digestOf(p.sestav(bezneBehy.kontrola)) });
      const v = overOtisk(bezneBehy.kontrola, r);
      expect(v.stav).toBe('ok');
      expect(v.predpis).toBe(p.id);
    }
  });

  it('starý záznam, který nesedí na nic, je NEPRŮKAZNÝ, ne manipulace', () => {
    // `schema: 1` nesly tři různé předpisy, takže z neshody nelze usoudit,
    // jestli se změnila data, nebo náš kód. Obvinit zákazníka z manipulace
    // váží stejně jako zamlčet skutečný zásah.
    const v = overOtisk(bezneBehy.kontrola, zaznam({ schema: 1, resultDigest: 'a'.repeat(64) }));
    expect(v.stav).toBe('neoveritelne');
    expect(v.duvod).toMatch(/nezaznamenávala/);
  });

  it('záznam s JEDNOZNAČNÝM předpisem a neshodou JE nesouhlas', () => {
    // Od chvíle, kdy se číslo opravdu zvyšuje, je tvrzení o rozporu
    // podložené — a zamlčet ho by byla druhá strana téže chyby.
    const v = overOtisk(bezneBehy.kontrola, zaznam({ schema: 2, resultDigest: 'a'.repeat(64) }));
    expect(v.stav).toBe('nesouhlasi');
  });

  it('chybějící session ani chybějící otisk nejsou manipulace', () => {
    expect(overOtisk(null, zaznam({ schema: 2 })).stav).toBe('neoveritelne');
    expect(overOtisk(bezneBehy.kontrola, { sessionId: 's' }).stav).toBe('neoveritelne');
    expect(overOtisk(bezneBehy.kontrola, null).stav).toBe('neoveritelne');
  });

  it('chybějící schema se čte jako doba před verzováním', () => {
    const r = { sessionId: 's', resultDigest: 'a'.repeat(64) };
    expect(overOtisk(bezneBehy.kontrola, r).stav).toBe('neoveritelne');
  });
});

describe('slabé ověření se nevydává za plné', () => {
  const kontrola = {
    status: 'completed', kind: 'compliance-scan',
    bugs: [], warnings: [], runErrors: [],
    auditSlug: 'analyze-nis2', verdict: 'findings', ruleRefs: [],
    checks: [{ key: 'k', ruleRef: 'r', ok: false, rationale: 'porušeno' }],
    summary: 's', steps: [],
  };

  it('u nejstaršího předpisu se řekne, co otisk nekryl', () => {
    // Otisk z 25. 8. nezávisel na `checks`, takže „souhlasí" u něj tvrdí
    // podstatně míň než u novějších. Nechat to bez poznámky by znamenalo
    // vydávat slabé ověření za plné.
    const v = overOtisk(kontrola, {
      sessionId: 's', schema: 1,
      resultDigest: digestOf(PREDPISY_OTISKU[0].sestav(kontrola)),
    });

    expect(v.stav).toBe('ok');
    expect(v.nekryje).toContain('verdikt předpisové kontroly');
    expect(v.duvod).toMatch(/nevypovídá/);
  });

  it('u novějších předpisů se nic nedodává', () => {
    for (const p of PREDPISY_OTISKU.slice(1)) {
      const v = overOtisk(kontrola, {
        sessionId: 's', schema: p.schema,
        resultDigest: digestOf(p.sestav(kontrola)),
      });
      expect(v.stav).toBe('ok');
      expect(v.nekryje).toEqual([]);
    }
  });

  it('u agentního běhu se výhrada o `checks` neuvádí — netýká se ho', () => {
    const agentni = { status: 'completed', bugs: ['n'], warnings: [], runErrors: [], summary: '', steps: [] };
    const v = overOtisk(agentni, {
      sessionId: 's', schema: 1,
      resultDigest: digestOf(PREDPISY_OTISKU[0].sestav(agentni)),
    });
    expect(v.stav).toBe('ok');
    expect(v.nekryje).toEqual([]);
  });
});
