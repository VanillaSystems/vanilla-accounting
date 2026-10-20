/**
 * The browser-session channel `io.web` (docs/0.4.0/webmail-source.md «In the app»): a source's
 * code opens pages in the source's own Chrome session, reads them, clicks and downloads, and the
 * host checks every step against the source's `reach.web` before it leaves the machine. It knows
 * no provider: what to open and what counts as a document is the source's code, written in the
 * workspace with the person (ADR 0015).
 *
 * The code never holds the browser. It may call:
 *
 *   io.web.open(url)          → WebPage    a page of `open` (a redirect to `sign-in` is a login the person does)
 *   io.web.read(selector?)    → WebPage    the page now, or the first element the selector finds
 *   io.web.list(selector)     → WebItem[]  every element the selector finds: its text and first link
 *   io.web.click(selector)    → WebPage    a link or a button; never one that submits a form
 *   io.web.download(url)      → WebFile    a GET in the session, from an address of `download`
 *   io.web.downloadBy(selector) → WebFile  the download a click starts, from an address of `download`
 *
 * There is no typing, no form submit, no send, delete or move: a source reads and downloads.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Held } from './mail-channel.js';
import type { WebReach } from './model.js';
import { matchesAny, ReachError } from './reach.js';
import { SourceError } from './launcher.js';

/** The source's own Chrome profile (src/platform/browser/chrome.ts): one sign-in per source. */
export const sessionOf = (source: string): string => `source-${source}`.slice(0, 63);

/** Where the person signs in: the reach's `start`, else its first sign-in or open address. */
export function signInUrl(r: WebReach): string | undefined {
  if (r.start) return r.start;
  const p = r.signIn[0] ?? r.open[0];
  return p ? `https://${p.host.replace(/^\*\./, '')}/${p.segments.map((s) => (s === '*' ? '' : s)).join('/')}` : undefined;
}

export interface WebPage { url: string; title: string; text: string; links: WebItem[] }
export interface WebItem { text: string; href?: string }
export interface WebFile { name: string; contentType: string; content: Buffer; url: string }

/**
 * What drives the browser: Playwright on the session's Chrome in the app (web-driver.ts), a
 * stand-in in tests. The driver refuses a top-level navigation `guard` does not allow before it
 * leaves (`blocked`), so the host's check is not after the fact.
 */
export interface WebDriver {
  goto(url: string): Promise<{ url: string; blocked?: string }>;
  url(): string;
  read(selector?: string): Promise<WebPage>;
  list(selector: string): Promise<WebItem[]>;
  /** Whether a click on the element would submit a form. */
  submits(selector: string): Promise<boolean>;
  click(selector: string): Promise<{ url: string; blocked?: string }>;
  fetch(url: string): Promise<WebFile>;
  /** The download a click starts; one `allow` refuses is cancelled before its bytes are kept. */
  clickDownload(selector: string, allow: (url: string) => boolean): Promise<WebFile | { refused: string }>;
  snapshot(): Promise<{ url: string; html: string; screenshot?: Buffer }>;
  close(): Promise<void>;
}

/** The page asked for a person: the session is not signed in, or a second factor is asked. */
export class LoginNeeded extends Error {
  constructor(readonly at: string) { super(`sign-in needed at ${at}`); }
}

/** Where a run's trace goes: app-local, outside the books and git, because it holds what the pages showed. */
export const traceHome = (): string => process.env.VANILLA_TRACES_DIR ?? join(homedir(), '.vanilla-accounting', 'traces');

