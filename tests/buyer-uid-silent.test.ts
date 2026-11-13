/**
 * The firm's own UID says nothing of who wrote a receipt (a supplier prints «Kunde CHE-… MWST»),
 * also while the settings have none (#466: the setup does not ask it). buyerUids gives the settings'
 * UID, else the ones the books show to be the buyer's: a UID in a customer's block on the receipts of
 * two vendors or more, the UID on the firm's own invoice money in pays. Without the settings' UID the
 * receipt sets key no receipt by its VAT number. Synthetic receipts, no real vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { buyerUids, twoVendors } from '../src/intake/own-invoice.js';
import { linkReceiptSets, proposalsFor } from '../src/intake/receipt-sets.js';
import { batchPayersOf, businessesOf } from '../src/intake/match.js';
import { bookingDraft, type DraftKnowledge } from '../src/accounting/manual-booking.js';
import { workspaceAt, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Mapping, Receipt } from '../src/types/index.js';

const FIRM = 'CHE-123.456.789';
const FIRM_DIGITS = '123456789';

let n = 0;
const receipt = (over: Partial<Receipt>): Receipt => {
  const k = ++n;
  return { id: `b${k}`, filename: `beleg-${k}.pdf`, originalFilename: `beleg-${k}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-08-10', currency: 'CHF', extractedText: 'Rechnung', ...over } as Receipt;
};
const pay = (ref: string, amount: number, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-08-12', amount, currency: 'CHF', direction: 'DBIT', description: 'Zahlung', ...over }) as BankTransaction;
const booksOf = (transactions: BankTransaction[], receipts: Receipt[], mappings: Mapping[] = []) =>
  ({ transactions, receipts, mappings, bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;
const open = (d: string) => d > '2026-06-30';

/** Two shops' invoices that print the firm's UID as their customer's, the model reading it as theirs. */
const shops = () => [
  receipt({ amount: 120, vatId: FIRM, title: { vendor: 'Shop Alpha AG', what: 'Einkauf' }, extractedText: `Shop Alpha AG\nRechnung 1\nKunde: Muster GmbH ${FIRM} MWST\nTotal 120.00` }),
  receipt({ amount: 80, vatId: FIRM, title: { vendor: 'Beta Handel GmbH', what: 'Einkauf' }, extractedText: `Beta Handel GmbH\nRechnung 2\nKunde: Muster GmbH ${FIRM} MWST\nTotal 80.00` }),
];

const demo = () => workspaceAt(DEMO_ROOT);
const withoutUid = <W extends { company: { uid?: string } }>(ws: W): W => ({ ...ws, company: { ...ws.company, uid: undefined } });

const firm = { name: 'Muster GmbH' };
const linkedTo = (rs: Receipt[], txs: BankTransaction[]) => booksOf(txs, rs, rs.map((r, i) => ({ receiptId: r.id, transactionRef: txs[i].ref }) as Mapping));

test('buyerUids: the settings\' UID alone when there is one; else a UID in a customer\'s block on two vendors\' receipts, or on the firm\'s own invoice money in pays', () => {
  const b = booksOf([], shops());
  assert.deepEqual(buyerUids({ uid: 'CHE-999.888.777', name: 'Muster GmbH' }, b), ['999888777'], 'the settings decide, the books are not read');
  assert.deepEqual(buyerUids(firm, b), [FIRM_DIGITS]);
  assert.deepEqual(buyerUids(firm, booksOf([], [shops()[0]])), [], 'one vendor\'s receipts: its UID may be its own');
  const own = () => receipt({ title: { vendor: 'Kunde AG', what: 'Rechnung' }, extractedText: `Muster GmbH, Bahnhofstrasse 1, 8000 Zürich\n${FIRM} MWST\nRechnung 2026-001\nKunde AG` });
  assert.deepEqual(buyerUids(firm, linkedTo([own()], [pay('IN', 1, { direction: 'CRDT' })])), [FIRM_DIGITS], 'her own invoice, paid by her customer');
  // A supplier's invoice with her name as the addressee on its first line, its UID near it: paid by money out.
  const addressed = receipt({ title: undefined, extractedText: 'Muster GmbH, Bahnhofstrasse 1, 8000 Zürich\nCHE-468.024.680 MWST\nRechnung 77\nLieferant AG' });
  assert.deepEqual(buyerUids(firm, linkedTo([addressed], [pay('OUT', 1)])), [], 'the supplier\'s UID is never the firm\'s own');
  assert.deepEqual(buyerUids(firm, booksOf([], [own()])), [], 'not paid in: no proof it is hers');
  const untitled = [receipt({ vatId: FIRM, title: undefined, extractedText: `Rechnung\nKunde: Muster GmbH ${FIRM}` }), receipt({ vatId: FIRM, title: undefined, extractedText: `Quittung\nKunde: Muster GmbH ${FIRM}` })];
  assert.deepEqual(buyerUids(firm, linkedTo(untitled, [pay('P1', 1, { counterparty: 'Garage Muster' }), pay('P2', 1, { counterparty: 'Papeterie Beispiel' })])), [FIRM_DIGITS], 'without a title: the counterparties of the payments they are linked to');
  assert.equal(twoVendors(['digitec', 'digitecgalaxus']), false, 'one name holding the other is one vendor');
  assert.equal(twoVendors(['shopalphaag', 'betahandelgmbh']), true);
});

