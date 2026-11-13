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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { browserPath, closeChrome, launchChrome } from './support/browser.js';
import { testIban } from './support/iban.js';
import { APP_FOLDER, MANIFEST_FILE } from '../src/workspace/workspace.js';

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

/** The receipts card's look at this Mac's AI, once it has answered: `ready` or `none`. */
const aiLook = (page: Page) => page.waitForFunction(() => {
  const v = document.querySelector('[data-step=receipts] .obcard[data-ai]')?.getAttribute('data-ai');
  return v && v !== 'unknown' ? v : false;
}, { timeout: 60_000, polling: 100 }).then((h) => h.jsonValue() as Promise<string>);

/**
 * With an AI: the books' look says so. On a machine under load (the full suite beside test VMs) a look
 * can run past its time and say «none» although the stub answers; the app looks again when the window
 * gets focus, as for a person who comes back to it, so the test does that, at most three times.
 */
async function aiReady(page: Page): Promise<string> {
  let look = await aiLook(page);
  for (let i = 0; i < 3 && look !== 'ready'; i++) {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    look = await page.waitForFunction(() => document.querySelector('[data-step=receipts] .obcard[data-ai]')?.getAttribute('data-ai') === 'ready', { timeout: 30_000, polling: 100 }).then(() => 'ready', () => look);
  }
  return look;
}

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
      // /start?new is new books chosen already (#363): without an AI it is the form; with one, «Ohne KI einrichten» leads there.
      if (ai) { await page.waitForSelector('[data-ready=claude]', { timeout: 60_000 }); await press(page, '[data-act=by-hand]'); }
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
      // The jump to the first missing question focuses the question, never its first answer, which would read as a proposal (#385).
      await page.waitForFunction(() => document.activeElement?.matches('.st-form [data-q=vatMethod]'), { timeout: 10_000 });
      assert.match(await text(page, '.st-form [data-q=vatMethod] .st-qhd'), /bitte wählen/, `${size}: the question says it waits for her`);
      await page.keyboard.press('Tab');
      assert.deepEqual(await page.evaluate(() => [document.activeElement?.closest('[data-q]')?.getAttribute('data-q'), document.activeElement?.getAttribute('aria-checked')]), ['vatMethod', 'false'], `${size}: Tab goes on to its first answer, not chosen`);
      // What the kind of firm gave and she did not touch is marked where it stands, with one line why (#385); a touched answer loses its mark.
      assert.match(await text(page, '.st-form [data-assumed-note]'), /angenommen, weil es bei Beratung, Dienstleistungen \(GmbH\) üblich ist/);
      assert.ok(await page.$('.st-form [data-q=employees] [data-assumed]'), `${size}: «Angestellte» marked assumed`);
      assert.equal(await page.$('.st-form [data-q=vatMethod] [data-assumed]'), null, `${size}: no mark on a VAT question she answers herself`);
      await press(page, '.st-form [data-q=employees] button[role=radio]:nth-child(3)');
      await page.waitForFunction(() => !document.querySelector('.st-form [data-q=employees] [data-assumed]'), { timeout: 10_000 });
      assert.ok(await page.$('.st-form [data-q=imports] [data-assumed]'), `${size}: the others keep theirs`);
      await page.$eval('.st-form [data-q=vatMethod]', (e) => e.scrollIntoView({ block: 'start' }));
      await shot(page, `${size}-0-form`);
      if (size === '1440x900') t.diagnostic(`words: form ${await words(page, '.st-form')}`);
      if (!ai) {
        // «nein», then «ja» to the registration: the period «nein» took away is asked again, not «angenommen» with nothing chosen (#387 review).
        await page.$$eval('.st-form [data-q=vatRegistered] button', (bs) => (bs[1] as HTMLButtonElement).click());
        await page.waitForFunction(() => !document.querySelector('.st-form [data-q=period]'), { timeout: 10_000 });
        await page.$$eval('.st-form [data-q=vatRegistered] button', (bs) => (bs[0] as HTMLButtonElement).click());
        await page.waitForSelector('.st-form [data-q=period]', { timeout: 10_000 });
        assert.equal(await page.$('.st-form [data-q=period] button.on'), null);
        assert.equal(await page.$('.st-form [data-q=period] [data-assumed]'), null, `${size}: no mark on a question without an answer`);
        await page.$$eval('.st-form [data-q=period] button', (bs) => (bs[0] as HTMLButtonElement).click());
        // «Wir rechnen keine MWST ab» (#347) on the form: «nein» to the registration, the two questions gone, the books an unregistered GmbH.
        assert.match(await text(page, '.st-form [data-q=vatMethod] [data-no-vat-hint]'), /nicht im MWST-Register.*CHF 100’000.*Treuhand/s);
        assert.deepEqual(await page.$$eval('.st-form [data-no-vat-hint]', (e) => e.map((x) => x.getAttribute('data-no-vat-hint'))), ['full', 'short'], `${size}: the hint whole under the method, short under the basis (#398)`);
        assert.match(await text(page, '.st-form [data-q=basis] [data-no-vat-hint]'), /«Wir rechnen keine MWST ab» nur, wenn die Firma nicht im MWST-Register steht/);
        // A rate typed for the Saldosteuersatz goes with the answer, as in the conversation.
        await press(page, '.st-form [data-q=vatMethod] button[role=radio]:nth-child(2)');
        await page.waitForSelector('.st-form input[name=netRate1]', { timeout: 10_000 });
        await page.type('.st-form input[name=netRate1]', '4.5');
        await press(page, '.st-form [data-q=vatMethod] [data-answer=no-vat]');
        await page.waitForFunction(() => !document.querySelector('.st-form [data-q=vatMethod]') && !document.querySelector('.st-form [data-q=basis]'), { timeout: 10_000 });
        assert.match(await text(page, '.st-form [data-q=vatRegistered] button.on'), /^nein$/, `${size}: the registration answer says the same`);
        // Back to «ja» and the Saldosteuersatz: the rate she typed is gone, the method asked again.
        await page.$$eval('.st-form [data-q=vatRegistered] button', (bs) => (bs[0] as HTMLButtonElement).click());
        await press(page, '.st-form [data-q=vatMethod] button[role=radio]:nth-child(2)');
        await page.waitForSelector('.st-form input[name=netRate1]', { timeout: 10_000 });
        assert.equal(await page.$eval('.st-form input[name=netRate1]', (e) => (e as HTMLInputElement).value), '', `${size}: the rate went with the answer`);
        await press(page, '.st-form [data-q=vatMethod] [data-answer=no-vat]');
        await page.waitForFunction(() => !document.querySelector('.st-form [data-q=vatMethod]'), { timeout: 10_000 });
        await page.$$eval('.st-form button', (bs) => (bs.find((b) => (b as HTMLElement).innerText.trim() === 'Buchhaltung anlegen') as HTMLButtonElement).click());
        const home = join(dir, 'Documents');
        await page.waitForFunction(() => location.pathname !== '/start', { timeout: 60_000 });
        const made = readdirSync(home).map((f) => join(home, f, APP_FOLDER, MANIFEST_FILE)).find((f) => existsSync(f));
        assert.ok(made, `${size}: the form created books`);
        const manifest = readFileSync(made!, 'utf8');
        assert.match(manifest, /vat:\n\s+registered: false\n/, `${size}: the form's books are not registered for VAT`);
        assert.match(manifest, /legalForm: GmbH/);
      }

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
      assert.match(basis, /ESTV-Portal unter «Neue Geschäfte».*Karte «Abrechnungsmodalitäten» auf «Anpassen».*vereinbart oder vereinnahmt \(du musst nichts ändern\).*Treuhand/s);
      assert.doesNotMatch(basis, /Gesetz|gilt, (wenn|ausser)/, '«Abrechnungsart» names no basis as the one that applies (#423)');
      await shot(page, `${size}-1b-basis-help`);
      assert.equal(await page.$('[data-step=basis] .qacts .btn.primary'), null, `${size}: no basis drawn as the proposal`);
      if (ai) {
        await press(page, '[data-step=basis] [data-answer=received]');
        await seen('[data-step=period] [data-answer=quarterly]');
        await press(page, '[data-step=period] [data-answer=quarterly]');
      } else {
        // «Wir rechnen keine MWST ab» (#347) in the conversation: the same «nein», the basis and the period not asked.
        assert.match(await text(page, '[data-step=basis] [data-no-vat-hint=short]'), /nicht im MWST-Register/, `${size}: the answer never stands without its line (#398)`);
        await press(page, '[data-step=basis] [data-answer=no-vat]');
      }
      await seen('.obflow input[name=bank1]');
      if (!ai) {
        assert.equal(await page.$('[data-step=vatMethod]'), null, `${size}: no method asked of a firm that files no VAT`);
        assert.match(await text(page, '[data-step=vatRegistered] .obme'), /nein/, `${size}: the registration answer says the same`);
      }
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
      if (!ai) assert.match(review, /Im MWST-Register eingetragen\?\s+Die Firma rechnet keine MWST ab: Käufe und Verkäufe werden ohne MWST gebucht, Rechnungen der App tragen keine MWST, und es gibt keine Abrechnung\.\s*Ändern/, `${size}: the review says plainly what follows, with «Ändern»`);
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
      if (!ai) assert.match(readFileSync(join(root, APP_FOLDER, MANIFEST_FILE), 'utf8'), /vat:\n\s+registered: false\n/, `${size}: the conversation's books are not registered for VAT`);
      await press(page, '[data-step=opening] [data-answer=later]');
      await page.waitForSelector('[data-step=receipts] [data-answer=later]', { timeout: 20_000 });
      // The look at the AI has answered: the receipts card says which, and the greeting follows it.
      assert.equal(ai ? await aiReady(page) : await aiLook(page), ai ? 'ready' : 'none', `${size}: the books' look at the AI`);
      const greeting = ai ? /mit einem Klick oder in deinen Worten/ : /mit einem Klick\./;
      assert.match(await text(page, '.aside.setup [data-step=company]'), greeting, `${size}: the greeting says what works on this Mac`);
      if (!ai) assert.doesNotMatch(await text(page, '.aside.setup [data-step=company]'), /in deinen Worten/, `${size}: the greeting offers no words the field cannot take`);
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
      // The chips are what the count counts (#385, r2-ai-11): four, not five beside «4 von 4».
      assert.deepEqual(await page.$$eval('.obrail button', (bs) => bs.map((b) => (b as HTMLElement).innerText.trim())), ['Firma und MWST', 'Eröffnung', 'Bank', 'Belege'], `${size}: four chips beside the count`);
      assert.match(await text(page, '[data-open=knowledge]'), /kommt mit den ersten Buchungen/);
      if (!ai) assert.match(await text(page, '[data-testid=setup-summary]'), /Die Firma rechnet keine MWST ab: Käufe und Verkäufe ohne MWST, Rechnungen der App ohne MWST, keine Abrechnung[\s\S]*Änderbar unter Firma › MWST, solange das Jahr keine Buchungen hat/, `${size}: the summary says it too, and where it changes`);
      // The assumed answers stand once, on the firm's card (#398): the summary counts them and leads there.
      assert.equal(await page.$('[data-testid=setup-summary] [data-assumed-list]'), null, `${size}: no second list in the summary`);
      assert.match(await text(page, '[data-testid=setup-summary] [data-assumed-count]'), /^\d+ Antworten? angenommen · ansehen$/);
      assert.equal(await page.$$eval('.aside.setup [data-assumed-list]', (e) => e.length), 1, `${size}: the list once, on the firm's card`);
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
      // The first step leads to the statements, which stand in no quarter while the books hold no payment, and say what to drop (#385).
      await press(page, '[data-testid=setup-statement]');
      await page.waitForFunction(() => /Noch kein Kontoauszug/.test((document.querySelector('.page .empty') as HTMLElement | null)?.innerText ?? ''), { timeout: 20_000 });
      assert.match(await text(page, '.page .empty'), /camt\.053-Datei \(XML\) oder das PDF deiner Bank/);
      assert.doesNotMatch(await text(page, '.page .empty'), /Q\d \d{4}/, `${size}: the empty page names no quarter`);
      assert.equal(await page.$('.page .lhead [data-testid=period-picker]'), null, `${size}: the page's head names no period yet`);
      await shot(page, `${size}-6-statements`);
      await page.close();
    }
  } finally {
    await closeChrome(browser);
    server.close();
  }
});
