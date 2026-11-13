/**
 * A bill paid long after its date by a payment that names its number (#426): the Akonto bill of a
 * compensation fund (07.07.) and its payment (28.09.), the same amount, the bill's own number in the
 * payment's text. Code links it whatever the days between, but only on the exact amount and a number
 * that tells one bill apart: not a short one, not one that is a date or the amount, not one two
 * payments name or two receipts carry, never a payment before its bill. Its title is a compound
 * («Akontorechnung»), which code reads as the bill's title, as it reads «Prämienrechnung».
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPairChain } from '../src/intake/pair-chain.js';
import { nearPairs } from '../src/intake/near-pairs.js';
import { ownNumbers } from '../src/intake/own-invoice.js';
import { documentKind } from '../src/intake/document-kind.js';
import { documents } from '../src/engines/index.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import type { Firm } from '../src/intake/own-invoice.js';

const FIRM: Firm = { uid: 'CHE-111.222.333', name: 'Teegarten Wyss GmbH' };

/** The bill as pdftotext reads the persona's PDF (books-after-drop2.json of round 4): the amounts in a column at the end. */
const akonto = (number = 'AK-26-Q3-30871', title = 'Akontorechnung') => `Ausgleichskasse Luzern
Würzenbachstrasse 8, 6006 Luzern

Teegarten Wyss GmbH
Unterstadt 9
6210 Sursee
${title} ${number}
Datum: 07.07.2026 Periode: 3. Quartal 2026 Lohnsumme gemäss Meldung: CHF 18'750.00

AHV/IV/EO 10.6%
ALV 2.2%
Familienausgleichskasse FAK 1.3%
Verwaltungskosten 2% der AHV/IV/EO-Beiträge
Total CHF
Beiträge von Arbeitgeber und Arbeitnehmenden zusammen. Sozialversicherungsbeiträge unterliegen nicht der MWST.

1987.50
412.50
243.75
39.75
2683.50`;

const bill = (over: Partial<Receipt> = {}, text = akonto()): Receipt => ({
  id: 'akonto', filename: 'akonto.pdf', originalFilename: 'Ausgleichskasse_Luzern_Akonto_Q3_2026.pdf', extractedText: text, extractionMethod: 'pdftotext',
  fileSize: 1, indexedAt: '', location: 'archived', date: '2026-07-07', amount: 2683.5, currency: 'CHF', ...over,
}) as Receipt;
const pay = (ref: string, date: string, amount: number, description: string, counterparty = 'Ausgleichskasse Luzern'): BankTransaction =>
  ({ ref, bank: 'LUKB', date, amount: -amount, currency: 'CHF', direction: 'DBIT', counterparty, description }) as BankTransaction;
const PAYMENT = pay('LUKB-26-0061', '2026-09-28', 2683.5, 'Akonto AHV/IV/EO/ALV Q3 2026 AK-26-Q3-30871');
// Payments around it, as the persona's statement has them: wages, the pension fund, the VAT.
const OTHERS = [
  pay('LUKB-26-0010', '2026-07-10', 398.4, 'Beiträge Q3 2026 PK-26-3-1180', 'Pensionskasse Zentral'),
  pay('LUKB-26-0020', '2026-07-24', 4200, 'Lohn Juli 2026', 'Nora Wyss'),
  pay('LUKB-26-0050', '2026-08-26', 2208.35, 'MWST 2. Quartal 2026', 'Eidg. Steuerverwaltung ESTV'),
];

