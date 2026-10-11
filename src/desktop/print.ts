/**
 * Invoice and report PDFs in the desktop app: the same sheet HTML as src/invoices/pdf.ts, printed by
 * Electron's own Chromium (`webContents.printToPDF`) in a hidden window, so no browser has to be
 * installed (ADR 0012). pdf.ts stamps the dates, as for every PDF.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type { PrintPage } from '../invoices/pdf.js';

// One hidden window prints every page in turn. A window per page failed: the next window's first
// load ended in ERR_FAILED while the previous one was being destroyed.
let window: BrowserWindow | undefined;
let queue: Promise<void> = Promise.resolve();
let file: string | undefined;

function printWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window;
  // The same viewport as a puppeteer page: the sheet measures its blocks in mm, but the page has a size.
  return (window = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  }));
}

export async function electronPage(): Promise<PrintPage> {
  let release!: () => void;
  const turn = queue;
  queue = new Promise((r) => { release = r; });
  await turn;
  const win = printWindow();
  return {
    async setContent(html) {
      // From a file, not a data: URL, which Chromium caps at 2 MB; the sheet inlines its fonts.
      file ??= join(mkdtempSync(join(tmpdir(), 'vanilla-print-')), 'sheet.html');
      writeFileSync(file, html);
      await win.loadFile(file);
    },
    evaluate: (script) => win.webContents.executeJavaScript(script),
    pdf: () => win.webContents.printToPDF({
      preferCSSPageSize: true, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 },
    }),
    async close() { release(); },
  };
}
