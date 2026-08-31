import {
  isTrackerStorageKey,
  isTrackerCookieName,
  nameSegments,
} from '../tracker-match.js';

/**
 * Falešné nálezy z podřetězcového porovnávání.
 *
 * Všechny případy níž byly ověřené jako skutečné vady: jediný takový klíč
 * stačil na verdikt „FAIL: ePrivacy Violation", tedy na doklad o porušení
 * u webu, který žádný tracker nepoužívá.
 */

describe('klíče úložiště — vlastní klíče aplikace nejsou trackery', () => {
  const vlastni = [
    ['image_gallery', 'obsahuje „_ga"'],
    ['mega_gallery', 'obsahuje „_ga"'],
    ['cheap_flights', 'obsahuje „heap"'],
    ['userSegment', 'obsahuje „segment"'],
    ['segments', 'množné číslo vlastního pojmu'],
    ['heapSize', 'obsahuje „heap"'],
    ['clarityLevel', 'obsahuje „clarity"'],
    ['galleryIndex', 'obsahuje „ga" jako podřetězec'],
  ];

  for (const [key, proc] of vlastni) {
    it(`${key} (${proc})`, () => {
      expect(isTrackerStorageKey(key)).toBe(false);
    });
  }
});

describe('klíče úložiště — skutečné trackery se poznat musí', () => {
  const trackery = [
    'amplitude_id',
    'mixpanel_token',
    'ajs_anonymous_id',
    'ajs_user_id',
    '_ga_G1XYZ',
    'hotjar_session',
    'posthog_id',
    'segment_write_key',
    'heap_user',
    'intercom-state',
    'hubspot_utk',
  ];

  for (const key of trackery) {
    it(key, () => {
      expect(isTrackerStorageKey(key)).toBe(true);
    });
  }
});

describe('názvy cookies — hranice předpony', () => {
  it('IDE od DoubleClicku nechytá vlastní IDENTITY', () => {
    // Předpona `IDE` se dřív porovnávala holým startsWith. Cookie
    // `IDENTITY` je přitom naprosto běžný název vlastní relační cookie.
    expect(isTrackerCookieName('IDE')).toBe(true);
    expect(isTrackerCookieName('IDENTITY')).toBe(false);
    expect(isTrackerCookieName('IDEA_TOKEN')).toBe(false);
  });

  it('_ga nechytá _gallery', () => {
    expect(isTrackerCookieName('_ga')).toBe(true);
    expect(isTrackerCookieName('_ga_G1XYZ')).toBe(true);
    expect(isTrackerCookieName('_gallery')).toBe(false);
  });

  it('velké písmeno je hranice, takže _hjSessionUser projde', () => {
    // Hotjar své cookie pojmenovává camelCase. Kdyby se hranice hledala
    // až po převedení na malá písmena, zmizela by.
    expect(isTrackerCookieName('_hjSessionUser_123')).toBe(true);
    expect(isTrackerCookieName('_hjid')).toBe(true);
  });

  it('_gat a _gac jsou skutečné cookies Google Analytics', () => {
    expect(isTrackerCookieName('_gat')).toBe(true);
    expect(isTrackerCookieName('_gat_gtag_UA_1_1')).toBe(true);
    expect(isTrackerCookieName('_gac_UA_1')).toBe(true);
  });

  it('ttclid nechytá ttclid_vlastni', () => {
    expect(isTrackerCookieName('ttclid')).toBe(true);
    expect(isTrackerCookieName('ttclid_x')).toBe(false);
  });

  it('prázdný a nesmyslný vstup nespadne', () => {
    for (const v of [null, undefined, '', 42, {}]) {
      expect(isTrackerCookieName(v)).toBe(false);
      expect(isTrackerStorageKey(v)).toBe(false);
    }
  });
});

describe('nameSegments', () => {
  it('rozdělí camelCase i oddělovače', () => {
    expect(nameSegments('_hjSessionUser')).toEqual(['hj', 'session', 'user']);
    expect(nameSegments('ajs_user_id')).toEqual(['ajs', 'user', 'id']);
    expect(nameSegments('userSegment')).toEqual(['user', 'segment']);
  });
});