test('buyerUids: a supplier\'s own UID is never the buyer\'s: two brands, two products, a card payment\'s name, a payout report and its fee bill', () => {
  const letterhead = (vendor: string, uid: string) => receipt({ vatId: uid, title: { vendor, what: 'Rechnung' }, extractedText: `${vendor}\n${uid} MWST\nRechnung\nMuster GmbH` });
  assert.deepEqual(buyerUids(firm, booksOf([], [letterhead('Digitec', 'CHE-192.837.465'), letterhead('Galaxus', 'CHE-192.837.465')])), [], 'two brands of one supplier');
  const footer = (vendor: string) => receipt({ vatId: 'CHE-357.913.579', title: { vendor, what: 'Abo' }, extractedText: `${vendor}\nRechnung\nMuster GmbH\nTotal 10.00\nGoogle Beispiel Ltd, CHE-357.913.579 MWST` });
  assert.deepEqual(buyerUids(firm, booksOf([], [footer('Google Cloud'), footer('Google Workspace')])), [], 'two products, the UID in the footer');
  // The host's UID below the customer number: its title on one receipt, the card's name on the payment of another.
  const hosting = (title?: string) => receipt({ vatId: 'CHE-579.135.791', title: title ? { vendor: title, what: 'Server' } : undefined, extractedText: 'Kunde: K-4711\nHosting Beispiel GmbH\nCHE-579.135.791 MWST\nRechnung' });
  assert.deepEqual(buyerUids(firm, linkedTo([hosting('Hosting Beispiel'), hosting()], [pay('H1', 1, { counterparty: 'Hosting Beispiel' }), pay('H2', 1, { counterparty: 'Visa Kartenzahlung' })])), [], 'a title and a payment\'s name are never mixed');
  const report = receipt({ vatId: 'CHE-111.222.333', title: { vendor: 'Verkauf', what: 'Auszahlung' }, extractedText: 'Kunde: Muster GmbH\nTerminal AG CHE-111.222.333\nAuszahlung Oktober' });
  const fees = receipt({ vatId: 'CHE-111.222.333', title: { vendor: 'Terminal AG', what: 'Gebühren' }, extractedText: 'Terminal AG CHE-111.222.333 MWST\nGebühren Oktober' });
  assert.deepEqual(buyerUids(firm, booksOf([], [report, fees])), [], 'a title that names no business counts for no vendor');
});

test('receipt sets: two shops printing the firm\'s UID are no one vendor, with the UID in the settings or without it', () => {
  const ws = demo();
  for (const w of [ws, withoutUid(ws)]) {
    const b = booksOf([pay('D', 200, { counterparty: 'Dritte AG', description: 'Dritte AG Zahlung' })], shops());
    const found = linkReceiptSets(b, { isOpen: open, payers: batchPayersOf(w, b), firmUid: w.company.uid });
    assert.deepEqual(found.sets, [], w.company.uid ? 'with the UID' : 'without the UID');
    assert.deepEqual(b.mappings, []);
  }
});

