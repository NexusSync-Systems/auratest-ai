import { test, expect } from '@playwright/test';

test.describe('Frontend UI Sanity Test', () => {
  test('Homepage should load successfully', async ({ page }) => {
    // baseURL je nastavená na http://localhost:3000 v playwright.config.js
    const response = await page.goto('/');

    // Zkontrolovat úspěšný návratový kód
    expect(response?.ok()).toBeTruthy();
    expect(response?.status()).toBe(200);

    // Zkontrolovat Title stránky (zjistíme z root index.html)
    await expect(page).toHaveTitle(/AuraTest/);

    // Počkat, až se načte hlavní část aplikace
    // Vycházíme z toho, že aplikace renderuje do `<div id="root">` a uvnitř je nějaký text nebo struktura
    const rootElement = page.locator('#root');
    await expect(rootElement).toBeVisible();

    // Ujištění, že je na stránce nějaký text "AuraTest" např. v hlavičce (H1, H2 atp.) nebo jinde
    await expect(page.locator('text=AuraTest').first()).toBeVisible();
  });
});
