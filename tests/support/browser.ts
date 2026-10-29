/**
 * Chrome for a browser test, started and closed with a time limit each. A test file's process lives as long as its
 * connection to Chrome: a start without a limit once stalled for good and kept a failed run's runner, test process and
 * Chrome alive, holding the machine's test lock, and puppeteer's close waits for Chrome's exit without one.
 */
import type { Browser, BrowserContext } from 'puppeteer-core';

const START_MS = 60_000;
const ends = new WeakMap<Browser, string>();

/** Started once more when the first start fails or stalls, as Chrome may under memory pressure; puppeteer gives each a fresh profile and kills a start it gave up on. */
export async function launchChrome(executablePath: string, args: string[] = []): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer-core');
  const launch = () => puppeteer.launch({ executablePath, headless: true, timeout: START_MS, args: ['--no-first-run', ...args] });
  const browser = await launch().catch(launch);
  const start = Date.now();
  browser.process()?.once('exit', (code, signal) => ends.set(browser, `${executablePath} ended ${Math.round((Date.now() - start) / 1000)} s after its start (exit code ${code}, signal ${signal})`));
  return browser;
}

/**
 * Closes a test's context. When Chrome itself ended during the test, it says so instead: closing a context of a browser
 * that is gone only fails with «Connection closed», which hid why the test's page went away. An installed Google Chrome
 * was seen ending by a SIGTERM from outside about 31 s after every start (exit code 0), where Chrome for Testing and
 * Brave ran on.
 */
export async function closeContext(browser: Browser, context: BrowserContext): Promise<void> {
  if (browser.connected) return context.close();
  throw new Error(`Chrome went away during the test: ${ends.get(browser) ?? 'its connection closed'}. If it ends on its own, set CHROME_PATH to another Chromium-based browser.`);
}

/** Closes the browser; one still running after `ms` is killed by the pid of the process this test started. */
export async function closeChrome(browser: Browser | undefined, ms = 30_000): Promise<void> {
  if (!browser) return;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((ok) => { timer = setTimeout(() => ok('late'), ms); });
  if (await Promise.race([browser.close().catch(() => undefined), late]) === 'late') browser.process()?.kill('SIGKILL');
  clearTimeout(timer);
}
