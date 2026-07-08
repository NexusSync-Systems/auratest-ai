import { chromium } from 'playwright';

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2 // High resolution for better visual
  });
  console.log('Navigating to http://localhost:3000...');
  try {
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(3000); // Let animations settle
    const outputPath = '/Users/zdenekdias/.gemini/antigravity/scratch/nexus-systems/public/auratest_demo.png';
    console.log('Taking screenshot to ' + outputPath);
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log('Screenshot taken successfully!');
  } catch (error) {
    console.error('Failed to take screenshot:', error);
  } finally {
    await browser.close();
  }
})();
