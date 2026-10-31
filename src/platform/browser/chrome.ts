/**
 * The company's own Chrome for a site (browser-design.md): the Chrome installed on the Mac,
 * started with a profile folder of its own per session, so a sign-in done there once stays there
 * and never touches the person's everyday profile. Chrome writes the port it listens on into the
 * folder (DevToolsActivePort), so every process (npm start, the CLI, the Mac app) finds a Chrome
 * already running on a session and attaches to it instead of starting a second one.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { findBrowser } from '../../invoices/pdf.js';

/** Where the sessions live: app-local, beside the approvals, outside the books and git. */
export function browserHome(): string {
  return process.env.VANILLA_BROWSER_DIR ?? join(homedir(), '.vanilla-accounting', 'browser');
}

const SESSION = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function sessionDir(session: string): string {
  if (!SESSION.test(session)) throw new Error(`"${session}" is no session name: small letters, digits and dashes`);
  return join(browserHome(), session);
}

/** The port of the Chrome running on this session's profile, if one answers. */
async function runningPort(dir: string): Promise<number | undefined> {
  const file = join(dir, 'DevToolsActivePort');
  if (!existsSync(file)) return undefined;
  const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
  if (!port) return undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? port : undefined;
  } catch {
    return undefined;
  }
}

export interface OpenSession {
  session: string;
  browser: Browser;
  /** Whether this call started Chrome (false: it was running already). */
  started: boolean;
  /** Lets go of Chrome; it keeps running for the person. */
  detach(): Promise<void>;
}

/**
 * Attaches to the session's Chrome, starting it when none runs. `url` is opened in a new window
 * when Chrome is started. `headless` only for tests: a run reads in a headed window, so the site
 * sees the same browser the person signed in with.
 */
export async function openSession(session: string, opts: { url?: string; headless?: boolean } = {}): Promise<OpenSession> {
  const dir = sessionDir(session);
  mkdirSync(dir, { recursive: true });
  let port = await runningPort(dir);
  const started = port === undefined;
  if (started) {
    const exe = process.env.CHROME_PATH ?? findBrowser();
    if (!exe) throw new Error('No Chromium browser found: install Google Chrome, Microsoft Edge or Brave (or set CHROME_PATH).');
    rmSync(join(dir, 'DevToolsActivePort'), { force: true });
    const args = [
      `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', ...(opts.headless ?? process.env.VANILLA_BROWSER_HEADLESS === '1' ? ['--headless=new'] : []), opts.url ?? 'about:blank',
    ];
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 100 && port === undefined; i++) {
      await new Promise((r) => setTimeout(r, 150));
      port = await runningPort(dir);
    }
    if (port === undefined) throw new Error(`Chrome did not start on the session ${session} (${dir})`);
  }
  const browser = await connect(port!);
  return {
    session, browser, started,
    // Closing a CDP connection leaves Chrome running; that is the point.
    detach: () => browser.close(),
  };
}

/** Attaches over CDP; a Chrome just started answers HTTP a moment before its socket takes connections. */
async function connect(port: number): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  for (let i = 0; ; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (e) {
      if (i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Ends the session's Chrome, if it runs. */
export async function closeSession(session: string): Promise<boolean> {
  const port = await runningPort(sessionDir(session));
  if (port === undefined) return false;
  const dir = sessionDir(session);
  const browser = await connect(port);
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.close').catch(() => undefined);
  // Chrome answers for a moment while it shuts down; done is when it no longer does.
  for (let i = 0; i < 50 && (await runningPort(dir)) !== undefined; i++) await new Promise((r) => setTimeout(r, 100));
  rmSync(join(dir, 'DevToolsActivePort'), { force: true });
  return true;
}
