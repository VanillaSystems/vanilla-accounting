/**
 * A receipt whose VAT could not be read (issue #57, owner 21.10.: «ask instead of assuming»): the
 * payment is not booked on a guessed rate. It waits for the person, who answers «neu fotografieren»,
 * «so buchen wie meistens» (the rate this business's receipts showed most often) or «ohne Vorsteuer
 * buchen»; «Immer so?» drafts the company's rule `apply: { unreadReceipt }`. Nothing shipped assumes
 * a rate: only a company's own rule does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classifyStep } from '../src/intake/classify.js';
import type { IntakeNote } from '../src/intake/pipeline.js';
import { receiptWait, receiptKnowledge, type WaitContext } from '../src/booking/receipt-wait.js';
import { parseApply } from '../src/booking/purchase-vat.js';
import { isUnreadable, linkedOf, waitingForReceipt } from '../src/accounting/receipt-due.js';
import { unreadOffer, usualRate, withUnreadRule } from '../src/saving/unread-rule.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const OUT = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-10-05', amount: 23.5, currency: 'CHF', direction: 'DBIT', description: 'Kiosk Muster Bahnhof', ...over });
const SCAN = (id: string, over: Partial<Receipt> = {}): Receipt =>
  ({ id, filename: `${id}.pdf`, location: 'archived', kind: 'invoice', date: '2026-10-05', amount: 23.5, currency: 'CHF', extractedText: '', needsVisionReview: true, ...over } as Receipt);
const READ = (id: string, rate: number | undefined): Receipt =>
  SCAN(id, { needsVisionReview: undefined, vatExtractedAt: '2026-10-01T00:00:00Z', hasSwissVat: rate !== undefined, vatSummary: rate ? [{ ratePercent: rate, gross: 23.5, vat: 1.76 }] : [] });

const CTX: WaitContext = { free: new Set(), wordings: [], assumesUnread: new Set(['kiosk']), ownIbans: new Set(), settles: () => false, inputTax: true };

test('a receipt the app tried and failed to read is unreadable; a person\'s facts, or a receipt never tried, are not', () => {
  assert.equal(isUnreadable(SCAN('a')), true, 'a scan too poor for its text');
  assert.equal(isUnreadable(SCAN('a', { needsVisionReview: undefined, vatExtractedAt: '2026-10-01T00:00:00Z' })), true, 'read, and it named no Swiss VAT either way');
  assert.equal(isUnreadable(READ('a', 8.1)), false);
  assert.equal(isUnreadable(SCAN('a', { vatBy: 'human', hasSwissVat: false, vatSummary: [] })), false, 'a person answered');
  assert.equal(isUnreadable(SCAN('a', { needsVisionReview: undefined })), false, 'never tried: no model yet');
  assert.equal(isUnreadable(SCAN('a', { kind: 'supporting' })), false, 'a supporting document decides no input tax');
  assert.equal(linkedOf([SCAN('a'), READ('b', 8.1)]), 'read', 'one readable receipt beside it decides');
  assert.equal(linkedOf([SCAN('a')]), 'unread');
});

test('the decision: an unread receipt waits for the person, unless the company\'s rule counts that business\'s unread receipt at a rate', () => {
  assert.deepEqual(receiptWait(OUT('a'), { linked: 'unread', business: 'other' }, CTX), { wait: true, unread: true });
  assert.deepEqual(receiptWait(OUT('a'), { linked: 'unread' }, CTX), { wait: true, unread: true }, 'no business: no rule can say');
  assert.deepEqual(receiptWait(OUT('a'), { linked: 'unread', business: 'kiosk' }, CTX), { wait: false, why: 'companyRate' });
  assert.deepEqual(receiptWait(OUT('a'), { linked: 'unread' }, { ...CTX, inputTax: false }), { wait: false, why: 'noInputTax' }, 'a firm without input tax needs no rate');
  assert.deepEqual(receiptWait(OUT('a', { noReceiptNeeded: true }), { linked: 'unread' }, CTX), { wait: false, why: 'marked' });
});

test('nothing shipped assumes a rate: no app-layer business file counts an unread receipt', () => {
  assert.equal(receiptKnowledge(loadKnowledge(APP_ROOT, DEMO_ROOT), {}).assumesUnread.size, 0);
});

test('the person is asked at once, not two weeks before the return; an answer ends the question', () => {
  const books = { transactions: [OUT('K', { waitsForReceipt: { since: '2026-10-06T06:00:00Z', unread: true } })], mappings: [{ transactionRef: 'K', receiptId: 's' }], receipts: [SCAN('s')], config: {} };
  assert.deepEqual(waitingForReceipt(books, () => false, '2026-10-06').map((w) => [w.tx.ref, w.kind]), [['K', 'unread']]);
  const answered = { ...books, receipts: [SCAN('s', { vatBy: 'human', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: 23.5, vat: 1.76 }] })] };
  assert.deepEqual(waitingForReceipt(answered, () => false, '2026-10-06'), [], 'the receipt reads now: the next run books it');
});

const KIOSK = `id: kiosk
name: Kiosk Muster
match:
  tx: [ "kiosk muster" ]
`;

/** The demo company with a business file for the kiosk (no rule of its own), and optionally its rule for unread receipts. */
function company(rate?: number): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-unread-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  mkdirSync(join(dir, 'knowledge', 'suppliers'), { recursive: true });
  const rule = rate ? `steps:\n  booking.guide.yaml#purchase_vat:\n    rules:\n      - id: kiosk-unread-receipt\n        when: a receipt of Kiosk Muster whose VAT could not be read\n        then: count it as Swiss VAT at ${rate} % on its whole amount\n        apply: { unreadReceipt: ${rate} }\n        source: correction 2026-10-20\n` : '';
  writeFileSync(join(dir, 'knowledge/suppliers/kiosk.yaml'), KIOSK + rule);
  return workspaceAt(dir);
}

