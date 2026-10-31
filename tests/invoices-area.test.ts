/**
 * Rechnungen as the UI lists them (src/app/areas/invoices/model.ts, address.ts): each invoice's
 * state and group, the status filters, the link ids, a draft following its customer, and the
 * customer form's rules per country. On the demo's invoices, on 11.10.2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePeriod } from '../src/accounting/periods.js';
import type { InvoiceBook } from '../src/invoices/model.js';
import { byRouteId, counts, customerChange, groupsOf, openSums, routeId, rowsOf } from '../src/app/areas/invoices/model.js';
import { addressRule, countryOf, languageFor, numberFirst, vatRule } from '../src/app/areas/invoices/address.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const TODAY = '2026-10-11';
const book = JSON.parse(readFileSync(join(DEMO_ROOT, 'invoices.json'), 'utf8')) as InvoiceBook;
const d = { today: TODAY, invoices: book.invoices, customers: book.customers, sent: book.sent };
const year = parsePeriod('2026', TODAY)!;

test('each invoice\'s state: paid, overdue past its due date, open, a credit note, cancelled, a draft', () => {
  const rows = rowsOf(d, year, undefined, TODAY);
  assert.deepEqual(rows.map((r) => `${r.inv.status === 'issued' ? r.inv.number : 'draft'} ${r.state}`), [
    '2026-001 paid', '2026-002 paid', '2026-003 overdue', '2026-004 credit', '2026-005 open', '2026-006 open', '2026-007 cancelled', 'draft draft', 'draft draft',
  ]);
  assert.deepEqual(counts(rows), { all: 9, open: 3, overdue: 1, draft: 2, paid: 2 }, '"offen" counts the overdue ones too');
  assert.deepEqual(groupsOf(rows, 'open').map((g) => g.state), ['overdue', 'open']);
  assert.deepEqual(groupsOf(rows, undefined).map((g) => g.state), ['overdue', 'open', 'draft', 'paid', 'credit', 'cancelled']);
  assert.deepEqual(openSums(rows, d.invoices).overdue, 861.84, 'what 2026-003 still owes');
  assert.deepEqual(openSums(rows, d.invoices), { open: 1827.03, overdue: 861.84, foreign: [{ currency: 'EUR', open: 865, overdue: 0 }] }, 'the EUR invoice counts in its own currency (r8c-9)');
  assert.deepEqual(rows.filter((r) => r.state === 'open' || r.state === 'overdue').map((r) => [r.inv.status === 'issued' ? r.inv.number : '', r.open]), [['2026-003', 861.84], ['2026-005', 865], ['2026-006', 965.19]], 'each row knows what is still open');
});

test('a period shows the invoices dated in it and every draft; the search finds number, customer and subject', () => {
  const q2 = rowsOf(d, parsePeriod('2026-Q2', TODAY)!, undefined, TODAY);
  assert.deepEqual(q2.map((r) => r.state), ['draft', 'draft']);
  assert.deepEqual(rowsOf(d, year, '2026-003', TODAY).map((r) => routeId(r.inv)), ['2026-003']);
  assert.ok(rowsOf(d, year, 'bistro', TODAY).every((r) => r.customer.includes('Bistro')));
});

test('links: an issued invoice by its number, a draft by draft-<id>; another id finds nothing', () => {
  const draft = d.invoices.find((i) => i.status === 'draft')!;
  assert.equal(byRouteId(d.invoices, routeId(draft)), draft);
  assert.equal(routeId(byRouteId(d.invoices, '2026-005')!), '2026-005');
  assert.equal(byRouteId(d.invoices, '2026-099'), undefined);
  assert.equal(byRouteId(d.invoices, `draft-${d.invoices.find((i) => i.status === 'issued')!.id}`), undefined, 'an issued invoice is no draft');
});

test('a draft follows its customer: abroad 0 % for a service abroad (EUR for the neighbours), back home the normal rate', () => {
  const lines = [{ text: 'Beratung', quantity: 2, price: 100, vatRate: 8.1 as const }];
  const de = { id: 'c1', language: 'de' as const, address: { country: 'DE' } };
  const us = { id: 'c2', language: 'en' as const, address: { country: 'US' } };
  const ch = { id: 'c3', language: 'fr' as const, address: { country: 'CH' } };
  assert.deepEqual(customerChange({ lines, currency: 'CHF' }, de), { customerId: 'c1', language: 'de', lines: [{ ...lines[0], vatRate: 0 }], exemption: 'abroad', currency: 'EUR' });
  assert.equal(customerChange({ lines, currency: 'CHF' }, us).currency, undefined, 'a US customer keeps the currency');
  assert.deepEqual(customerChange({ lines: [{ ...lines[0], vatRate: 0 }], currency: 'EUR' }, ch), { customerId: 'c3', language: 'fr', lines, exemption: null, currency: 'CHF' });
  assert.deepEqual(customerChange({ lines, currency: 'CHF' }, ch), { customerId: 'c3', language: 'fr' }, 'a Swiss draft keeps its rates');
});

test('the customer form per country: the postcode\'s name and shape, a state, the number first, the VAT number, the language', () => {
  assert.deepEqual([addressRule('US').postcode, addressRule('US').state, addressRule('US').townFirst, numberFirst('US')], ['zip', 'state', true, true]);
  assert.ok(addressRule('GB').pattern.test('E1 6QR'));
  assert.ok(!addressRule('CH').pattern.test('80000'));
  assert.equal(addressRule('XK').postcode, 'generic');
  assert.ok(vatRule('DE').pattern!.test('DE123456789'));
  assert.ok(vatRule('GR').pattern!.test('EL123456789'), 'Greece writes EL');
  assert.ok(vatRule('CH').pattern!.test('CHE-123.456.789 MWST'));
  assert.equal(vatRule('US').pattern, undefined);
  assert.deepEqual([languageFor('CH', '1204'), languageFor('CH', '6900'), languageFor('CH', '8000'), languageFor('AT', ''), languageFor('US', '')], ['fr', 'it', 'de', 'de', 'en']);
  assert.deepEqual([countryOf('Schweiz'), countryOf('Suisse'), countryOf('usa'), countryOf('Vereinigtes Königreich'), countryOf('Atlantis')], ['CH', 'CH', 'US', 'GB', undefined]);
});

test('linking from either side (r9c-3): a payment\'s page offers the open invoices of its currency, the named one first; an invoice\'s page offers the open period\'s incoming payments not yet allocated, a prepayment before its date included', async () => {
  const { linkableInvoices, linkablePayments } = await import('../src/app/areas/invoices/model.js');
  const issued = (id: string, number: string, currency: string, over: Record<string, unknown> = {}) => ({
    id, status: 'issued', kind: 'invoice', deleted: false, number, reference: `RF${number}`, currency, date: '2026-10-16', payments: [], reminders: [],
    customer: { name: 'Kunde' }, lines: [{ text: 'x', quantity: 1, price: 4200, vatRate: 0 }], ...over,
  }) as unknown as InvoiceBook['invoices'][number];
  const invoices = [issued('a', '2026-001', 'CHF'), issued('b', '2026-002', 'EUR'), issued('c', '2026-003', 'EUR'), issued('d', '2026-004', 'EUR', { cancelled: { date: '2026-10-17', reason: 'x' } }), issued('e', '2026-005', 'EUR', { payments: [{ transactionRef: 'W9', date: '2026-10-01', amount: 4200, by: 'reference' }] })];
  const tx = (ref: string, currency: string, date: string, description: string, direction: 'CRDT' | 'DBIT' = 'CRDT') => ({ ref, currency, date, description, direction, amount: 3000, source: 'camt053' }) as never;
  const wise = tx('W1', 'EUR', '2026-10-12', 'Rechnung 2026-003 Teilzahlung');
  assert.deepEqual(linkableInvoices(invoices, wise).map((i) => i.number), ['2026-003', '2026-002'], 'EUR only, the named one first; cancelled and paid left out');
  assert.deepEqual(linkableInvoices(invoices, tx('W2', 'EUR', '2026-10-12', 'x', 'DBIT')), [], 'money out pays no invoice');
  assert.deepEqual(linkableInvoices(invoices, tx('W9', 'EUR', '2026-10-01', 'x')), [], 'allocated already');
  const books = { transactions: [wise, tx('W9', 'EUR', '2026-10-01', 'x'), tx('R1', 'CHF', '2026-10-14', 'x'), tx('W0', 'EUR', '2026-03-03', 'alt')], config: { closedThrough: '2026-03-31' } };
  assert.deepEqual(linkablePayments(books, invoices, invoices[2] as never).map((t) => t.ref), ['W1'], 'W9 is allocated, R1 is CHF, W0 lies in a filed quarter');
});
