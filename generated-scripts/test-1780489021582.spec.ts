import { test, expect } from '@playwright/test';

test('Autonomously generated AI test', async ({ page }) => {
  await page.goto('http://localhost:3005/');

  // Step 1: (Záchranný krok) AI JSON error: Selhání komunikace s LLM AI (http://127.0.0.1:11434/v1/chat/completions): Selhání komunikace s LLM AI (http://127.0.0.1:11434/v1/chat/completions): API error (404): {"error":{"message":"model 'apple-foundationmodel' not found","type":"not_found_error","param":null,"code":null}}
.
  await page.mouse.wheel(0, 500);
  // Step 2: (Ochrana V2) Agent se zacyklil. Zaznamenávám selhání akce do paměti a vynucuji posun obrazovky.
  await page.mouse.wheel(0, 500);
  // Step 3: (Ochrana V2) Agent se zacyklil. Zaznamenávám selhání akce do paměti a vynucuji posun obrazovky.
  await page.mouse.wheel(0, 500);

  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))
});
