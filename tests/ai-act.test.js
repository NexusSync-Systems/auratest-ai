import {
  OBLIGATION_STATUS,
  AI_DISCLAIMER_PATTERN,
  isAiApiUrl,
  isChatWidgetUrl,
  evaluateInteractionObligation,
  evaluateSyntheticMarkingObligation,
  evaluateOutOfScopeObligations,
  summarizeObligations,
} from '../ai-act.js';

/**
 * Klasifikace podle čl. 50 AI Actu.
 *
 * Logika je záměrně oddělená od Playwrightu, aby šla testovat bez prohlížeče —
 * v tomhle projektu vznikala většina chyb právě v místech, která se dala
 * ověřit jen spuštěním celého skeneru.
 */

describe('Detekce upozornění na AI', () => {
  it('nematchuje "ai" uvnitř slova', () => {
    // Původní `includes('ai')` matchovalo email/detail/main/retail,
    // takže skener nikdy nic nenašel.
    const falsePositives = [
      'Napište nám na email',
      'Detail produktu',
      'Main page',
      'fair retail chair',
      'Mail nám pošlete',
    ];
    for (const text of falsePositives) {
      expect(AI_DISCLAIMER_PATTERN.test(text)).toBe(false);
    }
  });

  it('najde skutečná upozornění včetně českých', () => {
    const hits = [
      'Tento text vygenerovala AI',
      'Používáme umělou inteligenci',
      'Komunikujete s AI asistentem',
      'This is an AI assistant',
      'generativní model',
      'virtuální asistent vám pomůže',
      'Náš chatbot odpoví',
    ];
    for (const text of hits) {
      expect(AI_DISCLAIMER_PATTERN.test(text)).toBe(true);
    }
  });
});

