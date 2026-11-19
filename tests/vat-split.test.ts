/**
 * Where an entry's tax goes (vatSplitOf, src/accounting/statement-postings.ts), as the journal
 * detail shows it: the same posting the statements and the year close make (vatPostings), so the
 * detail cannot name another account or amount than the Bilanz.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { vatSplitOf, statementPostings } from '../src/accounting/statement-postings.js';
import { vatPostings } from '../src/accounting/year-close.js';
import type { JournalEntry } from '../src/types/index.js';

const CHART = ['1020', '1170', '2200', '2201', '3200', '6580'];
const VAT = '2201';
const entry = (accountDebit: string, accountCredit: string, amount: number, vatCode?: string): JournalEntry =>
  ({ id: `e-${accountDebit}-${accountCredit}-${vatCode}`, transactionRef: 'r', date: '2026-11-03', accountDebit, accountCredit, amount, description: 'x', ...(vatCode && { vatCode }) }) as JournalEntry;

test('a one-sided input tax correction: its empty debit side is the VAT account, the whole amount', () => {
  const e = entry('', '6580', 25.42, 'M81-2');
  assert.deepEqual(vatSplitOf(e, CHART), { tax: 25.42, account: VAT, side: 'debit', fillsEmpty: true });
  // The statements post the same: debit the VAT account, so the entry balances.
  const p = vatPostings([e], VAT)[0];
  assert.equal(p.accountDebit, VAT);
  assert.equal(p.amount, 25.42);
});

test('a one-sided minus code: its empty credit side is the VAT account', () => {
  const e = entry('6580', '', 12.5, '-M81-2');
  assert.deepEqual(vatSplitOf(e, CHART), { tax: 12.5, account: VAT, side: 'credit', fillsEmpty: true });
});

test('a two-sided sale at 8.1 %: the tax leaves the revenue, credited to the VAT account', () => {
  const s = vatSplitOf(entry('1020', '3200', 108.1, 'V81'), CHART);
  assert.deepEqual(s, { tax: 8.1, account: VAT, side: 'credit', fillsEmpty: false });
});

test('a two-sided purchase at 8.1 %: the input tax leaves the expense, debited to the VAT account', () => {
  const s = vatSplitOf(entry('6580', '1020', 339.62, 'M81'), CHART);
  assert.deepEqual(s, { tax: 25.45, account: VAT, side: 'debit', fillsEmpty: false });
});

test('no code, and a one-sided entry without a tax code: nothing is filled in', () => {
  assert.equal(vatSplitOf(entry('6580', '1020', 100), CHART), null);
  assert.equal(vatSplitOf(entry('', '6580', 100), CHART), null);
  assert.equal(vatSplitOf(entry('', '6580', 100, 'M0'), CHART), null);
});

test('the account is the statements\' own VAT account', () => {
  const e = entry('', '6580', 25.42, 'M81-2');
  const derived = (statementPostings([e], CHART) as unknown as JournalEntry[]).find((p) => p.id === `vat:${e.id}`);
  assert.equal(derived?.accountDebit, vatSplitOf(e, CHART)?.account);
});
