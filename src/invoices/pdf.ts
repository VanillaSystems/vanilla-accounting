/**
 * Invoice PDFs, printed from the HTML sheet by a Chromium-based browser already on the machine
 * (ADR 0012): puppeteer-core drives it, one browser per process; the desktop app prints with its own
 * Chromium instead (usePrintPages, src/desktop/print.ts). The PDF's creation and
 * modification dates are set to the document's own time, so the same sheet printed twice by
 * the same browser gives the same bytes. A sent PDF is stored once and never printed again.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
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
  // Imported only here: the desktop app prints without it and does not pack it (desktop/not-packed.cjs).
  launched ??= import('puppeteer-core').then(({ default: puppeteer }) => puppeteer.launch({
    executablePath, headless: true, args: ['--font-render-hinting=none', '--no-first-run'], handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  })).catch((e) => {
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

/** A browser page that lays out and prints HTML. */
export interface PrintPage {
  /** Resolves once the page has loaded. */
  setContent(html: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  /** A4 from the page's CSS, backgrounds printed, no margins of its own. */
  pdf(): Promise<Uint8Array>;
  close(): Promise<void>;
}

async function puppeteerPage(): Promise<PrintPage> {
  const page = await (await browser()).newPage();
  return {
    setContent: (html) => page.setContent(html, { waitUntil: 'load' }),
    evaluate: (script) => page.evaluate(script),
    pdf: () => page.pdf({ preferCSSPageSize: true, printBackground: true }),
    close: () => page.close(),
  };
}

let newPage: () => Promise<PrintPage> = puppeteerPage;

/** Prints through `pages` from now on instead of a browser on the machine. */
export function usePrintPages(pages: () => Promise<PrintPage>): void {
  newPage = pages;
}

async function withPage<T>(fn: (page: PrintPage) => Promise<T>): Promise<T> {
  const page = await newPage();
  try { return await fn(page); } finally { await page.close(); }
}

/** The sheet laid out: blocks measured in the browser, placed on A4 sheets, as one HTML document. */
async function layOut(page: PrintPage, d: SheetData): Promise<Rendered> {
  const blocks = sheetBlocks(d);
  const fonts = invoiceFontCss();
  const title = `${sheetTitle(d)} ${d.number ?? ''}`.trim();
  await page.setContent(sheetDocument(measureHtml(d, blocks), fonts, title, d.language));
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
    await page.setContent(laid.html);
    await page.evaluate('document.fonts.ready');
    return { ...laid, pdf: stampDates(Buffer.from(await page.pdf()), at) };
  });
}

/** Any HTML page as PDF (the export's reports), its dates set to `at`. */
export function printPdf(html: string, at: string): Promise<Buffer> {
  return withPage(async (page) => {
    await page.setContent(html);
    await page.evaluate('document.fonts.ready');
    return stampDates(Buffer.from(await page.pdf()), at);
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
