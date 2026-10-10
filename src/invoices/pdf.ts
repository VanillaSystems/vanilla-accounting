/**
 * Invoice PDFs, printed from the HTML sheet by a Chromium-based browser already on the machine
 * (ADR 0012): puppeteer-core drives it, one browser per process. The PDF's creation and
 * modification dates are set to the document's own time, so the same sheet printed twice by
 * the same browser gives the same bytes. A sent PDF is stored once and never printed again.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { invoiceFontCss } from './fonts.js';
import { MEASURE_SCRIPT, assembleSheets, hasQrBill, measureHtml, paginate, sheetBlocks, sheetDocument, sheetTitle, type SheetData } from './sheet.js';

/** Where Chrome, Edge, Brave and Chromium install themselves, per platform. CHROME_PATH comes first. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const byPlatform: Record<string, string[]> = {
    darwin: ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].flatMap((app) => {
      const bin = `${app}.app/Contents/MacOS/${app}`;
      return [join('/Applications', bin), join(home, 'Applications', bin)];
    }),
    win32: [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((d): d is string => !!d).flatMap((d) => [
      join(d, 'Google/Chrome/Application/chrome.exe'), join(d, 'Microsoft/Edge/Application/msedge.exe'),
      join(d, 'BraveSoftware/Brave-Browser/Application/brave.exe'), join(d, 'Chromium/Application/chrome.exe'),
    ]),
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  };
  return [...(env.CHROME_PATH ? [env.CHROME_PATH] : []), ...(byPlatform[platform] ?? byPlatform.linux)];
}

export class NoBrowserError extends Error {
  constructor() {
    super('Für Rechnungs-PDFs braucht die App einen Chromium-Browser: Google Chrome, Microsoft Edge, Brave oder Chromium installieren (oder CHROME_PATH auf das Programm setzen).');
  }
}

export function findBrowser(): string | undefined {
  return browserCandidates().find((p) => existsSync(p));
}

let launched: Promise<Browser> | undefined;

function browser(): Promise<Browser> {
  const executablePath = findBrowser();
  if (!executablePath) return Promise.reject(new NoBrowserError());
  // The process decides when it ends (src/server/main.ts closes the browser on a signal); puppeteer would keep it alive.
  launched ??= puppeteer.launch({
    executablePath, headless: true, args: ['--font-render-hinting=none', '--no-first-run'], handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  }).catch((e) => {
    launched = undefined;
    throw e;
  });
  return launched;
}

/** Closes the browser this process started; a CLI calls it before it exits. */
export async function closeBrowser(): Promise<void> {
  const b = launched;
  launched = undefined;
  if (b) await (await b).close();
}

export interface Rendered { html: string; pages: number }

async function withPage<T>(fn: (page: import('puppeteer-core').Page) => Promise<T>): Promise<T> {
  const page = await (await browser()).newPage();
  try { return await fn(page); } finally { await page.close(); }
}

/** The sheet laid out: blocks measured in the browser, placed on A4 sheets, as one HTML document. */
async function layOut(page: import('puppeteer-core').Page, d: SheetData): Promise<Rendered> {
  const blocks = sheetBlocks(d);
  const fonts = invoiceFontCss();
  const title = `${sheetTitle(d)} ${d.number ?? ''}`.trim();
  await page.setContent(sheetDocument(measureHtml(d, blocks), fonts, title, d.language), { waitUntil: 'load' });
  const mm = (await page.evaluate(MEASURE_SCRIPT)) as number[];
  const pagination = paginate(blocks, mm, { footer: d.layout.show.footer, qrBill: hasQrBill(d) });
  const html = sheetDocument(assembleSheets(d, blocks, pagination), fonts, title, d.language);
  return { html, pages: (html.match(/<div class="a4 /g) ?? []).length };
}

/** The paginated sheet as a standalone HTML page (the preview). */
export function renderHtml(d: SheetData): Promise<Rendered> {
  return withPage((page) => layOut(page, d));
}

/** The sheet as PDF, its dates set to `at` (the document's issue or send time, ISO). */
export function renderPdf(d: SheetData, at: string): Promise<Rendered & { pdf: Buffer }> {
  return withPage(async (page) => {
    const laid = await layOut(page, d);
    await page.setContent(laid.html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready');
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    return { ...laid, pdf: stampDates(Buffer.from(pdf), at) };
  });
}

/**
 * Chromium writes the print time into /CreationDate and /ModDate, the only bytes that differ
 * between two prints. They are replaced digit for digit, so every offset in the file stays right.
 */
export function stampDates(pdf: Buffer, at: string): Buffer {
  const ts = at.replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
  return Buffer.from(pdf.toString('latin1').replace(/\(D:\d{14}/g, `(D:${ts}`), 'latin1');
}
