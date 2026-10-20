/**
 * The web channel's driver in the app: Playwright on the source's own Chrome session
 * (src/platform/browser/chrome.ts), in a tab of its own that the run closes again. Every top-level
 * navigation goes through `guard` first: one it does not allow, or one that is not a GET (a form
 * sent), is aborted before it leaves the machine and reported as `blocked`; the tab goes back to
 * the page it was on.
 */
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { openSession } from '../browser/chrome.js';
import { findBrowser } from '../../invoices/pdf.js';
import type { WebDriver, WebFile, WebItem, WebPage } from './web-channel.js';

const TEXT_MAX = 20_000;
const ITEMS_MAX = 500;
const WAIT_MS = 30_000;

const nameOf = (url: string, disposition?: string): string => {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'download'); } catch { return 'download'; }
};

/** No Chromium browser on this machine: the person installs Google Chrome, Edge or Brave. */
export class NoChromeError extends Error {}

/** Opens the session (starting its Chrome when none runs) and a tab for this run. */
export async function playwrightDriver(session: string, guard: (url: string) => boolean, opts: { headless?: boolean } = {}): Promise<WebDriver> {
  if (!process.env.CHROME_PATH && !findBrowser()) throw new NoChromeError('no Chromium browser installed');
  const open = await openSession(session, opts);
  const context = open.browser.contexts()[0] ?? await open.browser.newContext();
  const page: Page = await context.newPage();
  let blocked: string | undefined;
  await page.route('**/*', (route) => {
    const r = route.request();
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && (r.method() !== 'GET' || !guard(r.url()))) {
      blocked = r.method() === 'GET' ? r.url() : `${r.method()} ${r.url()}`;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const settle = async <T>(act: () => Promise<T>): Promise<{ url: string; blocked?: string }> => {
    blocked = undefined;
    try { await act(); } catch (e) { if (!blocked) throw e; }
    // Chrome shows an error page for the aborted navigation: back to where the tab was ("load" may never come under routing).
    // The page comes back from the browser's cache then, with no new "domcontentloaded" to wait for.
    if (blocked) { if (page.url().startsWith('chrome-error:')) await page.goBack({ waitUntil: 'commit', timeout: WAIT_MS }).catch(() => undefined); }
    else await page.waitForLoadState('domcontentloaded', { timeout: WAIT_MS }).catch(() => undefined);
    return { url: page.url(), ...(blocked ? { blocked } : {}) };
  };
  const read = (selector?: string): Promise<WebPage> => page.evaluate(([sel, max, items]) => {
    const root = (sel ? document.querySelector(sel) : document.body) as HTMLElement | null;
    const links = root ? Array.from(root.querySelectorAll('a[href]')).slice(0, items).map((a) => ({ text: ((a as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200), href: (a as HTMLAnchorElement).href })) : [];
    return { url: location.href, title: document.title, text: (root?.innerText ?? '').slice(0, max), links };
  }, [selector ?? null, TEXT_MAX, ITEMS_MAX] as const);
  return {
    goto: (url) => settle(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: WAIT_MS })),
    url: () => page.url(),
    read,
    list: (selector): Promise<WebItem[]> => page.$$eval(selector, (els, max) => els.slice(0, max).map((el) => {
      const a = (el.matches('a[href]') ? el : el.querySelector('a[href]')) as HTMLAnchorElement | null;
      return { text: ((el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500), ...(a ? { href: a.href } : {}) };
    }), ITEMS_MAX),
    submits: (selector) => page.$eval(selector, (el) => {
      const form = el.closest('form');
      if (!form) return false;
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      return (el.tagName === 'BUTTON' && (type === '' || type === 'submit')) || (el.tagName === 'INPUT' && (type === 'submit' || type === 'image'));
    }),
    click: (selector) => settle(() => page.click(selector, { timeout: WAIT_MS })),
    async fetch(url): Promise<WebFile> {
      const r = await context.request.get(url, { timeout: WAIT_MS });
      if (!r.ok()) throw new Error(`download ${url}: ${r.status()}`);
      const h = r.headers();
      return { name: nameOf(url, h['content-disposition']), contentType: (h['content-type'] ?? 'application/octet-stream').split(';')[0], content: await r.body(), url };
    },
    async clickDownload(selector, allow) {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: WAIT_MS }), page.click(selector, { timeout: WAIT_MS })]);
      if (!allow(download.url())) { await download.cancel(); return { refused: download.url() }; }
      const path = await download.path();
      return { name: download.suggestedFilename(), contentType: /\.pdf$/i.test(download.suggestedFilename()) ? 'application/pdf' : 'application/octet-stream', content: readFileSync(path), url: download.url() };
    },
    async snapshot() {
      return { url: page.url(), html: await page.content(), screenshot: await page.screenshot({ fullPage: false }).catch(() => undefined) };
    },
    async close() {
      await page.close().catch(() => undefined);
      await open.detach();
    },
  };
}
