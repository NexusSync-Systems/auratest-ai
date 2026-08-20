import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Smoke testy hlavní komponenty.
 *
 * Motivace: `onSubmit={handleAuthSubmit}` odkazovalo na neexistující funkci
 * a shazovalo přihlašovací obrazovku na bílou stránku. Chytil by to jediný
 * render test — frontend ale neměl žádný.
 */

// Firebase se v testu nesmí připojovat.
let authCallback = null;

vi.mock('./lib/firebase.js', () => ({
  firebaseApp: {},
  firebaseAuth: { currentUser: null },
  firebaseDb: {},
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth, cb) => {
    authCallback = cb;
    // Simulace odhlášeného uživatele.
    cb(null);
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
  authCallback = null;
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => '[]',
  }));
});

describe('App', () => {
  it('se vykreslí bez pádu', () => {
    expect(() => render(<App />)).not.toThrow();
  });

  it('zobrazí přihlašovací formulář odhlášenému uživateli', async () => {
    render(<App />);

    // Přepnutí na jinou záložku než výchozí auraguard dřív shodilo aplikaci
    // (ReferenceError: handleAuthSubmit is not defined).
    const loginHeadings = await screen.findAllByText(/Přihlášení/i);
    expect(loginHeadings.length).toBeGreaterThan(0);
  });

  it('přihlašovací formulář má popsaná pole (label -> input)', async () => {
    render(<App />);

    // WCAG 4.1.2 / axe pravidlo `label`, které tenhle nástroj sám překládá.
    expect(await screen.findByLabelText(/e-?mail/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/heslo/i)).toBeInTheDocument();
  });

  it('má na stránce právě jeden viditelný <h1>', async () => {
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector('h1')).toBeTruthy());

    // Jediný <h1> byl dřív uvnitř .print-only s display:none, takže
    // na obrazovce nebyl žádný — porušení `page-has-heading-one`.
    const headings = [...container.querySelectorAll('h1')];
    const onScreen = headings.filter((h) => !h.closest('.print-only'));
    expect(onScreen).toHaveLength(1);
  });

  it('registruje posluchač změny přihlášení', () => {
    render(<App />);
    expect(authCallback).toBeTypeOf('function');
  });
});
