/**
 * The payments the matching model is shown for a receipt (src/intake/match.ts candidates): the
 * open ones that fit best, by invoice number, amount, vendor and date, never merely the books'
 * first rows. Usability finding misreads-4: a receipt without a date in its file name saw only the
 * 20 oldest payments, so the October payment naming «FM-79010» was never shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { candidates } from '../src/intake/match.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';

const tx = (ref: string, date: string, amount: number, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', description });
const receipt = (filename: string, extractedText: string, more: Partial<Receipt> = {}): Receipt =>
  ({ id: filename, filename, originalFilename: filename, extractedText, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-15T10:00:00Z', location: 'staged', ...more });

/** 30 payments of July to September, then the four of October. */
const OLD = Array.from({ length: 30 }, (_, i) => tx(`OLD-${i}`, `2026-0${7 + Math.floor(i / 10)}-${String(1 + (i % 10) * 2).padStart(2, '0')}`, 40 + i * 13, `Lieferant ${i}`));
const OCT = [
  tx('RB-1001', '2026-10-02', 386.6, 'Malerbedarf GmbH RE-4471'),
  tx('RB-1002', '2026-10-05', 187.35, 'Baucenter Gossau'),
  tx('RB-1003', '2026-10-08', 1506.45, 'Farbmix AG FM-79010 abzgl. Skonto'),
  tx('RB-1004', '2026-10-12', -3200, 'Bauer Konstanz Rechnung 2026-031'),
];
const BOOKS = [...OLD, ...OCT];
const refs = (txs: BankTransaction[]) => txs.map((t) => t.ref);

test('the invoice number in the payment text puts it first, though the file name has no date and the payment is the newest', () => {
  const farbmix = receipt('Farbmix_FM-79010.pdf', 'Farbmix AG\nRechnung Nr. FM-79010\nRechnungsdatum 28.09.2026\nTotal CHF 1\'537.22\n2 % Skonto innert 10 Tagen');
  const shown = candidates(farbmix, BOOKS);
  assert.equal(shown[0].ref, 'RB-1003');
  assert.ok(shown.length <= 20, 'the prompt stays bounded');
  assert.equal(candidates(receipt('Rechnung.pdf', 'Rechnung 2026-031\nLeistungsort Konstanz, Deutschland\nTotal CHF 3\'200.00'), BOOKS)[0].ref, 'RB-1004', 'a sale by its number too');
});

test('without a number, the amount (also the VAT block total) and the vendor rank', () => {
  const photo = receipt('IMG_4733.jpg', 'Baucenter Gossau\nTotal 187.35\nMWST 8.1% 14.04', { amount: 187.35, currency: 'CHF' });
  assert.equal(candidates(photo, BOOKS)[0].ref, 'RB-1002');
  const fromVat = receipt('scan.pdf', 'unleserlich', { vatSummary: [{ ratePercent: 8.1, vat: 14.04, gross: 187.35 }] });
  assert.equal(candidates(fromVat, BOOKS)[0].ref, 'RB-1002', 'the total of the VAT block counts as the amount');
  const euro = receipt('Malerbedarf.pdf', 'Malerbedarf GmbH\nRE-4471\nGesamtbetrag EUR 412.30 inkl. 19 % MwSt.');
  assert.equal(candidates(euro, BOOKS)[0].ref, 'RB-1001');
});

test('only payments without a receipt: one with a receipt already, one of a filed quarter that nothing fits and a fee are left out; with nothing known the newest come first', () => {
  const blank = receipt('scan.pdf', '');
  const linked = new Set(['RB-1004']);
  const shown = candidates(blank, [...BOOKS, { ...tx('FEE', '2026-10-13', 1.5, 'Gebühr'), type: 'wise-fee' }], linked, (d) => d <= '2026-06-30');
  assert.deepEqual(refs(shown).slice(0, 3), ['RB-1003', 'RB-1002', 'RB-1001']);
  assert.equal(shown.length, 20);
  assert.ok(!refs(shown).includes('RB-1004') && !refs(shown).includes('FEE'));
  assert.deepEqual(refs(candidates(blank, [tx('Q2', '2026-06-30', 10, 'x')], linked, (d) => d <= '2026-06-30')), []);
});

test('a late receipt sees the filed payment it fits, marked filed, after an open one of the same fit (corner-33)', () => {
  const late = receipt('Geruest_August.pdf', 'Gerüstbau Thurtal GmbH\nRechnung G-2208\nMiete Gerüst August\nTotal CHF 1\'120.00', { date: '2026-08-14' });
  const filed = tx('RB-0812', '2026-08-14', 1120, 'Gerüstbau Thurtal GmbH');
  const shown = candidates(late, [...BOOKS, filed], new Set(), (d) => d <= '2026-09-30');
  assert.equal(shown[0].ref, 'RB-0812');
  assert.equal(shown[0].filed, true, 'the model is told it is filed');
  const twin = tx('RB-1020', '2026-10-14', 1120, 'Gerüstbau Thurtal GmbH');
  const both = candidates({ ...late, date: '2026-09-14' }, [filed, twin], new Set(), (d) => d <= '2026-09-30');
  assert.deepEqual(refs(both), ['RB-1020', 'RB-0812'], 'the open one first at the same fit');
  assert.equal(both[0].filed, undefined);
});

test('a grouped vendor\'s payment stays a candidate with receipts on it, its amount aside', () => {
  const books = [...BOOKS, tx('AMZ-1', '2026-10-03', 312.4, 'AMAZON MKTPLACE'), tx('AMZ-2', '2026-08-03', 80, 'AMAZON MKTPLACE')];
  const item = receipt('amazon.pdf', 'Amazon.de Rechnung\nBestelldatum 02.10.2026\nGesamt EUR 41.90', { date: '2026-10-02' });
  assert.deepEqual(refs(candidates(item, books, new Set(['AMZ-1']))), ['AMZ-1', 'AMZ-2']);
});
