import { test, expect } from '@playwright/test';

test('Autonomously generated AI test', async ({ page }) => {
  await page.goto('http://localhost:3005/');


  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))
});
