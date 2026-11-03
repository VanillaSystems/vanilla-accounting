/**
 * The whole app for an end-to-end test: the real API server on a disposable copy of a demo workspace, the real UI (a Vite
 * build served by Vite's preview with the dev proxy) and a headless Chrome page on it, each on a port the system gives.
 * `stop` ends Chrome, the preview and the server and removes the copy; Chrome's start and close are bounded
 * (support/browser.ts). The UI is built once per state of the sources: a later test file of the same run reuses the build.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { startApi, type ApiServer } from './api-server.js';
import { browserPath, closeChrome, launchChrome } from './browser.js';
import { devProxy } from '../../src/server/app-paths.js';
import { loadBooks } from '../../src/books/store.js';
import type { Index } from '../../src/types/index.js';

const REPO = process.cwd();

/** Why an end-to-end test skips, or false. */
export const noBrowser: string | false = browserPath ? false : 'no Chromium browser installed (CHROME_PATH)';

export interface App {
  api: ApiServer;
  /** The UI's origin, e.g. http://127.0.0.1:53210. */
  ui: string;
  page: Page;
  /**
   * Opens an app path (/receipts/<id>?period=2026-Q2) and waits until the page's requests are done, or, given `ready`,
   * until that selector is on the page: the app asks for its status every 5 s, so under load the network may not go
   * quiet for the 500 ms the first wait needs.
   */
  open(path: string, ready?: string): Promise<void>;
  /** The books as they are on disk now. */
  books(): Index;
  /** Errors the page threw or logged. */
  errors: string[];
  stop(): Promise<void>;
}

function sourcesHash(): string {
  const hash = createHash('sha1');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else hash.update(`${relative(REPO, path)} ${st.size} ${st.mtimeMs}\n`);
    }
  };
  walk(join(REPO, 'src'));
  for (const f of ['index.html', 'vite.config.ts', 'package-lock.json']) hash.update(`${f} ${statSync(join(REPO, f)).mtimeMs}\n`);
  return hash.digest('hex').slice(0, 16);
}

/** The UI built from the sources as they are; built into a folder of its own and moved in place, so two test files never share a half-built one. */
async function uiBuild(): Promise<string> {
  const dir = join(tmpdir(), 'vanilla-e2e-ui', sourcesHash());
  if (existsSync(join(dir, 'index.html'))) return dir;
  const outDir = `${dir}.${process.pid}`;
  mkdirSync(join(tmpdir(), 'vanilla-e2e-ui'), { recursive: true });
  const { build } = await import('vite');
  await build({ configFile: join(REPO, 'vite.config.ts'), logLevel: 'error', build: { outDir, emptyOutDir: true } });
  try { renameSync(outDir, dir); } catch { rmSync(outDir, { recursive: true, force: true }); }
  return dir;
}

/** `demo`: the workspace folder of a bundled demo (demo/vanilla-accounting by default); `env` goes to the API server. */
export async function openApp(demo = 'demo/vanilla-accounting', env: Record<string, string> = {}): Promise<App> {
  const outDir = await uiBuild();
  const api = await startApi(demo, { CHROME_PATH: browserPath ?? '', ...env }, { manifestOf: join(REPO, demo), whole: true });
  let browser: Browser | undefined;
  let vite: Awaited<ReturnType<typeof import('vite')['preview']>> | undefined;
  const stop = async () => {
    await closeChrome(browser);
    await vite?.close();
    await api.stop();
  };
  try {
    const { preview } = await import('vite');
    vite = await preview({
      configFile: join(REPO, 'vite.config.ts'), logLevel: 'error', build: { outDir },
      preview: { host: '127.0.0.1', port: 0, proxy: devProxy(`http://127.0.0.1:${api.port}`) },
    });
    const ui = vite.resolvedUrls!.local[0].replace(/\/$/, '');
    browser = await launchChrome(browserPath!);
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    // A download (an invoice's PDF, an export) never lands in the person's Downloads folder: a test reads the file from the API.
    await (await page.createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('language', 'de'));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    return {
      api, ui, page, errors, stop,
      async open(path, ready) {
        await page.goto(ui + path, { waitUntil: ready ? 'domcontentloaded' : 'networkidle0', timeout: 60_000 });
        if (ready) await page.waitForSelector(ready, { timeout: 60_000 });
      },
      books: () => loadBooks(api.ws),
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Clicks in the page, not at the element's place on screen: the dock or a toast may lie over it. */
export async function click(page: Page, selector: string): Promise<void> {
  await (await page.waitForSelector(selector))!.evaluate((e) => (e as HTMLElement).click());
}

/** Clicks the button (or link) of `selector` whose text is `text`. */
export async function clickText(page: Page, text: string, selector = 'button'): Promise<void> {
  await page.waitForFunction((sel, t) => {
    const hit = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.innerText.trim() === t);
    hit?.click();
    return !!hit;
  }, {}, selector, text);
}

/** Waits until the page's text holds `text`. */
export async function waitText(page: Page, text: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}
