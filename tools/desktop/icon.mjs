/** Renders desktop/icon.svg to desktop/icon.png (1024 px), the source electron-builder makes the .icns from. */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { findBrowser } from '../../src/invoices/pdf.ts';

const executablePath = findBrowser();
if (!executablePath) throw new Error('Rendering the icon needs Chrome, Edge, Brave or Chromium (or CHROME_PATH).');
const browser = await puppeteer.launch({ executablePath, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 1024 });
await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${readFileSync('desktop/icon.svg', 'utf8')}`);
await page.screenshot({ path: 'desktop/icon.png', omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
console.log('desktop/icon.png');
