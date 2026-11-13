/**
 * One word, one count (#385): the dock, Automatisierung's headline, Belege's count line and the drop
 * dialog count the receipts of one set of books alike. A receipt is in the period of its payment once
 * it has one, else of its date; unpaid and undated, or dated before the working period, it is the
 * working period's (placeDay). «gebucht» of a receipt: its payment is booked. The persona's books of
 * round 2: till slips without a date linked to Q3 payments, an invoice of 28.06. not yet paid, a photo
 * not read, wages booked by hand without a receipt. Invented figures.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';
import type { DropRow } from '../src/types/drop.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { homeFigures } from '../src/app/automation/home.js';
import { dockWidget } from '../src/app/automation/widget.js';
import { ledgerOf, visible } from '../src/app/areas/receipts/model.js';
import { dropSummary } from '../src/app/shell/drop-summary.js';

const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-11-12T08:00:00Z', location: 'archived', currency: 'CHF', ...x,
});
const tx = (ref: string, date: string, amount: number): BankTransaction =>
  ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: amount < 0 ? 'DBIT' : 'CRDT', description: ref });
const entry = (id: string, ref: string, date: string, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: ref, date, accountDebit: '6500', accountCredit: '1020', amount: 10, ...x });

const Q3 = parsePeriod('2026-Q3', '2026-11-13')!;
const OPEN_FROM = '2026-07-01';

const books: Index = {
  receipts: [
    receipt('till-1', { amount: 38.9 }),                                  // till slip, no date, linked to a booked payment of 08.07.
    receipt('till-2', { amount: 64.5 }),                                  // till slip, no date, linked, payment not booked
    receipt('invoice-q3', { date: '2026-07-30', amount: 2410.85 }),       // linked, booked
    receipt('invoice-june', { date: '2026-06-28', amount: 1243.55 }),     // before the books, no payment yet: Q3's work
    receipt('invoice-sept', { date: '2026-09-29', amount: 412.3 }),       // no payment yet
    receipt('dated-q4-paid-q3', { date: '2026-10-02', amount: 89 }),      // a bill dated after its payment: the payment's period
    receipt('photo', {}),                                                 // not read: no date, no amount
    receipt('terms', { kind: 'supporting', date: '2026-08-01' }),         // no receipt
  ],
  transactions: [
    tx('T-till-1', '2026-07-08', -38.9), tx('T-till-2', '2026-08-12', -64.5), tx('T-q3', '2026-08-06', -2410.85), tx('T-early', '2026-09-30', -89),
    ...[1, 2, 3].map((m) => tx(`T-wage-${m}`, `2026-0${m + 6}-25`, -4800)),
    tx('T-fee', '2026-09-30', -12),
  ],
  mappings: [
    { receiptId: 'till-1', transactionRef: 'T-till-1' }, { receiptId: 'till-2', transactionRef: 'T-till-2' },
    { receiptId: 'invoice-q3', transactionRef: 'T-q3' }, { receiptId: 'dated-q4-paid-q3', transactionRef: 'T-early' },
  ],
  journalEntries: [
    entry('1', 'T-till-1', '2026-07-08', { by: { kind: 'rule', rule: 'r' } }),
    entry('2', 'T-q3', '2026-08-06', { origin: 'manual', by: { kind: 'person', at: 'x' } }),
    ...[1, 2, 3].map((m) => entry(`w${m}`, `T-wage-${m}`, `2026-0${m + 6}-25`, { accountDebit: '5000', origin: 'manual', by: { kind: 'person', at: 'x' } })),
    entry('fee', 'T-fee', '2026-09-30', { accountDebit: '6940', origin: 'classify' }),
  ],
  bankStatements: [],
};

test('the dock, Automatisierung, Belege and the drop dialog count one set of books alike (#385)', () => {
  const f = homeFigures(books, { key: Q3.token, from: Q3.from, to: Q3.to }, { today: '2026-11-13', vatRegistered: true, dueDays: 60, openFrom: OPEN_FROM });
  const belege = visible(ledgerOf(books, OPEN_FROM), Q3, undefined, undefined).counts;
  // The drop that brought every file of the books in.
  const rows = books.receipts.map((r): DropRow => ({ key: r.id, id: r.id, name: r.filename, size: 1, state: 'taken' }) as DropRow);
  const drop = dropSummary(rows, books, () => false, new Set(), (row) => books.receipts.find((r) => r.id === row.id), []).receipts!;

  // Seven receipts belong to Q3: the two undated till slips by their payments, the June invoice as the working period's, the bill dated in October by its September payment, the photo as undated.
  assert.equal(f.collected, 7, 'Automatisierung: «7 Belege gesammelt»');
  assert.equal(belege.all, f.collected, 'Belege «alle» = Automatisierung «gesammelt»');
  assert.equal(drop.n, f.collected, 'the drop: the files that are receipts');
  assert.equal(f.matched, 4);
  assert.equal(belege.linked, f.matched, 'Belege «zugeordnet» = Automatisierung «Zugeordnet»');
  assert.equal(drop.matched, f.matched, 'the drop «einer Zahlung zugeordnet»');
  assert.equal(belege.open, f.collected - f.matched, 'Belege «offen»: the rest');
  assert.equal(f.read, 6, 'read: linked, or with date and amount; the photo is not');
  assert.equal(drop.read, f.read, 'the drop «Belege gelesen» = the dock «gelesen»');
  assert.equal(f.booked, 2, '«gebucht» of a receipt: its payment is booked (till-1, invoice-q3)');

  // Eight payments, six booked (three wages and the bank's fee without a receipt): the bar says so in words.
  assert.deepEqual([f.paymentsBooked, f.payments], [6, 8]);
  const w = dockWidget(f, undefined, 0, new Date(2026, 10, 13));
  assert.deepEqual(w.stack, [{ key: 'payments', n: 6, of: 8 }, { key: 'waiting', n: 0 }], 'not «2 gebucht» beside six bookings');
});

test('the bar keeps receipts read and booked while every booked payment has its receipt', () => {
  const f = homeFigures(books, { key: Q3.token, from: Q3.from, to: Q3.to }, { today: '2026-11-13', vatRegistered: true, dueDays: 60, openFrom: OPEN_FROM });
  const w = dockWidget({ ...f, paymentsBooked: f.booked }, undefined, 1, new Date(2026, 10, 13));
  assert.deepEqual(w.stack.map((x) => x.key), ['read', 'booked', 'waiting']);
});