function booksOf(txs: BankTransaction[], receipts: Receipt[], links: Array<[string, string]>): Books {
  return { transactions: txs, receipts, mappings: links.map(([transactionRef, receiptId]) => ({ transactionRef, receiptId })), bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
}

const model = async (prompt: string) => JSON.stringify(Object.fromEntries(['K-1'].filter((r) => prompt.includes(r)).map((ref) => [ref, { entries: [{ accountDebit: '6570', accountCredit: '', amount: 23.5, vatCode: 'I81', description: 'Kiosk' }], reason: 'Kiosk' }])));

async function run(ws: Workspace, books: Books, ask: typeof model = model) {
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  return (await classifyStep()({ ws, books: port, ask, progress: () => {}, log: () => {} })).notes;
}
const entries = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.amount, e.vatCode ?? '']);

test('a payment whose receipt could not be read is not booked on a guess: it waits for the person, asking no model; her answer books it', async () => {
  const ws = company();
  const books = booksOf([OUT('K-1')], [SCAN('scan-1')], [['K-1', 'scan-1']]);
  let asked = 0;
  const notes = await run(ws, books, async (p) => { asked++; return model(p); });
  assert.deepEqual(entries(books, 'K-1'), []);
  assert.equal(asked, 0, 'the model is not asked to guess');
  assert.deepEqual(books.transactions[0].waitsForReceipt?.unread, true);
  assert.deepEqual(notes.filter((n): n is Extract<IntakeNote, { code: 'receiptUnread' }> => n.code === 'receiptUnread').map((n) => n.count), [1]);

  Object.assign(books.receipts[0], { vatBy: 'human', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: 23.5, vat: 1.76 }] });
  await run(ws, books);
  assert.deepEqual(entries(books, 'K-1'), [['6570', 23.5, 'I81']], '«so buchen wie meistens»: booked with the rate');
  assert.equal(books.transactions[0].waitsForReceipt, undefined);
});

test('«ohne Vorsteuer buchen»: the receipt counts as showing no Swiss VAT, the payment is booked with the zero code', async () => {
  const ws = company();
  const books = booksOf([OUT('K-1')], [SCAN('scan-1', { vatBy: 'human', hasSwissVat: false, vatSummary: [] })], [['K-1', 'scan-1']]);
  await run(ws, books);
  assert.deepEqual(entries(books, 'K-1'), [['6570', 23.5, 'I0']]);
});

test('the company\'s rule for the business books an unread receipt at once at its rate', async () => {
  const ws = company(8.1);
  const books = booksOf([OUT('K-1')], [SCAN('scan-1')], [['K-1', 'scan-1']]);
  await run(ws, books, async () => JSON.stringify({ 'K-1': { entries: [{ accountDebit: '6570', accountCredit: '', amount: 23.5, vatCode: 'I0', description: 'Kiosk' }] } }));
  assert.deepEqual(entries(books, 'K-1'), [['6570', 23.5, 'I81']], 'the rule\'s rate, whatever the model wrote');
});

test('«so buchen wie meistens» names the rate most of the business\'s other receipts showed; none when no rate wins', () => {
  const route = () => 'kiosk';
  const books = (rates: Array<number | undefined>) => booksOf([OUT('K-1'), ...rates.map((_, i) => OUT(`P-${i}`))], [SCAN('scan-1'), ...rates.map((r, i) => READ(`r-${i}`, r))], [['K-1', 'scan-1'], ...rates.map((_, i): [string, string] => [`P-${i}`, `r-${i}`])]);
  assert.equal(usualRate(books([8.1, 8.1, 2.6]), 'kiosk', 'K-1', route), 8.1);
  assert.equal(usualRate(books([8.1, 2.6]), 'kiosk', 'K-1', route), undefined, 'a tie names nothing');
  assert.equal(usualRate(books([undefined, undefined, 8.1]), 'kiosk', 'K-1', route), undefined, 'mostly no Swiss VAT: «ohne Vorsteuer» is the usual way');
  assert.equal(usualRate(books([]), 'kiosk', 'K-1', route), undefined);
});

test('the offer names the business and its usual rate; «Immer so?» drafts the company\'s rule, which the app reads back as the business\'s fact', () => {
  const ws = company();
  const books = booksOf([OUT('K-1'), OUT('P-1'), OUT('P-2')], [SCAN('scan-1'), READ('r1', 8.1), READ('r2', 8.1)], [['K-1', 'scan-1'], ['P-1', 'r1'], ['P-2', 'r2']]);
  const offer = unreadOffer(ws, books, 'K-1');
  assert.deepEqual(offer, { ref: 'K-1', business: { id: 'kiosk', name: 'Kiosk Muster' }, usual: 8.1, path: 'knowledge/suppliers/kiosk.yaml' });
  assert.equal(unreadOffer(ws, books, 'P-1'), undefined, 'a payment whose receipt reads offers nothing');
  const text = withUnreadRule(KIOSK, offer!, 8.1, '2026-10-23');
  const rule = parse(text).steps['booking.guide.yaml#purchase_vat'].rules[0];
  assert.deepEqual(parseApply(rule.apply, 'workspace'), { ok: true, fact: { kind: 'unreadReceipt', rate: 8.1 } });
  assert.equal(rule.source, 'correction 2026-10-23');
  assert.match(withUnreadRule(text, offer!, 2.6, '2026-10-24'), /unreadReceipt: 2\.6/, 'the business\'s own rule takes the new rate');
  assert.equal((withUnreadRule(text, offer!, 2.6, '2026-10-24').match(/unreadReceipt/g) ?? []).length, 1);
});
