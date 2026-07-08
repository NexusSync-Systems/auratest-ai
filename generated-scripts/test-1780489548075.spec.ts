import { test, expect } from '@playwright/test';

test('Autonomously generated AI test', async ({ page }) => {
  await page.goto('http://localhost:3005/');

  // Step 1: (Záchranný krok) AI JSON error: Ollama fallback failed: Not Found.
  await page.mouse.wheel(0, 500);
  // Step 2: (Ochrana V2) Agent se zacyklil. Zaznamenávám selhání akce do paměti a vynucuji posun obrazovky.
  await page.mouse.wheel(0, 500);
  // Step 3: (Ochrana V2) Agent se zacyklil. Zaznamenávám selhání akce do paměti a vynucuji posun obrazovky.
  await page.mouse.wheel(0, 500);

  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))
});
