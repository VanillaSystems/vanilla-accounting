// Screenshots of every mockup page (1440×900) into a folder outside the repo, to check the build.
// node docs/0.4.0/mockups/ai-setup/tools/shots.mjs <out-dir> [theme] [page…]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [outDir, theme = 'light', ...only] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const pages = only.length ? only : fs.readdirSync(dir).filter((f) => /^[abl]\d.*\.html$/.test(f));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
for (const f of pages) {
  await page.goto(`file://${dir}/${f}?theme=${theme}`, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(outDir, f.replace('.html', `${theme === 'light' ? '' : '-' + theme}.png`)) });
}
await browser.close();
console.log(pages.length, 'shots in', outDir);
