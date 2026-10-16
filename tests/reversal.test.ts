/**
 * Year-end accruals and reversals without typing them twice (persona test «treuhaender», finding
 * 27): an entry on a transitory account or a provision may be reversed on 1 January of the next
 * year, and any entry has its Gegenbuchung (Soll and Haben swapped, the VAT code turned).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { isAccrual, newYearAfter, reversalIn, reversalOf, reversedAsRule, turned } from '../src/accounting/reversal.js';
import type { JournalEntry } from '../src/types/index.js';
import { startApi } from './support/api-server.js';

const je = (id: string, date: string, dr: string, cr: string, amount: number, vatCode?: string): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: dr, accountCredit: cr, amount, description: id, ...(vatCode && { vatCode }) });

test('which entries are accruals: the transitory accounts reversed as a rule, a provision offered but not ticked', () => {
  assert.equal(isAccrual(je('ta', '2026-12-31', '1300', '6300', 653.35)), true);
  assert.equal(reversedAsRule(je('ta', '2026-12-31', '1300', '6300', 653.35)), true);
  assert.equal(reversedAsRule(je('tp', '2026-12-31', '5000', '2300', 2600)), true);
  assert.equal(isAccrual(je('pr', '2026-12-31', '6100', '2330', 3000)), true);
  assert.equal(reversedAsRule(je('pr', '2026-12-31', '6100', '2330', 3000)), false);
  assert.equal(isAccrual(je('dep', '2026-12-31', '6800', '1530', 4000)), false);
  assert.equal(isAccrual(je('back', '2027-01-01', '6300', '1300', 653.35)), false, 'the reversal itself is no accrual to reverse again');
  assert.equal(isAccrual(je('used', '2027-03-01', '2330', '1020', 3000)), false, 'a provision used is none');
});

test('the reversal swaps Soll and Haben, turns the VAT code, keeps the amount; dated on the next 1.1.', () => {
  const tp = je('tp', '2026-12-31', '5000', '2300', 2600);
  assert.equal(newYearAfter(tp.date), '2027-01-01');
  assert.deepEqual(reversalOf(tp, '2027-01-01', 'Auflösung'), { date: '2027-01-01', accountDebit: '2300', accountCredit: '5000', amount: 2600, description: 'Auflösung' });
  assert.equal(reversalOf(je('x', '2026-10-01', '4000', '1020', 100, 'M81'), '2026-10-16', 'G').vatCode, '-M81');
  assert.equal(turned('-I81'), 'I81');
  assert.equal(turned(undefined), undefined);
  const entries = [tp, je('back', '2027-01-01', '2300', '5000', 2600)];
  assert.equal(reversalIn(entries, tp)?.id, 'back');
  assert.equal(reversalIn([tp, je('other', '2027-01-01', '2300', '5000', 2500)], tp), undefined, 'another amount is no reversal of it');
});

test('an accrual on 31.12. and its reversal on 1.1. are both booked in the open period', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const ta = { date: '2026-12-31', accountDebit: '1300', accountCredit: '6300', amount: 653.35, description: 'Versicherung 8/12' };
    const first = await api.send('POST', '/api/journal-entries', ta);
    assert.equal(first.status, 200, String(first.json.error));
    const back = await api.send('POST', '/api/journal-entries', reversalOf(ta, newYearAfter(ta.date), 'Auflösung 2026: Versicherung 8/12'));
    assert.equal(back.status, 200, String(back.json.error));
    const entry = back.json.entry as JournalEntry;
    assert.deepEqual([entry.date, entry.accountDebit, entry.accountCredit, entry.amount, entry.origin], ['2027-01-01', '6300', '1300', 653.35, 'manual']);
    assert.match(entry.transactionRef, /^M2027-\d{3}$/, 'numbered in its own year');
  } finally {
    api.stop();
  }
});