const books = (receipts: Receipt[], transactions: BankTransaction[]): Books =>
  ({ receipts, transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const run = (b: Books) => runPairChain(port(b), { toChf: (a) => a, firm: FIRM });
const links = (b: Books) => b.mappings.map((m) => [m.receiptId, m.transactionRef]);

test('a compound title is the bill\'s title: «Akontorechnung AK-26-Q3-30871» is a receipt with its own number', () => {
  assert.equal(documentKind(akonto(), documents()).is, 'receipt');
  assert.deepEqual(ownNumbers({ extractedText: akonto() }), ['AK26Q330871']);
  assert.deepEqual(ownNumbers({ extractedText: akonto('PR-2026-2210', 'Prämienrechnung') }), ['PR20262210']);
  // A short title word is no compound's head: «Waybill 4471» is no bill of its own.
  assert.deepEqual(ownNumbers({ extractedText: akonto('77123456', 'Waybill') }), []);
  // A payslip and a calculation end in «…rechnung» too, and are no bill (documents.yaml notCompound).
  const payslip = 'Teegarten Wyss GmbH\nUnterstadt 9, 6210 Sursee\nLohnabrechnung Juli 2026\nNora Wyss, Geschäftsführerin\nBruttolohn 4700.00\nAHV/IV/EO 5.3% -249.10\nNettolohn, Auszahlung am 25. Juli 4200.00';
  assert.notEqual(documentKind(payslip, documents()).is, 'receipt');
  assert.deepEqual(ownNumbers({ extractedText: akonto('B-2026-7', 'Berechnung') }), []);
});

test('the Akonto bill, paid 83 days after its date by a payment naming its number with the same amount: linked by code', async () => {
  const b = books([bill()], [PAYMENT, ...OTHERS]);
  const r = await run(b);
  assert.deepEqual(links(b), [['akonto', 'LUKB-26-0061']]);
  assert.equal(r.linked[0].by, 'code');
  assert.match(b.mappings[0].rule!, /^pair:amount\+.*number\+near$/);
});

test('whatever the days between: 200 days after the bill too', async () => {
  const b = books([bill({ date: '2026-03-12' })], [PAYMENT, ...OTHERS]);
  await run(b);
  assert.deepEqual(links(b), [['akonto', 'LUKB-26-0061']]);
});

test('the same bill staged in the drop (provisional facts) is linked in the same run, before the payment is booked', async () => {
  const staged = bill({ location: 'staged', date: undefined, amount: undefined, currency: undefined });
  const b = books([staged], [PAYMENT, ...OTHERS]);
  const r = await runPairChain(port(b), { toChf: (a) => a, firm: FIRM, staged: [bill({ location: 'archived' })] });
  assert.deepEqual(r.staged.map((l) => [l.receipt, l.payment, l.by]), [['akonto', 'LUKB-26-0061', 'code']]);
});

test('past the terms only the exact amount: 5 Rappen off or less a discount is offered, not linked', async () => {
  const rounded = books([bill()], [{ ...PAYMENT, amount: -2683.55 }]);
  await run(rounded);
  assert.deepEqual(rounded.mappings, []);
  assert.equal(nearPairs(rounded, { isClosed: () => false, firm: FIRM }).length, 1, 'offered');
});

test('negatives past the terms: a short number, a number that is a date or the amount, two payments naming it, two receipts carrying it, a payment before the bill', async () => {
  const late = (number: string, description: string) => {
    const b = books([bill({}, akonto(number))], [pay('p', '2026-09-28', 2683.5, description)]);
    return b;
  };
  for (const [number, why] of [['AK-471', 'five characters'], ['20260707', 'a date'], ['268350', 'the amount in cents'], ['2683', 'the amount in francs']] as const) {
    const b = late(number, `Akonto ${number}`);
    await run(b);
    assert.deepEqual(b.mappings, [], why);
  }
  const twice = books([bill()], [PAYMENT, pay('again', '2026-10-05', 2683.5, 'Akonto Q3 AK-26-Q3-30871 Nachzahlung')]);
  await run(twice);
  assert.deepEqual(twice.mappings, [], 'two payments name the number');
  const copies = books([bill(), bill({ id: 'copy', filename: 'copy.pdf' })], [PAYMENT]);
  await run(copies);
  assert.deepEqual(copies.mappings, [], 'two receipts carry the number');
  const before = books([bill({ date: '2026-10-15' })], [PAYMENT]);
  await run(before);
  assert.deepEqual(before.mappings, [], 'the payment lies before the bill');
});

test('within the terms nothing changed: a short number with the same amount 10 days later is linked as before', async () => {
  const b = books([bill({}, akonto('AK-471'))], [pay('p', '2026-07-17', 2683.5, 'Akonto AK-471')]);
  await run(b);
  assert.deepEqual(links(b), [['akonto', 'p']]);
});
