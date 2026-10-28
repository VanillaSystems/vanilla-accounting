/**
 * `npm run extract` rebuilds the index from the files on disk. mergeIndex is the part that
 * decides what survives from the previous index: a person's work on a transaction, and the
 * receipt links behind filed returns (golden rule 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIndex, withinBooks, type KeptRead, type Scan } from '../src/books/bank-import.js';
import type { ReadMovement } from '../src/types/statement-read.js';
import { moduleActor, update, type Books } from '../src/books/store.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { sealOf } from '../src/books/seal.js';

const CLOSED_THROUGH = '2026-06-30';

function tx(ref: string, date: string, extra: Partial<BankTransaction> = {}): BankTransaction {
  return { ref, bank: 'Raiffeisen', date, amount: 10, currency: 'CHF', direction: 'DBIT', description: `bank ${ref}`, ...extra };
}

function receipt(id: string): Receipt {
  return { id, filename: `${id}.pdf`, extractedText: 'text', location: 'archived' } as Receipt;
}

function previousIndex(over: Partial<Index> = {}): Index {
  return {
    receipts: [receipt('r-closed'), receipt('r-open')],
    transactions: [tx('T-closed', '2026-05-10'), tx('T-open', '2026-08-10')],
    mappings: [
      { transactionRef: 'T-closed', receiptId: 'r-closed', by: 'human' },
      { transactionRef: 'T-open', receiptId: 'r-open', by: 'llm' },
    ],
    bankStatements: [],
    journalEntries: [],
    config: { closedThrough: CLOSED_THROUGH } as Index['config'],
    ...over,
  };
}

function scan(over: Partial<Scan> = {}): Scan {
  return {
    receipts: [receipt('r-closed'), receipt('r-open')],
    bankTransactions: [tx('T-closed', '2026-05-10'), tx('T-open', '2026-08-10')],
    reads: [],
    camtBalances: [],
    bankStatements: [],
    ...over,
  };
}

const merge = (previous: Index, s: Scan) => mergeIndex(previous, s).index;

/** The model's read of an August statement PDF kept beside the bank's export (#243): opening 100, the lines, closing as they make it unless given. */
function kept(bank: string, lines: ReadMovement[], closing?: number, file = 'statement-2026-08.pdf'): KeptRead {
  const made = Math.round((100 + lines.reduce((s, l) => s + l.amount, 0)) * 100) / 100;
  return {
    file, account: { account: '1022', bank, currency: 'CHF' },
    statement: { currency: 'CHF', opening: { date: '2026-08-01', amount: 100 }, closing: { date: '2026-08-31', amount: closing ?? made }, movements: lines },
  };
}
const byRef = (index: Index, ref: string) => index.transactions.find((t) => t.ref === ref);

// ─── Characterization: behavior that must not change ─────────────────────────

test('bank fields come from the fresh camt053 parse', () => {
  const merged = merge(previousIndex(), scan({ bankTransactions: [tx('T-closed', '2026-05-10'), tx('T-open', '2026-08-10', { description: 'corrected by bank', amount: 11 })] }));
  assert.equal(byRef(merged, 'T-open')?.description, 'corrected by bank');
  assert.equal(byRef(merged, 'T-open')?.amount, 11);
});

test('a bank transaction no longer in any open-period camt053 is dropped', () => {
  const merged = merge(previousIndex(), scan({ bankTransactions: [tx('T-closed', '2026-05-10')] }));
  assert.equal(byRef(merged, 'T-open'), undefined);
});

test('a new bank transaction is added', () => {
  const merged = merge(previousIndex(), scan({ bankTransactions: [tx('T-closed', '2026-05-10'), tx('T-open', '2026-08-10'), tx('T-new', '2026-09-01')] }));
  assert.deepEqual(byRef(merged, 'T-new'), tx('T-new', '2026-09-01'));
});

