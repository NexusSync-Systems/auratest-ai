import { test, expect } from '@playwright/test';

test('Autonomously generated AI test', async ({ page }) => {
  await page.goto('http://localhost:3005/');

  // Step 1: Vyzkouším všechny tlačítka a možnosti na stránce, abych zjistil jakýkoliv problém.
  await page.click('[data-qa-id="29"]');
  // Step 2: (Ochrana V3) Agent navrhl již zacyklenou/selhanou akci. Zaznamenávám do paměti a vynucuji posun obrazovky.
  await page.mouse.wheel(0, 500);
  // Step 3: (Ochrana V3) Agent navrhl již zacyklenou/selhanou akci. Zaznamenávám do paměti a vynucuji posun obrazovky.
  await page.mouse.wheel(0, 500);

  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))
});
