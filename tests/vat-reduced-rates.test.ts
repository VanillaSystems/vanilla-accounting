/**
 * Every Swiss rate the return form has a Ziffer for: 8.1/2.6/3.8 and the old 7.7/2.5/3.7.
 * The golden master's books have no entry at a reduced rate, so it cannot see one. This test
 * books one of each into an otherwise empty 2026-Q4 and checks the report the MWST tab shows
 * against the figures vat-xml files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '../src/types/index.js';
import { computeVatReport } from '../src/accounting/vat-report.js';
import { figuresFromBooks } from '../src/accounting/return-figures.js';

const booked = (vatCode: string, amount: number, debit: string, credit: string): JournalEntry => ({
  id: `synthetic-${vatCode}`, transactionRef: `SYN-${vatCode}`, date: '2026-11-02',
  accountDebit: debit, accountCredit: credit, amount, vatCode, description: `synthetic ${vatCode}`,
});
const sale = (vatCode: string, gross: number) => booked(vatCode, gross, '1020', '3000');
const purchase = (vatCode: string, gross: number) => booked(vatCode, gross, '6500', '1020');

// Gross amounts whose net is exactly CHF 1000 (sales) or whose tax is a round figure (purchases).
const entries = [
  sale('V81', 1081), sale('V26', 1026), sale('V38', 1038),
  sale('V77', 1077), sale('V25-N', 1025), sale('V37', 1037),
  purchase('M38', 103.8), purchase('I26', 102.6),
];
const report = computeVatReport(entries, '2026-Q4', []);
const z = (n: string) => report.ziffern.find((x) => x.number === n)?.amount;

test('a sale at each Swiss rate lands in its own Ziffer', () => {
  assert.equal(z('200'), 6284);
  assert.equal(z('299'), 6284);
  for (const n of ['303', '313', '343', '302', '312', '342']) assert.equal(z(n), 1000, `Ziffer ${n} net turnover`);
});

test('the MWST tab gets the tax per rate from the report', () => {
  const tax = Object.fromEntries(report.rates.map((r) => [r.row.ziffer, r.tax]));
  assert.deepEqual(tax, { '303': 81, '313': 26, '343': 38, '302': 77, '312': 25, '342': 37, '383': 0, '382': 0 });
});

test('the tax owed counts every rate', () => {
  assert.equal(z('399'), 81 + 26 + 38 + 77 + 25 + 37);
  assert.equal(z('400'), 3.8);
  assert.equal(z('405'), 2.6);
  assert.equal(z('479'), 6.4);
  assert.equal(z('500'), 277.6);
});

test('the report agrees with what vat-xml files', () => {
  const filed = figuresFromBooks(entries, '2026-Q4', []);
  assert.equal(filed.ziffern['343'], 1038);
  assert.equal(z('399'), filed.ziffern['399']);
  assert.equal(z('500'), filed.ziffern['500']);
});
