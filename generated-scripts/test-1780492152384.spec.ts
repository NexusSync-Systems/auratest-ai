import { test, expect } from '@playwright/test';

test('Autonomously generated AI test', async ({ page }) => {
  await page.goto('https://news.ycombinator.com');


  // Doplňte vlastní asserty (např. expect(page).toHaveTitle(...))
});
