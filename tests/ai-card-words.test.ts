/**
 * The AI step after «Claude Code installieren» (#385), the real UI built with Vite on the desktop's own
 * server, Terminal a stub that opens nothing: the card waits for the install with the vendor's command
 * still folded under «Befehl zeigen» (Terminal has it already); once the program is there and signed
 * out, the conversation says, before «Anmelden» opens the browser, what a person without an account
 * will see: the page in English, the account made there with the plan the card named, and that the app
 * notices the sign-in by itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';

const dir = mkdtempSync(join(tmpdir(), 'ai-card-words-'));
const claude = join(dir, 'bin-claude');
const opener = join(dir, 'opener');
writeFileSync(opener, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
Object.assign(process.env, {
  HOME: dir, VANILLA_WORKSPACE: '', VANILLA_AI_SETTINGS: join(dir, 'ai.json'), VANILLA_SECRETS_FILE: join(dir, 'secrets.json'),
  CLAUDE_BIN: claude, CODEX_BIN: join(dir, 'no-such-codex'), VANILLA_TERMINAL_OPENER: opener, CLAUDE_STUB_SIGNED_OUT: '1',
});
writeFileSync(join(dir, 'secrets.json'), '{}');

test('after «installieren» the command stays folded; before the sign-in a person without an account reads what she will see', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 420_000 }, async () => {
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
    await page.evaluateOnNewDocument(`
      const none = async () => null;
      window.vanilla = { chooseFolder: none, chooseNewFolder: none, onMenu: () => () => undefined, setLanguage: () => undefined, saveFile: async () => false };
      try { localStorage.setItem('language', 'de'); } catch { /* about:blank has no storage */ }
    `);
    const visibleCommands = () => page.evaluate(() => [...document.querySelectorAll('.aicmd')].filter((e) => e.checkVisibility()).length);
    await page.goto(`http://${host}/start`, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('[data-act=ai-setup]', { timeout: 60_000 });
    await page.click('[data-act=ai-setup]');
    await page.waitForSelector('[data-answer=install-claude]', { timeout: 20_000 });
    await page.click('[data-answer=install-claude]');
    await page.waitForSelector('.aicli[data-cli=claude][data-state=installing]', { timeout: 20_000 });
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'ai-installing.png') });
    assert.equal(await visibleCommands(), 0, 'the command stays folded after the click');
    assert.ok(await page.$('.aicli[data-state=installing] .aishow summary'), '«Befehl zeigen» is there to open it');
    await page.click('.aicli[data-state=installing] .aishow summary');
    assert.equal(await visibleCommands(), 1, 'and opens on her click');

    // The installer is done: the program is there, not signed in.
    copyFileSync(join(process.cwd(), 'tests/support/stub-bin/claude'), claude);
    await page.waitForSelector('[data-answer=sign-in]', { timeout: 30_000 });
    const said = await page.$eval('.obflowturns', (e) => (e as HTMLElement).innerText);
    assert.match(said, /Noch kein Konto bei Anthropic\?/, 'before «Anmelden» the app says what a person without an account does');
    assert.match(said, /auf Englisch/);
    assert.match(said, /legst du ein Konto an/);
    // Nothing in the repo says the plan is picked on the sign-in page (#387 review): the subscription is taken out with the vendor, by its plans page.
    assert.doesNotMatch(said, /wählst/, 'no promise that the plan is picked there');
    assert.match(said, /Abo \(Claude Pro, etwa 20 USD im Monat\) schliesst du bei Anthropic ab/, 'the subscription is taken out with the vendor');
    assert.equal(await page.$eval('[data-no-account] a', (a) => (a as HTMLAnchorElement).href), 'https://claude.com/pricing', 'with the vendor\'s plans page');
    assert.match(said, /merkt die Anmeldung von selbst/);
    assert.equal(await page.$$eval('[data-no-account]', (els) => els.length), 1, 'said once');
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'ai-signin.png') });
  } finally {
    await closeChrome(browser);
    server.close();
  }
});

test('no language promises that the plan is picked on the sign-in page, in the app or in Terminal (#387 review)', async () => {
  for (const code of ['de', 'fr', 'it', 'en']) {
    const { messages } = ((await import(`../src/app/i18n/locales/${code}.ts`)) as { default: { messages: Record<string, string> } }).default;
    for (const key of ['aiSetup.noAccount', 'aiSetup.script.loginStep2']) {
      assert.match(messages[key], /\{vendor\}/, `${code} ${key}: the subscription is taken out with the vendor`);
      assert.doesNotMatch(messages[key], /wählst|pick \{plan\}|choisis|scegli/, `${code} ${key}: no plan picked on the sign-in page`);
    }
  }
});
