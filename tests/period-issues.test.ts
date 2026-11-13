/**
 * What the review before filing names as still open in its period (persona round 4, r4c-38): the
 * open questions on its payments, a booking whose code its receipts contradict («I81 ohne Beleg»),
 * a payment nobody booked, a receipt without a payment. Nothing of another period, nothing settled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import type { Question } from '../src/questions/model.js';
import { countIssues, issuesLead, periodIssues, receiptWaits, unbookedOpen } from '../src/app/areas/automation/period-issues.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';
import { isPending, resultSentence, type VatReturn } from '../src/app/areas/vat/model.js';
import { journalOf, unsettledAtFiling } from '../src/app/areas/journal/model.js';
import { openWork } from '../src/server/open-work.js';
import { tempWorkspace } from './support/workspace.js';
import type { Books } from '../src/books/store.js';

const tx = (ref: string, date: string, amount: number, direction: 'DBIT' | 'CRDT' = 'DBIT'): BankTransaction => ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction, description: ref });
const receipt = (id: string, date: string): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'archived', currency: 'CHF', date, amount: 50 });
const books: Index = {
  config: { closedThrough: '2026-06-30' },
  transactions: [tx('KELLER', '2026-07-02', 4860, 'CRDT'), tx('NATEL', '2026-08-15', 89), tx('SEP', '2026-09-15', 89), tx('OKT', '2026-10-03', 12), tx('PAID', '2026-08-20', 50)],
  journalEntries: [
    { id: 'e-keller', transactionRef: 'KELLER', date: '2026-07-02', accountDebit: '1020', accountCredit: '3400', amount: 4860, vatCode: 'V81', origin: 'classify' },
    { id: 'e-natel', transactionRef: 'NATEL', date: '2026-08-15', accountDebit: '6510', accountCredit: '1020', amount: 89, vatCode: 'I81', origin: 'manual' },
    { id: 'e-paid', transactionRef: 'PAID', date: '2026-08-20', accountDebit: '6510', accountCredit: '1020', amount: 50, vatCode: 'I0', origin: 'classify' },
  ],
  receipts: [receipt('lonely', '2026-09-03'), receipt('paid', '2026-08-20'), receipt('october', '2026-10-04')],
  mappings: [{ receiptId: 'paid', transactionRef: 'PAID' }],
  bankStatements: [],
};
const question = (id: string, on: string, status: Question['status'] = 'open'): Question => ({ id, on: { kind: 'payment', id: on }, text: '?', choices: [], by: 'app', origin: 'booking', topic: 'saleVat', askedAt: '2026-10-01T00:00:00Z', status });

test('the review names each open issue of its quarter, and nothing of another quarter or already settled', () => {
  const issues = periodIssues(books, [question('q1', 'KELLER'), question('q2', 'OKT'), question('q3', 'NATEL', 'answered')], '2026-07-01', '2026-09-30', []);
  assert.deepEqual(issues.map((i) => [i.kind, i.kind === 'question' ? i.q.id : i.kind === 'evidence' ? i.entry.id : i.kind === 'unbooked' ? i.tx.ref : i.kind === 'unlinked' ? i.receipt.id : '']), [
    ['question', 'q1'],
    ['evidence', 'e-natel'],
    ['unbooked', 'SEP'],
    ['unlinked', 'lonely'],
  ]);
  assert.deepEqual(periodIssues({ ...books, transactions: books.transactions.filter((t) => t.ref !== 'SEP' && t.ref !== 'NATEL'), receipts: [], journalEntries: books.journalEntries!.filter((e) => e.id !== 'e-natel') }, [], '2026-07-01', '2026-09-30', []), [], 'nothing open: nothing listed');
});

const filed: Index = { ...books, config: { closedThrough: '2026-09-30' } };

test('a contradiction left when the quarter was filed stays named, for a correction in the open period, until a correction names its payment (r5h-33)', () => {
  const u = unsettledAtFiling(journalOf(filed), 'quarter');
  assert.deepEqual([u?.period, u?.items.map((i) => [i.v.e.id, i.check.kind])], ['2026-Q3', [['e-natel', 'vatWithoutReceipt']]]);
  assert.equal(journalOf(filed).views.find((v) => v.e.id === 'e-natel')!.evidence, undefined, 'the filed entry is not offered its one click: it stays as filed');
  const corrected: Index = { ...filed, journalEntries: [...filed.journalEntries!, { id: 'corr', transactionRef: 'M2026-001', date: '2026-10-05', accountDebit: '6510', accountCredit: '6510', amount: 89, vatCode: '-I81', description: 'Korrektur NATEL: ohne Beleg', corrects: '2026-Q3', origin: 'manual' }] };
  assert.deepEqual(unsettledAtFiling(journalOf(corrected), 'quarter')?.items, []);
  assert.equal(unsettledAtFiling(journalOf(books), 'quarter')?.period, '2026-Q2', 'before Q3 is filed, only the quarter filed last counts');
  assert.deepEqual(unsettledAtFiling(journalOf(books), 'quarter')?.items, []);
});

test('what waits, for the AI sidebar, names the bookings against their receipts, those left at filing, and the possible duplicates (w08, r5h-34)', () => {
  const ws = tempWorkspace('open-work-');
  const twin = (id: string, file: string): Receipt => ({ ...receipt(id, '2026-09-10'), filename: file, extractedText: 'Farbmix AG Rechnung FM-77812 Total CHF 1243.55', amount: 1243.55, description: 'Farbmix AG, Rechnung FM-77812' });
  const open = openWork(ws, { ...books, receipts: [...books.receipts, twin('fm', 'fm-77812.pdf'), twin('img', 'img-4801.jpg')] } as Books, [], 'de');
  assert.match(open, /Bookings whose VAT code contradicts their receipts \(1\)[^\n]*\n- 15\.08\.2026 [^\n]*\(NATEL\): «I81 ohne Beleg: die Vorsteuer braucht einen Beleg mit MWST, sonst I0\.»/);
  // A possible copy of the period is the period's, waiting for her word (#398), named with what it may repeat; not again below.
  assert.match(open, /Receipts that wait for the person's own word \(1\)[^\n]*\n- «Farbmix AG» of 10\.09\.2026, CHF 1.243\.55: «schon da\?», may be a copy of «Farbmix AG, Rechnung FM-77812», answered on the receipt/);
  assert.doesNotMatch(open, /Receipts that may be a copy of another/);
  assert.doesNotMatch(open, /Nothing waits/);
  const after = openWork(ws, filed as Books, [], 'de');
  assert.match(after, /Bookings of the filed 2026-Q3 that contradicted their receipts and were not settled before filing \(1\)[^\n]*\n- 15\.08\.2026 /);
});

test('the counts beside a figure that is not final come from the same list, and name the payments held for their receipt (#341)', () => {
  const held: Index = { ...books, transactions: books.transactions.map((t) => (t.ref === 'SEP' ? { ...t, waitsForReceipt: { since: '2026-10-01' } } : t)) };
  const issues = periodIssues(held, [question('q1', 'KELLER')], '2026-07-01', '2026-09-30', []);
  assert.deepEqual(countIssues(issues), { total: issues.length, questions: 1, evidence: 1, unbooked: 1, waitingReceipt: 1, waitingOutlays: 0, unlinked: 1, own: 0, held: 0, bills: 0 });
  assert.equal(countIssues(periodIssues(books, [], '2026-07-01', '2026-09-30', [])).waitingReceipt, 0, 'unbooked, but not held for a receipt');
  // Every period not filed: October's payment too.
  const open = unbookedOpen(held, []);
  assert.deepEqual([open.unbooked, open.waitingReceipt, open.first?.ref], [2, 1, 'SEP']);
  assert.deepEqual(unbookedOpen({ ...held, config: { closedThrough: '2026-12-31' } }, []), { unbooked: 0, waitingReceipt: 0, waitingOutlays: 0 });
});

test('a result that is not final never reads as final, a zero included; an approved return stands (#341 review)', () => {
  const q3 = (kind: 'open' | 'running' | 'filed') => ({ state: { kind }, period: { to: '2026-09-30' } }) as unknown as VatReturn;
  assert.equal(isPending(q3('open'), books, 3), true);
  assert.equal(isPending(q3('open'), books, 0), false, 'nothing open');
  assert.equal(isPending(q3('filed'), books, 3), false);
  const approved: Index = { ...books, config: { ...books.config, approvedReturn: { through: '2026-09-30' } as never } };
  assert.equal(isPending(q3('open'), approved, 3), false, 'approved and locked: the figure stands, with the transfer instruction');
  // The persona's case: the statement is in, nothing is booked, the result is 0.00.
  assert.equal(resultSentence('500', 0, true, 'open', false), 'vat.xZeroPending');
  assert.equal(resultSentence('510', 0, true, 'open', false), 'vat.xZeroPending');
  assert.equal(resultSentence('500', 932.89, true, 'open', false), 'vat.x500Pending');
  assert.equal(resultSentence('500', 932.89, true, 'open', true), 'vat.x500NetRatePending');
  assert.equal(resultSentence('510', 364.41, true, 'running', false), 'vat.x510Pending');
  assert.equal(resultSentence('500', 0, false, 'open', false), 'vat.x500NoneFile', 'a nil return is still due');
  assert.equal(resultSentence('500', 0, false, 'running', false), 'vat.x500None');
  assert.equal(resultSentence('510', 0, false, 'open', false), 'vat.x510None');
  assert.equal(resultSentence('500', 932.89, false, 'open', false), undefined, 'final: the transfer instruction stands');
});

test('«wartet auf ihren Beleg» is one number: the payments receipt-due holds, whatever the page (#341 review)', () => {
  const held: Index = { ...books, transactions: books.transactions.map((t) => (t.ref === 'SEP' || t.ref === 'PAID' ? { ...t, waitsForReceipt: { since: '2026-10-01' } } : t)) };
  assert.deepEqual([...receiptWaits(held, [], '2026-10-05')], ['SEP'], 'PAID carries the mark but is booked: it waits for nothing');
  assert.deepEqual([...receiptWaits(held, [], '2026-11-25')], ['SEP'], 'near its return it is a task on Aufgaben, and still counted as waiting for its receipt');
});

const say = (key: string, vars: Record<string, string | number> = {}) => formatIn({ code: 'de', ...de }, key as never, vars);

test('the open list\'s lead names only what holds the approval in this firm\'s books: no sales report for a firm without one (#428)', () => {
  // The consultancy: no provider, no VAT question left, payments and receipts open.
  const plain = periodIssues(books, [question('q3', 'NATEL', 'answered')], '2026-07-01', '2026-09-30', []);
  assert.ok(plain.length > 0);
  const lead = issuesLead(plain, say);
  assert.doesNotMatch(lead, /Verkaufsbericht|Bestellung|Frage/);
  assert.match(lead, /^Nichts davon hält die Abrechnung auf/);
  // An open VAT question about a sale, and nothing of a sales report.
  assert.match(issuesLead(periodIssues(books, [question('q1', 'KELLER')], '2026-07-01', '2026-09-30', []), say), /^Eine offene Frage zur MWST hält die Freigabe auf\. Das Übrige hält/);
  // A webshop: two orders its report could not split, and one held for another reason (shown, not withheld for).
  const order = (o: string, why: 'rate' | 'test') => ({ provider: 'shop', name: 'Shop', receipt: 'lonely', order: o, why, date: '2026-08-02' }) as never;
  const shop = periodIssues(books, [question('q1', 'KELLER')], '2026-07-01', '2026-09-30', [], undefined, undefined, undefined, { held: [order('#1', 'rate'), order('#2', 'rate'), order('#3', 'test')], bills: [], payouts: {} });
  assert.match(issuesLead(shop, say), /^Eine offene Frage zur MWST und 2 Bestellungen, deren MWST-Sätze der Verkaufsbericht nicht trennen konnte, halten die Freigabe auf\. Das Übrige/);
  const only = periodIssues({ ...books, transactions: [], receipts: [], journalEntries: [] }, [], '2026-07-01', '2026-09-30', [], undefined, undefined, undefined, { held: [order('#1', 'rate')], bills: [], payouts: {} });
  assert.equal(issuesLead(only, say), 'Eine Bestellung, deren MWST-Sätze der Verkaufsbericht nicht trennen konnte, hält die Freigabe auf.', 'nothing else on the list: no word of «the rest»');
});
