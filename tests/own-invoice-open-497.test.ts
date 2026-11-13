/**
 * #497 (consulting-ai-r6-15): since #466 the setup asks no UID, and the firm's own unpaid invoice was listed again as
 * «Beleg ohne Zahlung» on the open list and the AI's card: only an invoice showing the settings' UID waited for its
 * customer. One recognised by the firm's name heading it, with its own number and the vendor read on it the firm or
 * its own sale (the model's «Verkauf»), is shown as its own too: display, not a link. An invoice the app issued is never a receipt without
 * a payment. A supplier's invoice addressed to the firm stays one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import type { Index, Receipt } from '../src/types/index.js';
import { countIssues, periodIssues, waitsForCustomer } from '../src/app/areas/automation/period-issues.js';
import { nothingOpen, openPeriodState } from '../src/app/areas/automation/open-period.js';

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

/**
 * Review of #501: a supplier's document headed by the firm's name (its addressee, the logo an image), no UID in the
 * settings, is never hidden as the firm's own, whatever word the model took for its vendor: a word that only names
 * a document, a longer name that begins with the firm's, a credit note, a document without an invoice number.
 */
const probes: Receipt[] = [
  doc('p-rechnung', 'Kälin Advisory GmbH\nBahnweg 3, 6300 Zug\nRechnung 7781\nTotal CHF 410.00', { amount: 410, title: { vendor: 'Rechnung', what: 'Material' } }),
  doc('p-quittung', 'Kälin Advisory GmbH\nQuittung 2231\nTotal CHF 38.00', { amount: 38, title: { vendor: 'Quittung', what: 'Einkauf' } }),
  doc('p-beleg', 'Kälin Advisory GmbH\nRechnung 99120\nTotal CHF 64.00', { amount: 64, title: { vendor: 'Beleg', what: 'Service' } }),
  doc('p-uid3', 'Kälin Advisory GmbH\nIndustriestrasse 9, 6300 Zug\nCHE-111.222.333 MWST\nRechnung 55120\nTotal CHF 980.00', { amount: 980, vatId: 'CHE-111.222.333', title: { vendor: 'Rechnung', what: 'Wartung' } }),
  doc('p-credit', 'Kälin Advisory GmbH\nGutschrift 4410\nTotal CHF -120.00', { amount: -120, title: { vendor: 'Verkauf', what: 'Gutschrift' } }),
  doc('p-nonumber', 'Kälin Advisory GmbH\nVielen Dank für Ihren Einkauf\nTotal CHF 75.00', { amount: 75, title: { vendor: 'Verkauf', what: 'Einkauf' } }),
];
const meier = { name: 'Meier' };
const tobler = doc('p-tobler', 'Meier\nRechnung 30021\nTotal CHF 1450.00', { amount: 1450, title: { vendor: 'Meier Tobler', what: 'Heizung' } });

test('#501 review: a supplier\'s document headed by the firm\'s name stays a receipt without a payment', () => {
  const probed = { ...books, receipts: probes } as Index;
  for (const r of probes) assert.equal(waitsForCustomer(probed, r, firm), false, r.id);
  assert.equal(waitsForCustomer({ ...books, receipts: [tobler] } as Index, tobler, meier), false, '«Meier» is not «Meier Tobler»');
  assert.equal(waitsForCustomer(books, { ...tobler, title: { vendor: 'Meier', what: 'Heizung' } }, meier), true, 'the firm\'s name whole is its own');
});

test('#501 review: a supplier\'s document is counted, so the return stays «noch nicht endgültig» and the card never says «nichts offen»', () => {
  for (const r of [...probes, tobler]) {
    const f = r === tobler ? meier : firm;
    const one = { ...books, receipts: [r] } as Index;
    const issues = periodIssues(one, [], '2026-07-01', '2026-09-30', [], new Map(), '2026-11-13', new Map(), undefined, undefined, f);
    assert.equal(countIssues(issues).total, 1, `${r.id}: counted (isPending reads this total)`);
    const s = openPeriodState(one, [], [], [], { today: '2026-11-13', vatRegistered: true, length: 'quarter', dueDays: 60, firm: f });
    assert.equal(nothingOpen(s), false, `${r.id}: never «nichts offen»`);
  }
});
