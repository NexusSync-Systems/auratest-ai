/**
 * Pomocný skript pro pořízení snímku běžící aplikace (README, prezentace).
 *
 * Dřív měl výstupní cestu natvrdo nastavenou do ÚPLNĚ JINÉHO projektu na
 * disku autora, takže zapisoval mimo repozitář a prozrazoval lokální
 * uživatelské jméno. Cesta i adresa jsou teď parametrizované.
 *
 * Použití:
 *   node screenshot.mjs [url] [výstupní-soubor]
 *   node screenshot.mjs http://localhost:3001 ./docs/screenshot.png
 */
import { chromium } from 'playwright';
import path from 'path';

const url = process.argv[2] || process.env.SCREENSHOT_URL || 'http://localhost:3001';
const outputPath = path.resolve(process.argv[3] || process.env.SCREENSHOT_OUT || './screenshot.png');

(async () => {
  console.log('Spouštím prohlížeč…');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });

    console.log(`Otevírám ${url}…`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(3000); // ať doběhnou animace

    console.log(`Ukládám snímek do ${outputPath}`);
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log('Hotovo.');
  } catch (error) {
    console.error('Snímek se nepodařilo pořídit:', error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
