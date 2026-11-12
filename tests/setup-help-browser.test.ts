/**
 * The setup as a person without an AI meets it (#364), in the real UI built with Vite on the desktop's
 * own server, at the Mac app's default window (1440 × 900) and a small one (1024 × 768):
 *
 * - before the books, the count is of four parts, the same for every firm, so it never jumps or
 *   shrinks («0 von 14», «1 von 4», «4 von 8» before); «MWST-Methode» and «Abrechnungsart» say where
 *   the answer stands; the review marks what the kind of firm assumed;
 * - in the books, the greeting does not offer words the field cannot take, the receipts step offers
 *   «KI einrichten» instead of «Mit mir einrichten», and after the last answer the first step and its
 *   button are in sight (round 1: scrollTop 477 of 1110, the step 630 px below the edge);
 *   «Partner und Wissen», never asked on books without bookings, is not counted as discussed.
 *
 * SETUP_HELP_SHOTS=<folder> saves a screenshot of each stage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';
import { testIban } from './support/iban.js';

const dir = mkdtempSync(join(tmpdir(), 'setup-help-'));
Object.assign(process.env, {
  HOME: dir, VANILLA_WORKSPACE: '', VANILLA_AI_SETTINGS: join(dir, 'ai.json'), VANILLA_SECRETS_FILE: join(dir, 'secrets.json'),
  CLAUDE_BIN: join(dir, 'no-such-claude'), CODEX_BIN: join(dir, 'no-such-codex'),
});
writeFileSync(join(dir, 'secrets.json'), '{}');
const SHOTS = process.env.SETUP_HELP_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const UID = 'CHE-153.004.184';
const IBAN = testIban('00762011623852957');

/** The words a person reads in `sel`: what has a letter in it. */
const words = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length);
const count = (page: Page) => page.$eval('.obflowhd [data-progress]', (e) => (e as HTMLElement).innerText.trim());
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
/** Waits for `sel`, then clicks it as a person would. */
const press = async (page: Page, sel: string) => { await page.waitForSelector(sel, { visible: true, timeout: 20_000 }); await page.click(sel); };

/** Whether the element lies wholly inside the window and inside the scroll box around it. */
const inSight = (page: Page, sel: string) => page.$eval(sel, (e) => {
  const r = e.getBoundingClientRect();
  let box: Element | null = e.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  const b = box?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
  return { ok: r.top >= Math.max(0, b.top) - 1 && r.bottom <= Math.min(innerHeight, b.bottom) + 1, top: Math.round(r.top), bottom: Math.round(r.bottom), boxTop: Math.round(b.top), boxBottom: Math.round(b.bottom), scrollTop: box?.scrollTop ?? 0 };
});

