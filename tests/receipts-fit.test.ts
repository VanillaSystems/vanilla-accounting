/**
 * The warnings of Belege (src/app/areas/receipts/model.ts): a payment whose amount does not fit
 * the receipt's, a Skonto noted rather than warned, a VAT that claims more than the receipt's
 * amount, and one toast naming every field saved in a row. Usability findings misreads-22/23.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import { amountFit, candidates, ledgerOf, linkFit, together, vatMisfit, type ToChf } from '../src/app/areas/receipts/model.js';

const flat: ToChf = (amount, currency) => (currency === 'EUR' ? amount * 0.95 : amount);
const tx = (ref: string, amount: number, currency = 'CHF'): BankTransaction => ({ ref, bank: 'Raiffeisen', date: '2026-10-05', amount, currency, direction: 'DBIT', description: ref });
const receipt = (id: string, more: Partial<Receipt>): Receipt =>
  ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-15T00:00:00Z', location: 'archived', ...more });

test('a payment off the receipt\'s amount is a warning, a few per cent less is a Skonto, cents and exchange rates are the same', () => {
  const photo = { amount: 187.35, currency: 'CHF' };
  assert.deepEqual(amountFit(photo, tx('wrong', 158.6), flat), { kind: 'off', diff: -28.75, currency: 'CHF' });
  assert.deepEqual(amountFit(photo, tx('more', 200), flat), { kind: 'off', diff: 12.65, currency: 'CHF' });
  assert.deepEqual(amountFit(photo, tx('same', -187.35), flat), { kind: 'same' }, 'money out is negative, the receipt is not');
  assert.deepEqual(amountFit(photo, tx('cents', 187.4), flat), { kind: 'same' });
  assert.deepEqual(amountFit({ amount: 1537.22, currency: 'CHF' }, tx('farbmix', 1506.45), flat), { kind: 'skonto', percent: 2 });
  assert.deepEqual(amountFit({ amount: 412.3, currency: 'EUR' }, tx('eur-in-chf', 386.6), flat), { kind: 'same' }, 'EUR 412.30 is CHF 391.69 at the ESTV rate: the bank\'s rate differs');
  assert.equal(amountFit({ amount: 412.3, currency: 'EUR' }, tx('far', 200), flat)?.kind, 'off');
  assert.equal(amountFit({ currency: 'CHF' }, tx('x', 1), flat), undefined, 'no amount, no judgement');
});

test('the warning shows in the link dialog and at the link, but not for a payment several receipts share', () => {
  const books = {
    receipts: [receipt('photo', { date: '2026-10-05', amount: 187.35, currency: 'CHF' }), receipt('a', { amount: 10 }), receipt('b', { amount: 20 })],
    transactions: [tx('wrong', 158.6), tx('grouped', 30)],
    mappings: [{ receiptId: 'a', transactionRef: 'grouped' }, { receiptId: 'b', transactionRef: 'grouped' }],
    journalEntries: [], config: {},
  } as unknown as Index;
  const l = ledgerOf(books, '2026-10-01');
  const c = [...candidates(l.byId.get('photo')!, l, flat).best, ...candidates(l.byId.get('photo')!, l, flat).more];
  assert.deepEqual(c.find((x) => x.tx.ref === 'wrong')?.fit, { kind: 'off', diff: -28.75, currency: 'CHF' });
  assert.equal(c.find((x) => x.tx.ref === 'grouped')?.fit, undefined, 'a grouped payment holds other receipts too');
  assert.equal(linkFit(l.byId.get('a')!, l, flat), undefined);
  const linked = ledgerOf({ ...books, mappings: [{ receiptId: 'photo', transactionRef: 'wrong' }] } as Index, '2026-10-01');
  assert.equal(linkFit(linked.byId.get('photo')!, linked, flat)?.kind, 'off');
});

test('a VAT that belongs to more than the receipt\'s amount is a hint; less is none, a receipt may hold items without VAT', () => {
  const farbmix = { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 1422.02, vat: 115.2, gross: 1537.22 }] };
  assert.equal(vatMisfit(receipt('typed', { ...farbmix, amount: 1506.45 })), 1537.22, 'the paid amount typed over the invoice total');
  assert.equal(vatMisfit(receipt('as-read', { ...farbmix, amount: 1537.22 })), undefined);
  assert.equal(vatMisfit(receipt('more', { ...farbmix, amount: 1600 })), undefined);
  assert.equal(vatMisfit(receipt('tax-only', { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 14.04 }], amount: 187.35 })), undefined, 'the tax at its rate makes the amount');
  assert.equal(vatMisfit(receipt('tax-only-off', { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 14.04 }], amount: 150 })), 187.37);
  assert.equal(vatMisfit(receipt('foreign', { hasSwissVat: false, vatSummary: [{ ratePercent: 19, vat: 65.83, gross: 412.3 }], amount: 300 })), undefined, 'no Swiss VAT, nothing to claim');
});

test('fields saved one after another on one receipt are named in one toast; undo takes each back to what it was first', () => {
  const amount = together(undefined, { id: 'r', fields: ['amount'], back: { amount: 1537.22, currency: 'CHF' }, at: 0 });
  const both = together(amount, { id: 'r', fields: ['date'], back: { date: '2026-09-28' }, at: 4000 });
  assert.deepEqual(both.fields, ['amount', 'date']);
  assert.deepEqual(both.back, { amount: 1537.22, currency: 'CHF', date: '2026-09-28' });
  const again = together(both, { id: 'r', fields: ['amount'], back: { amount: 1506.45, currency: 'CHF' }, at: 6000 });
  assert.deepEqual([again.fields, again.back.amount], [['amount', 'date'], 1537.22], 'the first value before the run wins');
  assert.deepEqual(together(both, { id: 'other', fields: ['date'], back: {}, at: 5000 }).fields, ['date'], 'another receipt starts anew');
  assert.deepEqual(together(both, { id: 'r', fields: ['remarks'], back: {}, at: 60_000 }).fields, ['remarks'], 'and so does a save much later');
});
