/**
 * Where an entry's tax goes (vatSplitOf, src/accounting/statement-postings.ts), as the journal
 * detail shows it: read from the same shape the statements' derived posting is built from
 * (vatShapeOf, vatPostingOf), on the account statementPostings uses, so the detail cannot name
 * another account or amount than the Bilanz.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import { statementPostings, statementVatAccountOrNone, vatSplitOf } from '../src/accounting/statement-postings.js';
import { vatPostings } from '../src/accounting/year-close.js';
import type { JournalEntry } from '../src/types/index.js';

const { jurisdiction } = loadJurisdiction(APP_ROOT, 'ch');
const CHART = ['1020', '1170', '2200', '2201', '2451', '3200', '6580', '6600'];
const VAT = '2201';
const entry = (accountDebit: string, accountCredit: string, amount: number, vatCode?: string): JournalEntry =>
  ({ id: `e-${accountDebit}-${accountCredit}-${vatCode}`, transactionRef: 'r', date: '2026-11-03', accountDebit, accountCredit, amount, description: 'x', ...(vatCode && { vatCode }) }) as JournalEntry;
const split = (e: JournalEntry) => vatSplitOf(e, statementVatAccountOrNone(CHART));

test('a one-sided input tax correction: its empty debit side is the VAT account, the whole amount, as the statements post it', () => {
  const e = entry('', '6580', 25.42, 'M81-2');
  assert.deepEqual(split(e), { kind: 'tax', tax: 25.42, account: VAT, fills: 'debit' });
  const p = vatPostings([e], VAT)[0];
  assert.deepEqual([p.accountDebit, p.amount], [VAT, 25.42]);
  const derived = (statementPostings([e], CHART) as unknown as JournalEntry[]).find((x) => x.id === `vat:${e.id}`);
  assert.equal(derived?.accountDebit, VAT);
});

test('a one-sided minus code: its empty credit side is the VAT account', () => {
  assert.deepEqual(split(entry('6580', '', 12.5, '-M81-2')), { kind: 'tax', tax: 12.5, account: VAT, fills: 'credit' });
});

test('a one-sided entry with an ordinary rate code fills nothing: only its tax goes to the VAT account', () => {
  assert.deepEqual(split(entry('', '6580', 108.1, 'M81')), { kind: 'included', tax: 8.1, account: VAT });
});

test('a two-sided entry whose code books the tax: no side to fill, kind tax (no «davon» line)', () => {
  assert.deepEqual(split(entry('2451', '6580', 25.42, 'M81-2')), { kind: 'tax', tax: 25.42, account: VAT });
});

test('a two-sided sale and purchase at 8.1 %: the tax the gross amount holds', () => {
  assert.deepEqual(split(entry('1020', '3200', 108.1, 'V81')), { kind: 'included', tax: 8.1, account: VAT });
  assert.deepEqual(split(entry('6580', '1020', 339.62, 'M81')), { kind: 'included', tax: 25.45, account: VAT });
  // The VAT account itself on a side: the split is read from the construction, not by comparing accounts.
  assert.deepEqual(split(entry(VAT, '1020', 108.1, 'V81')), { kind: 'included', tax: 8.1, account: VAT });
});

test('no code, a code that splits nothing off, and a one-sided entry without a tax code: no split', () => {
  assert.equal(split(entry('6580', '1020', 100)), null);
  assert.equal(split(entry('', '6580', 100)), null);
  assert.equal(split(entry('', '6580', 100, 'M0')), null);
  assert.equal(split(entry('6600', '1020', 100, 'B81-1')), null, 'Bezugsteuer on the effective method nets to zero');
});

test('net-rate: Bezugsteuer owed without a deduction is tax on top of the amount', () => {
  const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    assert.deepEqual(split(entry('6600', '1020', 100, 'B81-1')), { kind: 'onTop', tax: 8.1, account: VAT });
  } finally {
    setJurisdiction(jurisdiction);
  }
});

test('statements shown gross: no derived postings, so no account and no split', () => {
  try {
    setJurisdiction({ ...jurisdiction, statements: { ...jurisdiction.statements, vat: 'gross' } });
    assert.equal(statementVatAccountOrNone(CHART), null);
    assert.equal(split(entry('', '6580', 25.42, 'M81-2')), null);
  } finally {
    setJurisdiction(jurisdiction);
  }
});