test('receipt sets: without the UID in the settings no VAT number is a vendor; receipts without a title join no set and wait', () => {
  const ws = withoutUid(demo());
  const [alpha, beta] = shops();
  const bare = (r: Receipt): Receipt => ({ ...r, title: undefined });
  for (const [what, rs] of [['both without a title', [bare(alpha), bare(beta)]], ['one with a title', [alpha, bare(beta)]]] as Array<[string, Receipt[]]>) {
    const b = booksOf([pay('D', 200, { counterparty: 'Dritte AG', description: 'Dritte AG Zahlung' })], rs);
    assert.deepEqual(linkReceiptSets(b, { isOpen: open, payers: batchPayersOf(ws, b), firmUid: ws.company.uid }).sets, [], what);
    assert.deepEqual(b.mappings, [], what);
    assert.deepEqual(proposalsFor(b, b.transactions[0], { isOpen: open, firmUid: ws.company.uid }).sets, [], what);
  }
  // With the UID in the settings a supplier's own VAT number still keys its receipts, as before.
  const supplier = [receipt({ amount: 120, vatId: 'CHE-283.746.519', title: undefined }), receipt({ amount: 80, vatId: 'CHE-283.746.519', title: undefined })];
  const b = booksOf([pay('S', 200, { counterparty: 'Lieferant AG' })], supplier);
  assert.equal(proposalsFor(b, b.transactions[0], { isOpen: open, firmUid: FIRM }).sets.length, 1, 'with the UID: keyed by the supplier\'s VAT number');
  assert.deepEqual(proposalsFor(b, b.transactions[0], { isOpen: open }).sets, [], 'without it: no key, the receipts wait');
});

test('routing: a receipt printing only the buyer\'s UID is routed by its sender\'s address, with the UID in the settings or the books showing it', () => {
  const dhl = receipt({ title: undefined, filename: 'scan-7.pdf', originalFilename: 'scan-7.pdf', extractedText: `DHL Express (Schweiz) AG\nwww.dhl.ch\nRechnung 991\nIhre UID: ${FIRM}` });
  const ws = demo();
  assert.equal(ws.company.uid, FIRM);
  assert.equal(businessesOf(ws)?.ofReceipt(dhl), 'dhl', 'the settings\' UID');
  const bare = withoutUid(ws);
  assert.equal(businessesOf(bare, booksOf([], [dhl]))?.ofReceipt(dhl), undefined, 'nothing shows whose the UID is: it is taken for the sender\'s');
  assert.equal(businessesOf(bare, booksOf([], [dhl, ...shops()]))?.ofReceipt(dhl), 'dhl', 'two shops print it as their customer\'s');
});

test('hand booking: money in with a business\'s document is no sale, by the firm\'s name while the settings have no UID', () => {
  const bank = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
  const sale = pay('IN', 540, { direction: 'CRDT', counterparty: 'Familie Keller', description: 'Gutschrift' });
  const doc = receipt({ id: 'cn', vatId: 'CHE-999.888.777', hasSwissVat: true, extractedText: 'Lieferant AG\nCHE-999.888.777 MWST\nGutschrift' } as Partial<Receipt>);
  const b = { transactions: [sale], journalEntries: [], receipts: [doc], mappings: [{ transactionRef: 'IN', receiptId: 'cn' }] } as unknown as Books;
  const known: DraftKnowledge = { defaults: { sales: '3400', purchase: '4000' }, chart: ['1020', '1100', '3400'], firmName: 'Muster GmbH' };
  const notes = (k: DraftKnowledge) => bookingDraft(b, 'IN', bank, undefined, k)!.notes.map((x) => x.kind);
  assert.ok(notes(known).includes('supplierDocument'), 'without the UID: the name says it is not hers');
  assert.ok(notes({ ...known, ownUid: FIRM }).includes('supplierDocument'), 'with the UID');
  const hers = { ...doc, vatId: FIRM, extractedText: `Muster GmbH, Bahnhofstrasse 1\n${FIRM} MWST\nRechnung 2026-001` };
  const own = { ...b, receipts: [hers] } as unknown as Books;
  assert.ok(!bookingDraft(own, 'IN', bank, undefined, known)!.notes.some((x) => x.kind === 'supplierDocument'), 'her own invoice is no business\'s document');
});
