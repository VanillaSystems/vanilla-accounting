/**
 * Pairing by what is written (#365): a receipt whose document number stands as a whole token in
 * exactly one payment's text, with its amount and a day not before the document's, is paired by
 * code, without a model: money out for a supplier's invoice as before, and money in for an invoice,
 * the firm's own, though nothing but its number and amount says it is a sale. Anything less sure is
 * proposed, never paired; money out never pays a credit note (tests/credit-note.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { searchPairs, stagesOf } from '../src/intake/pairing.js';
import { runPairChain } from '../src/intake/pair-chain.js';
import { tokensIn } from '../src/accounting/document-numbers.js';
import { candidates, ledgerOf, suggestion } from '../src/app/areas/receipts/model.js';
import type { Books } from '../src/books/store.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { vatCodeOf } from '../src/accounting/vat-codes.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';

const toChf = (a: number) => a;
const OWN = 'Malerei Huber GmbH\nIndustriestrasse 14, 9500 Wil SG\nMWST-Nr. CHE-345.678.915 MWST\nImmo Verwaltung Säntis AG\nBahnhofstrasse 2\n9000 St. Gallen\nRechnung 2026-029\nDatum: 10.07.2026\nMalerarbeiten Treppenhaus MFH Bronschhofen, 4 Geschosse 11517.10\nMWST 8.1% 932.90\nTotal CHF 12450.00\nZahlbar innert 30 Tagen. IBAN CH93 0076 2011 6238 5295 7';
// The persona's own invoice, read without an AI: its date, amount, rate and the firm's own UID.
const treppenhaus = (over: Partial<Receipt> = {}): Receipt => ({
  id: 'treppenhaus', filename: 'Rechnung_2026-029_Treppenhaus.pdf', originalFilename: 'Rechnung_2026-029_Treppenhaus.pdf', extractedText: OWN, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
  date: '2026-07-10', amount: 12450, currency: 'CHF', vatId: 'CHE-345.678.915', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 11517.1, vat: 932.9, gross: 12450 }], ...over,
});
const pay = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  ref, bank: 'Raiffeisen', date: '2026-08-04', amount: 12450, currency: 'CHF', direction: 'CRDT', counterparty: 'Immo Verwaltung Säntis AG', description: 'Rechnung 2026-029 Treppenhaus MFH Bronschhofen', ...over,
});
// The statement's other rows of the persona's quarter: wages, a customer's payment of another invoice, the bank's fee.
const quarter = [
  pay('lohn', { direction: 'DBIT', amount: 5200, counterparty: 'Marco Rossi', description: 'Lohn Juli 2026', date: '2026-07-25' }),
  pay('re028', { amount: 4860, counterparty: 'Familie Keller', description: 'Rechnung 2026-028 Malerarbeiten Wohnzimmer', date: '2026-07-02' }),
  pay('fee', { direction: 'DBIT', amount: 12, counterparty: 'Raiffeisen', description: 'Kontoführung Q3', date: '2026-09-30' }),
];
const books = (receipts: Receipt[], transactions: BankTransaction[], over: Partial<Books> = {}): Books =>
  ({ receipts, transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' }, ...over }) as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const stages = (b: Books) => stagesOf(searchPairs(b, toChf, (d) => d <= '2026-06-30'));

test('the persona\'s own invoice 2026-029 and the money in that names it are paired by code, without a model', async () => {
  const b = books([treppenhaus()], [pay('p'), ...quarter]);
  assert.deepEqual(stages(b).map((s) => s.kind === 'clear' && s.pair.payment), ['p']);
  const run = await runPairChain(port(b), { toChf });
  assert.deepEqual(run.linked.map((l) => [l.receipt, l.payment, l.by]), [['treppenhaus', 'p', 'code']]);
  assert.deepEqual(b.mappings.map((m) => [m.transactionRef, m.receiptId, m.by]), [['p', 'treppenhaus', 'rule']]);
  assert.match(b.mappings[0].rule!, /number/, 'the link says the number matched');
});

test('money out that names a supplier invoice\'s number is paired the same way, as before', async () => {
  const supplier = treppenhaus({ id: 'farbmix', extractedText: 'Farbmix AG\nRechnung FM-78230\nTotal CHF 2410.85', amount: 2410.85, vatId: 'CHE-999.888.777', title: { vendor: 'Farbmix AG', what: 'Farbe' } });
  const b = books([supplier], [pay('p', { direction: 'DBIT', amount: 2410.85, counterparty: 'Farbmix AG', description: 'Rechnung FM-78230', date: '2026-07-30' })]);
  assert.deepEqual((await runPairChain(port(b), { toChf })).linked.map((l) => l.payment), ['p']);
});

test('ambiguous: two payments naming the number with its amount are proposed, never paired', async () => {
  const b = books([treppenhaus()], [pay('p'), pay('q', { date: '2026-08-05' })]);
  const run = await runPairChain(port(b), { toChf });
  assert.deepEqual(run.linked, []);
  assert.deepEqual(run.left.map((l) => l.candidates.map((c) => c.payment).sort()), [['p', 'q']]);
});

test('ambiguous: a part of the amount is never paired', async () => {
  const b = books([treppenhaus()], [pay('p', { amount: 6000 })]);
  assert.deepEqual((await runPairChain(port(b), { toChf })).linked, []);
  assert.deepEqual(b.mappings, []);
});

test('ambiguous: a number other payments name too (digits only) is proposed, never paired', async () => {
  const digits = treppenhaus({ extractedText: OWN.replace('Rechnung 2026-029', 'Rechnung 202629') });
  const b = books([digits], [pay('p', { description: 'Zahlung 202629 Treppenhaus' }), pay('q', { amount: 380, description: 'Kunde 202629 Anzahlung' })]);
  const run = await runPairChain(port(b), { toChf });
  assert.deepEqual(run.linked, []);
  assert.deepEqual(run.left.map((l) => l.candidates.map((c) => c.payment)), [['p']]);
});

test('the number only inside a longer token, or a payment before the invoice\'s day, is no pair', async () => {
  for (const p of [pay('p', { description: 'Rechnung 2026-0291 Treppenhaus' }), pay('p', { date: '2026-07-08' })]) {
    const b = books([treppenhaus()], [p]);
    assert.deepEqual((await runPairChain(port(b), { toChf })).linked, [], JSON.stringify(p));
    assert.deepEqual(b.mappings, []);
  }
});

test('the year alone is no number: a payment naming «2026» with the amount but not the invoice\'s number is no pair', async () => {
  const b = books([treppenhaus()], [pay('p', { description: 'Zahlung Juli 2026 Immo Verwaltung' })]);
  assert.deepEqual((await runPairChain(port(b), { toChf })).linked, []);
});

test('whole tokens: «2026-029» stands in «Rechnung 2026-029 Treppenhaus», not in «2026-0291»', () => {
  assert.ok(tokensIn('Rechnung 2026-029 Treppenhaus').has('2026029'));
  assert.ok(!tokensIn('Rechnung 2026-0291').has('2026029'));
});

test('Belege offers the payment that names her invoice with one key («Zuordnen»), though the money came in', () => {
  const l = ledgerOf(books([treppenhaus()], [pay('p'), ...quarter]) as unknown as Index, '2026-07-01');
  const v = l.byId.get('treppenhaus')!;
  assert.deepEqual(candidates(v, l, toChf).best.map((c) => c.tx.ref), ['p']);
  assert.equal(suggestion(v, l, toChf)?.tx.ref, 'p');
  // Two payments naming it: both best, neither offered with one key.
  const two = ledgerOf(books([treppenhaus()], [pay('p'), pay('q', { date: '2026-08-05' })]) as unknown as Index, '2026-07-01');
  const w = two.byId.get('treppenhaus')!;
  assert.deepEqual(candidates(w, two, toChf).best.map((c) => c.tx.ref).sort(), ['p', 'q']);
  assert.equal(suggestion(w, two, toChf), undefined);
});

test('paired, without an AI, the payment opens «Von Hand buchen» as a sale at her invoice\'s rate: the firm\'s revenue account, V81', async () => {
  const b = books([treppenhaus()], [pay('p'), ...quarter]);
  await runPairChain(port(b), { toChf });
  const bank = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
  const d = bookingDraft(b, 'p', bank, undefined, { defaults: { sales: '3400' }, chart: ['1020', '1100', '3400'], ownUid: 'CHE-345.678.915' })!;
  assert.deepEqual(d.receipts, ['treppenhaus']);
  assert.deepEqual(d.lines.map((l) => [l.accountDebit, l.accountCredit, l.amount, vatCodeOf(l.vat, l.accountDebit, l.accountCredit)?.code]), [['1020', '3400', 12450, 'V81']]);
  assert.ok(d.notes.some((n) => n.kind === 'sale'));
});
