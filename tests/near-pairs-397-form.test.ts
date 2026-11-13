/**
 * The hand form for supplier payments without an AI (#397):
 * - a payment without a receipt whose last booking claimed input tax gets the zero code and says
 *   why, not «wie beim letzten Mal», and names the receipt that may be its own and the rate linking
 *   it would bring; on a firm without input tax no VAT sentence;
 * - no account is ever proposed from a receipt's words (#356, #389, review of #397): they rank the
 *   account list by whole words only, and the form says so;
 * - a payment with no proposal says why in one line;
 * - a payment less a cash discount is booked as paid, its VAT on what was paid, with a note; a
 *   receipt of several rates leaves the rates to her and says why; a firm without input tax hears no
 *   VAT sentence.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookingDraft, type DraftKnowledge } from '../src/accounting/manual-booking.js';
import { rankAccounts, ranksByWords } from '../src/app/lib/account-filter.js';
import { chart, setJurisdiction } from '../src/engines/index.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { APP_ROOT, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED } from '../src/workspace/vat-setup.js';
import { textFacts } from '../src/parsers/receipt-text.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';

const TEXTS: Record<string, string> = JSON.parse(readFileSync(new URL('./fixtures/persona-receipt-texts.json', import.meta.url), 'utf8')).huber;
const BANK = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
// The firm's purchase accounts with the Swiss chart's hints (modules/ch/accounts.yaml).
const ACCOUNTS = [
  { number: '4000', name: 'Materialaufwand Produktion', hints: ['Material', 'Rohmaterial', 'Farbe', 'Lack'] },
  { number: '6000', name: 'Mietaufwand', hints: ['Miete', 'Pacht', 'Parkplatz'] },
  { number: '6300', name: 'Sachversicherungen', hints: ['Versicherung', 'Haftpflicht', 'Police', 'Prämie'] },
  { number: '6510', name: 'Telefon, Internet', hints: ['Handy', 'Natel', 'Mobile', 'Abo'] },
  { number: '6640', name: 'Reisespesen', hints: ['Reise', 'Bahn', 'Hotel'] },
];
const KNOWN: DraftKnowledge = { defaults: { sales: '3400' }, ownUid: 'CHE-111.222.333', firmName: 'Malerei Huber GmbH', ranks: (words) => ranksByWords(ACCOUNTS, words) };
type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts'>;
const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description }) as BankTransaction;
function read(file: string, text = TEXTS[file]): Receipt {
  const { vatId: _v, noSwissVat: _n, ...facts } = textFacts(text);
  return { id: file, filename: file, extractedText: text, location: 'archived', ...facts, ...(facts.vatSummary ? { hasSwissVat: true } : {}) } as Receipt;
}
const entry = (over: Partial<JournalEntry>): JournalEntry => ({ id: 'e', transactionRef: '', date: '2026-07-01', accountDebit: '', accountCredit: '', amount: 0, description: 'x', ...over }) as JournalEntry;
const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
function unregistered<T>(fn: () => T): T {
  setJurisdiction(ch, NOT_REGISTERED);
  try { return fn(); } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
}
const NEAR = { name: 'Baucenter Gossau', rate: 8.1, why: 'gleiche Firma · gleicher Betrag · ohne Datum' };
const baucenter = (): Books => ({
  transactions: [pay('jul', '2026-07-08', 312.9, 'Baucenter Gossau', 'Karte 5412 Einkauf'), pay('oct', '2026-10-05', 187.35, 'Baucenter Gossau', 'Karte 5412 Einkauf')], receipts: [], mappings: [],
  journalEntries: [entry({ id: 'j', transactionRef: 'jul', date: '2026-07-08', accountDebit: '4000', accountCredit: '1020', amount: 312.9, vatCode: 'M81', origin: 'manual' })],
});
const fm79010 = (text = TEXTS['Farbmix_Rechnung_FM-79010.pdf']): Books => {
  const r = read('Farbmix_Rechnung_FM-79010.pdf', text);
  return { transactions: [pay('p', '2026-10-08', 1506.45, 'Farbmix AG', 'Rechnung FM-79010 abzgl. 2% Skonto')], receipts: [r], mappings: [{ transactionRef: 'p', receiptId: r.id }], journalEntries: [] };
};

test('Baucenter without its receipt, last booked at 8.1 %: the zero code says no receipt is linked, and the receipt that may fit brings its rate', () => {
  const d = bookingDraft(baucenter(), 'oct', BANK, undefined, { ...KNOWN, near: NEAR })!;
  assert.deepEqual([d.lines[0].accountDebit, d.lines[0].vat], ['4000', 'M0']);
  assert.deepEqual(d.lines[0].source?.vat, { from: 'noReceipt' }, 'not «wie beim letzten Mal»: last time was M81');
  assert.equal(d.lines[0].source?.account?.from, 'precedent', 'the account as last time');
  assert.deepEqual(d.notes.find((n) => n.kind === 'nearReceipt'), { kind: 'nearReceipt', name: 'Baucenter Gossau', rate: 8.1, why: NEAR.why, vat: true });
});

test('a firm without input tax: the receipt that may fit is named without a rate, the Skonto note without a VAT sentence', () => {
  unregistered(() => {
    const d = bookingDraft(baucenter(), 'oct', BANK, undefined, { ...KNOWN, near: NEAR })!;
    assert.deepEqual(d.notes.find((n) => n.kind === 'nearReceipt'), { kind: 'nearReceipt', name: 'Baucenter Gossau', why: NEAR.why, vat: false });
    const s = bookingDraft(fm79010(), 'p', BANK, undefined, KNOWN)!;
    assert.deepEqual(s.notes.find((n) => n.kind === 'discount'), { kind: 'discount', percent: 2, amount: 30.77, vat: 'none' });
  });
});

test('FM-79010 linked, no precedent: no account guessed from its words; paid less 2 % Skonto, booked as paid with its rate and a note', () => {
  const d = bookingDraft(fm79010(), 'p', BANK, undefined, KNOWN)!;
  assert.deepEqual(d.lines.map((l) => [l.accountDebit, l.accountCredit, l.amount, l.vat]), [['', '1020', 1506.45, '8.1']], 'the VAT is on what was paid; the account is hers');
  assert.equal(d.lines[0].source?.account, undefined);
  assert.deepEqual(d.notes.find((n) => n.kind === 'discount'), { kind: 'discount', percent: 2, amount: 30.77, vat: 'paid' });
  assert.ok(d.notes.some((n) => n.kind === 'chooseAccount'));
  assert.ok(!d.notes.some((n) => n.kind === 'rankedByReceipt'), '«Dispersionsfarbe» is no «Farbe»: the list is not said to be ranked');
});

test('a receipt that names a hint as a whole word ranks the list and says so, still without an account', () => {
  const text = TEXTS['Farbmix_Rechnung_FM-79010.pdf'].replace('Dispersionsfarbe weiss', 'Farbe weiss');
  const d = bookingDraft(fm79010(text), 'p', BANK, undefined, KNOWN)!;
  assert.equal(d.lines[0].accountDebit, '');
  assert.ok(d.notes.some((n) => n.kind === 'rankedByReceipt'));
  assert.ok(d.words?.includes('Farbe'));
});

test('words name a hint only whole: «Preise» is no «Reise», «Gerüstmiete» no «Miete», «Krankenversicherung» no «Versicherung», «Büromaterial» no «Material»', () => {
  const typeOf = (n: string) => chart().typeOf(n);
  for (const w of ['Preise', 'Gerüstmiete', 'Automiete', 'Krankenversicherung', 'Unfallversicherung', 'Büromaterial', 'Werbematerial', 'Dispersionsfarbe']) {
    assert.equal(ranksByWords(ACCOUNTS, [w]), false, w);
    const first = rankAccounts(ACCOUNTS, '', { typeOf, suggest: [w] })[0].account.number;
    assert.equal(first, '4000', `${w}: the chart's order stands`);
  }
  assert.equal(rankAccounts(ACCOUNTS, '', { typeOf, suggest: ['Hotel'] })[0].account.number, '6640', 'a whole word ranks');
});

test('a multi-rate receipt paid less Skonto: no rate, and the note says the rates are hers to split', () => {
  const text = TEXTS['Farbmix_Rechnung_FM-79010.pdf'];
  const b = fm79010(text);
  b.receipts[0].vatSummary = [{ ratePercent: 8.1, net: 800, vat: 64.8, gross: 864.8 }, { ratePercent: 2.6, net: 655.38, vat: 17.04, gross: 672.42 }];
  const d = bookingDraft(b, 'p', BANK, undefined, KNOWN)!;
  assert.equal(d.lines[0].vat, '');
  assert.deepEqual(d.notes.find((n) => n.kind === 'discount'), { kind: 'discount', percent: 2, amount: 30.77, vat: 'rates' });
});

test('a supplier payment with no proposal at all says why: no receipt and no earlier booking', () => {
  const p = pay('m', '2026-09-01', 980, 'Mobiliar Versicherung', 'Betriebshaftpflicht 2026/27');
  const d = bookingDraft({ transactions: [p], receipts: [], mappings: [], journalEntries: [] }, 'm', BANK, undefined, KNOWN)!;
  assert.deepEqual([d.lines[0].accountDebit, d.lines[0].vat], ['', '']);
  assert.deepEqual(d.notes, [{ kind: 'noProposal', name: 'Mobiliar Versicherung', linked: false }]);
});