test('manual transactions are kept whole', () => {
  const manual = tx('M-1', '2026-07-02', { bank: 'manual', source: 'manual', remarks: 'cash' });
  const merged = merge(previousIndex({ transactions: [...previousIndex().transactions, manual] }), scan());
  assert.deepEqual(byRef(merged, 'M-1'), manual);
});

test('remarks and noReceiptNeeded set by a person survive the rebuild', () => {
  const prev = previousIndex({ transactions: [tx('T-closed', '2026-05-10', { remarks: 'privat' }), tx('T-open', '2026-08-10', { noReceiptNeeded: true })] });
  const merged = merge(prev, scan());
  assert.equal(byRef(merged, 'T-closed')?.remarks, 'privat');
  assert.equal(byRef(merged, 'T-open')?.noReceiptNeeded, true);
});

test('a reference and an original amount the export drops are filled from its statement PDF\'s read, on the payment of the same day, direction and amount', () => {
  const payments = [tx('W-1~a', '2026-08-03', { bank: 'Beispielbank' }), tx('W-2', '2026-08-03', { bank: 'Beispielbank', amount: 12 }), tx('W-3', '2026-08-04', { bank: 'Beispielbank' })];
  const read = kept('Beispielbank', [
    { date: '2026-08-03', amount: -10, reference: ' INV-42 ' }, { date: '2026-08-03', amount: -12, original: { amount: 13.4, currency: 'USD' } },
    { date: '2026-08-05', amount: -10, reference: 'a day off' },
  ]);
  const merged = merge(previousIndex(), scan({ bankTransactions: payments, reads: [read] }));
  assert.deepEqual(payments.map((t) => [byRef(merged, t.ref)?.reference, byRef(merged, t.ref)?.original]), [['INV-42', undefined], [undefined, { amount: 13.4, currency: 'USD' }], [undefined, undefined]]);
  const elsewhere = merge(previousIndex(), scan({ bankTransactions: payments, reads: [{ ...read, account: { account: '1023', bank: 'Beispielbank', currency: 'EUR' } }] }));
  assert.equal(byRef(elsewhere, 'W-1~a')?.reference, undefined, 'a read of another account adds nothing');
});

test('a reference or original amount the camt053 already has wins over the read', () => {
  const wise = tx('W-1', '2026-08-03', { bank: 'Wise', reference: 'from-camt', original: { amount: 11, currency: 'EUR' } });
  const merged = merge(previousIndex(), scan({ bankTransactions: [wise], reads: [kept('Wise', [{ date: '2026-08-03', amount: -10, reference: 'from-pdf', original: { amount: 11.5, currency: 'EUR' } }])] }));
  assert.deepEqual([byRef(merged, 'W-1')?.reference, byRef(merged, 'W-1')?.original], ['from-camt', { amount: 11, currency: 'EUR' }]);
});

test('a read that adds up closes its month at its account; one that does not closes none; it replaces what the books hold from its file and leaves a year-end confirmation of the day', () => {
  const line = { date: '2026-08-03', amount: -10 };
  const balance = (over: object = {}) => ({ account: '1022', bank: 'Wise', currency: 'CHF', date: '2026-08-31', amount: 90, source: 'pdf' as const, sourceFile: 'statement-2026-08.pdf', ...over });
  assert.deepEqual(merge(previousIndex(), scan({ reads: [kept('Wise', [line])] })).statementBalances, [balance()]);
  assert.equal(merge(previousIndex(), scan({ reads: [kept('Wise', [line], 99)] })).statementBalances, undefined, 'opening 100 and -10 do not make 99');
  const before = previousIndex({ statementBalances: [balance({ amount: 91 }), balance({ date: '2026-07-31', amount: 80, sourceFile: 'statement-2026-07.pdf' })] });
  assert.deepEqual(merge(before, scan({ reads: [kept('Wise', [line])] })).statementBalances, [balance({ date: '2026-07-31', amount: 80, sourceFile: 'statement-2026-07.pdf' }), balance()]);
  const confirmed = balance({ amount: 95, sourceFile: 'year-end/confirmation.pdf' });
  assert.deepEqual(merge(previousIndex({ statementBalances: [confirmed] }), scan({ reads: [kept('Wise', [line])] })).statementBalances, [confirmed]);
});

