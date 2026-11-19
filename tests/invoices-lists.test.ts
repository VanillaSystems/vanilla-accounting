/**
 * What the lists of Verkauf say as facts (src/invoices/lists.ts): the sent log per document (the
 * last send, its channel, the last Mahnung), a Gutschrift's status from what is left to pay back,
 * the age bands of the open items with their subtotals, and the CSV they export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Invoice } from '../src/invoices/model.js';
import { AGE_BANDS, ageBand, channelOf, creditNoteStatus, creditRest, csvOf, daysBetween, openItemGroups, openItems, sentFacts, unsent, wasSent } from '../src/invoices/lists.js';
import { issued, sentDoc } from './support/invoice-fixtures.js';
import './support/jurisdiction.js';

test('the sent log of a document: its last send and channel, every entry, the last Mahnung sent; a reminder alone is no send of the invoice', () => {
  const inv = issued('i1', '2026-001', { reminders: [{ level: 1, date: '2026-11-10', dueDate: '2026-11-20', intro: '', closing: '', documentId: 'r1' }, { level: 2, date: '2026-11-18', dueDate: '2026-11-28', intro: '', closing: '', documentId: 'r2' }] });
  const log = [
    sentDoc('s2', inv, { sentAt: '2026-10-05T10:00:00Z', to: 'download', channel: 'download', messageId: undefined, kind: 'resend' }),
    sentDoc('s1', inv),
    sentDoc('r1', inv, { kind: 'reminder', sentAt: '2026-11-10T08:00:00Z' }),
    sentDoc('r2', inv, { kind: 'reminder', sentAt: '2026-11-18T08:00:00Z' }),
    sentDoc('x', issued('i2', '2026-002')),
  ];
  const f = sentFacts(log, inv);
  assert.equal(f.sent, true);
  assert.equal(f.last?.id, 's2', 'the later of the two sends of the document itself');
  assert.equal(channelOf(f.last!), 'download');
  assert.deepEqual(f.all.map((x) => x.id), ['s1', 's2', 'r1', 'r2'], 'oldest first, only this document\'s');
  assert.deepEqual(f.reminder, { level: 2, date: '2026-11-18' });
  assert.equal(wasSent([log[2]], inv), false, 'a Mahnung is not the invoice');
  assert.equal(channelOf({ to: 'download' }), 'download', 'an entry from before the channel was recorded: `to` tells');
  assert.equal(channelOf({ to: 'x@y.example' }), 'email');
  assert.equal(unsent(inv, []), true);
  assert.equal(unsent({ ...inv, cancelled: { date: '2026-10-03', reason: 'x' } }, []), false, 'a cancelled one is not waiting to be sent');
});

test('a Gutschrift: Offen while something is still to pay back, Teilweise once part went back, Abgerechnet when its Rechnung absorbs it', () => {
  const inv = issued('i1', '2026-001', { payments: [{ transactionRef: 'T1', date: '2026-10-10', amount: 1000, by: 'reference' }] });
  const cn = issued('c1', '2026-002', { kind: 'credit-note', creditFor: 'i1', lines: [{ text: 'Gutschrift', quantity: 1, price: -300, vatRate: 0 }], settlement: 'refund' });
  assert.equal(creditRest(cn, [inv, cn]), 300, 'the invoice was paid in full: all 300 go back');
  assert.equal(creditNoteStatus(cn, [inv, cn]), 'open');
  const half = { ...cn, payments: [{ transactionRef: 'T2', date: '2026-10-20', amount: 100, by: 'confirmed' as const }] };
  assert.equal(creditNoteStatus(half, [inv, half]), 'partly');
  const back = { ...cn, payments: [{ transactionRef: 'T2', date: '2026-10-20', amount: 300, by: 'confirmed' as const }] };
  assert.equal(creditNoteStatus(back, [inv, back]), 'settled');
  const unpaid = issued('i1', '2026-001');
  assert.equal(creditNoteStatus(cn, [unpaid, cn]), 'settled', 'an unpaid invoice takes the credit: nothing to pay back');
  const offset = { ...cn, settlement: 'offset' as const };
  assert.equal(creditNoteStatus(offset, [inv, offset]), 'open', 'set off against the next invoice: open until it is');
  assert.equal(creditNoteStatus({ ...cn, status: 'draft', comments: [] } as unknown as Invoice, [inv]), 'draft');
  assert.equal(creditNoteStatus({ ...cn, cancelled: { date: '2026-10-05', reason: 'x' } }, [inv, cn]), 'cancelled');
});

test('open items on a reference date: what openOn leaves, the age from the invoice date in its band, the days past due, subtotals per contact and currency', () => {
  const a = issued('a', '2026-001', { date: '2026-09-01', dueDate: '2026-10-01' });
  const b = issued('b', '2026-002', { date: '2026-11-15', dueDate: '2026-12-15', payments: [{ transactionRef: 'T', date: '2026-12-20', amount: 400, by: 'reference' }] });
  const c = issued('c', '2026-003', { date: '2026-06-01', dueDate: '2026-07-01', customerId: 'c2', customer: { ...a.customer, name: 'Alpha GmbH' }, currency: 'EUR' });
  const paid = issued('d', '2026-004', { payments: [{ transactionRef: 'T4', date: '2026-10-02', amount: 1000, by: 'reference' }] });
  const items = openItems([a, b, c, paid], '2026-12-31');
  assert.deepEqual(items.map((x) => [x.inv.number, x.open, x.age, x.band, x.overdue]), [
    ['2026-003', 1000, 213, '90+', 183],
    ['2026-001', 1000, 121, '90+', 91],
    ['2026-002', 600, 46, '31-60', 16],
  ]);
  assert.deepEqual(openItems([a, b], '2026-12-10').map((x) => [x.inv.number, x.open, x.overdue]), [['2026-001', 1000, 70], ['2026-002', 1000, 0]], 'before the payment, before its due date');
  const { groups, totals } = openItemGroups(items);
  assert.deepEqual(groups.map((g) => [g.name, g.currency, g.total]), [['Alpha GmbH', 'EUR', 1000], ['Kunde AG', 'CHF', 1600]]);
  assert.deepEqual(totals, [
    { currency: 'CHF', total: 1600, count: 2, bands: { '0-30': 0, '31-60': 600, '61-90': 0, '90+': 1000 } },
    { currency: 'EUR', total: 1000, count: 1, bands: { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 1000 } },
  ]);
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91].map(ageBand), ['0-30', '0-30', '31-60', '31-60', '61-90', '61-90', '90+']);
  assert.equal(AGE_BANDS.length, 4);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2, 'across the switch to summer time');
});

test('CSV as the app exports it: BOM, semicolons, CRLF, two decimals, a field with a semicolon quoted', () => {
  assert.equal(csvOf(['Nr.', 'Kontakt', 'Offen'], [['2026-001', 'Muster; Söhne "AG"', 1234.5]]), '﻿Nr.;Kontakt;Offen\r\n2026-001;"Muster; Söhne ""AG""";1234.50\r\n');
});
