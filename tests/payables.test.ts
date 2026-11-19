/**
 * Zu bezahlen (#571): the due date a bill's text states (src/books/due-date.ts), a person's due date
 * over it, and each bill's state as a fact of the books (src/app/areas/receipts/payables.ts): open,
 * overdue, paid by a linked payment; the sums, the filter and the CSV rows.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import { documents } from '../src/engines/index.js';
import { dueDateIn, dueOf } from '../src/books/due-date.js';
import { ledgerOf } from '../src/app/areas/receipts/model.js';
import { billCounts, billOf, billsOf, billsTable, passes, unpaidSums } from '../src/app/areas/receipts/payables.js';
import { csvOf } from '../src/export/csv.js';

const W = documents();

test('the due date a bill states: a date after a due word, a column head above its value, terms in days from its date, the net term over a Skonto', () => {
  assert.equal(dueDateIn('Rechnung 1234\nZahlbar bis 30.11.2026\nTotal CHF 120.00', '2026-10-31', W), '2026-11-30');
  assert.equal(dueDateIn('Invoice 77\nDue date: 2026-12-15', '2026-11-15', W), '2026-12-15');
  assert.equal(dueDateIn("Date d'échéance 05.01.27", '2026-12-01', W), '2027-01-05', 'a two-digit year');
  assert.equal(dueDateIn('Rechnungsdatum      Fälligkeit\n15.10.2026          14.11.2026', '2026-10-15', W), '2026-11-14', 'the value under its own column, not the invoice date beside it');
  assert.equal(dueDateIn('Zahlbar innert 30 Tagen netto.', '2026-10-15', W), '2026-11-14');
  assert.equal(dueDateIn('Zahlungsbedingungen: 10 Tage 2 % Skonto, 30 Tage netto', '2026-10-01', W), '2026-10-31', 'the net term, not the Skonto\'s');
  assert.equal(dueDateIn('Conditions: 30 jours net', '2026-10-01', W), '2026-10-31', 'a net term without a due word');
  assert.equal(dueDateIn('Pagabile entro 20 giorni', '2026-10-01', W), '2026-10-21');
  assert.equal(dueDateIn('Zahlbar innert 30 Tagen', undefined, W), undefined, 'terms in days need the bill\'s date');
  assert.equal(dueDateIn('Fällig am 01.09.2026', '2026-10-01', W), undefined, 'a day before the bill\'s own is none of it');
  assert.equal(dueDateIn('Kassenbon Coop\nTotal 12.50\n12.10.2026', '2026-10-12', W), undefined, 'a till receipt states none');
  assert.equal(dueDateIn('Zahlbar bis 31.02.2026', undefined, W), undefined, 'no such day');
});

test('a person\'s due date wins over the text\'s; without hers, the text\'s', () => {
  assert.deepEqual(dueOf({ extractedText: 'zahlbar bis 30.11.2026', date: '2026-10-31' }, W), { day: '2026-11-30', by: 'read' });
  assert.deepEqual(dueOf({ dueDate: '2026-12-20', extractedText: 'zahlbar bis 30.11.2026', date: '2026-10-31' }, W), { day: '2026-12-20', by: 'hand' });
  assert.equal(dueOf({ extractedText: '', date: '2026-10-31' }, W), undefined);
});

const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-10-30T08:00:00Z', location: 'archived', currency: 'CHF', ...x,
});
const tx = (ref: string, date: string, amount: number): BankTransaction => ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: 'DBIT', description: ref });
const TODAY = '2026-11-19';

const books: Index = {
  config: { closedThrough: '2026-09-30' },
  receipts: [
    receipt('late', { date: '2026-10-01', amount: 300, description: 'Druckerei AG, Flyer', extractedText: 'Rechnung\nzahlbar bis 31.10.2026' }),
    receipt('soon', { date: '2026-11-10', amount: 120, extractedText: 'Rechnung\nzahlbar innert 30 Tagen' }),
    receipt('eur', { date: '2026-11-12', amount: 80, currency: 'EUR', extractedText: 'Invoice\nPayment due 2026-11-30' }),
    receipt('paid', { date: '2026-10-05', amount: 50, extractedText: 'Rechnung\nFällig am 04.11.2026' }),
    receipt('hand', { date: '2026-11-01', amount: 40, dueDate: '2026-11-15' }),
    receipt('till', { date: '2026-11-02', amount: 12.5, extractedText: 'Kassenbon\nTotal 12.50' }),
    receipt('credit', { date: '2026-11-03', amount: -20, extractedText: 'Gutschrift\nzahlbar bis 30.11.2026' }),
    receipt('accrual', { date: '2026-10-20', amount: 90, extractedText: 'Rechnung\nzahlbar bis 01.11.2026' }),
  ],
  transactions: [tx('T-paid', '2026-11-03', 50)],
  mappings: [{ receiptId: 'paid', transactionRef: 'T-paid' }, { receiptId: 'accrual', transactionRef: 'ABGR-1' }],
  bankStatements: [],
  journalEntries: [{ id: 'e1', date: '2026-10-31', transactionRef: 'ABGR-1', amount: 90, debitAccount: '6500', creditAccount: '2300', description: 'Abgrenzung' } as never],
};
const l = ledgerOf(books, '2026-10-01');
const Q4 = { from: '2026-10-01', to: '2026-12-31' };

test('each bill\'s state is a fact: overdue once its day has passed unpaid, open until then (its day included), paid by a linked payment on that payment\'s day; a booking without a payment pays nothing', () => {
  const by = Object.fromEntries(billsOf(l, Q4, TODAY, W).map((b) => [b.v.r.id, b]));
  assert.deepEqual(Object.keys(by).sort(), ['accrual', 'eur', 'hand', 'late', 'paid', 'soon'], 'no till receipt, no credit note');
  assert.equal(by.late.state, 'overdue');
  assert.equal(by.soon.state, 'open');
  assert.equal(by.soon.due, '2026-12-10', '30 days from its date');
  assert.equal(by.eur.state, 'open');
  assert.deepEqual([by.paid.state, by.paid.paidOn], ['paid', '2026-11-03']);
  assert.deepEqual([by.hand.state, by.hand.dueBy], ['overdue', 'hand']);
  assert.equal(by.accrual.state, 'overdue', 'hung on an accrual, not paid');
  assert.equal(billOf(l.byId.get('soon')!, l, '2026-12-10', W)?.state, 'open', 'due today is not overdue');
  assert.equal(billOf(l.byId.get('soon')!, l, '2026-12-11', W)?.state, 'overdue');
});

test('overdue first by due day, then open, then paid; «offen» holds the overdue ones; sums per currency, the books\' first', () => {
  const bills = billsOf(l, Q4, TODAY, W);
  assert.deepEqual(bills.map((b) => b.v.r.id), ['late', 'accrual', 'hand', 'eur', 'soon', 'paid']);
  assert.deepEqual(billCounts(bills), { all: 6, overdue: 3, open: 5, paid: 1 });
  assert.deepEqual(bills.filter((b) => passes(b, 'open')).map((b) => b.v.r.id), ['late', 'accrual', 'hand', 'eur', 'soon']);
  assert.deepEqual(unpaidSums(bills, 'CHF'), [{ currency: 'CHF', open: 550, overdue: 430 }, { currency: 'EUR', open: 80, overdue: 0 }]);
});

test('the CSV holds what the list shows: dates as written, the state in words, the amount as a number', () => {
  const bills = billsOf(l, Q4, TODAY, W).filter((b) => b.v.r.id === 'late' || b.v.r.id === 'paid');
  const words = { head: ['Datum', 'Lieferant', 'Was', 'Fällig', 'Status', 'Bezahlt am', 'Währung', 'Betrag', 'Datei'] as [string, string, string, string, string, string, string, string, string], state: { overdue: 'Überfällig', open: 'Offen', paid: 'Bezahlt' } };
  const csv = csvOf(billsTable(bills, words, 'CHF'));
  assert.equal(csv, '﻿Datum;Lieferant;Was;Fällig;Status;Bezahlt am;Währung;Betrag;Datei\r\n'
    + '01.10.2026;Druckerei AG;Flyer;31.10.2026;Überfällig;;CHF;300.00;late.pdf\r\n'
    + '05.10.2026;paid;;04.11.2026;Bezahlt;03.11.2026;CHF;50.00;paid.pdf\r\n');
});
