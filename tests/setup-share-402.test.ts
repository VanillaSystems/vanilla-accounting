/**
 * #402: «s Gschäftshandy bruuch ich au privat, öppe d Hälfti» in the setup. The share is kept with her
 * words (in the setup's draft, then in onboarding.json, never in the settings), the reply says what
 * the app will do with it, and the phone provider's first booked payment offers the rule «50 %
 * privat» on its card, from her words. A changed answer on the review keeps naming the kind she chose.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { kindOf, newDraft, withPatch, type SetupDraft } from '../src/onboarding/draft.js';
import { sharesOf } from '../src/onboarding/draft-store.js';
import { applyTalk, parseTalk, talkPrompt } from '../src/onboarding/draft-talk.js';
import { seedCreated, readProgress } from '../src/onboarding/store.js';
import { clearTakenShares, dismissSetupShare, shareOffer, withShareRule } from '../src/saving/share-rule.js';
import { loadBooks } from '../src/books/store.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { testIban } from './support/iban.js';

const NOW = '2026-11-13T09:00:00.000Z';
const WORDS = 's Gschäftshandy bruuch ich au privat, öppe d Hälfti';
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const consultant = (): SetupDraft => withPatch(newDraft('de', NOW), { step: 'preset', value: 'consultant' });

test('the share her words name is kept with her words, of what is used privately, and the reply carries it', () => {
  const out = parseTalk(JSON.stringify({ say: 'Verstanden.', answers: { privateUse: ['phone'] }, privateShares: { phone: { percent: 50, words: 'öppe d Hälfti' } } }))!;
  const { draft, reply } = applyTalk(consultant(), out, [WORDS], 'CHF');
  assert.deepEqual(draft.shares, { phone: { percent: 50, said: 'öppe d Hälfti' } }, 'the words that name the share, not the whole message');
  assert.deepEqual(reply.kind === 'read' && reply.shares, { phone: { percent: 50, said: 'öppe d Hälfti' } });
  // Words the model claims she wrote and she did not: no words kept.
  const made = applyTalk(consultant(), parseTalk(JSON.stringify({ say: '', answers: { privateUse: ['phone'] }, privateShares: { phone: { percent: 50, words: 'zur Hälfte privat' } } }))!, [WORDS], 'CHF');
  assert.deepEqual(made.draft.shares, { phone: { percent: 50, said: '' } });
  // A share of what the setup does not name as used privately, or no whole percent: nothing kept.
  const car = applyTalk(consultant(), parseTalk(JSON.stringify({ say: '', answers: { privateUse: ['phone'] }, privateShares: { car: 50, phone: 150 } }))!, [WORDS], 'CHF');
  assert.equal(car.draft.shares, undefined);
  assert.match(talkPrompt(consultant(), WORDS, [], 'CHF'), /privateShares: only when the words name how much of the phone's or the car's use is private/);
  // Taken back from «private use», it does not reach the books.
  assert.equal(sharesOf({ ...draft, answers: { ...draft.answers, privateUse: [] } }), undefined);
  assert.deepEqual(sharesOf(draft), { phone: { percent: 50, said: 'öppe d Hälfti' } });
});

const pay = (ref: string, date: string, amount: number): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty: 'Alpentel AG', counterpartyIban: testIban('04835012345678009'), description: 'Mobilfunk' });
const booked = (t: BankTransaction): JournalEntry =>
  ({ id: `e-${t.ref}`, transactionRef: t.ref, date: t.date, accountDebit: '6510', accountCredit: '1020', amount: t.amount, vatCode: 'I81', description: 'Alpentel, Mobilfunk', origin: 'classify', by: { kind: 'model', model: 'test' } });

function firm(shares: boolean, opt: { car?: boolean; chartName?: string; bookA8?: boolean } = {}): Workspace {
  const made = tempWorkspace('share-402-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: yes\n  imports: no\n  employees: owner\n  ownerPaysPrivately: yes\n  privateUse: [phone]\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.number === '6510' && opt.chartName ? opt.chartName : a.name, type: a.type }))));
  const t = pay('A7', '2026-07-20', 84.35);
  const t8 = pay('A8', '2026-08-20', 97.2);
  const fuel = { ...pay('F7', '2026-07-22', 80), counterparty: 'Tankstelle Zug', counterpartyIban: undefined };
  writeIndex(ws, {
    transactions: [t, t8, fuel],
    journalEntries: [booked(t), ...(opt.bookA8 ? [{ ...booked(t8) }] : []), { ...booked(fuel), accountDebit: '6200' }],
    config: { closedThrough: '2026-06-30' },
  });
  if (shares) seedCreated(ws, { started: NOW, shares: { phone: { percent: 50, said: 'öppe d Hälfti' }, ...(opt.car && { car: { percent: 30, said: '' } }) } }, NOW);
  return ws;
}

test('the phone provider\'s first booked payment offers her share as the rule of its payer, from her words', () => {
  const ws = firm(true);
  assert.deepEqual(readProgress(ws).shares, { phone: { percent: 50, said: 'öppe d Hälfti' } }, 'onboarding.json keeps it');
  assert.ok(!readFileSync(join(ws.paths.root, 'belege.workspace.yaml'), 'utf8').includes('Hälfti'), 'never the settings');
  const offer = shareOffer(ws, loadBooks(ws), 'A7')!;
  assert.deepEqual([offer.percent, offer.booking, offer.setup], [50, { account: '6510', vat: 'I81', private: 50 }, { item: 'phone', said: 'öppe d Hälfti' }]);
  assert.equal(shareOffer(ws, loadBooks(ws), 'A8'), undefined, 'a payment not booked yet offers nothing');
  const rule = withShareRule('', offer, '2026-11-13');
  assert.match(rule, /then: \{ account: "?6510"?, vat: I81, private: 50 \}/);
  assert.match(rule, /source: wish 2026-11-13/);
  // Without a share named in the setup: nothing.
  const bare = firm(false);
  assert.equal(shareOffer(bare, loadBooks(bare), 'A7'), undefined);
});

test('the setup\'s offer: on the first booked payment of a business only, never for the car, not on a chart that uses the account otherwise; «Nicht jetzt», «Nie» and a kept rule end it', () => {
  const ws = firm(true, { car: true, bookA8: true });
  assert.ok(shareOffer(ws, loadBooks(ws), 'A7'), 'the first payment');
  assert.equal(shareOffer(ws, loadBooks(ws), 'A8'), undefined, 'not again on the next one');
  assert.equal(shareOffer(ws, loadBooks(ws), 'F7'), undefined, 'no offer per petrol station: the car share stays for the year close');
  assert.deepEqual(readProgress(ws).shares?.car, { percent: 30, said: '' }, 'kept all the same');
  assert.equal(dismissSetupShare(ws, 'A7'), true);
  assert.equal(shareOffer(ws, loadBooks(ws), 'A7'), undefined, '«Nicht jetzt» for this business holds');
  assert.equal(dismissSetupShare(firm(true), 'A7', true), true);
  const never = firm(true);
  dismissSetupShare(never, 'A7', true);
  assert.equal(readProgress(never).shares?.phone, undefined, '«Nie»: the share goes');
  const renamed = firm(true, { chartName: 'Fahrzeugleasing' });
  assert.equal(shareOffer(renamed, loadBooks(renamed), 'A7'), undefined, 'the firm uses 6510 for something else');
  const kept = firm(true);
  mkdirSync(join(kept.paths.root, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(kept.paths.root, 'knowledge', 'rules', 'booking.guide.yaml'), 'process: booking\nsteps:\n  classify:\n    rules:\n      - id: alpentel-privat\n        when: { text: "Mobilfunk" }\n        then: { account: "6510", vat: 81, private: 50 }\n        source: wish 2026-11-13\n');
  clearTakenShares(kept);
  assert.equal(readProgress(kept).shares?.phone, undefined, 'a kept rule took the share');
});

test('one changed answer on the review keeps her kind of firm, «mit einer Änderung»', () => {
  const taken = withPatch(consultant(), { step: 'question', key: 'start', value: null });
  const changed = withPatch(taken, { step: 'question', key: 'start', value: 'switching' });
  assert.equal(changed.preset, 'custom', 'internally the preset is custom, so the question was asked');
  assert.deepEqual(kindOf(changed), { kind: 'consultant', changes: 1 });
  assert.deepEqual(kindOf(withPatch(taken, { step: 'question', key: 'start', value: 'new' })), { kind: 'consultant', changes: 0 }, 'changed back: no change to name');
  assert.deepEqual(kindOf(withPatch(changed, { step: 'preset', value: 'custom' })), { kind: 'custom', changes: 0 }, 'her own «Etwas anderes»');
  assert.deepEqual(kindOf(withPatch(changed, { step: 'preset', value: 'trades' })), { kind: 'trades', changes: 0 });
});
