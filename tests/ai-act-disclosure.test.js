import { evaluateInteractionObligation, OBLIGATION_STATUS } from '../ai-act.js';
import { PLACEMENT } from '../disclosure-placement.js';

/**
 * Verdikt čl. 50 odst. 1 po zpřísnění (úkol A4).
 *
 * Dřív z „na stránce je někde slovo AI" plynulo SPLNĚNO. Projde tím zmínka
 * v patičce i v marketingové větě — a report by tvrdil splnění povinnosti,
 * kterou nikdo neověřil.
 */

const withAi = (disclosure) => ({
  aiApiCalls: ['https://api.openai.com/v1/chat/completions'],
  chatWidgets: [],
  dom: {},
  hasDisclaimer: true,
  disclosure,
});

const placement = (p) => ({ placement: p, occurrences: 1, rationale: 'x'.repeat(40) });

describe('prokázané použití AI', () => {
  test('viditelné upozornění je splněno', () => {
    const result = evaluateInteractionObligation(withAi(placement(PLACEMENT.PROMINENT)));
    expect(result.status).toBe(OBLIGATION_STATUS.PASS);
  });

  test('upozornění jen v patičce už NENÍ splněno', () => {
    // Přesně ta změna, o kterou v A4 jde.
    const result = evaluateInteractionObligation(withAi(placement(PLACEMENT.FOOTER_ONLY)));
    expect(result.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
    expect(result.status).not.toBe(OBLIGATION_STATUS.PASS);
  });

  test('skryté upozornění je porušení', () => {
    const result = evaluateInteractionObligation(withAi(placement(PLACEMENT.HIDDEN)));
    expect(result.status).toBe(OBLIGATION_STATUS.FAIL);
  });

  test('žádné upozornění je porušení', () => {
    const result = evaluateInteractionObligation(withAi(placement(PLACEMENT.NONE)));
    expect(result.status).toBe(OBLIGATION_STATUS.FAIL);
  });

  test('důkaz nese i umístění, nejen ano/ne', () => {
    // Bez toho by kontrolor viděl verdikt a nevěděl, z čeho plyne.
    const result = evaluateInteractionObligation(withAi(placement(PLACEMENT.FOOTER_ONLY)));
    expect(result.evidence.disclosurePlacement).toBe(PLACEMENT.FOOTER_ONLY);
    expect(result.rationale).toContain('volání AI API');
  });
});

describe('zpětná slučitelnost', () => {
  test('bez údaje o umístění se chová jako dřív', () => {
    // Starší uložené běhy `disclosure` nemají. Nesmí kvůli tomu spadnout
    // ani tiše změnit verdikt.
    const result = evaluateInteractionObligation({
      aiApiCalls: ['https://api.openai.com/v1/x'],
      hasDisclaimer: true,
    });
    expect(result.status).toBe(OBLIGATION_STATUS.PASS);
    expect(result.evidence.disclosurePlacement).toBeNull();
  });

  test('bez umístění a bez textu zůstává porušení', () => {
    const result = evaluateInteractionObligation({
      aiApiCalls: ['https://api.openai.com/v1/x'],
      hasDisclaimer: false,
    });
    expect(result.status).toBe(OBLIGATION_STATUS.FAIL);
  });
});

describe('bez prokázaného použití AI', () => {
  test('umístění verdikt nemění — pořád je neprůkazný', () => {
    // Sebelepší upozornění nedokazuje, že se AI používá; a jeho absence
    // nedokazuje porušení, protože server-side integraci sken nevidí.
    const result = evaluateInteractionObligation({
      aiApiCalls: [],
      chatWidgets: [],
      dom: {},
      hasDisclaimer: false,
      disclosure: placement(PLACEMENT.NONE),
    });
    expect(result.status).toBe(OBLIGATION_STATUS.INCONCLUSIVE);
  });
});
