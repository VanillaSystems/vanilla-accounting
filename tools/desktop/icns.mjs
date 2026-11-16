/**
 * Makes the Mac app's icons with Apple's own iconutil (macOS only):
 *
 *   node tools/desktop/icns.mjs
 *
 *   desktop/icon.icns      the app's icon, from desktop/icon.png (the brand's, 1024 px)
 *   desktop/document.icns  the icon of a Freigabe-Datei (.vanillashare, .vanilla), from desktop/document.svg
 *                          (a page with the app's icon on it), rendered at 1024 px
 *
 * electron-builder's own icns from a PNG holds its 16, 32 and 64 px images as PNGs under the types
 * icp4, icp5 and icp6, which macOS draws as pixel noise at those sizes (a file's icon in Chrome's
 * download list); iconutil writes every size at its exact pixels and the small ones as ic04/ic05.
 * tests/desktop-icns.test.ts checks both files.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findBrowser } from '../../src/invoices/pdf.ts';

/** An iconset's file names and their pixel sizes: each point size once and at @2x. */
const SIZES = [16, 32, 128, 256, 512].flatMap((pt) => [[`icon_${pt}x${pt}.png`, pt], [`icon_${pt}x${pt}@2x.png`, pt * 2]]);

/** Writes `out` from a 1024 px PNG through an iconset of every size, each scaled down from it. */
function icns(png, out) {
  const set = join(mkdtempSync(join(tmpdir(), 'icns-')), 'icon.iconset');
  execFileSync('mkdir', [set]);
  for (const [name, px] of SIZES) execFileSync('/usr/bin/sips', ['-z', String(px), String(px), png, '--out', join(set, name)], { stdio: 'ignore' });
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', out]);
  rmSync(join(set, '..'), { recursive: true, force: true });
  console.log(out);
}

/** Renders an SVG of 1024 × 1024 to a PNG with a transparent background. */
async function render(svg, png) {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('Rendering the document icon needs Chrome, Edge, Brave or Chromium (or CHROME_PATH).');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 1024 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${readFileSync(svg, 'utf8')}`);
    await page.screenshot({ path: png, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  } finally {
    await browser.close();
  }
}

if (process.platform !== 'darwin') throw new Error('iconutil and sips run on macOS only.');
icns('desktop/icon.png', 'desktop/icon.icns');
const tmp = mkdtempSync(join(tmpdir(), 'document-icon-'));
await render('desktop/document.svg', join(tmp, 'document.png'));
icns(join(tmp, 'document.png'), 'desktop/document.icns');
rmSync(tmp, { recursive: true, force: true });
