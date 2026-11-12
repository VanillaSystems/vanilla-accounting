/**
 * «Einrichtung» on a fresh install at the Mac app's default window (1440 × 900): once the Claude
 * Code check answers, the folder step's answers are the last turn of the conversation, and the
 * input box `.obtalk` sticks to the bottom edge. The view follows the newest turn as a chat does
 * (src/app/onboarding/follow-end.ts), so a click at «Erst die Demo ansehen» and at «Ohne KI
 * einrichten» lands on them, not on the box. The real UI, built with Vite, on the desktop's own
 * server with the claude stub signed in; the bridge of the Mac app stands in as a fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';

const dir = mkdtempSync(join(tmpdir(), 'first-run-scroll-'));
Object.assign(process.env, {
  HOME: dir, VANILLA_WORKSPACE: '', VANILLA_AI_SETTINGS: join(dir, 'ai.json'), VANILLA_SECRETS_FILE: join(dir, 'secrets.json'),
  CLAUDE_BIN: join(process.cwd(), 'tests/support/stub-bin/claude'), CODEX_BIN: join(dir, 'no-such-codex'),
});
writeFileSync(join(dir, 'secrets.json'), '{}');

/** The element a click at the centre of `selector` reaches, and whether it is that element (or inside it). */
const hit = (page: Page, selector: string) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, at: 'none' };
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: !!top && el.contains(top), at: top ? `${top.tagName}.${top.className}` : 'nothing', y: Math.round(r.top + r.height / 2) };
}, selector);

test('the folder step\'s answers are in reach above the input box once they show', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 420_000 }, async () => {
  const { build } = await import('vite');
  const dist = join(dir, 'dist');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: dist, emptyOutDir: true } });
  const { desktopServer, listen, portOf } = await import('../src/desktop/server.js');
  const desktop = desktopServer({ stateFile: join(dir, 'desktop.json'), demoRoot: join(dir, 'Demo'), booksHome: join(dir, 'Documents'), dist });
  const server = await listen(desktop.app, '127.0.0.1', undefined);
  const host = `127.0.0.1:${portOf(server)}`;
  desktop.allowHost(host);
  const browser = await launchChrome(browserPath!);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    // The Mac app's bridge, as a string: tsx would wrap the functions of a callback in a helper the page does not have.
    await page.evaluateOnNewDocument(`
      const none = async () => null;
      window.vanilla = { chooseFolder: none, chooseNewFolder: none, onMenu: () => () => undefined, setLanguage: () => undefined, saveFile: async () => false };
      try { localStorage.setItem('language', 'de'); } catch { /* about:blank has no storage */ }
    `);
    for (const path of ['/start', '/start?new']) {
      await page.goto(`http://${host}${path}`, { waitUntil: 'networkidle0', timeout: 60_000 });
      await page.waitForSelector('[data-answer=demo]', { timeout: 60_000 }).catch(async (e) => { throw new Error(`${path}: no folder step: ${await page.evaluate(() => `${location.href} vanilla=${typeof (window as { vanilla?: unknown }).vanilla} ${document.body.innerText}`)}`, { cause: e }); });
      assert.ok(await page.$('[data-ready=claude]'), `${path}: the folder step follows the Claude Code check`);
      // The view follows the turn, smoothly: wait until it rests, then a click at the buttons reaches them.
      for (const sel of ['[data-answer=demo]', '[data-act=by-hand]']) {
        await page.waitForFunction((s) => {
          const el = document.querySelector(s)!;
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }, { timeout: 5_000 }, sel).catch(() => undefined);
        const at = await hit(page, sel);
        assert.ok(at.ok, `${path}: a click at ${sel} (y ${at.y} of 900) reaches ${at.at}`);
      }
      const box = await page.$eval('.obtalk', (e) => e.getBoundingClientRect().top);
      const last = await page.$eval('.obend', (e) => e.getBoundingClientRect().bottom);
      assert.ok(last <= box + 2, `${path}: the conversation ends above the input box (${last} ≤ ${box})`);
    }
    // A puppeteer click, as tools/desktop/smoke.mjs makes it, lands on «Ohne KI einrichten»: the form opens.
    await page.click('[data-act=by-hand]');
    await page.waitForSelector('.st-form input[name=name]', { timeout: 10_000 });
  } finally {
    await closeChrome(browser);
    server.close();
  }
});
