import { test, expect } from '@playwright/test';

test.describe('Backend API Smoke Tests', () => {
  // Use playwright API testing context
  test('API /api/mock-translations should respond successfully', async ({ request }) => {
    // API běží na portu 3001
    const response = await request.get('http://localhost:3001/api/mock-translations');
    expect(response.ok()).toBeTruthy();
    expect(response.status()).toBe(200);

    // Zkusíme jestli odpovídá JSON formátem
    const data = await response.json();
    expect(typeof data).toBe('object');
    // Ověříme, že obsahuje aspoň nějaké překlady, např. 'hn.title'
    expect(data['hn.title']).toBeDefined();
  });

  test('API root fallback should respond (if any)', async ({ request }) => {
    // Ověření, že server žije
    const response = await request.get('http://localhost:3001/');
    // Buď vrací static (200), nebo fallback do 404/500, důležité je, že nevyhodí error CONNECTION REFUSED
    expect(response.status()).toBeLessThan(500);
  });
});
