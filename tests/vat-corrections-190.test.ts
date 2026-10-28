/**
 * #190 part 4: a bill that proves a VAT-only correction (a platform's monthly bill, whose input tax is
 * booked as one single-leg entry without a payment) is its own kind, from the business's file
 * (`documents: … proves: vat-correction`): never paired with a payment, and Belege names the
 * correction booking it fits. Invented business, bills and bookings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import './support/jurisdiction.js';
import { vatCorrectionsOf } from '../src/booking/vat-corrections.js';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import { noPaymentFor, runPairChain, vatCorrectionsIn } from '../src/intake/pair-chain.js';
import { ledgerOf } from '../src/app/areas/receipts/model.js';
import { APP_FOLDER, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Index, JournalEntry, Mapping, Receipt } from '../src/types/index.js';

const FILE = `id: plattform
name: Plattform Beispiel
match:
  tx: [ "plattform beispiel" ]
documents:
  - id: monthly-bill
    kind: invoice
    text: [ "Plattform Beispiel", "Monatsrechnung Gebühren" ]
    proves: vat-correction
`;
const plattform = () => compileCounterparty(parse(FILE), { binding: 'knowledge/suppliers/plattform.yaml' }, 'supplier');

let n = 0;
const bill = (over: Partial<Receipt> = {}): Receipt => {
  const k = ++n;
  return {
    id: `r${k}`, filename: `rechnung-${k}.pdf`, originalFilename: `rechnung-${k}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
    date: '2026-08-31', amount: 54.05, currency: 'CHF', title: { vendor: 'Plattform Beispiel', what: 'Gebühren August' },
    extractedText: 'Plattform Beispiel\nMonatsrechnung Gebühren August 2026\nTotal CHF 54.05 inkl. MWST 8.1 % CHF 4.05', vatSummary: [{ ratePercent: 8.1, vat: 4.05, gross: 54.05 }], ...over,
  } as Receipt;
};
const correction = (ref: string, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `${ref}-1`, transactionRef: ref, date: '2026-09-02', accountDebit: '', accountCredit: '6580', amount: 4.05, vatCode: 'M81-2', description: 'Plattform, Vorsteuer Gebühren August', ...over }) as JournalEntry;
const pay = (ref: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Bank', date: '2026-09-01', amount: 54.05, currency: 'CHF', direction: 'DBIT', description: 'Zahlung Plattform Beispiel', ...over });
const booksOf = (receipts: Receipt[], journalEntries: JournalEntry[] = [], transactions: BankTransaction[] = [], mappings: Mapping[] = []): Books =>
  ({ receipts, journalEntries, transactions, mappings, bankStatements: [], config: {} }) as unknown as Books;

test('a document type proves only what the app knows: vat-correction', () => {
  assert.throws(() => compileCounterparty(parse(FILE.replace('proves: vat-correction', 'proves: payment')), { binding: 'knowledge/suppliers/plattform.yaml' }, 'supplier'), /proves must be vat-correction/);
  assert.equal(plattform().documents[0].proves, 'vat-correction');
});

test('vatCorrectionsOf: the bill, its VAT and the one correction booking without a payment that books it', () => {
  const b = bill();
  assert.deepEqual(vatCorrectionsOf(booksOf([b], [correction('M2026-001')]), [plattform()]).get(b.id), { business: 'plattform', name: 'Plattform Beispiel', document: 'monthly-bill', vat: 4.05, booking: 'M2026-001' });
  const none = (books: Books) => vatCorrectionsOf(books, [plattform()]).get(b.id)?.booking;
  assert.equal(none(booksOf([b], [correction('M2026-001'), correction('M2026-002')])), undefined, 'two fit: the person picks');
  assert.equal(none(booksOf([b], [correction('M2026-001', { amount: 4.5 })])), undefined, 'another tax amount');
  assert.equal(none(booksOf([b], [correction('M2026-001', { accountDebit: '1170' })])), undefined, 'two legs: no VAT-only correction');
  assert.equal(none(booksOf([b], [correction('M2026-001', { vatCode: 'M81' })])), undefined, 'a gross code');
  assert.equal(none(booksOf([b], [correction('M2026-001', { date: '2026-12-31' })])), undefined, 'months later');
  assert.equal(none(booksOf([b, bill({ id: 'other' })], [correction('M2026-001')], [], [{ transactionRef: 'M2026-001', receiptId: 'other' }])), undefined, 'the booking holds its bill already');
  assert.equal(none(booksOf([b], [correction('P1')], [pay('P1')])), undefined, 'an entry of a payment is no booking without one');
  assert.equal(vatCorrectionsOf(booksOf([bill({ extractedText: 'Plattform Beispiel\nRechnung Abonnement' })]), [plattform()]).size, 0, 'another document of the business is paid as usual');
  assert.equal(vatCorrectionsOf(booksOf([b], [], [pay('P1')], [{ transactionRef: 'P1', receiptId: b.id }]), [plattform()]).size, 0, 'a linked bill is done');
  const noVat = bill({ vatSummary: undefined });
  assert.deepEqual(vatCorrectionsOf(booksOf([noVat], [correction('M2026-001')]), [plattform()]).get(noVat.id), { business: 'plattform', name: 'Plattform Beispiel', document: 'monthly-bill' });
});

test('the chain never pairs such a bill with a payment; Belege shows it with the booking it fits', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'vat-correction-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  const ws = workspaceAt(join(repo, APP_FOLDER));
  const toChf = (a: number) => a;
  const b = bill();
  const books = () => booksOf([b], [correction('M2026-001')], [pay('P1')]);
  const port = (x: Books) => ({ read: () => x, update: <T>(fn: (y: Books) => T) => fn(x) });
  const before = await runPairChain(port(books()), { toChf, noPayment: noPaymentFor(ws) });
  assert.deepEqual(before.linked.map((l) => l.payment), ['P1'], 'without the business file the bill pairs like any receipt');

  const file = join(ws.paths.root, 'knowledge/suppliers/plattform.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, FILE);
  const after = await runPairChain(port(books()), { toChf, noPayment: noPaymentFor(ws) });
  assert.deepEqual([after.linked, after.left.map((l) => l.receipt)], [[], []], 'no pair, and no candidates for the person either');
  const corrections = vatCorrectionsIn(ws, books());
  assert.equal(corrections[b.id].booking, 'M2026-001');
  const view = ledgerOf(books() as unknown as Index, '2026-07-01', new Map(), new Map(), new Map(Object.entries(corrections))).byId.get(b.id)!;
  assert.equal(view.vatCorrection?.booking, 'M2026-001');
});
