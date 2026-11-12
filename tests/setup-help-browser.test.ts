/**
 * The setup as a person meets it (#364), in the real UI built with Vite on the desktop's own server:
 * with an AI (the claude stub, signed in) at the Mac app's default window (1440 × 900, smooth
 * scrolling), without one at a small window (1024 × 768, reduced motion).
 *
 * - The form and the conversation before the books say where the answer to «MWST-Methode»,
 *   «Abrechnungsart» and «Ausgangslage» stands, cite no law, and steer neither VAT question: no answer
 *   drawn as the proposal, none preselected; the form asks for both before it creates the books.
 * - The count before the books is of four parts, the same for every firm, so it never jumps or
 *   shrinks («0 von 14», «1 von 4», «4 von 8» before).
 * - The review marks what the kind of firm assumed, named after that kind also once it became
 *   «Etwas anderes».
 * - In the books: without an AI the greeting offers no words and the receipts step offers «KI
 *   einrichten»; after an answer the newest question is in sight; after the last answer the first
 *   step and «Kontoauszug einlesen» are, also while an AI answer streams in after it and when the
 *   setup opens again on the summary; «Partner und Wissen», never asked on books without bookings, is
 *   not counted as discussed.
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
const STUB = join(process.cwd(), 'tests/support/stub-bin/claude');
const NONE = join(dir, 'no-such-claude');
Object.assign(process.env, {
  HOME: dir, VANILLA_WORKSPACE: '', VANILLA_AI_SETTINGS: join(dir, 'ai.json'), VANILLA_SECRETS_FILE: join(dir, 'secrets.json'),
  CLAUDE_BIN: NONE, CODEX_BIN: join(dir, 'no-such-codex'),
});
writeFileSync(join(dir, 'secrets.json'), '{}');
const SHOTS = process.env.SETUP_HELP_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const UID = 'CHE-153.004.184';
const IBAN = testIban('00762011623852957');

/** The words a person reads in `sel`: what has a letter in it. */
const words = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length);
const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText);
const count = (page: Page) => text(page, '.obflowhd [data-progress]').then((s) => s.trim());
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
/** Waits for `sel`, then clicks it as a person would. */
const press = async (page: Page, sel: string) => { await page.waitForSelector(sel, { visible: true, timeout: 20_000 }); await page.click(sel); };

/** Where the element lies: wholly inside the window and the scroll box around it (`ok`), with the numbers for the message. */
const measure = (sel: string) => {
  const e = document.querySelector(sel);
  if (!e) return { ok: false, missing: sel };
  const r = e.getBoundingClientRect();
  let box: Element | null = e.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  const b = box?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
  return { ok: r.top >= Math.max(0, b.top) - 1 && r.bottom <= Math.min(innerHeight, b.bottom) + 1, top: Math.round(r.top), bottom: Math.round(r.bottom), boxTop: Math.round(b.top), boxBottom: Math.round(b.bottom), scrollTop: box?.scrollTop ?? 0 };
};
/** Waits until `sel` is in sight (a smooth scroll ends), and says where it is. */
const inSight = async (page: Page, sel: string) => {
  await page.waitForFunction((s, f) => (new Function(`return (${f})`)() as (x: string) => { ok: boolean })(s).ok, { timeout: 5_000, polling: 50 }, sel, measure.toString()).catch(() => undefined);
  return page.evaluate((s, f) => (new Function(`return (${f})`)() as (x: string) => { ok: boolean })(s), sel, measure.toString());
};

