/**
 * r5h-32: the Swisscom October invoice and a forwarded copy of it came in together; each held the
 * other back as its possible copy, so the payment the link dialog ranks first was never linked and
 * stayed booked without input tax. Of such a pair the first is linked, the other waits in Belege.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, waitsBehind } from '../src/intake/match.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';

const INVOICE = 'Swisscom (Schweiz) AG\n3050 Bern\nMWST-Nr. CHE-123.456.789 MWST\n\nMalerei Huber GmbH\nIndustriestrasse 14\n9500 Wil SG\nRechnung 7712399871\nDatum: 10.10.2026\n\nArtikel\ninOne mobile business, Oktober\nTotal exkl. MWST\nMWST 8.1%\nTotal CHF\nZahlbar innert 30 Tagen.\n\nBetrag CHF\n82.33\n82.33\n6.65\n88.98';
const FORWARD = `Von: Thomas Huber <thomas@malerei-huber.example>\nGesendet: Freitag, 16. Oktober 2026 07:12\nAn: Sandra Huber\nBetreff: WG: Ihre Swisscom Rechnung Oktober\nKannst du die ablegen? Gruss Thomas\n---------- Weitergeleitete Nachricht ----------\nVon: Swisscom <rechnung@swisscom.example>\n\n${INVOICE}`;
const rc = (id: string, text: string, location: Receipt['location']): Receipt => ({ id, filename: `${id}.pdf`, location, extractedText: text, date: '2026-10-10', amount: 88.98, currency: 'CHF', indexedAt: '2026-10-16T07:00:00Z' } as Receipt);
const PAY: BankTransaction = { ref: 'RB-2026-3002', bank: 'Raiffeisen', date: '2026-10-22', amount: 89, currency: 'CHF', direction: 'DBIT', description: 'Rechnung Oktober Natel' } as BankTransaction;

test('of an invoice and its forwarded copy staged together, the first is linked and only the second waits', () => {
  const orig = rc('orig', INVOICE, 'staged'), copy = rc('copy', FORWARD, 'staged');
  const index = { receipts: [orig, copy], mappings: [] };
  const order = ['orig', 'copy'];
  assert.equal(waitsBehind(index, orig, order), undefined, 'the first is linked');
  assert.equal(waitsBehind(index, copy, order), 'orig', 'the copy waits behind it');
});

test('a copy in the books with no link holds nothing back; a linked one holds the newcomer', () => {
  const orig = rc('orig', INVOICE, 'staged'), copy = rc('copy', FORWARD, 'archived');
  assert.equal(waitsBehind({ receipts: [orig, copy], mappings: [] }, orig, ['orig']), undefined);
  assert.equal(waitsBehind({ receipts: [orig, copy], mappings: [{ receiptId: 'copy', transactionRef: 'X' }] }, orig, ['orig']), 'copy');
});

test('the model is shown the 89.00 payment first for the 88.98 invoice', () => {
  const other = { ...PAY, ref: 'RB-9', date: '2026-10-01', amount: 412.5, description: 'Farbmix AG' };
  assert.equal(candidates(rc('orig', INVOICE, 'staged'), [other, PAY])[0].ref, 'RB-2026-3002');
});

test('Aufgaben lists the possible duplicate that waits for an answer, not its linked original, and no longer once answered (r5h-34)', async () => {
  const { ledgerOf, openTwins } = await import('../src/app/areas/receipts/model.js');
  const orig = { ...rc('orig', INVOICE, 'archived'), indexedAt: '2026-10-16T07:00:00Z' };
  const copy = { ...rc('copy', FORWARD, 'archived'), indexedAt: '2026-10-16T07:01:00Z' };
  const books = { receipts: [orig, copy], transactions: [PAY], mappings: [{ receiptId: 'orig', transactionRef: PAY.ref }], journalEntries: [], bankStatements: [], config: {} };
  assert.deepEqual(openTwins(ledgerOf(books as never, '2026-10-01')).map((v) => v.r.id), ['copy']);
  const answered = { ...books, receipts: [orig, { ...copy, kind: 'duplicate' as const, kindBy: 'human' as const }] };
  assert.deepEqual(openTwins(ledgerOf(answered as never, '2026-10-01')).map((v) => v.r.id), []);
});