test('closed transactions get no batch parts and no reference', () => {
  const parts = [{ amount: 5, currency: 'CHF', counterparty: 'A' }, { amount: 5, currency: 'CHF', counterparty: 'B' }];
  const merged = merge(previousIndex(), scan({
    bankTransactions: [tx('T-closed', '2026-05-10', { parts, reference: 'R1' }), tx('T-open', '2026-08-10', { parts, reference: 'R2' })],
  }));
  assert.deepEqual(byRef(merged, 'T-closed'), tx('T-closed', '2026-05-10'));
  assert.deepEqual(byRef(merged, 'T-open')?.parts, parts);
  assert.equal(byRef(merged, 'T-open')?.reference, 'R2');
});

test('an open-period link whose receipt file is gone is dropped', () => {
  const merged = merge(previousIndex(), scan({ receipts: [receipt('r-closed')] }));
  assert.deepEqual(merged.mappings, [{ transactionRef: 'T-closed', receiptId: 'r-closed', by: 'human' }]);
});

test('receipts and bank statements are the scan; journal and config are untouched', () => {
  const statements = [{ bank: 'Wise' as const, filename: 's.pdf', fromDate: '2026-08-01', toDate: '2026-08-31' }];
  const entries = [{ id: 'je-1' }] as Index['journalEntries'];
  const merged = merge(previousIndex({ journalEntries: entries }), scan({ receipts: [receipt('r-closed'), receipt('r-open'), receipt('r-new')], bankStatements: statements }));
  assert.deepEqual(merged.receipts.map((r) => r.id), ['r-closed', 'r-open', 'r-new']);
  assert.deepEqual(merged.bankStatements, statements);
  assert.equal(merged.journalEntries, entries);
  assert.deepEqual(merged.config, { closedThrough: CLOSED_THROUGH });
});

// ─── (a) Every field not from the bank survives ──────────────────────────────

test('a filed transaction stays exactly as the books hold it: the counterparty, reference and parts it was filed with are neither stripped nor taken from the camt053', () => {
  const parts = [{ amount: 5, currency: 'CHF', counterparty: 'A' }, { amount: 5, currency: 'CHF', counterparty: 'B' }];
  const filed = tx('T-closed', '2026-05-10', { counterparty: 'Familie Keller', counterpartyIban: 'CH00', reference: 'Rechnung 2026-028', parts });
  const prev = previousIndex({ transactions: [filed, tx('T-open', '2026-08-10')] });
  const merged = merge(prev, scan({ bankTransactions: [tx('T-closed', '2026-05-10', { counterparty: 'Familie Keller', counterpartyIban: 'CH00', reference: 'Rechnung 2026-028', parts }), tx('T-open', '2026-08-10')] }));
  assert.deepEqual(byRef(merged, 'T-closed'), filed);
  const renamed = merge(prev, scan({ bankTransactions: [tx('T-closed', '2026-05-10', { description: 'the bank corrected the text', counterparty: 'Keller' }), tx('T-open', '2026-08-10')] }));
  assert.deepEqual(byRef(renamed, 'T-closed'), filed);
});

test('a field another step set on a bank transaction survives the rebuild', () => {
  const stamped = { ...tx('T-open', '2026-08-10'), checkedBy: 'evidence', noReceiptNeeded: false, remarks: '' } as BankTransaction;
  const merged = merge(previousIndex({ transactions: [tx('T-closed', '2026-05-10'), stamped] }), scan());
  assert.deepEqual(byRef(merged, 'T-open'), stamped);
});

