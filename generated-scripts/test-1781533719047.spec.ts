import { test, expect } from '@playwright/test';

test('Autonomously generated AI test', async ({ page }) => {
  await page.goto('file:///Users/zdenekdias/.gemini/antigravity/scratch/auratest-ai/test-sites/prod.html');

  // Step 1: První krok je zjistit, zda se na stránce nachází další tlačítka a jak fungují. Zde vidím tlačítko 'Odeslat data' a jeho vlastnosti.
  await page.click('[data-qa-id="3"]');
  // Step 2: (Ochrana V4, pokus 1/5) Detekována halucinace nebo smyčka. Ghostuji cíl, posúvám obrazovku dolů pro rozšíření kontextu.
  await page.mouse.wheel(0, 500);
  // Step 3: První krok je zjistit, zda se na stránce nachází další tlačítka a jak fungují. Zde vidím tlačítko 'Jméno' a jeho vlastnosti. Přejděme na detailnější analýzu.
  await page.fill('[data-qa-id="2"]', '');
  // Step 4: (Ochrana V4, pokus 1/5) Detekována halucinace nebo smyčka. Ghostuji cíl, posúvám obrazovku dolů pro rozšíření kontextu.
  await page.mouse.wheel(0, 500);
  // Step 5: První krok je zjistit, zda se na stránce nachází další tlačítka a jak fungují. Zde vidím tlačítko 'Jméno' a jeho vlastnosti. Přejděme na detailnější analýzu.
  await page.fill('[data-qa-id="1"]', '');

  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))
});