describe('Rozpoznání URL', () => {
  it('pozná volání AI API', () => {
    expect(isAiApiUrl('https://api.openai.com/v1/chat/completions')).toBe(true);
    expect(isAiApiUrl('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isAiApiUrl('https://example.com/api/products')).toBe(false);
  });

  it('pozná chatovací widget', () => {
    expect(isChatWidgetUrl('https://widget.intercom.io/widget/abc')).toBe(true);
    expect(isChatWidgetUrl('https://static.zdassets.com/ekr/snippet.js')).toBe(true);
    expect(isChatWidgetUrl('https://example.com/main.js')).toBe(false);
  });
});

describe('Povinnost 1 — informování o komunikaci s AI', () => {
  it('volání AI API + upozornění = splněno', () => {
    const result = evaluateInteractionObligation({
      aiApiCalls: ['https://api.openai.com/v1/chat/completions'],
      hasDisclaimer: true,
    });
    expect(result.status).toBe(OBLIGATION_STATUS.PASS);
    expect(result.id).toBe('art50.1');
  });

  it('volání AI API bez upozornění = nesplněno', () => {
    const result = evaluateInteractionObligation({
      aiApiCalls: ['https://api.openai.com/v1/chat/completions'],
      hasDisclaimer: false,
    });
    expect(result.status).toBe(OBLIGATION_STATUS.FAIL);
  });

  it('chat widget bez volání AI API je NEPRŮKAZNÉ, ne nesplněno', () => {
    // Za widgetem může sedět živý operátor — pak se povinnost neuplatní.
    // Tvrdit porušení by byl falešný poplach.
    const result = evaluateInteractionObligation({
      aiApiCalls: [],
      chatWidgets: ['widget.intercom.io'],
      hasDisclaimer: false,
    });
    expect(result.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    expect(result.rationale).toMatch(/živý operátor|posuďte ručně/i);
  });

  it('konverzační prvek v DOM zvedne výsledek nad "nic jsme nenašli"', () => {
    const withoutDom = evaluateInteractionObligation({ aiApiCalls: [] });
    const withDom = evaluateInteractionObligation({
      aiApiCalls: [],
      dom: { chatIndicators: ['#intercom-container'] },
    });

    expect(withoutDom.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    expect(withDom.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    // Oba jsou neprůkazné, ale odůvodnění se liší — to je smysl detekce z DOM.
    expect(withoutDom.rationale).toMatch(/Nezachyceno/);
    expect(withDom.rationale).toMatch(/konverzační prvky/);
  });

  it('žádný signál = neprůkazné se zmínkou o server-side', () => {
    const result = evaluateInteractionObligation({ aiApiCalls: [] });
    expect(result.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    expect(result.rationale).toMatch(/[Ss]erver-side/);
  });
});

describe('Povinnost 2 — označení syntetického obsahu', () => {
  it('bez obrázků se povinnost neuplatní', () => {
    const result = evaluateSyntheticMarkingObligation({
      dom: { images: { total: 0, sampled: 0, withC2pa: 0 } },
    });
    expect(result.status).toBe(OBLIGATION_STATUS.NOT_APPLICABLE);
  });

  it('nalezené C2PA je neprůkazné, ne splněno', () => {
    // Že JEDEN obrázek má manifest, neznamená, že jsou označené všechny
    // syntetické výstupy.
    const result = evaluateSyntheticMarkingObligation({
      dom: { images: { total: 10, sampled: 8, withC2pa: 3 } },
    });
    expect(result.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    expect(result.status).not.toBe(OBLIGATION_STATUS.PASS);
  });

  it('bez C2PA a s voláním AI API upozorní na podezření', () => {
    const result = evaluateSyntheticMarkingObligation({
      aiApiCalls: ['https://api.openai.com/v1/images/generations'],
      dom: { images: { total: 5, sampled: 5, withC2pa: 0 } },
    });
    expect(result.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    expect(result.rationale).toMatch(/podezření/i);
  });

  it('bez C2PA a bez AI API nevyvozuje porušení', () => {
    const result = evaluateSyntheticMarkingObligation({
      aiApiCalls: [],
      dom: { images: { total: 5, sampled: 5, withC2pa: 0 } },
    });
    expect(result.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    expect(result.rationale).toMatch(/nelze usuzovat na porušení/i);
  });
});

describe('Povinnosti 3 a 4 — mimo dosah skeneru', () => {
  it('jsou vždy neprůkazné a označené jako mimo dosah', () => {
    const results = evaluateOutOfScopeObligations({});
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
      expect(r.outOfScope).toBe(true);
    }
    expect(results.map((r) => r.id)).toEqual(['art50.3', 'art50.4']);
  });

  it('náznak biometrie se promítne do odůvodnění', () => {
    const [emotion] = evaluateOutOfScopeObligations({
      dom: { biometricHints: ['text zmiňuje rozpoznávání obličeje nebo emocí'] },
    });
    expect(emotion.rationale).toMatch(/biometri/i);
  });
});

describe('Souhrn', () => {
  const inconclusive = (id) => ({ id, status: OBLIGATION_STATUS.INCONCLUSIVE });
  const pass = (id) => ({ id, status: OBLIGATION_STATUS.PASS });
  const fail = (id) => ({ id, status: OBLIGATION_STATUS.FAIL });

  it('jediné prokazatelné porušení znamená nesplněno', () => {
    const summary = summarizeObligations([
      fail('art50.1'), inconclusive('art50.2'), inconclusive('art50.3'), inconclusive('art50.4'),
    ]);
    expect(summary.isCompliant).toBe(false);
    expect(summary.rating).toMatch(/NESPLNĚNO/);
  });

  it('neprůkazné výsledky nesmí vyjít jako splněno', () => {
    // Klíčové pravidlo: dvě ze čtyř povinností zvenčí ověřit nejde,
    // takže celková shoda se tvrdit nedá.
    const summary = summarizeObligations([
      pass('art50.1'), inconclusive('art50.2'), inconclusive('art50.3'), inconclusive('art50.4'),
    ]);
    expect(summary.isCompliant).toBeNull();
    expect(summary.rating).toMatch(/NEPRŮKAZNÉ/);
  });

  it('započítá i not_applicable', () => {
    const summary = summarizeObligations([
      pass('art50.1'),
      { id: 'art50.2', status: OBLIGATION_STATUS.NOT_APPLICABLE },
      inconclusive('art50.3'), inconclusive('art50.4'),
    ]);
    expect(summary.counts).toEqual({ pass: 1, fail: 0, inconclusive: 2, not_applicable: 1 });
  });

  it('reálný běh nikdy nevrátí true, protože odst. 3 a 4 jsou vždy neprůkazné', () => {
    const obligations = [
      evaluateInteractionObligation({ aiApiCalls: ['https://api.openai.com/x'], hasDisclaimer: true }),
      evaluateSyntheticMarkingObligation({ dom: { images: { total: 0, sampled: 0, withC2pa: 0 } } }),
      ...evaluateOutOfScopeObligations({}),
    ];
    const summary = summarizeObligations(obligations);
    expect(summary.isCompliant).toBeNull();
  });
});