test('without an AI: a steady count, help where the answer stands, assumed answers marked, the first step in sight', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 600_000 }, async (t) => {
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
    for (const [width, height, motion] of [[1440, 900, 'no-preference'], [1024, 768, 'reduce']] as const) {
      const size = `${width}x${height}`;
      const page = await browser.newPage();
      await page.setViewport({ width, height });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: motion }]);
      await page.evaluateOnNewDocument(`
        const none = async () => null;
        window.vanilla = { chooseFolder: none, chooseNewFolder: none, onMenu: () => () => undefined, setLanguage: () => undefined, saveFile: async () => false };
        try { localStorage.setItem('language', 'de'); } catch { /* about:blank has no storage */ }
      `);
      // The form, the way without an AI: the same help under the same questions.
      await page.goto(`http://${host}/start?new`, { waitUntil: 'networkidle0', timeout: 60_000 });
      await press(page, '[data-answer=create]');
      await page.waitForSelector('.st-form [data-q=vatMethod] [data-where]', { timeout: 20_000 });
      for (const q of ['vatMethod', 'basis', 'start']) assert.ok(await page.$(`.st-form [data-q=${q}] [data-where]`), `${size}: the form says where «${q}» stands`);
      assert.doesNotMatch(await page.$eval('.st-form', (e) => (e as HTMLElement).innerText), /Art\. 39|auf Gesuch/, `${size}: the form cites no law`);
      await page.$eval('.st-form [data-q=vatMethod]', (e) => e.scrollIntoView({ block: 'start' }));
      await shot(page, `${size}-0-form`);
      if (size === '1440x900') t.diagnostic(`words: form ${await words(page, '.st-form')}`);
      const root = join(dir, `Malerei-${size}`);
      await page.goto(`http://${host}/start`, { waitUntil: 'networkidle0', timeout: 60_000 });
      await page.evaluate(async (r) => { await fetch('/api/desktop/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: r, language: 'de' }) }); }, root);
      await page.goto(`http://${host}/start?setup=${encodeURIComponent(root)}`, { waitUntil: 'networkidle0', timeout: 60_000 });

      // Before the books: the count after each answer.
      const counts: string[] = [];
      /** The count once the next question shows. */
      const seen = async (next: string) => { await page.waitForSelector(next, { visible: true, timeout: 20_000 }); counts.push(await count(page)); };
      await page.waitForSelector('.obflow input[name=name]', { timeout: 30_000 });
      counts.push(await count(page));
      await page.type('.obflow input[name=name]', 'Malerei Huber GmbH');
      await page.type('.obflow input[name=uid]', UID);
      await page.type('.obflow input[name=owner]', 'Sandra Huber');
      await press(page, '[data-act=firm-next]');
      await press(page, '[data-step=preset] [data-answer=trades]');
      await seen('[data-step=vatRegistered] [data-answer=yes]');
      await press(page, '[data-step=vatRegistered] [data-answer=yes]');
      await seen('[data-step=vatMethod] [data-answer=net-rate]');
      // «MWST-Methode» says where the answer stands and what a wrong pick costs.
      await page.waitForSelector('[data-step=vatMethod] [data-where]', { timeout: 20_000 });
      assert.match(await page.$eval('[data-step=vatMethod] [data-where]', (e) => (e as HTMLElement).innerText), /Schreiben der ESTV.*Treuhand.*Firma › MWST/s);
      await shot(page, `${size}-1-method-help`);
      await press(page, '[data-step=vatMethod] [data-answer=net-rate]');
      await seen('[data-step=basis] [data-answer=received]');
      // Changed her mind: the effective method asks fewer questions; the count stays as it was.
      await page.click('[data-step=vatMethod] .obme .linkbtn');
      await press(page, '[data-step=vatMethod] [data-answer=effective]');
      await seen('[data-step=basis] [data-answer=received]');
      const basis = await page.$eval('[data-step=basis]', (e) => (e as HTMLElement).innerText);
      assert.doesNotMatch(basis, /Art\. 39|auf Gesuch/, '«Abrechnungsart» cites no law');
      assert.match(basis, /Schreiben der ESTV/);
      await press(page, '[data-step=basis] [data-answer=received]');
      await seen('[data-step=period] [data-answer=quarterly]');
      await press(page, '[data-step=period] [data-answer=quarterly]');
      await seen('.obflow input[name=bank1]');
      await page.type('.obflow input[name=bank1]', 'Raiffeisen');
      await page.type('.obflow input[name=iban1]', IBAN);
      await press(page, '[data-act=banks-next]');
      await page.waitForSelector('[data-step=review]', { timeout: 20_000 });
      counts.push(await count(page));
      const totals = new Set(counts.map((c) => c.replace(/^\d+ /, '')));
      assert.deepEqual([...totals], ['von 4 erledigt'], `${size}: the total never changes (${counts.join(' → ')})`);
      const done = counts.map((c) => Number(c.split(' ')[0]));
      for (let i = 1; i < done.length; i++) assert.ok(done[i] >= done[i - 1], `${size}: never back (${counts.join(' → ')})`);
      assert.equal(done.at(-1), 4);
      // The review marks what she never said.
      const review = await page.$eval('[data-step=review]', (e) => (e as HTMLElement).innerText);
      assert.match(review, /Ausgangslage\s+neue Firma, leere Bücher\s*angenommen\b/, `${size}: «Ausgangslage» is marked as assumed`);
      assert.match(review, /hast du nicht gesagt: so ist es üblich bei Handwerk, Bau \(GmbH\)/, `${size}: and why`);
      assert.match(review, /Kundschaft im Ausland\?\s+nein\s*angenommen/, `${size}: «Kundschaft im Ausland» too`);
      assert.doesNotMatch(review.slice(review.indexOf('Im MWST-Register'), review.indexOf('Geschäftsjahr')), /angenommen/, 'the VAT she answered is not marked');
      await page.$eval('[data-step=review]', (e) => e.scrollIntoView({ block: 'start' }));
      await shot(page, `${size}-2-review`);
      if (size === '1440x900') t.diagnostic(`words: conversation before the books ${await words(page, '.obflow .obflowturns')}`);

      // In the books: no AI on this Mac.
      await press(page, '[data-act=setup-create]');
      await page.waitForSelector('.aside.setup [data-step=company]', { timeout: 60_000 });
      await page.waitForFunction(() => /mit einem Klick\./.test((document.querySelector('.aside.setup [data-step=company]') as HTMLElement | null)?.innerText ?? ''), { timeout: 20_000 });
      assert.doesNotMatch(await page.$eval('.aside.setup [data-step=company]', (e) => (e as HTMLElement).innerText), /in deinen Worten/, `${size}: the greeting offers no words the field cannot take`);
      await press(page, '[data-step=opening] [data-answer=later]');
      await page.waitForSelector('[data-step=receipts] [data-testid=sources-no-ai]', { timeout: 20_000 });
      assert.equal(await page.$('[data-act=sources-ask]'), null, `${size}: «Mit mir einrichten» is not offered without an AI`);
      assert.ok(await page.$('[data-step=receipts] [data-act=ai-set-up]'), `${size}: its place leads to «KI einrichten»`);
      // The newest question comes into sight after an answer.
      await new Promise((r) => setTimeout(r, motion === 'reduce' ? 100 : 1000));
      const next = await inSight(page, '[data-step=receipts] [data-answer=later]');
      assert.ok(next.ok, `${size}: the receipts question's answers in sight after «Später» on the opening (${JSON.stringify(next)})`);
      await shot(page, `${size}-3-receipts`);
      await press(page, '[data-step=receipts] [data-answer=later]');
      await page.waitForSelector('[data-testid=setup-summary] [data-first]', { timeout: 20_000 });
      // The smooth scroll ends; then the first step and its button are in sight.
      await page.waitForFunction(() => { const b = document.querySelector('[data-testid=setup-statement]')!.getBoundingClientRect(); return b.bottom > 0 && b.bottom <= innerHeight; }, { timeout: 5_000 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, motion === 'reduce' ? 100 : 1000));
      for (const sel of ['[data-testid=setup-summary] [data-first]', '[data-testid=setup-statement]']) {
        const at = await inSight(page, sel);
        assert.ok(at.ok, `${size}: ${sel} in sight after the last answer (${JSON.stringify(at)})`);
      }
      assert.match(await page.$eval('.obrail [data-progress]', (e) => (e as HTMLElement).innerText), /^4 von 4 besprochen$/, `${size}: «Partner und Wissen» was never asked and is not counted`);
      assert.match(await page.$eval('[data-open=knowledge]', (e) => (e as HTMLElement).innerText), /kommt mit den ersten Buchungen/);
      await shot(page, `${size}-4-summary`);
      if (size === '1440x900') t.diagnostic(`words: conversation in the books ${await words(page, '.aside.setup .aiturns')}`);
      await page.close();
    }
  } finally {
    await closeChrome(browser);
    server.close();
  }
});
