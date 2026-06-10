import { test, expect } from '@playwright/test';

test('homepage se načte a obsahuje správný titulek a element', async ({ page }) => {
  // Přejdi na kořenovou adresu aplikace
  await page.goto('/');

  // Očekáváme, že se stránka vykreslí
  await expect(page).toHaveTitle(/AuraTest/i);

  // Očekáváme, že se vykreslí hlavička, nebo nějaký základní prvek.
  // Podle README.md to je např. AuraTest AI nebo UI hlavička (ověřováno flexibilně)
  const header = page.locator('h1, h2, .title').first();
  await expect(header).toBeVisible({ timeout: 10000 });
});
