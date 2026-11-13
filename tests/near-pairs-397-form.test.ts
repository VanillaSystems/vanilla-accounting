/**
 * The hand form for supplier payments without an AI (#397): a payment without a receipt whose last
 * booking claimed input tax gets the zero code and says why, not «wie beim letzten Mal», and names
 * the receipt that may be its own and the rate linking it would bring; a read receipt's words
 * propose the one purchase account its lines name («laut Beleg: Dispersionsfarbe»), never one of
 * several; a payment with no proposal says why in one line; a payment less a cash discount is
 * booked as paid, its VAT on what was paid, with a note naming the discount.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookingDraft, type DraftKnowledge } from '../src/accounting/manual-booking.js';
import { accountOfWords } from '../src/app/lib/account-filter.js';
import { chart } from '../src/engines/index.js';
import { textFacts } from '../src/parsers/receipt-text.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';

const TEXTS: Record<string, string> = JSON.parse(readFileSync(new URL('./fixtures/persona-receipt-texts.json', import.meta.url), 'utf8')).huber;
const BANK = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
// The firm's purchase accounts with the Swiss chart's hints (modules/ch/accounts.yaml).
const ACCOUNTS = [
  { number: '4000', name: 'Materialaufwand Produktion', hints: ['Material', 'Rohmaterial', 'Farbe', 'Lack'] },
  { number: '6000', name: 'Mietaufwand', hints: ['Miete', 'Pacht', 'Parkplatz'] },
  { number: '6300', name: 'Sachversicherungen', hints: ['Versicherung', 'Haftpflicht', 'Police', 'Prämie'] },
  { number: '6510', name: 'Telefon, Internet', hints: ['Handy', 'Natel', 'Mobile', 'Abo'] },
  { number: '3400', name: 'Dienstleistungserlöse', hints: ['Dienstleistung', 'Honorar'] },
];
const KNOWN: DraftKnowledge = {
  defaults: { sales: '3400' }, ownUid: 'CHE-111.222.333', firmName: 'Malerei Huber GmbH',
  byWords: (words) => accountOfWords(ACCOUNTS, words, { typeOf: (n) => chart().typeOf(n), expense: 'expense' }),
};
type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts'>;
const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description }) as BankTransaction;
function read(file: string): Receipt {
  const { vatId: _v, noSwissVat: _n, ...facts } = textFacts(TEXTS[file]);
  return { id: file, filename: file, extractedText: TEXTS[file], location: 'archived', ...facts, ...(facts.vatSummary ? { hasSwissVat: true } : {}) } as Receipt;
}
const entry = (over: Partial<JournalEntry>): JournalEntry => ({ id: 'e', transactionRef: '', date: '2026-07-01', accountDebit: '', accountCredit: '', amount: 0, description: 'x', ...over }) as JournalEntry;

test('Baucenter without its receipt, last booked at 8.1 %: the zero code says no receipt is linked, and the receipt that may fit brings its rate', () => {
  const july = pay('jul', '2026-07-08', 312.9, 'Baucenter Gossau', 'Karte 5412 Einkauf');
  const oct = pay('oct', '2026-10-05', 187.35, 'Baucenter Gossau', 'Karte 5412 Einkauf');
  const books: Books = { transactions: [july, oct], receipts: [], mappings: [], journalEntries: [entry({ id: 'j', transactionRef: 'jul', date: '2026-07-08', accountDebit: '4000', accountCredit: '1020', amount: 312.9, vatCode: 'M81', origin: 'manual' })] };
  const d = bookingDraft(books, 'oct', BANK, undefined, { ...KNOWN, near: { name: 'Baucenter Gossau', rate: 8.1, why: 'gleiche Firma · gleicher Betrag · ohne Datum' } })!;
  assert.deepEqual([d.lines[0].accountDebit, d.lines[0].vat], ['4000', 'M0']);
  assert.deepEqual(d.lines[0].source?.vat, { from: 'noReceipt' }, 'not «wie beim letzten Mal»: last time was M81');
  assert.equal(d.lines[0].source?.account?.from, 'precedent', 'the account as last time');
  assert.deepEqual(d.notes.find((n) => n.kind === 'nearReceipt'), { kind: 'nearReceipt', name: 'Baucenter Gossau', rate: 8.1, why: 'gleiche Firma · gleicher Betrag · ohne Datum' });
});

test('Farbmix FM-79010 linked, no precedent: the receipt\'s «Dispersionsfarbe» proposes the material account; paid less 2 % Skonto, booked as paid with its rate and a note', () => {
  const p = pay('p', '2026-10-08', 1506.45, 'Farbmix AG', 'Rechnung FM-79010 abzgl. 2% Skonto');
  const r = read('Farbmix_Rechnung_FM-79010.pdf');
  const books: Books = { transactions: [p], receipts: [r], mappings: [{ transactionRef: 'p', receiptId: r.id }], journalEntries: [] };
  const d = bookingDraft(books, 'p', BANK, undefined, KNOWN)!;
  assert.deepEqual(d.lines.map((l) => [l.accountDebit, l.accountCredit, l.amount, l.vat]), [['4000', '1020', 1506.45, '8.1']], 'the VAT is on what was paid');
  assert.deepEqual(d.lines[0].source, { account: { from: 'receiptWords', word: 'Dispersionsfarbe' }, vat: { from: 'receipt' } });
  assert.deepEqual(d.notes.find((n) => n.kind === 'discount'), { kind: 'discount', percent: 2, amount: 30.77 });
  assert.ok(!d.notes.some((n) => n.kind === 'chooseAccount'));
});

test('words that name several purchase accounts propose none; the list stays ranked by them', () => {
  assert.equal(accountOfWords(ACCOUNTS, ['Farbe', 'Miete'], { typeOf: (n) => chart().typeOf(n), expense: 'expense' }), undefined);
  assert.deepEqual(accountOfWords(ACCOUNTS, ['Gerüstmiete'], { typeOf: (n) => chart().typeOf(n), expense: 'expense' }), { account: '6000', word: 'Gerüstmiete' });
  assert.equal(accountOfWords(ACCOUNTS, ['Dienstleistung'], { typeOf: (n) => chart().typeOf(n), expense: 'expense' }), undefined, 'a revenue account is no purchase');
  assert.equal(accountOfWords(ACCOUNTS, ['Autofarbenmischer'], { typeOf: (n) => chart().typeOf(n), expense: 'expense' }), undefined, 'a hint inside a word is none');
});

test('a supplier payment with no proposal at all says why: no receipt and no earlier booking', () => {
  const p = pay('m', '2026-09-01', 980, 'Mobiliar Versicherung', 'Betriebshaftpflicht 2026/27');
  const d = bookingDraft({ transactions: [p], receipts: [], mappings: [], journalEntries: [] }, 'm', BANK, undefined, KNOWN)!;
  assert.deepEqual([d.lines[0].accountDebit, d.lines[0].vat], ['', '']);
  assert.deepEqual(d.notes, [{ kind: 'noProposal', name: 'Mobiliar Versicherung', linked: false }]);
});
