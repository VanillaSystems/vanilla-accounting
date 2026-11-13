/**
 * #497 (consulting-ai-r6-15): since #466 the setup asks no UID, and the firm's own unpaid invoice was listed again as
 * «Beleg ohne Zahlung» on the open list and the AI's card: only an invoice showing the settings' UID waited for its
 * customer. One recognised by the firm's name heading it, the vendor read on it naming the firm or no business (the
 * model's «Verkauf»), is shown as its own too: display, not a link. An invoice the app issued is never a receipt without
 * a payment. A supplier's invoice addressed to the firm stays one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import type { Index, Receipt } from '../src/types/index.js';
import { countIssues, periodIssues, waitsForCustomer } from '../src/app/areas/automation/period-issues.js';

const doc = (id: string, text: string, extra: Partial<Receipt> = {}): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: text, extractionMethod: 'pdftotext', fileSize: 4000, indexedAt: '2026-11-13T08:00:00Z', location: 'archived', currency: 'CHF', date: '2026-09-01', amount: 7783.2, ...extra } as Receipt);
/** The firm without a UID in its settings, as the setup leaves it since #466. */
const firm = { name: 'Kälin Advisory GmbH' };
/** The persona's invoice as read in round 8: its UID in the letterhead, the model's vendor «Verkauf». */
const verkauf = doc('verkauf', 'Kälin Advisory GmbH\nBaarerstrasse 41, 6300 Zug\nMWST-Nr. CHE-123.456.789 MWST\n\nBrändli Logistik AG\nIndustriestrasse 12\n6343 Rotkreuz\nRechnung RE-2026-036\nDatum: 01.09.2026\nTotal CHF\n7783.20', { vatId: 'CHE-123.456.789', title: { vendor: 'Verkauf', what: 'Beratungsmandat' } });
/** The same firm's invoice read with its own name as the vendor, no UID on it. */
const named = doc('named', 'Kälin Advisory GmbH, Baarerstrasse 41, 6300 Zug\nRechnung RE-2026-037\nBrändli Logistik AG\nTotal CHF 1200.00', { amount: 1200, title: { vendor: 'Kälin Advisory', what: 'Beratung' } });
/** A supplier's invoice that names the firm as its addressee on the first line (its logo an image), with its own UID. */
const supplierUid = doc('supplier-uid', 'Kälin Advisory GmbH\nRechnung 4471\nAlpentel AG CHE-111.222.333 MWST\nTotal CHF 84.35', { amount: 84.35, title: { vendor: 'Alpentel', what: 'Telefon' } });
/** The same without a UID shown: its read vendor tells it is not the firm's. */
const supplierRead = doc('supplier-read', 'Kälin Advisory GmbH\nRechnung 5512\nWerkplatz Zug\nTotal CHF 320.00', { amount: 320, title: { vendor: 'Werkplatz Zug', what: 'Arbeitsplatz' } });
/** Unread by the model: the name alone is no proof. */
const unread = doc('unread', 'Kälin Advisory GmbH\nRechnung 5513 der Haarpflege AG\nTotal CHF 120.00', { amount: 120 });
const books = { config: { closedThrough: '2026-06-30' }, transactions: [], journalEntries: [], receipts: [verkauf, named, supplierUid, supplierRead, unread], mappings: [], bankStatements: [] } as unknown as Index;

test('#497 without a UID in the settings, the firm\'s own invoice recognised by its name waits for the customer', () => {
  assert.equal(waitsForCustomer(books, verkauf, firm), true, 'the model read it as the firm\'s own sale');
  assert.equal(waitsForCustomer(books, named, firm), true, 'the model read the firm\'s name');
  assert.equal(waitsForCustomer(books, verkauf, { ...firm, uid: 'CHE-123.456.789' }), true, 'with the UID in the settings, as before');
});

test('#497 a supplier\'s invoice addressed to the firm stays a receipt without a payment', () => {
  assert.equal(waitsForCustomer(books, supplierUid, firm), false, 'another UID shown');
  assert.equal(waitsForCustomer(books, supplierRead, firm), false, 'another vendor read');
  assert.equal(waitsForCustomer(books, unread, firm), false, 'the name alone');
  assert.equal(waitsForCustomer(books, supplierUid, { ...firm, uid: 'CHE-123.456.789' }), false, 'with the firm\'s UID in the settings too');
});

test('#497 the open list keeps the firm\'s own invoices apart, not counted; the suppliers\' are points', () => {
  const issues = periodIssues(books, [], '2026-07-01', '2026-09-30', [], new Map(), '2026-11-13', new Map(), undefined, undefined, firm);
  const ids = (kind: string) => issues.filter((i) => i.kind === kind).map((i) => (i as { receipt: Receipt }).receipt.id).sort();
  assert.deepEqual(ids('issued'), ['named', 'verkauf']);
  assert.deepEqual(ids('unlinked'), ['supplier-read', 'supplier-uid', 'unread']);
  assert.equal(countIssues(issues).total, 3);
});

test('#497 money in that may be its payment still leaves the own invoice to be paired', () => {
  const paid = { ...books, transactions: [{ ref: 'IN', bank: 'ZKB', date: '2026-09-20', amount: 7783.2, currency: 'CHF', direction: 'CRDT', description: 'Brändli Logistik AG RE-2026-036' }] } as unknown as Index;
  assert.equal(waitsForCustomer(paid, verkauf, firm), false);
});
