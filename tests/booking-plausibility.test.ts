/**
 * A booking by hand that looks wrong is saved with a warning from code, never silently (r8k-8):
 * a cash account (Kasse, 1000–1009) below zero at the booking's date, or revenue debited against
 * cash or bank on a positive amount (a swapped sale; a customer refund carries the minus code).
 * The same account on both sides without a VAT code is refused with a typed code. `npm run
 * doctor` names both kinds of entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookingWarnings, plausibility } from '../src/accounting/booking-warnings.js';
import { loadBooks, saveBooks, update, PERSON } from '../src/books/store.js';
import { plausibilityHints } from '../src/accounting/booking-warnings.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { JournalEntry } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';
import './support/jurisdiction.js';

const e = (id: string, date: string, accountDebit: string, accountCredit: string, amount: number, more: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: `M2026-${id}`, date, accountDebit, accountCredit, amount, description: id, ...more });

test('revenue debited against cash on a sale warns twice: a swapped sale, and the cash account below zero; the right way round warns nothing', () => {
  const books = { journalEntries: [e('a', '2026-10-01', '1000', '3400', 300), e('b', '2026-10-16', '3400', '1000', 520)], config: { openingBalances: { 2026: { 1000: 0 } } } };
  assert.deepEqual(bookingWarnings(books, books.journalEntries[1]), [
    { code: 'swappedSale', entry: 'b', date: '2026-10-16', accountDebit: '3400', accountCredit: '1000' },
    { code: 'cashNegative', entry: 'b', account: '1000', date: '2026-10-16', balance: -220 },
  ]);
  assert.deepEqual(bookingWarnings(books, books.journalEntries[0]), [], 'cash in, revenue out: a sale');
  assert.deepEqual(bookingWarnings({ journalEntries: [e('r', '2026-10-16', '3400', '1020', 50, { vatCode: '-V81' })] }, e('r', '2026-10-16', '3400', '1020', 50, { vatCode: '-V81' })), [], 'a refund to the customer debits revenue and says so with the minus code');
  assert.deepEqual(bookingWarnings({ journalEntries: [e('w', '2026-10-16', '2850', '1020', 500)] }, e('w', '2026-10-16', '2850', '1020', 500)), [], 'a bank account may go below zero');
});

test('the books\' plausibility names each cash account once, at the day it first goes below zero, and every swapped-looking entry', () => {
  const books = { journalEntries: [e('a', '2026-10-01', '1000', '3400', 100), e('b', '2026-10-02', '3400', '1000', 150), e('c', '2026-10-03', '6500', '1000', 10), e('d', '2026-10-04', '3400', '1000', 5)], config: {} };
  assert.deepEqual(plausibility(books, '2026'), [
    { code: 'swappedSale', entry: 'b', date: '2026-10-02', accountDebit: '3400', accountCredit: '1000' },
    { code: 'cashNegative', entry: 'b', account: '1000', date: '2026-10-02', balance: -50 },
    { code: 'swappedSale', entry: 'd', date: '2026-10-04', accountDebit: '3400', accountCredit: '1000' },
  ]);
});

test('API: the saved booking comes back with its warnings; the same account on both sides is refused with sameAccount', async () => {
  const api = await startApi('tests/fixtures/classify-index.json');
  try {
    const made = await api.send('POST', '/api/journal-entries', { date: '2026-08-20', accountDebit: '3400', accountCredit: '1000', amount: 520, description: 'Bareinnahmen Kasse' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.deepEqual((made.json.warnings as Array<{ code: string }>).map((w) => w.code), ['swappedSale', 'cashNegative']);
    const id = (made.json.entry as JournalEntry).id;
    const same = await api.send('PATCH', `/api/journal-entries/${id}`, { accountDebit: '1000' });
    assert.deepEqual([same.status, same.json.code, same.json.params], [400, 'sameAccount', { account: '1000' }]);
    const fixed = await api.send('PATCH', `/api/journal-entries/${id}`, { accountDebit: '1000', accountCredit: '3400' });
    assert.deepEqual([fixed.status, fixed.json.warnings], [200, []], 'both sides together: no warning left');
    const refused = await api.send('POST', '/api/journal-entries', { date: '2026-08-20', accountDebit: '6500', accountCredit: '6500', amount: 5, description: 'x' });
    assert.deepEqual([refused.status, refused.json.code], [400, 'sameAccount']);
    const vatOnly = await api.send('POST', '/api/journal-entries', { date: '2026-08-20', accountDebit: '6500', accountCredit: '6500', amount: 5, vatCode: 'M81', description: 'nur die Steuer' });
    assert.equal(vatOnly.status, 200, 'a VAT-only correction keeps both sides on the same account');
  } finally {
    await api.stop();
  }
});

test('npm run doctor names a cash account below zero and a swapped-looking sale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plausibility-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  const date = books.config.closedThrough ? `${books.config.closedThrough.slice(0, 4)}-12-20` : '2026-12-20';
  update(books, PERSON, (b) => { b.journalEntries.push(e('swap', date, '3400', '1000', 520, { origin: 'manual' })); });
  saveBooks(ws, books);
  const warned = plausibilityHints(loadBooks(ws)).map((r) => r.label);
  assert.ok(warned.some((l) => /1000/.test(l) && /below zero|-520/.test(l)), `cash: ${warned.join(' | ')}`);
  assert.ok(warned.some((l) => /3400 \/ 1000/.test(l)), `swapped: ${warned.join(' | ')}`);
});