/** What a run saw: every step, and each page it landed on (its HTML and a screenshot), for a repair and the person's review. */
export class Trace {
  readonly dir: string;
  private n = 0;
  constructor(source: string, run: string) {
    this.dir = join(traceHome(), source, `${run}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(this.dir, { recursive: true });
  }
  step(x: Record<string, unknown>): void {
    appendFileSync(join(this.dir, 'steps.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...x }) + '\n');
  }
  async page(driver: WebDriver): Promise<void> {
    try {
      const s = await driver.snapshot();
      const name = String(++this.n).padStart(3, '0');
      writeFileSync(join(this.dir, `${name}.html`), s.html);
      if (s.screenshot) writeFileSync(join(this.dir, `${name}.png`), s.screenshot);
      this.step({ page: name, url: s.url });
    } catch (e) {
      this.step({ snapshot: 'failed', error: (e as Error).message });
    }
  }
}

/** Whether a top-level navigation may leave: a page of `open` or `sign-in`, https only. */
export const navigationAllowed = (r: WebReach) => (url: string): boolean => matchesAny(r.open, url) || matchesAny(r.signIn, url);

const fileRef = (f: WebFile, held: Map<string, Held>) => {
  const file = `web:${held.size + 1}`;
  held.set(file, { name: f.name, content: f.content, from: f.url });
  return { file, filename: f.name, contentType: f.contentType, size: f.content.length };
};

/**
 * A page that is not as the code expected (a selector that finds nothing, a page that does not
 * load) is the source's failure, `changed`, which a repair fixes: never a crash of the host.
 */
function asPageErrors(d: WebDriver): WebDriver {
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try { return await f(...a); } catch (e) { throw e instanceof ReachError || e instanceof LoginNeeded ? e : new SourceError(String((e as Error)?.message ?? e).split('\n')[0]); }
  };
  return { ...d, goto: wrap(d.goto), read: wrap(d.read), list: wrap(d.list), submits: wrap(d.submits), click: wrap(d.click), fetch: wrap(d.fetch), clickDownload: wrap(d.clickDownload), url: () => d.url(), snapshot: () => d.snapshot(), close: () => d.close() };
}

/** The channel the code calls through the host. `held` collects downloads by reference for the delivery. */
export function webChannel(browser: WebDriver, reach: WebReach, held: Map<string, Held>, trace?: Trace) {
  const driver = asPageErrors(browser);
  const landed = async (r: { url: string; blocked?: string }, asked: string): Promise<WebPage> => {
    trace?.step({ asked, landed: r.url, ...(r.blocked ? { blocked: r.blocked } : {}) });
    if (r.blocked) throw new ReachError('web', `open ${r.blocked}`);
    if (matchesAny(reach.signIn, r.url) && !matchesAny(reach.signIn, asked)) { await trace?.page(driver); throw new LoginNeeded(r.url); }
    if (!navigationAllowed(reach)(r.url)) throw new ReachError('web', `open ${r.url}`);
    await trace?.page(driver);
    return driver.read();
  };
  return {
    async open(url: unknown): Promise<WebPage> {
      const u = String(url);
      if (!matchesAny(reach.open, u)) throw new ReachError('web', `open ${u}`);
      return landed(await driver.goto(u), u);
    },
    read: (selector?: unknown) => driver.read(selector === undefined ? undefined : String(selector)),
    list: (selector: unknown) => driver.list(String(selector)),
    async click(selector: unknown): Promise<WebPage> {
      const s = String(selector);
      if (await driver.submits(s)) throw new ReachError('web', `submit ${s}`);
      const before = driver.url();
      return landed(await driver.click(s), before);
    },
    async download(url: unknown) {
      const u = String(url);
      if (!matchesAny(reach.download, u)) throw new ReachError('web', `download ${u}`);
      const f = await driver.fetch(u);
      trace?.step({ download: u, name: f.name, bytes: f.content.length });
      return fileRef(f, held);
    },
    async downloadBy(selector: unknown) {
      const s = String(selector);
      if (await driver.submits(s)) throw new ReachError('web', `submit ${s}`);
      const f = await driver.clickDownload(s, (u) => matchesAny(reach.download, u));
      if ('refused' in f) throw new ReachError('web', `download ${f.refused}`);
      trace?.step({ download: f.url, name: f.name, bytes: f.content.length });
      return fileRef(f, held);
    },
  };
}
