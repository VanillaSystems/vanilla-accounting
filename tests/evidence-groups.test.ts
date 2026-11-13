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
  assert.deepEqual(checks([line('a', 'T', 846.42, 'I81'), line('b', 'T', 240, 'I0')], [taxOnly]), [undefined, undefined], 'a group named by its tax alone beside a line at its rate: the zero line may be the untaxed part (#455)');
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
  // The July bill booked whole at 8.1 % claims the tax of 1086.42 where the bill shows 63.42: an over-claim (#469), see below.
  assert.equal(checks([line('w', 'T', 1086.42, 'I81')], [july])[0]?.kind, 'receiptGroups');
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

// ─── #406 second review ───────────────────────────────────────────────────────

test('a receipt whose only group read is at 0 % proves no input tax: the rate code is zeroed per line, as before', () => {
  const zeroOnly = bill(100, [{ ratePercent: 0, net: 20, vat: 0 }]);
  assert.deepEqual(checks([line('a', 'T', 100, 'I81')], [zeroOnly])[0], { kind: 'vatWithoutReceipt', code: 'I0' });
  const none = bill(30, [], { id: 'n', hasSwissVat: false });
  assert.deepEqual(checks([line('a', 'T', 130, 'I81')], [none, { ...zeroOnly, amount: 100 }])[0], { kind: 'vatWithoutReceipt', code: 'I0' }, 'with a receipt without VAT beside it');
});

test('a hand booking from before `by` was recorded counts as the person\'s: decided', () => {
  const c = checks([line('a', 'T', 80, 'I81'), line('b', 'T', 20, 'I81', { by: undefined, origin: 'manual' })], [twoGroups])[0];
  assert.equal(c?.decided, true);
});

test('lines of different days get no click', () => {
  const c = checks([line('a', 'T', 80, 'I81'), line('b', 'T', 20, 'I81', { date: '2026-08-25' })], [twoGroups])[0];
  assert.equal(c?.kind, 'receiptGroups');
  assert.equal((c as { lines?: unknown }).lines, undefined);
});

test('a line of a closed period is no mate and leaves the finding without a click', () => {
  const lines = [line('a', 'T', 50, 'I0'), line('b', 'T', 50, 'I81', { date: '2026-06-20' })];
  const c = lines.map((e) => evidenceCheck(e, [twoGroups], '2026-06-30', undefined, lines));
  assert.equal(c[1], undefined, 'the filed line itself is never checked');
  assert.equal(c[0]?.kind, 'receiptGroups');
  assert.deepEqual((c[0] as { entries: string[] }).entries, ['a']);
  assert.equal((c[0] as { lines?: unknown }).lines, undefined);
});

// ─── #455: a zero-rated part of the receipt, and receipts that cannot be compared ────────────────

// The consultancy persona's hotel bill as the reader read it (consulting-ai r3-14): the room at 3.8 %, the Kurtaxe «ohne MWST» only the rest of its total.
const hotel = bill(164, [{ ratePercent: 3.8, vat: 5.78, gross: 158 }], { id: 'hotel' });

test('#455: the hotel bill paid on its own, room I38 and Kurtaxe I0: the Kurtaxe is the bill\'s untaxed part, no finding', () => {
  assert.deepEqual(checks([line('room', 'H', 158, 'I38'), line('kurtaxe', 'H', 6, 'I0')], [hotel]), [undefined, undefined]);
  const both = bill(164, [{ ratePercent: 3.8, vat: 5.78, gross: 158 }, { ratePercent: 0, vat: 0, gross: 6 }], { id: 'hotel' });
  assert.deepEqual(checks([line('room', 'H', 158, 'I38'), line('kurtaxe', 'H', 6, 'I0')], [both]), [undefined, undefined], 'the zero part read as a group of its own');
});

test('#455: 100 at 8.1 % and 20 at 0 % on two lines fit the receipt; the click on the whole never puts the rate on the 20', () => {
  const mixed = bill(120, [{ ratePercent: 8.1, vat: 7.49, gross: 100 }, { ratePercent: 0, vat: 0, gross: 20 }]);
  assert.deepEqual(checks([line('a', 'T', 100, 'I81'), line('b', 'T', 20, 'I0')], [mixed]), [undefined, undefined]);
  assert.deepEqual(checks([line('w', 'T', 120, 'I0')], [mixed])[0], { kind: 'receiptGroups', rate: 8.1, amount: 100, currency: 'CHF', lines: [{ amount: 100, code: 'I81' }, { amount: 20, code: 'I0' }], entries: ['w'], receipts: ['r'] });
});

test('#455: a receipt in another currency on the payment is left out of the sum: the hotel bill alone shows the Kurtaxe untaxed', () => {
  const linkly = bill(180, [], { id: 'linkly', currency: 'USD', hasSwissVat: false });
  assert.deepEqual(checks([line('room', 'H', 158, 'I38'), line('kurtaxe', 'H', 6, 'I0')], [hotel, linkly]), [undefined, undefined]);
});

