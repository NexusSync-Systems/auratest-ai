import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Regresní testy přístupnosti.
 *
 * Aplikace překládá axe pravidla `label`, `button-name`, `page-has-heading-one`
 * a `use-of-color` (App.jsx), ale sama je porušovala. Tyhle testy hlídají,
 * aby se to nevrátilo.
 */

vi.mock('./lib/firebase.js', () => ({
  firebaseApp: {},
  firebaseAuth: { currentUser: null },
  firebaseDb: {},
}));

// Přihlášeného uživatele si test nastaví sám.
//
// Menu aplikace se odhlášenému nezobrazuje — vedlo by na zamčené sekce.
// Testy, které menu zkoumají, proto musí renderovat jako přihlášený.
let authUser = null;

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth, cb) => {
    cb(authUser);
    return () => {};
  },
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  setDoc: vi.fn(),
  getDoc: vi.fn(async () => ({ exists: () => false })),
  collection: vi.fn(),
  addDoc: vi.fn(),
}));

const App = (await import('./App.jsx')).default;

beforeEach(() => {
  authUser = null;

  // Na `/` je od zavedení veřejné části úvodní stránka, ne aplikace. Tyhle
  // testy zkoumají přihlašovací obrazovku a rozhraní aplikace, takže si
  // adresu musí nastavit — jinak by prověřovaly marketingový text.
  window.history.replaceState({}, '', '/prihlaseni');

  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => '[]',
  }));
});

describe('Přístupnost', () => {
  it('každý htmlFor má odpovídající id (axe pravidlo `label`)', () => {
    const { container } = render(<App />);

    const labels = [...container.querySelectorAll('label[for]')];
    expect(labels.length).toBeGreaterThan(0);

    const orphans = labels
      .map((l) => l.getAttribute('for'))
      .filter((id) => !container.querySelector(`#${CSS.escape(id)}`));

    expect(orphans).toEqual([]);
  });

  it('žádný label není bez vazby na ovládací prvek', () => {
    const { container } = render(<App />);

    const unbound = [...container.querySelectorAll('label')].filter((label) => {
      if (label.hasAttribute('for')) return false;
      // Label, který ovládací prvek obaluje, je také platná vazba.
      return !label.querySelector('input, select, textarea');
    });

    expect(unbound.map((l) => l.textContent.trim())).toEqual([]);
  });

  it('žádné id se neopakuje', () => {
    const { container } = render(<App />);

    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

    expect(duplicates).toEqual([]);
  });

  it('interaktivní prvky navigace jsou tlačítka, ne divy s onClick', () => {
    authUser = { uid: 'test-uid', email: 'test@example.com' };
    window.history.replaceState({}, '', '/hub');
    const { container } = render(<App />);

    const nav = container.querySelector('.nav-menu');
    expect(nav).toBeTruthy();

    const items = [...nav.querySelectorAll('.nav-item')];
    expect(items.length).toBeGreaterThan(0);
    // `page-has-heading-one` a `button-name`: každý ovladač musí být
    // fokusovatelný a mít dostupný název.
    for (const item of items) {
      expect(item.tagName).toBe('BUTTON');
      expect(item.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('aktivní záložka je označená aria-current, ne jen barvou', () => {
    authUser = { uid: 'test-uid', email: 'test@example.com' };
    window.history.replaceState({}, '', '/hub');
    const { container } = render(<App />);
    expect(container.querySelector('.nav-item[aria-current="page"]')).toBeTruthy();
  });

  it('odhlášenému se menu nezobrazuje — vedlo by na zamčené sekce', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.nav-menu')).toBeNull();
  });

  it('přihlašovacím formulářem lze projít klávesnicí', async () => {
    const user = userEvent.setup();
    render(<App />);

    const email = await screen.findByLabelText(/e-?mail/i);
    const password = await screen.findByLabelText(/heslo/i);

    await user.tab();
    // Postupně se dostaneme na obě pole, aniž bychom použili myš.
    let guard = 0;
    while (document.activeElement !== email && guard++ < 40) {
      await user.tab();
    }
    expect(document.activeElement).toBe(email);

    await user.tab();
    expect(document.activeElement).toBe(password);
  });

  it('přepínání přihlášení/registrace je tlačítko, ne prázdný odkaz', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    // Dřív <a href="#" onClick> — nebyl to ani odkaz, ani tlačítko.
    expect(container.querySelector('a[href="#"]')).toBeNull();

    const toggle = await screen.findByRole('button', { name: /zaregistrujte se/i });
    await user.click(toggle);

    expect(await screen.findByRole('button', { name: /přihlaste se/i })).toBeInTheDocument();
  });

  it('stav běhu má role="status" pro oznámení screen readeru', () => {
    const { container } = render(<App />);
    const status = container.querySelector('.status-badge[role="status"]');

    expect(status).toBeTruthy();
    // Barevná tečka sama o sobě informaci nenese.
    expect(status.querySelector('.status-dot[aria-hidden="true"]')).toBeTruthy();
    expect(status.textContent.trim().length).toBeGreaterThan(0);
  });
});
