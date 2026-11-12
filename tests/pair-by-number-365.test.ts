/**
 * Pairing by what is written (#365): the firm's own invoice (issued by the firm: its UID, or for a
 * firm without one its name heading the text) is paid by money in that names the invoice's own
 * number (the number an invoice word labels, «Rechnung 2026-029») as a whole token, with its amount,
 * on or after its day. Code links it only when nothing else could be the payment: no other payment
 * names that number, none names another number of its shape, and no payment of its amount goes the
 * way an invoice is paid. Anything less sure is proposed, never linked. A supplier's invoice is never
 * paired with money in (a refund that names it), and money out never pays a credit note
 * (tests/credit-note.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { searchPairs, stagesOf } from '../src/intake/pairing.js';
import { checkPrompt, runPairChain } from '../src/intake/pair-chain.js';
import { tokensIn } from '../src/accounting/document-numbers.js';
import { issuedByFirm, ownNumbers, type Firm } from '../src/intake/own-invoice.js';
import { candidates, ledgerOf, suggestion } from '../src/app/areas/receipts/model.js';
import type { Books } from '../src/books/store.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { vatCodeOf } from '../src/accounting/vat-codes.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';

const toChf = (a: number) => a;
const FIRM: Firm = { uid: 'CHE-123.456.789', name: 'Malerei Huber GmbH' };
const OWN = 'Malerei Huber GmbH\nIndustriestrasse 14, 9500 Wil SG\nMWST-Nr. CHE-123.456.789 MWST\nImmo Verwaltung Säntis AG\nBahnhofstrasse 2\n9000 St. Gallen\nKunden-Nr. 10042\nRechnung 2026-029\nDatum: 10.07.2026\nMalerarbeiten Treppenhaus MFH Bronschhofen, 4 Geschosse 11517.10\nMWST 8.1% 932.90\nTotal CHF 12450.00\nZahlbar innert 30 Tagen';
// The persona's own invoice, read without an AI: its date, amount, rate and the firm's own UID.
const treppenhaus = (over: Partial<Receipt> = {}): Receipt => ({
  id: 'treppenhaus', filename: 'Rechnung_2026-029_Treppenhaus.pdf', originalFilename: 'Rechnung_2026-029_Treppenhaus.pdf', extractedText: OWN, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
  date: '2026-07-10', amount: 12450, currency: 'CHF', vatId: 'CHE-123.456.789', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 11517.1, vat: 932.9, gross: 12450 }], ...over,
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
const stages = (b: Books) => stagesOf(searchPairs(b, toChf, (d) => d <= '2026-06-30', { firm: FIRM }));
const run = (b: Books, firm: Firm | null = FIRM) => runPairChain(port(b), { toChf, firm: firm ?? undefined });

test('the persona\'s own invoice 2026-029 and the money in that names it are paired by code, without a model', async () => {
  const b = books([treppenhaus()], [pay('p'), ...quarter]);
  assert.deepEqual(stages(b).map((s) => s.kind === 'clear' && s.pair.payment), ['p']);
  const r = await run(b);
  assert.deepEqual(r.linked.map((l) => [l.receipt, l.payment, l.by]), [['treppenhaus', 'p', 'code']]);
  assert.deepEqual(b.mappings.map((m) => [m.transactionRef, m.receiptId, m.by]), [['p', 'treppenhaus', 'rule']]);
  assert.match(b.mappings[0].rule!, /number/, 'the link says the number matched');
});

test('the firm\'s own invoice: its UID; a firm without one, its name heading the text and no other UID', () => {
  assert.equal(issuedByFirm(treppenhaus(), FIRM), true);
  assert.equal(issuedByFirm(treppenhaus({ vatId: 'CHE-999.888.777' }), FIRM), false, 'another UID: a supplier\'s');
  assert.equal(issuedByFirm(treppenhaus(), undefined), false, 'no firm known: no own invoice');
  const unregistered: Firm = { name: 'Malerei Huber GmbH' };
  assert.equal(issuedByFirm(treppenhaus({ vatId: undefined }), unregistered), true);
  assert.equal(issuedByFirm(treppenhaus({ vatId: undefined, extractedText: `Garage Meier AG\nAn: Malerei Huber GmbH\n${OWN}` }), unregistered), false, 'her name as the addressee is no issuer');
  assert.equal(issuedByFirm(treppenhaus(), unregistered), false, 'a UID on the text the firm has none of: someone else\'s');
});

test('without the firm known, money in is no candidate: the chain is as on 0.4.2', async () => {
  const b = books([treppenhaus()], [pay('p')]);
  assert.deepEqual((await run(b, null)).linked, []);
});

// The review's case: a supplier's invoice paid by card, and a refund that names it.
const garage = (over: Partial<Receipt> = {}): Receipt => treppenhaus({
  id: 'garage', filename: 'garage.pdf', extractedText: 'Garage Meier AG\nMWST-Nr. CHE-999.888.777 MWST\nAn: Malerei Huber GmbH\nRechnung RE-4471\nDatum: 10.07.2026\nService Lieferwagen\nMWST 8.1%\nTotal CHF 1850.00\nZahlbar innert 30 Tagen',
  vatId: 'CHE-999.888.777', amount: 1850, date: '2026-07-10', title: { vendor: 'Garage Meier', what: 'Service' }, vatSummary: [{ ratePercent: 8.1, net: 1711.38, vat: 138.62, gross: 1850 }], ...over,
});
const card = pay('card', { direction: 'DBIT', amount: 1850, date: '2026-07-12', counterparty: undefined, description: 'Kartenzahlung Garage Meier' });
const refund = pay('refund', { amount: 1850, date: '2026-07-30', counterparty: 'Garage Meier AG', description: 'Gutschrift Rechnung RE-4471 Garage Meier' });

test('a supplier\'s invoice pairs with its card payment, never with the refund that names it (both in one import)', async () => {
  const b = books([garage()], [card, refund]);
  assert.deepEqual((await run(b)).linked.map((l) => [l.receipt, l.payment]), [['garage', 'card']]);
});

test('a supplier\'s invoice with only the refund in the books: no link, as on 0.4.2', async () => {
  const b = books([garage()], [refund]);
  assert.deepEqual((await run(b)).linked, []);
  assert.deepEqual(b.mappings, []);
});

test('her own invoice: a payment of its amount going the way an invoice is paid holds the money in back: proposed, not linked', async () => {
  const b = books([treppenhaus()], [pay('p'), pay('out', { direction: 'DBIT', description: 'Zahlung Gerüstbau', counterparty: 'Gerüst AG', date: '2026-07-20' })]);
  const r = await run(b);
  assert.deepEqual(r.linked, []);
  assert.ok(r.left.some((l) => l.candidates.some((c) => c.payment === 'p')), 'the money in is proposed');
});

test('only her invoice\'s own number counts: a customer number, or another invoice of the same shape, is no pair', async () => {
  assert.deepEqual(ownNumbers(treppenhaus()), ['2026029']);
  const small = treppenhaus({ amount: 1850, vatSummary: [] });
  const b = books([small], [pay('p', { amount: 1850, description: 'Kd 10042 Rechnung 2026-030 Unterhalt August' })]);
  assert.deepEqual((await run(b)).linked, []);
  const both = books([treppenhaus()], [pay('p', { description: 'Rechnungen 2026-029 2026-030' })]);
  assert.deepEqual((await run(both)).linked, [], 'a payment that names another invoice of the shape too');
});

test('an offer, an order confirmation, a delivery note or a reminder is not paired by its number', async () => {
  for (const title of ['Offerte 2026-029', 'Auftragsbestätigung 2026-029', 'Lieferschein 2026-029', 'Mahnung Rechnung 2026-029']) {
    const doc = treppenhaus({ extractedText: OWN.replace('Rechnung 2026-029', title) });
    assert.deepEqual(ownNumbers(doc), [], title);
    const b = books([doc], [pay('p', { description: `Anzahlung ${title}` })]);
    assert.deepEqual((await run(b)).linked, [], title);
  }
});

test('ambiguous: two payments naming the number with its amount are proposed, never paired', async () => {
  const b = books([treppenhaus()], [pay('p'), pay('q', { date: '2026-08-05' })]);
  const r = await run(b);
  assert.deepEqual(r.linked, []);
  assert.deepEqual(r.left.map((l) => l.candidates.map((c) => c.payment).sort()), [['p', 'q']]);
});

test('ambiguous: a part of the amount is never paired', async () => {
  const b = books([treppenhaus()], [pay('p', { amount: 6000 })]);
  assert.deepEqual((await run(b)).linked, []);
  assert.deepEqual(b.mappings, []);
});

test('ambiguous: a number other payments name too (digits only) is proposed, never paired', async () => {
  const digits = treppenhaus({ extractedText: OWN.replace('Rechnung 2026-029', 'Rechnung 202629') });
  const b = books([digits], [pay('p', { description: 'Zahlung 202629 Treppenhaus' }), pay('q', { amount: 380, description: 'Kunde 202629 Anzahlung' })]);
  const r = await run(b);
  assert.deepEqual(r.linked, []);
  assert.deepEqual(r.left.map((l) => l.candidates.map((c) => c.payment)), [['p']]);
});

test('the number only inside a longer token, or a payment before the invoice\'s day, is no pair', async () => {
  for (const p of [pay('p', { description: 'Rechnung 2026-0291 Treppenhaus' }), pay('p', { date: '2026-07-08' })]) {
    const b = books([treppenhaus()], [p]);
    assert.deepEqual((await run(b)).linked, [], JSON.stringify(p));
    assert.deepEqual(b.mappings, []);
  }
});

test('the year alone is no number: a payment naming «2026» with the amount but not the invoice\'s number is no pair', async () => {
  const b = books([treppenhaus()], [pay('p', { description: 'Zahlung Juli 2026 Immo Verwaltung' })]);
  assert.deepEqual((await run(b)).linked, []);
});

test('whole tokens: «2026-029» stands in «Rechnung 2026-029 Treppenhaus», not in «2026-0291»', () => {
  assert.ok(tokensIn('Rechnung 2026-029 Treppenhaus').has('2026029'));
  assert.ok(!tokensIn('Rechnung 2026-0291').has('2026029'));
});

test('Belege offers the payment that names her invoice with one key («Zuordnen»), though the money came in', () => {
  const l = ledgerOf(books([treppenhaus()], [pay('p'), ...quarter]) as unknown as Index, '2026-07-01', undefined, undefined, undefined, FIRM);
  const v = l.byId.get('treppenhaus')!;
  assert.deepEqual(candidates(v, l, toChf).best.map((c) => c.tx.ref), ['p']);
  assert.equal(suggestion(v, l, toChf)?.tx.ref, 'p');
  // Two payments naming it: both best, neither offered with one key.
  const two = ledgerOf(books([treppenhaus()], [pay('p'), pay('q', { date: '2026-08-05' })]) as unknown as Index, '2026-07-01', undefined, undefined, undefined, FIRM);
  const w = two.byId.get('treppenhaus')!;
  assert.deepEqual(candidates(w, two, toChf).best.map((c) => c.tx.ref).sort(), ['p', 'q']);
  assert.equal(suggestion(w, two, toChf), undefined);
  // A supplier's invoice, a receipt without a date: the refund that names it stays the wrong way.
  const g = ledgerOf(books([garage()], [refund]) as unknown as Index, '2026-07-01', undefined, undefined, undefined, FIRM);
  assert.deepEqual(candidates(g.byId.get('garage')!, g, toChf).best, []);
  const undated = ledgerOf(books([treppenhaus({ date: undefined })], [pay('p')]) as unknown as Index, '2026-07-01', undefined, undefined, undefined, FIRM);
  const u = candidates(undated.byId.get('treppenhaus')!, undated, toChf);
  assert.equal([...u.best, ...u.more].find((c) => c.tx.ref === 'p')?.wrongWay, true, 'no date, no pairing by number');
});

test('with an AI, the check is told the receipt is the firm\'s own invoice and the money came in', () => {
  const prompt = checkPrompt([{ r: treppenhaus(), t: pay('p'), own: true }]);
  assert.match(prompt, /"own":true/);
  assert.match(prompt, /own invoice/);
});

test('paired, without an AI, the payment opens «Von Hand buchen» as a sale at her invoice\'s rate: the firm\'s revenue account, V81', async () => {
  const b = books([treppenhaus()], [pay('p'), ...quarter]);
  await run(b);
  const bank = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
  const d = bookingDraft(b, 'p', bank, undefined, { defaults: { sales: '3400' }, chart: ['1020', '1100', '3400'], ownUid: 'CHE-123.456.789' })!;
  assert.deepEqual(d.receipts, ['treppenhaus']);
  assert.deepEqual(d.lines.map((l) => [l.accountDebit, l.accountCredit, l.amount, vatCodeOf(l.vat, l.accountDebit, l.accountCredit)?.code]), [['1020', '3400', 12450, 'V81']]);
  assert.ok(d.notes.some((n) => n.kind === 'sale'));
});
