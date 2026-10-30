/**
 * Kontoauszüge (src/app/areas/bank/model.ts, lines.ts): which statements a period lists, a month
 * without its statement as missing, the balance checks against the bank and the ledger, a Wise
 * fee folded into its payment, and the payment's line found on the statement page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index } from '../src/types/index.js';
import { badgeCount, bankOf, fileFacts, payText, troubled, unbookedPayments, type Account, type Statement } from '../src/app/areas/bank/model.js';
import { parseIban } from '../src/workspace/banks.js';
import { findLines, type TextItem } from '../src/app/areas/bank/lines.js';
import './support/jurisdiction.js';

const ACCOUNTS: Account[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Raiffeisen', statements: 'camt053', role: 'bank' },
  { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', statements: 'wise', role: 'bank' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Privat', role: 'owner' },
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

test('a booked fee the bank debited apart is folded into its payment: not listed, counted in the balance; an open one keeps its row (#42)', () => {
  const feeEntry = { id: 'J4', transactionRef: 'FEE-CARD-1', date: '2026-07-05', accountDebit: '6940', accountCredit: '1023', amount: 0.5 };
  const b = bankOf(books({ journalEntries: [...books().journalEntries!, feeEntry] }), ACCOUNTS, '2026-09-15');
  const s = b.byKey('1023-2026-07')!;
  assert.deepEqual(b.payments(s).map((p) => p.ref), ['CARD-1']);
  assert.equal(b.feeOf('CARD-1')?.ref, 'FEE-CARD-1');
  const c = b.check(s);
  assert.equal(c.out, 20.5);
  assert.equal(c.open, null, 'July has no balance before it and is not the year\'s start');
  assert.equal(b.needsReceipt(b.feeOf('CARD-1')!), false);

  const open = bankOf(books(), ACCOUNTS, '2026-09-15');
  const fee = open.txByRef.get('FEE-CARD-1')!;
  assert.deepEqual(open.payments(open.byKey('1023-2026-07')!).map((p) => p.ref), ['FEE-CARD-1', 'CARD-1'], 'an open fee is listed, to be booked');
  assert.equal(open.feeOf('CARD-1'), undefined);
  assert.equal(open.unbooked(fee), true);
  assert.equal(open.needsReceipt(fee), false);
});

test('a fee the bank links by its id apart from the ref is folded into its payment once booked (#42)', () => {
  const charge = tx('WEUR1', '2026-07-05', -20, { bank: 'Wise', currency: 'EUR', bankTxId: 'CARD-9' });
  const fee = tx('WEUR2', '2026-07-05', -0.5, { bank: 'Wise', currency: 'EUR', type: 'wise-fee', bankTxId: 'FEE-CARD-9' });
  const b = bankOf(books({
    transactions: [charge, fee],
    journalEntries: [{ id: 'J4', transactionRef: 'WEUR2', date: '2026-07-05', accountDebit: '6940', accountCredit: '1023', amount: 0.5 }],
  }), ACCOUNTS, '2026-09-15');
  assert.deepEqual(b.payments(b.byKey('1023-2026-07')!).map((p) => p.ref), ['WEUR1']);
  assert.equal(b.feeOf('WEUR1')?.ref, 'WEUR2');
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

test('several statements in one month: each its own key, totals, and payments; a payment opens the statement that holds it (r4t-1)', () => {
  const oct = books({
    transactions: [tx('A1', '2026-10-02', -40), tx('A2', '2026-10-14', 1000), tx('B1', '2026-10-15', -89), tx('C1', '2026-10-22', 250), tx('C2', '2026-10-28', -10)],
    bankStatements: [
      { bank: 'Raiffeisen', filename: 'camt_14-10.xml', fromDate: '2026-10-01', toDate: '2026-10-14' },
      { bank: 'Raiffeisen', filename: 'camt_15-10.xml', fromDate: '2026-10-15', toDate: '2026-10-15' },
      { bank: 'Raiffeisen', filename: 'camt_31-10.xml', fromDate: '2026-10-16', toDate: '2026-10-31' },
    ],
    statementBalances: [
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-09-30', amount: 100, source: 'camt', sourceFile: 'a' },
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-10-14', amount: 1060, source: 'camt', sourceFile: 'a' },
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-10-15', amount: 971, source: 'camt', sourceFile: 'b' },
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-10-31', amount: 1211, source: 'camt', sourceFile: 'c' },
    ],
    journalEntries: [],
  });
  const b = bankOf(oct, ACCOUNTS, '2026-11-02');
  const files = b.statements('2026-10-01', '2026-10-31').filter((s) => s.file && s.account.account === '1021');
  assert.deepEqual(files.map((s) => s.key), ['1021-2026-10-16', '1021-2026-10-15', '1021-2026-10-01']);
  assert.deepEqual(files.map((s) => b.byKey(s.key)!.file!.filename), ['camt_31-10.xml', 'camt_15-10.xml', 'camt_14-10.xml'], 'each key opens its own file');
  const c = b.check(b.byKey('1021-2026-10-15')!);
  assert.deepEqual({ open: c.open, inc: c.inc, out: c.out, close: c.close, n: c.n, ok: c.ok }, { open: 1060, inc: 0, out: 89, close: 971, n: 1, ok: true }, 'the 15.10. statement has its own day, not the month');
  const late = b.check(b.byKey('1021-2026-10-16')!);
  assert.deepEqual({ inc: late.inc, out: late.out, close: late.close, ok: late.ok }, { inc: 250, out: 10, close: 1211, ok: true });
  const st = b.statementOf(b.txByRef.get('C1')!)!;
  assert.equal(st.key, '1021-2026-10-16');
  assert.deepEqual(b.payments(st).map((p) => p.ref), ['C2', 'C1'], 'the unbooked payment is in the statement its link opens');
  assert.equal(b.byKey('1021-2026-10')?.file?.filename, 'camt_14-10.xml', 'an old month link opens the month\'s first statement');
});

test('two statements starting the same day get keys of their own', () => {
  const b = bankOf(books({ bankStatements: [
    { bank: 'Raiffeisen', filename: 'a.xml', fromDate: '2026-07-01', toDate: '2026-07-31' },
    { bank: 'Raiffeisen', filename: 'b.pdf', fromDate: '2026-07-01', toDate: '2026-07-15' },
    { bank: 'Raiffeisen', filename: 'c.pdf', fromDate: '2026-07-01', toDate: '2026-07-20' },
  ] }), ACCOUNTS, '2026-08-15');
  const keys = b.statements('2026-07-01', '2026-07-31').filter((s) => s.account.account === '1021').map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, keys.join(' '));
  assert.equal(b.statementOf(b.txByRef.get('R1')!)?.file?.filename, 'b.pdf', 'the narrowest statement holding the day');
});

test('the dock counts statements with a problem from the open quarter on', () => {
  const b = bankOf(books(), ACCOUNTS, '2026-09-15');
  assert.equal(badgeCount(b, '2026-07-01', '2026-09-15'), 2, 'the two missing Augusts; July adds up, September is running');
});

test('#88: a month without a statement is missing only on an account that has had statements', () => {
  const paypal: Account = { bank: 'PayPal', currency: 'CHF', account: '1025', label: 'PayPal', role: 'bank' };
  const b = bankOf(books({ transactions: [...books().transactions, tx('P1', '2026-07-10', -40, { bank: 'PayPal' }), tx('P2', '2026-08-12', -15, { bank: 'PayPal' })] }), [...ACCOUNTS, paypal], '2026-09-15');
  const august = b.statements('2026-08-01', '2026-08-31').filter((s) => !s.file);
  assert.deepEqual(august.map((s) => [s.account.account, s.missing === true, troubled(b, s)]), [
    ['1021', true, true],
    ['1023', true, true],
    ['1025', false, false],
  ], 'Raiffeisen and Wise had a July statement: their August is missing; PayPal never had one: its August is only without a statement');
  assert.equal(b.statements('2026-07-01', '2026-07-31').find((s) => s.account.account === '1025')?.missing, undefined, 'nor is its July missing');
  assert.equal(badgeCount(b, '2026-07-01', '2026-09-15'), 2, 'the badge counts the two missing Augusts, none of PayPal\'s months');
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

test('payments without an entry are listed, oldest first: the open period only; a fee the bank debited apart is booked by its own entry alone (corner-9, #42)', () => {
  const b = books();
  assert.deepEqual(unbookedPayments(b, ACCOUNTS).map((t) => t.ref), ['CARD-1', 'FEE-CARD-1', 'M1', 'R3']);
  const charge = { id: 'J3', transactionRef: 'CARD-1', date: '2026-07-05', accountDebit: '6000', accountCredit: '1023', amount: 20 };
  const chargeBooked = books({ journalEntries: [...b.journalEntries!, charge] });
  assert.deepEqual(unbookedPayments(chargeBooked, ACCOUNTS).map((t) => t.ref), ['FEE-CARD-1', 'M1', 'R3'], 'the payment\'s booking leaves its fee open');
  const fee = { id: 'J4', transactionRef: 'FEE-CARD-1', date: '2026-07-05', accountDebit: '6940', accountCredit: '1023', amount: 0.5 };
  assert.deepEqual(unbookedPayments(books({ journalEntries: [...b.journalEntries!, charge, fee] }), ACCOUNTS).map((t) => t.ref), ['M1', 'R3'], 'the fee\'s own entry books it');
  assert.deepEqual(unbookedPayments(books({ config: { closedThrough: '2026-07-31' } }), ACCOUNTS).map((t) => t.ref), ['R3'], 'a filed payment is a correction, not a task');
  assert.equal(bankOf(b, ACCOUNTS, '2026-09-15').unbooked(tx('R1', '2026-07-03', -100)), false);
});

test('an entry that moves the bank without a statement line is found; a payment\'s entry, a VAT-only correction and the year-end revaluation are not (corner-29)', () => {
  const extra = [
    { id: 'storno', transactionRef: 'M2026-001', date: '2026-10-16', accountDebit: '1021', accountCredit: '6000', amount: 100, vatCode: '-I81', corrects: '2026-Q3' },
    { id: 'vatOnly', transactionRef: 'M2026-002', date: '2026-10-16', accountDebit: '6000', accountCredit: '6000', amount: 100, vatCode: '-I81', corrects: '2026-Q3' },
    { id: 'fx', transactionRef: 'YE-1', date: '2026-12-31', accountDebit: '1023', accountCredit: '6950', amount: 3, origin: 'year-close' as const },
  ];
  const b = bankOf(books({ journalEntries: [...books().journalEntries!, ...extra] }), ACCOUNTS, '2026-12-31');
  assert.deepEqual(b.strays('2026-01-01', '2026-12-31').map((e) => e.id), ['storno']);
  assert.deepEqual(b.strays('2026-07-01', '2026-09-30'), [], 'only the period asked for');
});

test('r10c-2: two statements that share a day each list only the payments their file holds (`refs`) and their own balances; the one that starts later is listed first and gives the account\'s balance', () => {
  const bal = (date: string, amount: number, sourceFile: string) => ({ account: '1021', bank: 'Raiffeisen', currency: 'CHF', date, amount, source: 'camt' as const, sourceFile });
  const b = bankOf(books({
    transactions: [tx('B1', '2026-10-12', 100), tx('B2', '2026-10-16', -45), tx('C1', '2026-10-16', 500)],
    bankStatements: [
      { bank: 'Raiffeisen', filename: 'raiB.xml', fromDate: '2026-10-11', toDate: '2026-10-16', currency: 'CHF', refs: ['B1', 'B2'] },
      { bank: 'Raiffeisen', filename: 'raiC.xml', fromDate: '2026-10-16', toDate: '2026-10-16', currency: 'CHF', refs: ['C1'] },
    ],
    statementBalances: [bal('2026-10-10', 1000, 'raiB.xml'), bal('2026-10-16', 1055, 'raiB.xml'), bal('2026-10-15', 1055, 'raiC.xml'), bal('2026-10-16', 1555, 'raiC.xml')],
    journalEntries: [],
    config: { closedThrough: '2026-09-30', openingBalances: { 2026: { 1021: 1000 } } },
  }), ACCOUNTS, '2026-10-20');
  const [second, first] = b.statements('2026-10-01', '2026-10-31').filter((s) => s.file);
  assert.deepEqual([first.key, second.key], ['1021-2026-10-11', '1021-2026-10-16'], 'the statement that starts later comes first');
  assert.deepEqual(b.payments(first).map((t) => t.ref), ['B2', 'B1']);
  assert.deepEqual(b.payments(second).map((t) => t.ref), ['C1']);
  const c1 = b.check(first), c2 = b.check(second);
  assert.deepEqual([c1.open, c1.inc, c1.out, c1.close, c1.n, c1.diff, c1.ok], [1000, 100, 45, 1055, 2, 0, true]);
  assert.deepEqual([c2.open, c2.inc, c2.out, c2.close, c2.n, c2.diff, c2.ok], [1055, 500, 0, 1555, 1, 0, true]);
  assert.equal(b.statementOf(b.txByRef.get('C1')!)?.key, second.key);
  assert.equal(b.statementOf(b.txByRef.get('B2')!)?.key, first.key);
});

test('r10h-7: statements whose balances do not chain name the days between them as a missing statement, and are counted as a problem, not «Salden stimmen»', () => {
  const bal = (date: string, amount: number, sourceFile: string) => ({ account: '1021', bank: 'Raiffeisen', currency: 'CHF', date, amount, source: 'camt' as const, sourceFile });
  const b = bankOf(books({
    transactions: [tx('O1', '2026-10-03', -100), tx('P1', '2026-10-17', -50)],
    bankStatements: [
      { bank: 'Raiffeisen', filename: 'okt.xml', fromDate: '2026-10-01', toDate: '2026-10-14', currency: 'CHF', refs: ['O1'] },
      { bank: 'Raiffeisen', filename: 'okt2.xml', fromDate: '2026-10-16', toDate: '2026-10-20', currency: 'CHF', refs: ['P1'] },
    ],
    statementBalances: [bal('2026-09-30', 1000, 'okt.xml'), bal('2026-10-14', 900, 'okt.xml'), bal('2026-10-15', 403.85, 'okt2.xml'), bal('2026-10-20', 353.85, 'okt2.xml')],
    journalEntries: [],
    config: { closedThrough: '2026-09-30', openingBalances: { 2026: { 1021: 1000 } } },
  }), ACCOUNTS, '2026-10-25');
  const [later, earlier] = b.statements('2026-10-01', '2026-10-31').filter((s) => s.file);
  assert.equal(b.check(earlier).gap, undefined);
  assert.deepEqual(b.check(later).gap, { from: '2026-10-15', to: '2026-10-15', bank: 900, open: 403.85, diff: -496.15 }, 'the bank moved 496.15 between the statements without a statement');
  assert.deepEqual([b.check(later).ok, troubled(b, later), troubled(b, earlier)], [true, true, false], 'the later statement itself adds up, yet it is a problem');
});

test('a bank statement filed among the receipts shows at the statements of its account it overlaps, with or without a file; one no account fits nowhere (#151)', () => {
  const accounts = ACCOUNTS.map((a) => (a.account === '1021' ? { ...a, iban: parseIban('CH6580808000000000001') } : a));
  const filed = (id: string, from: string, to: string, iban: string) => ({
    id, filename: `${id}.pdf`, kind: 'statement', date: to,
    extractedText: [`Kontoauszug ${from} - ${to}`, `IBAN ${iban}`, 'Schlusssaldo: 950.00'].join('\n'),
  }) as Index['receipts'][number];
  const plain = books();
  const withFiled = books({ receipts: [...plain.receipts,
    filed('july', '01.07.2026', '31.07.2026', 'CH65 8080 8000 0000 0000 1'),
    filed('august', '01.08.2026', '31.08.2026', 'CH65 8080 8000 0000 0000 1'),
    filed('stranger', '01.07.2026', '31.07.2026', 'CH00 1234 5678 9012 3456 7'),
  ] });
  const b = bankOf(withFiled, accounts, '2026-09-15');
  const ids = (s: Statement | undefined) => s?.receipts?.map((x) => x.id);
  const july = b.byKey('1021-2026-07')!;
  assert.ok(july.file, 'July of 1021 has its own file');
  assert.deepEqual(ids(july), ['july']);
  const august = b.byKey('1021-2026-08')!;
  assert.deepEqual([august.file, ids(august)], [undefined, ['august']], 'August has no file: the receipt is there all the same');
  const all = b.statements('2026-01-01', '2026-09-30');
  assert.ok(!all.some((s) => ids(s)?.includes('stranger')), 'an IBAN no account has places it nowhere');
  assert.equal(ids(b.byKey('1023-2026-07')), undefined, 'another account of the same month gets none');
  const before = bankOf(plain, accounts, '2026-09-15');
  assert.deepEqual(all.map((s) => troubled(b, s)), before.statements('2026-01-01', '2026-09-30').map((s) => troubled(before, s)));
  assert.equal(badgeCount(b, '2026-07-01', '2026-09-15'), badgeCount(before, '2026-07-01', '2026-09-15'));
  const late = bankOf(books({ receipts: [filed('may', '01.05.2026', '31.05.2026', 'CH65 8080 8000 0000 0000 1')], config: { closedThrough: '2026-06-30' } }), accounts, '2026-09-15');
  assert.deepEqual(ids(late.statements('2026-05-01', '2026-05-31').find((s) => s.account.account === '1021')), ['may'], 'a month before the account\'s first payment gets its row');
});

test('a statement file is shown whole with the movements it holds, its days and its balances, not split into months (#208)', () => {
  const b = bankOf(books({
    transactions: [tx('X1', '2026-07-03', -100), tx('X2', '2026-08-20', 50), tx('X3', '2026-08-04', -30), tx('OTHER', '2026-08-05', -7)],
    bankStatements: [{ bank: 'Raiffeisen', filename: 'camt-jul-aug.xml', fromDate: '2026-07-01', toDate: '2026-08-31', refs: ['X1', 'X2', 'X3'] }],
    statementBalances: [
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-06-30', amount: 1000, source: 'camt', sourceFile: 'camt-jul-aug.xml' },
      { account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-08-31', amount: 920, source: 'camt', sourceFile: 'camt-jul-aug.xml' },
    ],
  }), ACCOUNTS, '2026-09-15');
  const files = b.files('2026-08-01', '2026-08-31');
  assert.deepEqual(files.map((f) => f.key), ['1021/camt-jul-aug.xml'], 'one file, though the month view splits it in two');
  const f = b.fileByKey('1021/camt-jul-aug.xml')!;
  assert.deepEqual(f.payments.map((p) => p.ref), ['X1', 'X3', 'X2'], 'the movements it holds, oldest first; a payment of its days it does not hold is not its');
  const d = fileFacts(f);
  assert.deepEqual([d.currency, d.period, d.booked, d.movements, d.opening, d.closing], ['CHF', { from: '2026-07-01', to: '2026-08-31' }, { first: '2026-07-03', last: '2026-08-20' }, 3, { date: '2026-06-30', amount: 1000 }, { date: '2026-08-31', amount: 920 }]);
  assert.deepEqual(b.files('2026-10-01', '2026-10-31'), [], 'a period it does not reach lists it not');
  assert.equal(b.fileByKey('1021/none.xml'), undefined);
  assert.equal(b.files('2026-07-01', '2026-07-31').length, 1, 'a PDF is no file of this view: its month is its page');
});

test('#273: a bank export over months is its part of each month: one row a month, never «fehlt» for a month it covers, no row over years, no one-day row', () => {
  const bal = (date: string, amount: number, sourceFile: string, account = '1021') => ({ account, bank: account === '1021' ? 'Raiffeisen' : 'Wise', currency: account === '1021' ? 'CHF' : 'EUR', date, amount, source: 'camt' as const, sourceFile });
  const pdf = (m: string, last: string) => ({ bank: 'Raiffeisen', filename: `Kontoauszug ${m}.pdf`, fromDate: `2026-${m}-01`, toDate: `2026-${m}-${last}` });
  const b = bankOf(books({
    transactions: [
      tx('H1', '2026-06-10', -40), tx('Q1', '2026-07-08', -100), tx('Q2', '2026-08-12', 300), tx('Q3', '2026-09-03', -20), tx('Q4', '2026-09-30', -5),
      tx('W1', '2026-06-20', -10, { bank: 'Wise', currency: 'EUR' }),
    ],
    bankStatements: [
      pdf('05', '31'), pdf('06', '30'),
      // A quarter's export the bank dates through the day after its last booking, and the next one «since the account's opening».
      { bank: 'Raiffeisen', filename: 'q2.xml', fromDate: '2026-04-01', toDate: '2026-07-01', currency: 'CHF', refs: ['H1'] },
      { bank: 'Raiffeisen', filename: 'q3.xml', fromDate: '2017-01-01', toDate: '2026-09-30', currency: 'CHF', refs: ['Q1', 'Q2', 'Q3', 'Q4'] },
      { bank: 'Wise', filename: 'wise-q2.xml', fromDate: '2026-04-01', toDate: '2026-07-01', currency: 'EUR', refs: ['W1'] },
    ],
    statementBalances: [
      bal('2026-06-30', 1000, 'Kontoauszug 06.pdf'),
      bal('2026-07-07', 1000, 'q3.xml'), bal('2026-09-30', 1175, 'q3.xml'),
      bal('2026-03-31', 500, 'wise-q2.xml', '1023'), bal('2026-07-01', 490, 'wise-q2.xml', '1023'),
    ],
    journalEntries: [],
    config: { closedThrough: '2026-06-30', openingBalances: { 2026: { 1021: 1000 } } },
  }), ACCOUNTS, '2026-10-01');
  const q3 = b.statements('2026-07-01', '2026-09-30');
  assert.deepEqual(q3.map((s) => [s.key, s.from, s.to, s.file?.filename ?? (s.missing ? 'fehlt' : s.running ? 'läuft' : '-')]), [
    ['1021-2026-09', '2026-09-01', '2026-09-30', 'q3.xml'],
    ['1023-2026-09', '2026-09-01', '2026-09-30', 'fehlt'],
    ['1021-2026-08', '2026-08-01', '2026-08-31', 'q3.xml'],
    ['1023-2026-08', '2026-08-01', '2026-08-31', 'fehlt'],
    ['1021-2026-07', '2026-07-01', '2026-07-31', 'q3.xml'],
    ['1023-2026-07', '2026-07-01', '2026-07-31', 'fehlt'],
  ], 'one row a month from the export; the Wise export reaching one day into July is no July statement');
  const aug = b.byKey('1021-2026-08')!;
  assert.deepEqual([aug.part, b.payments(aug).map((t) => t.ref)], [true, ['Q2']], 'a month\'s part holds that month\'s payments only');
  assert.equal(b.statementOf(b.txByRef.get('Q2')!)?.key, '1021-2026-08', 'a payment opens its month, not the export\'s first');
  const c = (key: string) => { const x = b.check(b.byKey(key)!); return [x.open, x.inc, x.out, x.close, x.diff]; };
  assert.deepEqual(c('1021-2026-07'), [1000, 0, 100, 900, 0], 'the export\'s opening carries into its first month');
  assert.deepEqual(c('1021-2026-08'), [900, 300, 0, 1200, 0]);
  assert.deepEqual(c('1021-2026-09'), [1200, 0, 25, 1175, 0], 'the last month closes on the bank\'s stated balance');
  const june = b.byKey('1021-2026-06')!;
  assert.deepEqual([june.file?.filename, june.export?.filename], ['Kontoauszug 06.pdf', 'q2.xml'], 'a PDF month the export covers too is the PDF, marked with the export');
  assert.equal(b.byKey('1021-2026-05')!.export?.filename, 'q2.xml');
  assert.equal(b.statements('2017-01-01', '2026-12-31').filter((s) => s.account.account === '1021').some((s) => s.from < '2026-01-01'), false, 'nothing before the books\' first year');
  assert.deepEqual(b.files('2026-07-01', '2026-09-30').map((f) => [f.key, f.payments.length]), [['1021/q3.xml', 4], ['1021/q2.xml', 1], ['1023/wise-q2.xml', 1]], 'Datei lists each export whole');
});
