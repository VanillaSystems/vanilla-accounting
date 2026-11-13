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
// Payments around it, as the persona's statement has them from 1 July: a fee, the pension fund, wages, the VAT.
const OTHERS = [
  pay('LUKB-26-0001', '2026-07-01', 5, 'Kontoführung', 'Luzerner Kantonalbank'),
  pay('LUKB-26-0010', '2026-07-10', 398.4, 'Beiträge Q3 2026 PK-26-3-1180', 'Pensionskasse Zentral'),
  pay('LUKB-26-0020', '2026-07-24', 4200, 'Lohn Juli 2026', 'Nora Wyss'),
  pay('LUKB-26-0050', '2026-08-26', 2208.35, 'MWST 2. Quartal 2026', 'Eidg. Steuerverwaltung ESTV'),
];
/** The books' payments from 1 January: a bill of the spring lies after the first of them. */
const SINCE_JANUARY = [...OTHERS, pay('LUKB-26-J', '2026-01-05', 5, 'Kontoführung', 'Luzerner Kantonalbank')];

const books = (receipts: Receipt[], transactions: BankTransaction[]): Books =>
  ({ receipts, transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const run = (b: Books) => runPairChain(port(b), { toChf: (a) => a, firm: FIRM });
const links = (b: Books) => b.mappings.map((m) => [m.receiptId, m.transactionRef]);
const kind = (text: string) => documentKind(text, documents()).is;

test('a compound title with a number of its own is the bill\'s title: «Akontorechnung AK-26-Q3-30871» is a receipt with its own number', () => {
  assert.equal(kind(akonto()), 'receipt');
  assert.deepEqual(ownNumbers({ extractedText: akonto() }), ['AK26Q330871']);
  assert.deepEqual(ownNumbers({ extractedText: akonto('PR-2026-2210', 'Prämienrechnung') }), ['PR20262210']);
  // A short title word is no compound's head: «Waybill 4471» is no bill of its own.
  assert.deepEqual(ownNumbers({ extractedText: akonto('77123456', 'Waybill') }), []);
  // A payslip and a calculation end in «…rechnung» too, and are no bill (documents.yaml notCompound).
  const payslip = 'Teegarten Wyss GmbH\nUnterstadt 9, 6210 Sursee\nLohnabrechnung Juli 2026\nNora Wyss, Geschäftsführerin\nBruttolohn 4700.00\nAHV/IV/EO 5.3% -249.10\nNettolohn, Auszahlung am 25. Juli 4200.00';
  assert.notEqual(kind(payslip), 'receipt');
  assert.deepEqual(ownNumbers({ extractedText: akonto('B-2026-7', 'Berechnung') }), []);
});

test('no compound title without a number of its own: annual accounts, calculations, an interest or a wage credit, a pro-forma invoice', () => {
  const docs: Record<string, string> = {
    Erfolgsrechnung: 'Treuhand Muster AG\nErfolgsrechnung 2025\nVanilla GmbH\nUmsatz 120000\nAufwand 80000\nTotal 40000\nMWST 8.1%',
    Jahresrechnung: 'Jahresrechnung 2025\nMusterfirma GmbH\nBilanz per 31.12.2025\nTotal Aktiven CHF 50\'000.00\nMWST 8.1% 1200.00',
    Geldflussrechnung: 'Geldflussrechnung 2025\nTotal CHF 12\'000.00',
    Kostenrechnung: 'Kostenrechnung Projekt Alpha\nTotal CHF 8\'000.00\nMWST 8.1%',
    Wirtschaftlichkeitsrechnung: 'Wirtschaftlichkeitsrechnung Photovoltaik\nTotal CHF 20\'000.00\nMWST 8.1%',
    Zinsgutschrift: 'Zürcher Kantonalbank\nZinsgutschrift 31.12.2026\nKonto 12-3456-7\nTotal CHF 12.30',
    Lohngutschrift: 'Lohngutschrift Juli 2026\nNettolohn 4200.00\nTotal CHF 4200.00',
    Proformarechnung: 'Lieferant AG\nProformarechnung PF-2026-0815\nTotal CHF 1\'250.00\nMWST 8.1% 93.75\nzahlbar innert 30 Tagen',
    'a date after it': 'Lieferant AG\nPrämienrechnung 01.07.2026\nTotal CHF 200.00\nMWST 8.1%',
    'a month after it': 'Lieferant AG\nBeitragsrechnung 2026-07\nTotal CHF 200.00\nMWST 8.1%',
  };
  for (const [name, text] of Object.entries(docs)) {
    // A pro-forma invoice shows most of an invoice and stays what the other words make it; it has no number of its own.
    if (name !== 'Proformarechnung') assert.notEqual(kind(text), 'receipt', name);
    assert.deepEqual(ownNumbers({ extractedText: text }), [], name);
  }
});

test('a compound title never outranks a reminder or an order confirmation below it', () => {
  assert.equal(kind('Versicherung AG\nPrämienrechnung PR-2026-2210\n2. Mahnung\nTotal CHF 450.00\nzahlbar innert 10 Tagen'), 'supporting');
  assert.equal(kind('Lieferant AG\nTeilrechnung TR-5521\nAuftragsbestätigung AB-5521\nTotal CHF 900.00 MWST 8.1%'), 'supporting');
});

test('only the head\'s first compound title gives the number: a final invoice that lists the Akonto bills paid carries none of theirs', async () => {
  const final = 'Bau AG\nSchlussrechnung SR-2026-0042\nDatum: 30.09.2026\nAkontorechnung AK-2026-0101 bezahlt 5000.00\nAkontorechnung AK-2026-0102 bezahlt 5000.00\nTotal CHF 3\'500.00\nzahlbar innert 30 Tagen';
  assert.deepEqual(ownNumbers({ extractedText: final }), ['SR20260042']);
  const ak = bill({ id: 'ak1', date: '2026-07-01', amount: 5000 }, akonto('AK-2026-0101'));
  const b = books([ak, bill({ id: 'sr', date: '2026-09-30', amount: 3500 }, final)], [pay('pak', '2026-07-20', 5000, 'Akonto AK-2026-0101', 'Bau AG'), ...OTHERS]);
  await run(b);
  assert.deepEqual(links(b), [['ak1', 'pak']]);
});

test('a compound credit note pays in: «Warengutschrift WG-2026-0071» is no pair of money out naming it', async () => {
  const credit = bill({ id: 'wg', date: '2026-07-10', amount: 120 }, 'Lieferant AG\nWarengutschrift WG-2026-0071\nDatum: 10.07.2026\nTotal CHF 120.00\nMWST 8.1% 9.00');
  const b = books([credit], [pay('w', '2026-09-30', 120, 'Verrechnung WG-2026-0071', 'Lieferant AG'), ...OTHERS]);
  await run(b);
  assert.deepEqual(b.mappings, []);
  assert.deepEqual(nearPairs(b, { isClosed: () => false, firm: FIRM }), []);
});

test('the Akonto bill, paid 83 days after its date by a payment naming its number with the same amount: linked by code', async () => {
  const b = books([bill()], [PAYMENT, ...OTHERS]);
  const r = await run(b);
  assert.deepEqual(links(b), [['akonto', 'LUKB-26-0061']]);
  assert.equal(r.linked[0].by, 'code');
  assert.match(b.mappings[0].rule!, /^pair:amount\+.*number\+near$/);
});

test('up to half a year after the bill: 170 days linked, 181 days offered only', async () => {
  const b = books([bill({ date: '2026-04-11' })], [PAYMENT, ...SINCE_JANUARY]);
  await run(b);
  assert.deepEqual(links(b), [['akonto', 'LUKB-26-0061']]);
  const far = books([bill({ date: '2026-03-31' })], [PAYMENT, ...SINCE_JANUARY]);
  await run(far);
  assert.deepEqual(far.mappings, []);
});

test('past the terms never a bill older than the books\' first payment: last year\'s licence or policy bill that keeps its number', async () => {
  const licence = bill({ id: 'lic', date: '2025-08-01', amount: 1081, hasSwissVat: true }, 'Software Muster AG\nZürich\n\nTeegarten Wyss GmbH\nLizenzrechnung KD-447120\nDatum: 01.08.2025\nTotal CHF 1\'081.00\nMWST 8.1% 81.00\nzahlbar innert 30 Tagen');
  const lic = books([licence], [pay('l26', '2026-09-05', 1081, 'Lizenz 2026 KD-447120', 'Software Muster AG'), ...OTHERS]);
  await run(lic);
  assert.deepEqual(lic.mappings, [], 'its input tax would go onto this year\'s payment');
  // Within half a year too: a bill dated before the statements begin may have been paid before them.
  const early = books([bill({ date: '2026-06-20' })], [PAYMENT, ...OTHERS]);
  await run(early);
  assert.deepEqual(early.mappings, [], 'dated before the books\' first payment');
});

test('the same bill staged in the drop (provisional facts) is linked in the same run, before the payment is booked', async () => {
  const staged = bill({ location: 'staged', date: undefined, amount: undefined, currency: undefined });
  const b = books([staged], [PAYMENT, ...OTHERS]);
  const r = await runPairChain(port(b), { toChf: (a) => a, firm: FIRM, staged: [bill({ location: 'archived' })] });
  assert.deepEqual(r.staged.map((l) => [l.receipt, l.payment, l.by]), [['akonto', 'LUKB-26-0061', 'code']]);
});

test('past the terms only the exact amount: 5 Rappen off or less a discount is offered, not linked', async () => {
  const rounded = books([bill()], [{ ...PAYMENT, amount: -2683.55 }, ...OTHERS]);
  await run(rounded);
  assert.deepEqual(rounded.mappings, []);
  assert.equal(nearPairs(rounded, { isClosed: () => false, firm: FIRM }).filter((p) => p.receipt === 'akonto').length, 1, 'offered');
});

test('negatives past the terms: a short number, a number that is a day, a month or the amount, two payments naming it, two receipts carrying it, a payment before the bill', async () => {
  const late = (number: string) => books([bill({}, akonto(number))], [pay('p', '2026-09-28', 2683.5, `Akonto ${number}`), ...OTHERS]);
  const control = late('AK-26-Q3-30871');
  await run(control);
  assert.deepEqual(links(control), [['akonto', 'p']], 'the same books with a telling number link');
  for (const [number, why] of [['AK-471', 'five characters'], ['20260707', 'a date'], ['260301', 'a date yymmdd'], ['2026-07', 'a month'], ['202607', 'a month yyyymm'], ['268350', 'the amount in cents'], ['2683', 'the amount in francs']] as const) {
    const b = late(number);
    await run(b);
    assert.deepEqual(b.mappings, [], why);
  }
  const twice = books([bill()], [PAYMENT, pay('again', '2026-10-05', 2683.5, 'Akonto Q3 AK-26-Q3-30871 Nachzahlung'), ...OTHERS]);
  await run(twice);
  assert.deepEqual(twice.mappings, [], 'two payments name the number');
  const copies = books([bill(), bill({ id: 'copy', filename: 'copy.pdf' })], [PAYMENT, ...OTHERS]);
  await run(copies);
  assert.deepEqual(copies.mappings, [], 'two receipts carry the number');
  const before = books([bill({ date: '2026-10-15' })], [PAYMENT, ...OTHERS]);
  await run(before);
  assert.deepEqual(before.mappings, [], 'the payment lies before the bill');
});

test('within the terms nothing changed: a short number with the same amount 10 days later is linked as before', async () => {
  const b = books([bill({}, akonto('AK-471'))], [pay('p', '2026-07-17', 2683.5, 'Akonto AK-471'), ...OTHERS]);
  await run(b);
  assert.deepEqual(links(b), [['akonto', 'p']]);
});
