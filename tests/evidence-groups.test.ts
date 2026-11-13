/**
 * A receipt of several VAT groups against the lines of its payment (#406): the Post's bill for
 * shipping labels shows domestic labels at 8.1 % and «0% (Export)»; the payment booked in two
 * lines, each at its group's rate, fits it. Only a rate booked beyond what the receipt shows at it
 * is a finding, which names the amount and the rate the receipt shows, and proposes the payment's
 * lines by the receipt's groups.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { evidenceCheck } from '../src/accounting/evidence-check.js';
import type { JournalEntry, Receipt } from '../src/types/index.js';

// The webshop persona's bills (webshop-ai r1, books-final.json): the July bill as the reader read it
// (the 8.1 % group only; the export part is the rest of its total), the August bill with both groups.
const july = { id: 'r-jul', filename: 'post-jul.pdf', amount: 1086.42, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 783, vat: 63.42 }] } as Receipt;
const august = { id: 'r-aug', filename: 'post-aug.pdf', amount: 1070.86, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 702, vat: 56.86 }, { ratePercent: 0, net: 312, vat: 0 }] } as Receipt;

const line = (id: string, ref: string, amount: number, vatCode: string, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: ref, date: '2026-08-24', accountDebit: '6280', accountCredit: '1020', amount, vatCode, origin: 'classify', by: { kind: 'model', model: 'sonnet' }, ...over });

const checks = (lines: JournalEntry[], receipts: Receipt[]) => lines.map((e) => evidenceCheck(e, receipts, '2026-06-30', undefined, lines));

test('the bill\'s two lines booked each at its rate fit it: no task on the export line (webshop-ai-21)', () => {
  const jul = [line('a', 'LUKB-26-0034', 846.42, 'I81'), line('b', 'LUKB-26-0034', 240, 'I0')];
  assert.deepEqual(checks(jul, [july]), [undefined, undefined], 'the export part is the rest of the July bill\'s total');
  const aug = [line('c', 'LUKB-26-0055', 758.86, 'I81'), line('d', 'LUKB-26-0055', 312, 'I0')];
  assert.deepEqual(checks(aug, [august]), [undefined, undefined], 'the August bill names its export group');
});

test('the mirror: the export line set to 8.1 % claims input tax the bill does not show, and the finding says which amount', () => {
  const aug = [line('a', 'LUKB-26-0055', 758.86, 'I81'), line('b', 'LUKB-26-0055', 312, 'I81')];
  const [first, second] = checks(aug, [august]);
  assert.deepEqual(first, { kind: 'receiptGroups', rate: 0, amount: 312, currency: 'CHF', lines: [{ amount: 758.86, code: 'I81' }, { amount: 312, code: 'I0' }], entries: ['a', 'b'], receipts: ['r-aug'] });
  assert.equal(second, undefined, 'one finding per payment');
  const whole = [line('w', 'LUKB-26-0055', 1070.86, 'I81')];
  assert.deepEqual(checks(whole, [august])[0], { kind: 'receiptGroups', rate: 0, amount: 312, currency: 'CHF', lines: [{ amount: 758.86, code: 'I81' }, { amount: 312, code: 'I0' }], entries: ['w'], receipts: ['r-aug'] }, 'one line at 8.1 % for the whole bill');
});

test('the whole bill at the zero code: the receipt\'s 8.1 % part is named, and the proposal books each group on its own line', () => {
  const whole = [line('w', 'LUKB-26-0055', 1070.86, 'I0')];
  assert.deepEqual(checks(whole, [august])[0], { kind: 'receiptGroups', rate: 8.1, amount: 758.86, currency: 'CHF', lines: [{ amount: 758.86, code: 'I81' }, { amount: 312, code: 'I0' }], entries: ['w'], receipts: ['r-aug'] });
});

test('the payment\'s rounding goes on the largest line', () => {
  const whole = [line('w', 'T', 1070.85, 'I0')];
  assert.deepEqual((checks(whole, [august])[0] as { lines: unknown }).lines, [{ amount: 758.85, code: 'I81' }, { amount: 312, code: 'I0' }]);
});

test('a receipt with one rate and a booking at the zero code stays a finding, as before', () => {
  const single = { id: 'r1', filename: 'x.pdf', amount: 846.42, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 783, vat: 63.42 }] } as Receipt;
  assert.deepEqual(checks([line('a', 'T', 846.42, 'I0')], [single])[0], { kind: 'receiptShowsVat', rate: 8.1, code: 'I81', receipts: ['r1'] });
  assert.equal(checks([line('a', 'T', 846.42, 'I81')], [single])[0], undefined);
});

test('a receipt whose groups were not read is no evidence either way', () => {
  const unread = { id: 'r1', filename: 'x.pdf', amount: 1086.42, currency: 'CHF' } as Receipt;
  assert.deepEqual(checks([line('a', 'T', 846.42, 'I81'), line('b', 'T', 240, 'I0')], [unread]), [undefined, undefined]);
  const taxOnly = { ...july, vatSummary: [{ ratePercent: 8.1, vat: 63.42 }] } as Receipt;
  assert.deepEqual(checks([line('a', 'T', 846.42, 'I81'), line('b', 'T', 240, 'I0')], [taxOnly]), [undefined, { kind: 'receiptShowsVat', rate: 8.1, code: 'I81', receipts: ['r-jul'] }], 'a group named by its tax alone: compared per line, as before');
});

// ─── #406 review ──────────────────────────────────────────────────────────────

const bill = (amount: number, vatSummary: Receipt['vatSummary'], over: Partial<Receipt> = {}) => ({ id: 'r', filename: 'r.pdf', amount, currency: 'CHF', hasSwissVat: true, vatSummary, ...over } as Receipt);
const twoGroups = bill(100, [{ ratePercent: 8.1, net: 74, vat: 6 }, { ratePercent: 0, net: 20, vat: 0 }]);

test('M1: the rest of a total beyond its groups read never accuses a rate line, and feeds no rebooking', () => {
  // The reader missed the 2.6 % group: booked right, I81 40 + I26 60.
  const missed = bill(100, [{ ratePercent: 8.1, net: 37, vat: 3 }]);
  assert.deepEqual(checks([line('a', 'T', 40, 'I81'), line('b', 'T', 60, 'I26')], [missed]), [undefined, undefined]);
  // A group read as net 100 for a gross: the 8.10 rest is no export part.
  assert.deepEqual(checks([line('a', 'T', 108.1, 'I81')], [bill(108.1, [{ ratePercent: 8.1, gross: 100, vat: 8.1 }])]), [undefined]);
  assert.deepEqual(checks([line('a', 'T', 108.1, 'I81')], [bill(108.1, [{ ratePercent: 8.1, net: 100, vat: 0 }])]), [undefined]);
  // The July bill booked whole at 8.1 %: its rest is not read as 0 %, nothing to accuse.
  assert.deepEqual(checks([line('w', 'T', 1086.42, 'I81')], [july]), [undefined]);
  // A zero line beyond the group and the rest is still a finding, without a click.
  assert.deepEqual(checks([line('z', 'T', 100, 'I0')], [missed])[0], { kind: 'receiptGroups', rate: 8.1, amount: 40, currency: 'CHF', entries: ['z'], receipts: ['r'] });
});

test('M2: a rebooking is offered only for lines on the same accounts, of one code family, with the same tags', () => {
  const accounts = checks([line('a', 'T', 60, 'I81', { accountDebit: '6500' }), line('b', 'T', 40, 'I81', { accountDebit: '6510' })], [twoGroups])[0];
  assert.equal(accounts?.kind, 'receiptGroups');
  assert.equal((accounts as { lines?: unknown }).lines, undefined, 'two accounts: no click');
  const families = checks([line('b', 'T', 40, 'M0', { accountDebit: '4200' }), line('a', 'T', 60, 'I81')], [twoGroups]);
  assert.equal(families.find(Boolean)?.kind, 'receiptGroups');
  assert.equal((families.find(Boolean) as { lines?: unknown }).lines, undefined, 'M and I: no click');
  const tags = checks([line('a', 'T', 60, 'I81', { tags: { projekt: 'alpha' } }), line('b', 'T', 40, 'I81')], [twoGroups])[0];
  assert.equal((tags as { lines?: unknown }).lines, undefined, 'tags differ: no click');
});

test('S1: a line a person decided with the receipt before her makes the finding decided', () => {
  const person = { kind: 'person' as const, at: '2026-10-16T09:00:00.000Z' };
  const c = checks([line('a', 'T', 80, 'I81'), line('b', 'T', 20, 'I81', { by: person, origin: 'manual', receipts: ['r'] })], [twoGroups])[0];
  assert.equal(c?.kind, 'receiptGroups');
  assert.equal(c?.decided, true);
});

test('S2: a group at a rate no domestic rate is (a foreign VAT) leaves the receipt to the check per line', () => {
  const foreign = bill(100, [{ ratePercent: 19, gross: 50, vat: 7.98 }]);
  assert.deepEqual(checks([line('a', 'T', 100, 'I81')], [foreign])[0], { kind: 'vatWithoutReceipt', code: 'I0' }, 'only a foreign rate: no input tax, as before');
});