test('a steady count, help where the answer stands, no VAT answer steered, assumed answers marked, the first step in sight', { skip: browserPath ? false : 'no Chromium browser installed (CHROME_PATH)', timeout: 600_000 }, async (t) => {
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
    for (const [width, height, motion, ai] of [[1440, 900, 'no-preference', true], [1024, 768, 'reduce', false]] as const) {
      const size = `${width}x${height}`;
      // Detection asks the pinned program afresh on every look.
      process.env.CLAUDE_BIN = ai ? STUB : NONE;
      const page = await browser.newPage();
      await page.setViewport({ width, height });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: motion }]);
      await page.evaluateOnNewDocument(`
        const none = async () => null;
        window.vanilla = { chooseFolder: none, chooseNewFolder: none, onMenu: () => () => undefined, setLanguage: () => undefined, saveFile: async () => false };
        try { localStorage.setItem('language', 'de'); } catch { /* about:blank has no storage */ }
      `);

      // The form: the same help under the same questions; neither VAT question answered for her.
      await page.goto(`http://${host}/start?new`, { waitUntil: 'networkidle0', timeout: 60_000 });
      if (ai) { await page.waitForSelector('[data-ready=claude]', { timeout: 60_000 }); await press(page, '[data-act=by-hand]'); } else await press(page, '[data-answer=create]');
      await page.waitForSelector('.st-form [data-q=vatMethod] [data-where]', { timeout: 20_000 });
      for (const q of ['vatMethod', 'basis', 'start']) assert.ok(await page.$(`.st-form [data-q=${q}] [data-where]`), `${size}: the form says where «${q}» stands`);
      assert.doesNotMatch(await text(page, '.st-form'), /Art\. 39|auf Gesuch|das Übliche/, `${size}: the form cites no law and calls no method the usual one`);
      for (const q of ['vatMethod', 'basis']) assert.equal(await page.$(`.st-form [data-q=${q}] button.on`), null, `${size}: «${q}» has no answer selected for her`);
      await page.type('.st-form input[name=name]', 'Malerei Huber GmbH');
      await page.type('.st-form input[name=uid]', UID);
      await page.type('.st-form input[name=owner]', 'Sandra Huber');
      await page.$$eval('.st-form button', (bs) => (bs.find((b) => (b as HTMLElement).innerText.trim() === 'Buchhaltung anlegen') as HTMLButtonElement).click());
      await page.waitForSelector('.st-form [data-q=vatMethod].err', { timeout: 10_000 });
      assert.ok(await page.$('.st-form [data-q=basis].err'), `${size}: both VAT questions wait for her click`);
      assert.match(await text(page, '.st-create'), /Bitte jede Frage beantworten/);
      await page.$eval('.st-form [data-q=vatMethod]', (e) => e.scrollIntoView({ block: 'start' }));
      await shot(page, `${size}-0-form`);
      if (size === '1440x900') t.diagnostic(`words: form ${await words(page, '.st-form')}`);

      // Before the books: the count after each answer, the help, no proposal on the two VAT questions.
      const root = join(dir, `Malerei-${size}`);
      await page.evaluate(async (r) => { await fetch('/api/desktop/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: r, language: 'de' }) }); }, root);
      await page.goto(`http://${host}/start?setup=${encodeURIComponent(root)}`, { waitUntil: 'networkidle0', timeout: 60_000 });
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
      assert.match(await text(page, '[data-step=vatMethod] [data-where]'), /beantragt.*Formular 0553.*Treuhand.*Firma › MWST/s);
      assert.equal(await page.$('[data-step=vatMethod] .qacts .btn.primary'), null, `${size}: no method drawn as the proposal`);
      await shot(page, `${size}-1-method-help`);
      await press(page, '[data-step=vatMethod] [data-answer=net-rate]');
      await seen('[data-step=basis] [data-answer=received]');
      // Changed her mind: the effective method asks fewer questions; the count stays as it was.
      await page.click('[data-step=vatMethod] .obme .linkbtn');
      await press(page, '[data-step=vatMethod] [data-answer=effective]');
      await seen('[data-step=basis] [data-answer=received]');
      const basis = await text(page, '[data-step=basis]');
      assert.doesNotMatch(basis, /Art\. 39|auf Gesuch/, '«Abrechnungsart» cites no law');
      assert.match(basis, /Vereinbart sieht das Gesetz vor; vereinnahmt gilt, wenn die Firma es beantragt hat.*Treuhand/s);
      assert.equal(await page.$('[data-step=basis] .qacts .btn.primary'), null, `${size}: no basis drawn as the proposal`);
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

      // The review marks what she never said, named after the kind of firm that assumed it, also after a change made it «Etwas anderes».
      let review = await text(page, '[data-step=review]');
      assert.match(review, /Ausgangslage\s+neue Firma, leere Bücher\s*angenommen\b/, `${size}: «Ausgangslage» is marked as assumed`);
      assert.match(review, /Kundschaft im Ausland\?\s+nein\s*angenommen/, `${size}: «Kundschaft im Ausland» too`);
      assert.doesNotMatch(review.slice(review.indexOf('Im MWST-Register'), review.indexOf('Geschäftsjahr')), /angenommen/, 'the VAT she answered is not marked');
      if (size === '1440x900') t.diagnostic(`words: conversation before the books ${await words(page, '.obflow .obflowturns')}`);
      await page.$$eval('[data-step=review] dt', (dts) => { const dt = dts.find((d) => (d as HTMLElement).innerText.trim() === 'Ausgangslage')!; ((dt.nextElementSibling!.nextElementSibling as HTMLElement).querySelector('button') as HTMLButtonElement).click(); });
      await press(page, '[data-step=start] [data-answer=switching]');
      await page.waitForSelector('[data-step=review]', { timeout: 20_000 });
      review = await text(page, '[data-step=review]');
      assert.match(review, /hast du nicht gesagt: so ist es üblich bei Handwerk, Bau \(GmbH\)/, `${size}: the note names the kind of firm that assumed, not «Etwas anderes»`);
      assert.doesNotMatch(review, /üblich bei Etwas anderes/);
      assert.match(review, /Ausgangslage\s+Wechsel von einer anderen Buchhaltung\s*Ändern/, `${size}: her own answer is no longer marked`);
      await page.$eval('[data-step=review]', (e) => e.scrollIntoView({ block: 'start' }));
      await shot(page, `${size}-2-review`);

      // In the books.
      await press(page, '[data-act=setup-create]');
      await page.waitForSelector('.aside.setup [data-step=company]', { timeout: 60_000 });
      const greeting = ai ? /mit einem Klick oder in deinen Worten/ : /mit einem Klick\./;
      await page.waitForFunction((re) => new RegExp(re).test((document.querySelector('.aside.setup [data-step=company]') as HTMLElement | null)?.innerText ?? ''), { timeout: 20_000 }, greeting.source);
      if (!ai) assert.doesNotMatch(await text(page, '.aside.setup [data-step=company]'), /in deinen Worten/, `${size}: the greeting offers no words the field cannot take`);
      await press(page, '[data-step=opening] [data-answer=later]');
      await page.waitForSelector('[data-step=receipts] [data-answer=later]', { timeout: 20_000 });
      if (ai) assert.ok(await page.$('[data-step=receipts] [data-act=sources-ask]'), `${size}: with an AI «Mit mir einrichten» is offered`);
      else {
        assert.ok(await page.$('[data-step=receipts] [data-testid=sources-no-ai]'), `${size}: without an AI its place says so`);
        assert.equal(await page.$('[data-act=sources-ask]'), null, `${size}: «Mit mir einrichten» is not offered without an AI`);
        assert.ok(await page.$('[data-step=receipts] [data-act=ai-set-up]'), `${size}: and leads to «KI einrichten»`);
      }
      const next = await inSight(page, '[data-step=receipts] [data-answer=later]');
      assert.ok(next.ok, `${size}: the receipts question's answers in sight after «Später» on the opening (${JSON.stringify(next)})`);
      await shot(page, `${size}-3-receipts`);
      await press(page, '[data-step=receipts] [data-answer=later]');
      await page.waitForSelector('[data-testid=setup-summary] [data-first]', { timeout: 20_000 });
      const firstInSight = async (when: string) => {
        for (const sel of ['[data-testid=setup-summary] [data-first]', '[data-testid=setup-statement]']) {
          const at = await inSight(page, sel);
          assert.ok(at.ok, `${size}: ${sel} in sight ${when} (${JSON.stringify(at)})`);
        }
      };
      await firstInSight('after the last answer');
      assert.match(await text(page, '.obrail [data-progress]'), /^4 von 4 besprochen$/, `${size}: «Partner und Wissen» was never asked and is not counted`);
      assert.match(await text(page, '[data-open=knowledge]'), /kommt mit den ersten Buchungen/);
      await shot(page, `${size}-4-summary`);
      if (size === '1440x900') t.diagnostic(`words: conversation in the books ${await words(page, '.aside.setup .aiturns')}`);

      if (ai) {
        // A long AI answer that streams in after the last answer, during the smooth scroll: the summary's top wins over the sidebar's follow-the-end.
        writeFileSync(join(dir, 'long-answer.txt'), Array.from({ length: 12 }, (_, i) => `Absatz ${i + 1}: Das ist eine lange Antwort, die in Stücken hereinkommt, damit das Ende der Unterhaltung weit unter der Zusammenfassung liegt.`).join('\n\n'));
        process.env.CLAUDE_STUB_TEXT = join(dir, 'long-answer.txt');
        await page.type('.aside .aicompose textarea', 'Danke, das reicht für heute.');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => /Stub-Antwort/.test((document.querySelector('.aside.setup .aiturns') as HTMLElement).innerText) && !document.querySelector('.aside .aitext.pending'), { timeout: 30_000 });
        await firstInSight('after an AI answer streamed in');
        // Opened again on the summary: the turns load after the conversation is drawn, and the first step stays in sight.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid=setup-summary] [data-first]', { timeout: 60_000 });
        await page.waitForFunction(() => /Stub-Antwort/.test((document.querySelector('.aside.setup .aiturns') as HTMLElement | null)?.innerText ?? ''), { timeout: 30_000 });
        await firstInSight('when the setup opens again on the summary');
        await shot(page, `${size}-5-reopened`);
      }
      await page.close();
    }
  } finally {
    await closeChrome(browser);
    server.close();
  }
});