test('a bank field the bank no longer reports is not carried over', () => {
  const prev = previousIndex({ transactions: [tx('T-closed', '2026-05-10'), tx('T-open', '2026-08-10', { type: 'wise-fee', reference: 'old' })] });
  assert.deepEqual(byRef(merge(prev, scan()), 'T-open'), tx('T-open', '2026-08-10'));
});

// ─── (b) A filed quarter's receipt links are never dropped ───────────────────

test('a closed link whose receipt file is gone is kept and reported', () => {
  const { index, brokenClosedLinks } = mergeIndex(previousIndex(), scan({ receipts: [receipt('r-open')] }));
  const closedLink = { transactionRef: 'T-closed', receiptId: 'r-closed', by: 'human' as const };
  assert.deepEqual(index.mappings, [closedLink, { transactionRef: 'T-open', receiptId: 'r-open', by: 'llm' }]);
  assert.deepEqual(brokenClosedLinks, [closedLink]);
});

test('a closed transaction missing from the camt053 files is kept with its link, and reported', () => {
  const closed = tx('T-closed', '2026-05-10', { remarks: 'filed' });
  const { index, vanishedClosedTransactions } = mergeIndex(
    previousIndex({ transactions: [closed, tx('T-open', '2026-08-10')] }),
    scan({ bankTransactions: [tx('T-open', '2026-08-10')] }),
  );
  assert.deepEqual(byRef(index, 'T-closed'), closed);
  assert.deepEqual(vanishedClosedTransactions, [closed]);
  assert.ok(index.mappings.some((m) => m.transactionRef === 'T-closed'));
});

test('nothing is reported when every closed link and transaction is intact', () => {
  const { brokenClosedLinks, vanishedClosedTransactions } = mergeIndex(previousIndex(), scan());
  assert.deepEqual(brokenClosedLinks, []);
  assert.deepEqual(vanishedClosedTransactions, []);
});

// ─── (c) Idempotent ──────────────────────────────────────────────────────────

test('merging the same scan twice gives the same index', () => {
  const parts = [{ amount: 5, currency: 'CHF', counterparty: 'A' }, { amount: 5, currency: 'CHF', counterparty: 'B' }];
  const prev = previousIndex({
    transactions: [
      tx('T-closed', '2026-05-10', { remarks: 'privat' }),
      tx('T-open', '2026-08-10', { noReceiptNeeded: true }),
      tx('M-1', '2026-07-02', { bank: 'manual', source: 'manual' }),
    ],
  });
  const s = scan({
    receipts: [receipt('r-open')],
    bankTransactions: [tx('T-closed', '2026-05-10', { parts }), tx('T-open', '2026-08-10', { parts }), tx('W-1~a', '2026-08-03', { bank: 'Wise' })],
    reads: [kept('Wise', [{ date: '2026-08-03', amount: -10, reference: 'INV-42' }])],
  });
  const once = mergeIndex(prev, s);
  const twice = mergeIndex(once.index, s);
  assert.deepEqual(twice.index, once.index);
  assert.deepEqual(twice.brokenClosedLinks, once.brokenClosedLinks);
});

test('bank rows dated before the books open (first opening-balance year) stay out; no opening balances keeps all', () => {
  const rows = [tx('T-prior', '2025-12-30'), tx('T-first', '2026-01-01')];
  const opened = withinBooks(rows, { openingBalances: { '2027': {}, '2026': {} } } as unknown as Index['config']);
  assert.deepEqual(opened.kept.map((t) => t.ref), ['T-first']);
  assert.equal(opened.before, '2026-01-01');
  assert.deepEqual(withinBooks(rows, undefined).kept.map((t) => t.ref), ['T-prior', 'T-first']);
});

// ─── A Wise card charge split over two currencies: two legs, one ref (#23) ───

const wiseLeg = (date: string, currency: string, amount: number, extra: Partial<BankTransaction> = {}) =>
  tx('CARD-123', date, { bank: `Wise ${currency}`, currency, amount, description: `Card charge ${currency}`, ...extra });

