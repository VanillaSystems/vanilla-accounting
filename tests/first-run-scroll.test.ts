/**
 * «Einrichtung» on a fresh install at the Mac app's default window (1440 × 900), the real UI built
 * with Vite on the desktop's own server, the Mac app's bridge as a fake (issue #343, docs/0.4.0/ai-setup.md
 * decision 1 as changed on 12.11.2026). The books come first: the first screen asks what the person
 * wants, shows no AI card and no shell command, fits the window with the language switch in sight,
 * and its answers are in reach of a click. With the claude stub signed in, the line under the
 * choices says so and «Ohne KI einrichten» opens the form. Without any AI, «Neue Buchhaltung
 * erstellen» is the form at once; «KI einrichten» opens the cards, which say what a program needs
 * and keep the vendor's command folded until «Befehl zeigen»; «Ohne KI weiter» leads back.
 * Nothing here clicks «installieren» or «Anmelden»: those open the real Terminal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('the first screen asks what the person wants; the AI is one line, its cards say what they need before Terminal opens', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 420_000 }, async () => {
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
    const visibleCommands = () => page.evaluate(() => [...document.querySelectorAll('.aicmd')].filter((e) => e.checkVisibility()).length);
    for (const path of ['/start', '/start?new']) {
      await page.goto(`http://${host}${path}`, { waitUntil: 'networkidle0', timeout: 60_000 });
      await page.waitForSelector('[data-answer=demo]', { timeout: 60_000 }).catch(async (e) => { throw new Error(`${path}: no choices: ${await page.evaluate(() => `${location.href} vanilla=${typeof (window as { vanilla?: unknown }).vanilla} ${document.body.innerText}`)}`, { cause: e }); });
      // The choices show before the look at this Mac's AI has its answer; the line under them follows it.
      await page.waitForSelector('[data-ready=claude]', { timeout: 60_000 });
      assert.equal(await page.$('.aicli'), null, `${path}: no AI card on the first screen`);
      assert.doesNotMatch(await page.$eval('.obflow', (e) => (e as HTMLElement).innerText), /curl|API|\.yaml/, `${path}: no command, no key, no file name on the first screen`);
      for (const sel of ['[data-answer=create]', '[data-answer=open]', '[data-answer=switch]', '[data-answer=demo]', '[data-act=by-hand]']) {
        const at = await hit(page, sel);
        assert.ok(at.ok, `${path}: a click at ${sel} (y ${at.y} of 900) reaches ${at.at}`);
      }
      const frame = await page.$eval('.st', (e) => ({ scrolled: e.scrollTop, fits: e.scrollHeight <= e.clientHeight }));
      assert.deepEqual(frame, { scrolled: 0, fits: true }, `${path}: the first screen fits the window, nothing scrolled`);
      // Its place in the window, not the element at that point: the Mac app's drag strip lies over the top edge (buttons stay clickable there).
      const lang = await page.$eval('.st-top .seg2', (e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; });
      assert.ok(lang, `${path}: the language switch is in sight`);
    }
    // A puppeteer click, as tools/desktop/smoke.mjs makes it, lands on «Ohne KI einrichten»: the form opens.
    await page.click('[data-act=by-hand]');
    await page.waitForSelector('.st-form input[name=name]', { timeout: 10_000 });

    // No AI on this Mac: detection asks the pinned program afresh on every look.
    process.env.CLAUDE_BIN = join(dir, 'no-such-claude');
    await page.goto(`http://${host}/start`, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('[data-ai=none]', { timeout: 60_000 });
    assert.equal(await page.$('.aicli'), null, 'without an AI the first screen still shows no card');
    assert.equal(await page.$('[data-act=by-hand]'), null, 'without an AI «new books» is the form itself, no small link beside it');
    await page.click('[data-answer=create]');
    await page.waitForSelector('.st-form input[name=name]', { timeout: 10_000 });

    await page.goto(`http://${host}/start`, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('[data-act=ai-setup]', { timeout: 60_000 });
    await page.click('[data-act=ai-setup]');
    await page.waitForSelector('.aicli[data-cli=claude][data-state=missing]', { timeout: 20_000 });
    const needs = await page.$eval('.aicli[data-cli=claude]', (e) => (e as HTMLElement).innerText);
    assert.match(needs, /Anthropic/, 'the card names the vendor the account is with');
    assert.match(needs, /Claude Pro/, 'and the plan');
    assert.match(needs, /20 USD/, 'and about what it costs');
    assert.match(needs, /Englisch/, 'and that the sign-in page is in English');
    assert.match(needs, /warten/, 'and that it can wait');
    assert.equal(await visibleCommands(), 0, 'no shell command in sight before the person asks for it');
    await page.click('.aicli[data-cli=claude] .aishow summary');
    assert.equal(await visibleCommands(), 1, '«Befehl zeigen» shows that program\'s command, not the other\'s');
    assert.equal(await page.$eval('.aiadv', (e) => (e as HTMLDetailsElement).open), false, '«Erweitert: mit API-Schlüssel» stays folded');
    await page.click('[data-answer=no-ai]');
    await page.waitForSelector('[data-ai=none]', { timeout: 10_000 });
    assert.ok(await page.$('[data-answer=create]'), '«Ohne KI weiter» leads back to the choices');
    assert.equal(JSON.parse(readFileSync(join(dir, 'ai.json'), 'utf8')).noAi, true, 'and is kept on this Mac');

    // «Zur Startseite» on a fresh install shows the start screen and stays there.
    await page.click('[data-act=first-leave]');
    await page.waitForSelector('.st-choices [data-act=open]', { timeout: 10_000 });
    assert.doesNotMatch(await page.$eval('.st-main', (e) => (e as HTMLElement).innerText), /\.yaml|\.json/, 'the start screen names no file');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(await page.$('.st-choices'), 'the start screen stays');
  } finally {
    await closeChrome(browser);
    server.close();
  }
});
