import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { lazyWithReload } from './lazy-with-reload.js';

/**
 * Části bundlu po nasazení nové verze.
 *
 * Vite pojmenovává soubory podle otisku obsahu. Po nasazení se otisk změní
 * a starý soubor zmizí; prohlížeč, který má aplikaci otevřenou od doby
 * před nasazením, po něm ale pořád sahá. Uvidí to každý, kdo měl aplikaci
 * otevřenou během nasazení — u nás to potkalo zrovna Doložitelnost.
 *
 * Tlačítko „Zkusit znovu" ten případ vyřešit nemůže: soubor na serveru
 * není a nebude, a prohlížeč si odmítnutý modul navíc pamatuje.
 */

const chybaCasti = () =>
  new Error(
    'Failed to fetch dynamically imported module: '
    + 'https://auraguard.nexusstack.eu/assets/PrintReport-H9jzyYzR.js'
  );

let reload;

beforeEach(() => {
  window.sessionStorage.clear();
  reload = vi.fn();
  // `location.reload` nejde v jsdom volat, takže se nahradí.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chybějící část bundlu po nasazení', () => {
  test('načte stránku znovu', async () => {
    const C = lazyWithReload(() => Promise.reject(chybaCasti()), 'test-a');
    render(<Suspense fallback={<div>načítám</div>}><C /></Suspense>);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  test('podruhé už ne — jinak by stránka blikala donekonečna', async () => {
    // Kdyby soubor chyběl z jiného důvodu (rozbité nasazení, plný disk),
    // znamenalo by opakované načítání nekonečnou smyčku. Podruhé se chyba
    // nechá probublat, aby ji uživatel aspoň viděl.
    window.sessionStorage.setItem('reload-po-nasazeni:test-b', '1');

    const C = lazyWithReload(() => Promise.reject(chybaCasti()), 'test-b');
    const chyby = [];
    const puvodni = console.error;
    console.error = (...a) => chyby.push(a);

    class Hlidka extends (await import('react')).Component {
      constructor(p) { super(p); this.state = { padlo: false }; }
      static getDerivedStateFromError() { return { padlo: true }; }
      render() { return this.state.padlo ? 'chyba' : this.props.children; }
    }

    render(
      <Hlidka>
        <Suspense fallback={<div>načítám</div>}><C /></Suspense>
      </Hlidka>
    );

    await waitFor(() => expect(screen.getByText('chyba')).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();
    console.error = puvodni;
  });

  test('pojistka je pro každou část zvlášť', async () => {
    // Vyčerpat ji kvůli jedné části a tím zablokovat druhou by znamenalo,
    // že se druhá nikdy nezotaví.
    window.sessionStorage.setItem('reload-po-nasazeni:test-c', '1');
    const C = lazyWithReload(() => Promise.reject(chybaCasti()), 'test-d');
    render(<Suspense fallback={<div>načítám</div>}><C /></Suspense>);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe('jiné chyby se nemaskují', () => {
  test('chyba uvnitř komponenty stránku nenačítá znovu', async () => {
    // Načíst znovu kvůli chybě v kódu by ji jen schovalo a uživatel by
    // koukal na blikající stránku bez vysvětlení.
    const C = lazyWithReload(
      () => Promise.reject(new Error('TypeError: x is not a function')),
      'test-e'
    );
    const puvodni = console.error;
    console.error = () => {};

    class Hlidka extends (await import('react')).Component {
      constructor(p) { super(p); this.state = { padlo: false }; }
      static getDerivedStateFromError() { return { padlo: true }; }
      render() { return this.state.padlo ? 'chyba' : this.props.children; }
    }

    render(
      <Hlidka>
        <Suspense fallback={<div>načítám</div>}><C /></Suspense>
      </Hlidka>
    );

    await waitFor(() => expect(screen.getByText('chyba')).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();
    console.error = puvodni;
  });
});
