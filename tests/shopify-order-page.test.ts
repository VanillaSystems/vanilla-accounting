/**
 * Characterization of the Shopify order page parser behind rebook-shopify-orders. The fixture
 * holds the extractedText of seven synthetic order pages in Shopify's layout; customers, amounts
 * and numbers are invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOrderPage } from '../src/cli/extract-shopify-orders.js';

const pages = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/shopify-order-pages.json'), 'utf8')) as Record<string, string>;
const parse = (file: string) => parseOrderPage(file, pages[file]);

test('Swiss order priced in CHF: MwSt 8.1% in CHF and the CHF consideration', () => {
  const file = '20260803-shopify-order-1001-lea-brunner.pdf';
  assert.deepEqual(parse(file), {
    num: '1001', odate: '2026-08-03', customer: 'L. Brunner', country: 'Schweiz', taxlabel: 'MwSt 8.1%',
    taxrate: 8.1, taxcur: 'CHF', taxamt: 5.32, paidEur: 76.34, chfPaid: 71, refundEur: 0,
    payouts: [{ eur: 73.8, date: '2026-08-06' }], pendingPayouts: [], paidByBank: false, refunds: [], file,
  });
});

test('EU order: foreign VAT label with country code, paid in EUR', () => {
  const file = '20260714-shopify-order-1002.pdf';
  assert.deepEqual(parse(file), {
    num: '1002', odate: '2026-07-14', customer: 'J. Weber', country: 'DE', taxlabel: 'DE MwSt 19%',
    taxrate: 19, taxcur: 'EUR', taxamt: 10.86, paidEur: 68, chfPaid: null, refundEur: 0,
    payouts: [{ eur: 65.4, date: '2026-07-17' }], pendingPayouts: [], paidByBank: false, refunds: [], file,
  });
});

test('export order split over two payouts', () => {
  const o = parse('20260602-shopify-order-1003.pdf');
  assert.ok(!('problem' in o));
  assert.equal(o.country, 'United States');
  assert.equal(o.taxlabel, '');
  assert.equal(o.taxcur, null);
  assert.equal(o.paidEur.toFixed(2), '103.64');
  assert.deepEqual(o.payouts, [{ eur: 29.8, date: '2026-06-09' }, { eur: 70.1, date: '2026-06-05' }]);
});

test('refunded order: refund deducted from a later payout, order date from the timeline', () => {
  const o = parse('20260615-shopify-order-1004-refund.pdf');
  assert.ok(!('problem' in o));
  assert.equal(o.odate, '2026-06-09');
  assert.equal(o.paidEur, 62);
  assert.equal(o.refundEur, 62);
  assert.deepEqual(o.refunds, [{ eur: 62, date: '2026-06-17' }]);
  assert.deepEqual(o.payouts, [{ eur: 59.6, date: '2026-06-12' }]);
  assert.equal(o.country, 'Germany');
});

test('converted order with a partial refund: the refund conversion does not count as paid', () => {
  const o = parse('20260901-shopify-order-1006-sam-rivera.pdf');
  assert.ok(!('problem' in o));
  assert.equal(o.paidEur, 81.82);
  assert.equal(o.refundEur, 17.86);
  assert.deepEqual(o.payouts, [{ eur: 79, date: '2026-09-04' }]);
  assert.equal(o.country, 'United States');
});

test('paid by bank transfer: no payout ever comes', () => {
  const o = parse('20260821-shopify-order-1005-eva-hofmann.pdf');
  assert.ok(!('problem' in o));
  assert.equal(o.paidByBank, true);
  assert.deepEqual(o.payouts, []);
  assert.equal(o.paidEur, 96);
});

test('payout announced but not yet made is pending', () => {
  const o = parse('20260928-shopify-order-1007-nina-graf.pdf');
  assert.ok(!('problem' in o));
  assert.deepEqual(o.payouts, []);
  assert.deepEqual(o.pendingPayouts, [{ eur: 57.2, date: '2026-10-02' }]);
  assert.equal(o.chfPaid, 55);
});

test('pages that do not add up are problems, never guesses', () => {
  assert.deepEqual(parseOrderPage('receipt.pdf', 'x'), { file: 'receipt.pdf', problem: 'no order number in filename' });
  assert.deepEqual(parseOrderPage('x-shopify-order-1.pdf', 'nothing here'), { file: 'x-shopify-order-1.pdf', problem: 'order date not found' });
  const pending = pages['20260615-shopify-order-1004-refund.pdf'].replace('€62.00 EUR refund was deducted from your Jun 17, 2026 payout.', '');
  assert.notEqual(pending, pages['20260615-shopify-order-1004-refund.pdf']);
  assert.deepEqual(parseOrderPage('x-shopify-order-1004.pdf', pending), { file: 'x-shopify-order-1004.pdf', problem: 'refund pending, not yet deducted from a payout' });
  const overpaid = pages['20260714-shopify-order-1002.pdf'].replace('€65.40 EUR was added', '€999.90 EUR was added');
  assert.notEqual(overpaid, pages['20260714-shopify-order-1002.pdf']);
  assert.deepEqual(parseOrderPage('x-shopify-order-1002.pdf', overpaid), { file: 'x-shopify-order-1002.pdf', problem: 'payouts 999.90 exceed paid 68.00' });
});
