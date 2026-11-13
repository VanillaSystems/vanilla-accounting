/**
 * The firm's own UID says nothing of who wrote a receipt (a supplier prints «Kunde CHE-… MWST»),
 * also while the settings have none (#466: the setup does not ask it). buyerUids gives the settings'
 * UID, else the ones the books show to be the buyer's: a UID on the receipts of two vendors or more,
 * the UID on the firm's own invoices recognised by its name. Synthetic receipts, no real vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { buyerUids, twoVendors } from '../src/intake/own-invoice.js';
import { linkReceiptSets, proposalsFor } from '../src/intake/receipt-sets.js';
import { batchPayersOf, businessesOf, buyerUidsOf } from '../src/intake/match.js';
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

test('buyerUids: the settings\' UID alone when there is one; else a UID on two vendors\' receipts, or on the firm\'s own invoice by its name', () => {
  const b = booksOf([], shops());
  assert.deepEqual(buyerUids({ uid: 'CHE-999.888.777', name: 'Muster GmbH' }, b), ['999888777'], 'the settings decide, the books are not read');
  assert.deepEqual(buyerUids({ name: 'Muster GmbH' }, b), [FIRM_DIGITS]);
  assert.deepEqual(buyerUids({ name: 'Muster GmbH' }, booksOf([], [shops()[0]])), [], 'one vendor\'s receipts: its UID may be its own');
  const own = receipt({ title: { vendor: 'Kunde AG', what: 'Rechnung' }, extractedText: `Muster GmbH, Bahnhofstrasse 1, 8000 Zürich\n${FIRM} MWST\nRechnung 2026-001\nKunde AG` });
  assert.deepEqual(buyerUids({ name: 'Muster GmbH' }, booksOf([], [own])), [FIRM_DIGITS], 'the firm\'s own invoice by its name');
  const untitled = [receipt({ vatId: FIRM, title: undefined }), receipt({ vatId: FIRM, title: undefined })];
  const paid = booksOf([pay('P1', 1, { counterparty: 'Garage Muster' }), pay('P2', 1, { counterparty: 'Papeterie Beispiel' })], untitled, [{ receiptId: untitled[0].id, transactionRef: 'P1' }, { receiptId: untitled[1].id, transactionRef: 'P2' }] as Mapping[]);
  assert.deepEqual(buyerUids({ name: 'Muster GmbH' }, paid), [FIRM_DIGITS], 'without a title: the counterparties of the payments they are linked to');
  assert.equal(twoVendors(['digitec', 'digitecgalaxus']), false, 'one name holding the other is one vendor');
  assert.equal(twoVendors(['shopalphaag', 'betahandelgmbh']), true);
});

test('receipt sets: two shops printing the firm\'s UID are no one vendor, with the UID in the settings or without it', () => {
  const ws = demo();
  for (const w of [ws, withoutUid(ws)]) {
    const b = booksOf([pay('D', 200, { counterparty: 'Dritte AG', description: 'Dritte AG Zahlung' })], shops());
    const found = linkReceiptSets(b, { isOpen: open, payers: batchPayersOf(w, b), buyerUids: buyerUidsOf(w, b) });
    assert.deepEqual(found.sets, [], w.company.uid ? 'with the UID' : 'without the UID');
    assert.deepEqual(b.mappings, []);
  }
});

test('receipt sets: receipts without a title keyed by the firm\'s UID join no set once the books show it is the buyer\'s', () => {
  const ws = withoutUid(demo());
  // The two shops' receipts teach the UID in their text (not read as theirs); the untitled ones would otherwise be one vendor by it.
  const untitled = [receipt({ amount: 120, vatId: FIRM, title: undefined }), receipt({ amount: 80, vatId: FIRM, title: undefined })];
  const b = booksOf([pay('D', 200, { counterparty: 'Dritte AG' })], [...shops().map((r) => ({ ...r, amount: 1, vatId: undefined })), ...untitled]);
  assert.deepEqual(proposalsFor(b, b.transactions[0], { isOpen: open, buyerUids: [] }).sets.length, 1, 'keyed by the buyer\'s UID (the defect): one vendor of nobody');
  assert.deepEqual(proposalsFor(b, b.transactions[0], { isOpen: open, buyerUids: buyerUidsOf(ws, b) }).sets, []);
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