for (const [period, date] of [['closed', '2026-05-12'], ['open', '2026-08-12']] as const) {
  test(`both legs of a split card charge in ${period === "open" ? "an" : "a"} ${period} period survive a bank re-read, each as itself`, () => {
    const legs = [wiseLeg(date, 'EUR', 40, { remarks: 'EUR leg' }), wiseLeg(date, 'CHF', 2.5, { noReceiptNeeded: true })];
    const books = previousIndex({ transactions: [...previousIndex().transactions, ...legs] }) as Books;
    const fresh = [wiseLeg(date, 'EUR', 40), wiseLeg(date, 'CHF', 2.5)];
    // The write door refuses any change to a closed transaction: the re-read must not trip it.
    update(books, moduleActor('intake'), (b) => {
      Object.assign(b, mergeIndex(b, scan({ bankTransactions: [tx('T-closed', '2026-05-10'), tx('T-open', '2026-08-10'), ...fresh] })).index);
    });
    const merged = books.transactions.filter((t) => t.ref === 'CARD-123').sort((a, b) => a.currency.localeCompare(b.currency));
    assert.deepEqual(merged, [legs[1], legs[0]]);
  });
}

test('a vanished leg of a closed split card charge is kept and reported while its other leg is still read', () => {
  const legs = [wiseLeg('2026-05-12', 'EUR', 40), wiseLeg('2026-05-12', 'CHF', 2.5)];
  const prev = previousIndex({ transactions: [...previousIndex().transactions, ...legs] });
  const out = mergeIndex(prev, scan({ bankTransactions: [...scan().bankTransactions, legs[1]] }));
  assert.deepEqual(out.index.transactions.filter((t) => t.ref === 'CARD-123').sort((a, b) => a.currency.localeCompare(b.currency)), [legs[1], legs[0]]);
  assert.deepEqual(out.vanishedClosedTransactions, [legs[0]]);
});

test('re-reading a Wise camt053 gives open transactions their Wise id and leaves filed ones, and their seal, as filed (#69)', () => {
  const xml = readFileSync(join(import.meta.dirname, 'fixtures/camt053/uuid_statement_wise_USD.xml'), 'utf8');
  const read = readCamt(xml).statements.flatMap((s) => transactionsOf(s, { bank: 'Wise', statements: 'wise' })).slice(0, 2);
  const open = read.map((t) => ({ ...t, ref: `${t.ref}-OPEN`, date: '2026-08-07' }));
  const asFiled = [...read, ...open].map(({ bankTxId: _, ...t }) => t);
  const prev = previousIndex({ transactions: asFiled });
  const sealed = sealOf(prev, '2026-Q2', '2026-07-01').sha256;
  const lines = [...read, ...open].map((t) => ({ date: t.date, amount: t.direction === 'DBIT' ? -Math.abs(t.amount) : Math.abs(t.amount), reference: 'Rechnung 4711' }));
  const merged = merge(prev, scan({ bankTransactions: [...read, ...open], reads: [{ ...kept('Wise', lines), account: { account: '1024', bank: 'Wise', currency: read[0].currency } }] }));
  assert.equal(sealOf(merged, '2026-Q2', '2026-07-01').sha256, sealed, 'the seal of the filed quarter holds');
  assert.deepEqual(read.map((t) => byRef(merged, t.ref)?.bankTxId), [undefined, undefined], 'a filed transaction keeps what it was filed with');
  assert.deepEqual(open.map((t) => byRef(merged, t.ref)?.bankTxId), ['CARD-7200000001', 'FEE-CARD-7200000001']);
  assert.equal(byRef(merged, open[0].ref)?.reference, 'Rechnung 4711', 'the read\'s reference reaches the open payment');
  assert.deepEqual(read.map((t) => byRef(merged, t.ref)?.reference), [undefined, undefined], 'and never a filed one');
});
