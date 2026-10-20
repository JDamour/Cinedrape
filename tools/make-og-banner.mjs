// Renders the 1200x630 Open Graph / Twitter card banner (docs/branding/og-banner.png) from
// docs/branding/og-banner.html using the installed Chrome, the same discovery the e2e harness uses.
//   node tools/make-og-banner.mjs
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function main() {
  const { findChrome } = await import(pathToFileURL(resolve(root, 'test', 'e2e', 'lib', 'browser.mjs')).href);
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found (set CHROME_PATH or install Google Chrome).');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(resolve(root, 'docs', 'branding', 'og-banner.html')).href, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: resolve(root, 'docs', 'branding', 'og-banner.png'), type: 'png' });
    console.log('og-banner: wrote docs/branding/og-banner.png (1200x630)');
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(`og-banner: ${err.message}`); process.exit(1); });
}
