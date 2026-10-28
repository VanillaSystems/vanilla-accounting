/**
 * The parity harness of #243 on invented data: an invented card-and-transfer account, its bank
 * export without references, the per-bank readers' answer and a model read of the same month.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsOfRead } from '../src/books/bank-import.js';
import type { BankTransaction } from '../src/types/index.js';
import type { ReadStatement } from '../src/types/statement-read.js';
import { fileParity, summarize } from '../tools/statement-parity/parity.js';

const account = { account: '1023', bank: 'Beispielbank', currency: 'EUR' };
const tx = (ref: string, date: string, amount: number, extra: Partial<BankTransaction> = {}): BankTransaction => ({
  ref, bank: account.bank, currency: account.currency, date, amount, direction: amount < 0 ? 'DBIT' : 'CRDT', description: `Movement ${ref}`, ...extra,
});

const exported = [
  tx('TRANSFER-9000000001', '2026-07-03', 1250, { bankTxId: 'TRANSFER-9000000001' }),
  tx('TRANSFER-9000000002', '2026-07-09', 480.5),
  tx('CARD-9000000003', '2026-07-12', -24.9, { original: { amount: 27.5, currency: 'USD' } }),
  tx('CARD-9000000004', '2026-07-20', -60, { description: 'Card transaction of 66.00 USD issued by Example Store' }),
  tx('CARD-9000000005', '2026-07-25', -15),
  tx('TRANSFER-9000000006', '2026-07-28', 300, { reference: 'Already in the export' }),
];

const read = (over: Partial<ReadStatement> = {}): ReadStatement => ({
  iban: 'XX00000000000000000000', currency: 'EUR', period: { from: '2026-07-01', to: '2026-07-31' },
  opening: { date: '2026-07-01', amount: 100 }, closing: { date: '2026-07-31', amount: 2030.6 },
  movements: [
    { date: '2026-07-03', amount: 1250, reference: 'Invoice 2026000123 Ref.: 4400000001-1' },
    { date: '2026-07-09', amount: 480.5, reference: '  Shopify  X1Y2Z3 ' },
    { date: '2026-07-12', amount: -24.9, original: { amount: 27.5, currency: 'USD' } },
    { date: '2026-07-20', amount: -60, original: { amount: 66, currency: 'USD' } },
    { date: '2026-07-25', amount: -15, original: { amount: 16.2, currency: 'GBP' } },
    { date: '2026-07-28', amount: 300, reference: 'Printed differently' },
  ],
  ...over,
});

const reader = {
  balance: { account: '1023', bank: account.bank, currency: 'EUR', date: '2026-07-31', amount: 2030.6, source: 'pdf' as const, sourceFile: 'july.pdf' },
  references: new Map([
    ['TRANSFER-9000000001', 'Invoice 2026000123 Ref.: 4400000001-1'],
    ['TRANSFER-9000000002', 'Shopify X1Y2Z3'],
    ['TRANSFER-9000000006', 'Already in the export'],
  ]),
};

test('a read that gives what the readers give is at parity; a payment the export names a reference for counts on neither side', () => {
  const p = fileParity('july.pdf', reader, { statement: read(), account }, exported);
  assert.equal(p.balance, 'equal');
  assert.deepEqual(p.references, { equal: 2, differ: 0, readerOnly: 0, modelOnly: 0 });
  assert.deepEqual(p.originals, { equal: 2, differ: 0, readerOnly: 0, modelOnly: 1 }, 'camt InstdAmt and the description agree; the GBP charge only the read gives');
  assert.deepEqual([p.readLines, p.unmatchedLines, p.differences], [6, 0, ['original extra CARD-9000000005']]);
});

test('a misread reference, a missed one, a wrong closing balance and a misread original each count as a difference', () => {
  const s = read({ opening: { date: '2026-07-01', amount: 99.46 }, closing: { date: '2026-07-31', amount: 2030.06 } });
  s.movements[0] = { ...s.movements[0], reference: 'Invoice 2026000128 Ref.: 4400000001-1' };
  s.movements[1] = { date: '2026-07-09', amount: 480.5 };
  s.movements[3] = { date: '2026-07-20', amount: -60, original: { amount: 66.6, currency: 'USD' } };
  const p = fileParity('july.pdf', reader, { statement: s, account }, exported);
  assert.equal(p.balance, 'differ');
  assert.deepEqual(p.references, { equal: 0, differ: 1, readerOnly: 1, modelOnly: 0 });
  assert.deepEqual(p.originals, { equal: 1, differ: 1, readerOnly: 0, modelOnly: 1 });
});

test('a line read on another day matches no payment and is counted; without a read every reader fact is missing', () => {
  const s = read();
  s.movements[0] = { ...s.movements[0], date: '2026-07-04' };
  const p = fileParity('july.pdf', reader, { statement: s, account }, exported);
  assert.deepEqual([p.unmatchedLines, p.references.readerOnly], [1, 1]);
  const unchecked = fileParity('july.pdf', reader, { statement: read({ closing: { date: '2026-07-31', amount: 2030.06 } }), account }, exported);
  assert.equal(unchecked.balance, 'readerOnly', 'a read that does not add up closes no month');
  const none = fileParity('july.pdf', reader, undefined, exported);
  assert.deepEqual([none.balance, none.references.readerOnly], ['readerOnly', 2]);
  const sum = summarize([p, none]);
  assert.deepEqual([sum.files, sum.read, sum.balance.equal, sum.balance.readerOnly, sum.references.readerOnly], [2, 1, 1, 1, 3]);
});

test('factsOfRead gives only what the export lacks: no reference over the export\'s, no original in the account\'s own currency', () => {
  const s = read();
  s.movements.push({ date: '2026-07-30', amount: -5, original: { amount: 5, currency: 'EUR' } });
  const facts = factsOfRead(s, account, [...exported, tx('FEE-9000000007', '2026-07-30', -5)]);
  assert.deepEqual([...facts.references], [['TRANSFER-9000000001', 'Invoice 2026000123 Ref.: 4400000001-1'], ['TRANSFER-9000000002', 'Shopify  X1Y2Z3']]);
  assert.deepEqual([...facts.originals], [['CARD-9000000004', { amount: 66, currency: 'USD' }], ['CARD-9000000005', { amount: 16.2, currency: 'GBP' }]]);
  assert.equal(facts.unmatched, 0);
});