test('#455: a group named by its tax alone is set against the lines by the gross its tax proves', () => {
  // 100 at 8.1 % named by its tax (7.49), 20 beside it: the tax proves 99.96 taxed, the 20 is the rest.
  const taxOnly = bill(120, [{ ratePercent: 8.1, vat: 7.49 }]);
  assert.deepEqual(checks([line('a', 'T', 100, 'I81'), line('b', 'T', 20, 'I0')], [taxOnly]), [undefined, undefined]);
  // Alone on the receipt, the zero line is told what the tax proves taxed, without a click (the rest may be a rate not read).
  assert.deepEqual(checks([line('b', 'T', 120, 'I0')], [taxOnly])[0], { kind: 'receiptGroups', rate: 8.1, amount: 99.96, currency: 'CHF', entries: ['b'], receipts: ['r'] });
});

test('#455 review F1: a tax that proves the whole total taxed still accuses the zero line beside the rate line', () => {
  // 81.41 at 8.1 % is the tax of all of 1086.42 (to the cent's rounding): the 240 at I0 loses CHF 17.99.
  const all = { ...july, vatSummary: [{ ratePercent: 8.1, vat: 81.41 }] } as Receipt;
  assert.deepEqual(checks([line('a', 'T', 846.42, 'I81'), line('b', 'T', 240, 'I0')], [all]), [undefined, { kind: 'receiptShowsVat', rate: 8.1, code: 'I81', receipts: ['r-jul'] }]);
});

test('#455 review F4: 1000 at I81 and 86.42 at I0 on the bill whose tax 63.42 proves 846.39 taxed: no rate is offered for the zero line', () => {
  const taxOnly = { ...july, vatSummary: [{ ratePercent: 8.1, vat: 63.42 }] } as Receipt;
  const [, zero] = checks([line('a', 'T', 1000, 'I81'), line('b', 'T', 86.42, 'I0')], [taxOnly]);
  assert.equal(zero, undefined, 'the 86.42 lies within the 240 the tax leaves untaxed: I81 on it would claim more');
});

test('#455 review G1: a bill in another currency beside a bill at 8.1 % on all of 120 does not excuse the zero line', () => {
  const chf = bill(120, [{ ratePercent: 8.1, vat: 9, gross: 120 }], { id: 'chf' });
  const usd = bill(45, [], { id: 'usd', currency: 'USD', hasSwissVat: false });
  const lines = [line('a', 'T', 100, 'I81'), line('b', 'T', 20, 'I0'), line('c', 'T', 40, 'B81-1')];
  assert.deepEqual(checks(lines, [chf, usd]), [undefined, { kind: 'receiptShowsVat', rate: 8.1, code: 'I81', receipts: ['chf', 'usd'] }, undefined]);
});

// ─── #455 second review: the tax's rounding in the comparisons ─────────────────────────────────

const CODE: Record<number, string> = { 2.6: 'I26', 3.8: 'I38', 8.1: 'I81' };
/** A bill of `g` taxed at `rate` and `z` untaxed, its group named by its tax alone, rounded to the cent. */
const taxBill = (g: number, z: number, rate: number) => bill(Math.round((g + z) * 100) / 100, [{ ratePercent: rate, vat: Math.round((g * rate) / (100 + rate) * 100) / 100 }]);

test('#455 second review: 150.16 at 2.6 % (tax 3.81) and a Kurtaxe of 6 booked so: no finding of CHF 0.19 at 2.6 % on the zero line', () => {
  assert.deepEqual(checks([line('a', 'T', 150.16, 'I26'), line('b', 'T', 6, 'I0')], [taxBill(150.16, 6, 2.6)]), [undefined, undefined]);
});

test('#455 second review: over a sweep of bills named by their tax, every right split fits and every under-claim of 5 is told', () => {
  let seed = 455;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const rate of [2.6, 3.8, 8.1]) {
    for (let i = 0; i < 300; i++) {
      const g = Math.round((10 + next() * 490) * 100) / 100;
      const z = next() < 0.5 ? 6 : 20;
      const r = taxBill(g, z, rate);
      const right = checks([line('a', 'T', g, CODE[rate]), line('b', 'T', z, 'I0')], [r]);
      assert.deepEqual(right, [undefined, undefined], `${g} at ${rate} % + ${z}: tax ${r.vatSummary![0].vat}`);
      const under = checks([line('a', 'T', Math.round((g - 5) * 100) / 100, CODE[rate]), line('b', 'T', z + 5, 'I0')], [r]);
      assert.equal(under[1]?.kind, 'receiptGroups', `${g - 5} at ${rate} % + ${z + 5}: the 5 taxed booked at I0`);
    }
  }
});
