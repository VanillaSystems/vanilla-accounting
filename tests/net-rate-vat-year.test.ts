/**
 * The year's VAT of a net-rate firm, as the year close and Bilanz & ER explain it (r9n-27): the
 * Bezugsteuer a B81 entry owes without a deduction is tax of the year and its own line, not
 * «Rundung pro Buchung»; a -F1 correction takes sales tax back and is no «Vorsteuer» in a firm
 * that has none. The effective method is unchanged: its B81 nets to zero and posts nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import type { Index, JournalEntry } from '../src/types/index.js';
import type { Books } from '../src/books/store.js';
import { vatCheck, vatPostings } from '../src/accounting/year-close.js';
import { vatInFigures, vatParts } from '../src/app/areas/reports/model.js';

const { jurisdiction } = loadJurisdiction(APP_ROOT, 'ch');
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };
const je = (id: string, date: string, dr: string, cr: string, amount: number, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: dr, accountCredit: cr, amount, description: id, ...x });

const netRateEntries: JournalEntry[] = [
  je('sale', '2026-08-03', '1020', '3400', 1000, { vatCode: 'F1' }),
  je('ads', '2026-08-05', '6600', '1020', 100, { vatCode: 'B81-1' }),
  je('paper', '2026-08-06', '6500', '1020', 50),
  je('corr', '2026-08-20', '3400', '2451', 200, { vatCode: '-F1', corrects: '2026-H1' }),
];

test('net-rate: B81 posts the Bezugsteuer it owes to the VAT account, a sale its rate\'s tax, a -F1 correction takes tax back', () => {
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    const postings = vatPostings(netRateEntries, '2200');
    assert.deepEqual(postings.map((p) => [p.code, p.accountDebit, p.accountCredit, p.amount]), [
      ['F1', '3400', '2200', 45],
      ['B81-1', '6600', '2200', 8.1],
      ['-F1', '2200', '3400', 9],
    ]);
  } finally {
    setJurisdiction(jurisdiction);
  }
});

test('net-rate: Bilanz & ER split the period\'s VAT into sales tax (corrections included) and Bezugsteuer; no «Vorsteuer» in a firm without input tax', () => {
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    const v = vatInFigures(netRateEntries, '2026-08-01', '2026-08-31')!;
    assert.deepEqual(v, { owed: 36, input: 0, acquisition: 8.1, net: 44.1 });
    assert.deepEqual(vatParts(v), [{ key: 'reports.vatPart.owed', amount: 36 }, { key: 'reports.vatPart.acquisition', amount: 8.1 }]);
  } finally {
    setJurisdiction(jurisdiction);
  }
});

test('effective: B81 nets to zero and posts nothing; the parts are owed and input tax', () => {
  const entries = [je('sale', '2026-08-03', '1020', '3200', 1081, { vatCode: 'V81' }), je('paper', '2026-08-06', '6500', '1020', 108.1, { vatCode: 'I81' }), je('ads', '2026-08-05', '6600', '1020', 100, { vatCode: 'B81-1' })];
  const v = vatInFigures(entries, '2026-08-01', '2026-08-31')!;
  assert.deepEqual(v, { owed: 81, input: 8.1, acquisition: 0, net: 72.9 });
  assert.deepEqual(vatParts(v), [{ key: 'reports.vatPart.owed', amount: 81 }, { key: 'reports.vatPart.input', amount: 8.1 }]);
});

test('net-rate year close: the tax of the year holds the Bezugsteuer as its own line, and nothing is left as rounding', () => {
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    const index: Index = { config: {}, receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: netRateEntries };
    const check = vatCheck(index as unknown as Books, '2026', [], { vatSettlement: '2200', vatAccounts: ['2200'], retainedEarnings: '2970', fxDifference: '6960', receivables: { account: '1100', inChart: true } });
    assert.equal(check.booked, 44.1, 'sales tax 45 − 9, Bezugsteuer 8.10');
    assert.equal(check.acquisition, 8.1);
    assert.equal(check.rounding, 0, 'the returns declare the same tax: nothing to call rounding');
  } finally {
    setJurisdiction(jurisdiction);
  }
});
