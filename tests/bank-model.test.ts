/**
 * Kontoauszüge (src/app/areas/bank/model.ts, lines.ts): which statements a period lists, a month
 * without its statement as missing, the balance checks against the bank and the ledger, a Wise
 * fee folded into its payment, and the payment's line found on the statement page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index } from '../src/types/index.js';
import { badgeCount, bankOf, payText, type Account } from '../src/app/areas/bank/model.js';
import { findLines, type TextItem } from '../src/app/areas/bank/lines.js';

const ACCOUNTS: Account[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Raiffeisen', statements: 'camt053' },
  { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', statements: 'wise' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Privat' },
];

const tx = (ref: string, date: string, amount: number, extra: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount: Math.abs(amount), currency: 'CHF', direction: amount < 0 ? 'DBIT' : 'CRDT', description: `Zahlung ${ref}`, ...extra });

function books(over: Partial<Index> = {}): Index {
  return {
    receipts: [{ id: 'r1', filename: 'r1.pdf', description: 'Laden, Papier', date: '2026-08-04' } as Index['receipts'][number]],
    transactions: [
      tx('R1', '2026-07-03', -100),
      tx('R2', '2026-07-20', 50),
      tx('R3', '2026-08-04', -30),
      tx('CARD-1', '2026-07-05', -20, { bank: 'Wise', currency: 'EUR', description: 'Card transaction of 20.00 EUR issued by Shop BERLIN' }),
      tx('FEE-CARD-1', '2026-07-05', -0.5, { bank: 'Wise', currency: 'EUR', type: 'wise-fee', description: 'Wise Charges for: CARD-1' }),
      tx('M1', '2026-07-08', -9, { bank: 'manual', source: 'manual' }),
    ],
    mappings: [{ transactionRef: 'R3', receiptId: 'r1' }],
    bankStatements: [
      { bank: 'Raiffeisen', filename: 'Kontoauszug 01.07.2026 - 31.07.2026.pdf', fromDate: '2026-07-01', toDate: '2026-07-31' },
      { bank: 'Wise', filename: 'statement_1_EUR_2026-07-01_2026-07-31.pdf', fromDate: '2026-07-01', toDate: '2026-07-31', currency: 'EUR' },
    ],
    statementBalances: [
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-06-30', amount: 1000, source: 'pdf', sourceFile: 'a.pdf' },
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-07-31', amount: 950, source: 'pdf', sourceFile: 'b.pdf' },
      { account: '1023', bank: 'Wise', currency: 'EUR', date: '2026-07-31', amount: 79.5, source: 'pdf', sourceFile: 'c.pdf' },
    ],
    journalEntries: [
      { id: 'J1', transactionRef: 'R1', date: '2026-07-03', accountDebit: '6000', accountCredit: '1021', amount: 100 },
      { id: 'J2', transactionRef: 'R2', date: '2026-07-20', accountDebit: '1021', accountCredit: '3200', amount: 50 },
    ],
    config: { closedThrough: '2026-06-30', openingBalances: { 2026: { 1021: 1000 } }, openingBalancesNative: { 2026: { 1023: { amount: 100, currency: 'EUR' } } } },
    ...over,
  };
}

test('a period lists each account\'s statements, an ended month without one as missing, the running month with payments', () => {
  const b = bankOf(books(), ACCOUNTS, '2026-09-15');
  const keys = b.statements('2026-07-01', '2026-09-30').map((s) => [s.key, s.file ? 'file' : s.running ? 'running' : 'missing']);
  assert.deepEqual(keys, [
    ['1021-2026-08', 'missing'],
    ['1023-2026-08', 'missing'],
    ['1021-2026-07', 'file'],
    ['1023-2026-07', 'file'],
  ]);
  assert.equal(b.accounts.some((a) => a.account === '2451'), false, 'the private account has no statements');
  const later = bankOf(books({ transactions: [...books().transactions, tx('R4', '2026-09-02', -5)] }), ACCOUNTS, '2026-09-15');
  assert.deepEqual(later.statements('2026-09-01', '2026-09-30').map((s) => [s.key, !!s.running]), [['1021-2026-09', true]]);
});

test('the check: opening + payments − closing against the bank, and the ledger against the bank\'s close', () => {
  const b = bankOf(books(), ACCOUNTS, '2026-09-15');
  const c = b.check(b.byKey('1021-2026-07')!);
  assert.deepEqual({ open: c.open, close: c.close, inc: c.inc, out: c.out, n: c.n, diff: c.diff, ok: c.ok }, { open: 1000, close: 950, inc: 50, out: 100, n: 2, diff: 0, ok: true });
  assert.equal(c.book, 950);
  assert.equal(c.bookDiff, 0);

  const off = bankOf(books({ transactions: books().transactions.filter((t) => t.ref !== 'R2') }), ACCOUNTS, '2026-09-15');
  assert.equal(off.check(off.byKey('1021-2026-07')!).diff, -50, 'a payment missing from the import shows as the difference');

  const unbooked = bankOf(books({ journalEntries: [] }), ACCOUNTS, '2026-09-15');
  assert.equal(unbooked.check(unbooked.byKey('1021-2026-07')!).bookDiff, 50, 'payments not booked show against the ledger');
});

test('a Wise fee is folded into its payment: not listed, counted in the balance', () => {
  const b = bankOf(books(), ACCOUNTS, '2026-09-15');
  const s = b.byKey('1023-2026-07')!;
  assert.deepEqual(b.payments(s).map((p) => p.ref), ['CARD-1']);
  assert.equal(b.feeOf('CARD-1')?.ref, 'FEE-CARD-1');
  const c = b.check(s);
  assert.equal(c.out, 20.5);
  assert.equal(c.open, null, 'July has no balance before it and is not the year\'s start');
  assert.equal(b.needsReceipt(b.feeOf('CARD-1')!), false);
});

test('a payment needs a receipt until one is linked or it is marked as needing none', () => {
  const b = bankOf(books(), ACCOUNTS, '2026-09-15');
  assert.equal(b.needsReceipt(b.txByRef.get('R1')!), true);
  assert.equal(b.needsReceipt(b.txByRef.get('R3')!), false);
  assert.equal(b.needsReceipt({ ...b.txByRef.get('R1')!, noReceiptNeeded: true }), false);
  assert.deepEqual(b.receiptOf('r1'), { name: 'Laden', date: '2026-08-04' });
});

test('a payment\'s statement: the one holding its date; none when paid privately', () => {
  const b = bankOf(books(), ACCOUNTS, '2026-09-15');
  assert.equal(b.statementOf(b.txByRef.get('R2')!)?.key, '1021-2026-07');
  assert.equal(b.statementOf(b.txByRef.get('R3')!)?.key, '1021-2026-08', 'a payment of a missing month leads to that month');
  assert.equal(b.statementOf(b.txByRef.get('M1')!), undefined);
});

test('the dock counts statements with a problem from the open quarter on', () => {
  const b = bankOf(books(), ACCOUNTS, '2026-09-15');
  assert.equal(badgeCount(b, '2026-07-01', '2026-09-15'), 2, 'the two missing Augusts; July adds up, September is running');
});

test('a bank text as name and note', () => {
  assert.deepEqual(payText(tx('C', '2026-07-01', -1, { currency: 'EUR', description: 'Card transaction of 12.50 USD issued by Shop LONDON' })), { name: 'Shop LONDON', note: 'USD 12.50' });
  assert.deepEqual(payText(tx('T', '2026-07-01', 1, { description: 'Received money from Kunde AG with reference R-7' })), { name: 'Kunde AG', note: 'R-7' });
  assert.deepEqual(payText(tx('Z', '2026-07-01', -1, { description: 'Zahlung Post CH AG' })), { name: 'Post CH AG' });
});

const line = (y: number, ...parts: string[]): TextItem[] => parts.map((s, i) => ({ s, x: i * 100, y, h: 10 }));

test('a Wise payment is found by its transaction id, with its fee', () => {
  const items = [
    ...line(100, 'Card transaction of 20.00 EUR issued by Shop', '-20.00', '80.00'),
    ...line(112, '5 July 2026 | Transaction: CARD-1'),
    ...line(140, 'Wise Charges for: CARD-1', '-0.50', '79.50'),
    ...line(152, '5 July 2026 | Transaction: FEE-CARD-1'),
    ...line(180, 'Card transaction of 9.00 EUR issued by Other', '-9.00', '71.00'),
    ...line(192, '6 July 2026 | Transaction: CARD-2'),
  ];
  const bands = findLines(items, { ref: 'CARD-1', date: '2026-07-05', amount: 20 }, true, { ref: 'FEE-CARD-1' });
  assert.equal(bands.length, 2);
  assert.ok(bands[0][0] < 100 && bands[0][1] > 112 && bands[0][1] < 140, 'the payment\'s two lines');
  assert.ok(bands[1][0] < 140 && bands[1][1] > 152 && bands[1][1] < 180, 'its fee\'s two lines, not CARD-2');
  const oneText = [
    ...line(100, 'Anfangssaldo 01.06.2026: 2565.00'),
    ...line(112, '03.06.2026 | Card transaction of 39.00 EUR issued by Shop | -39.00 | Ref. CARD-7'),
  ];
  const [band] = findLines(oneText, { ref: 'CARD-7', date: '2026-06-03', amount: -39 }, true);
  assert.ok(band[0] > 90 && band[1] > 112, 'a row printed as one text is its own band, without the lines above');
});

test('another bank\'s payment is the dated row with its amount closest to its date', () => {
  const items = [
    ...line(100, '04.07.26', 'Zahlung Post', '30.00', '970.00'),
    ...line(112, 'Postfach, Bern'),
    ...line(130, '20.07.26', 'Zahlung Post', '30.00', '940.00'),
    ...line(142, 'Postfach, Bern'),
  ];
  const [band] = findLines(items, { ref: 'X', date: '2026-07-19', amount: -30 }, false);
  assert.ok(band[0] < 130 && band[0] > 112 && band[1] > 142, 'the 20 July row with the line under it');
  assert.deepEqual(findLines(items, { ref: 'X', date: '2026-07-19', amount: -31 }, false), []);
  const oneText = line(200, '21.07.2026 | Zahlung Post CH AG | -217.75 | Ref. 90000000058');
  assert.equal(findLines(oneText, { ref: 'X', date: '2026-07-21', amount: -217.75 }, false).length, 1, 'a row printed as one text, with a four-digit year');
});
