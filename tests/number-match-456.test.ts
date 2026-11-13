/**
 * The consultancy's Akonto bill and its payment (#456, round 5 r3-11): the bill AK-2026-Q3-4471 of
 * 06.07. and the payment of 25.09. with the same amount and the number in its text were not matched
 * in the drop, though #431 matches a bill by its number past its terms. The rule was never asked:
 * the app's file of the compensation fund says its payments need no receipt to be booked
 * (`apply: { receipt: none }`), and the matching chain took that as «has no receipt of its own», so
 * the fund's payment was no candidate for its own bill. A business's file frees its payments from
 * the wait only, as a wage's wording does: its bill is still paired. And in «Zahlung verknüpfen» the
 * payment with the same amount that carries the bill's own number ranks above a «Skonto?» guess.
 *
 * The bill's text is the persona's PDF as pdftotext reads it (persona-files/consulting.mjs, the
 * books of the round 5 walk), the payments the persona's camt.053 rows as the parser reads them.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noReceiptFor, runPairChain } from '../src/intake/pair-chain.js';
import { provisional } from '../src/intake/match.js';
import { receiptWaitOf, receiptKnowledge } from '../src/booking/receipt-wait.js';
import { loadClassifyContext } from '../src/booking/classify.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { candidates, ledgerOf } from '../src/app/areas/receipts/model.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import type { Firm } from '../src/intake/own-invoice.js';
import { DEMO_ROOT } from './support/workspace.js';

const FIRM: Firm = { name: 'Kälin Advisory GmbH', owner: 'Matthias Kälin' };
/** A workspace with the app's knowledge, the compensation fund's file among it (processes/authorities/ausgleichskasse.yaml). */
const ws = workspaceAt(DEMO_ROOT);

const AKONTO_TEXT = `Ausgleichskasse Zug
Baarerstrasse 11, 6300 Zug

Kälin Advisory GmbH
Baarerstrasse 41
6300 Zug
Akontorechnung AK-2026-Q3-4471
Datum: 06.07.2026 Periode: 3. Quartal 2026 Lohnsumme gemäss Meldung: CHF 28'500.00

AHV/IV/EO 10.6%
ALV 2.2%
Familienausgleichskasse FAK 1.3%
Verwaltungskosten 2% der AHV/IV/EO-Beiträge
Total CHF
Beiträge von Arbeitgeber und Arbeitnehmenden zusammen. Sozialversicherungsbeiträge unterliegen nicht der MWST.

3021.00
627.00
370.50
60.42
4078.92`;

/** The bill as the drop stages it: nothing read by a model yet. */
const staged = (): Receipt => ({
  id: 'akonto', filename: 'Ausgleichskasse_Akonto_Q3_2026.pdf', originalFilename: 'Ausgleichskasse_Akonto_Q3_2026.pdf', extractedText: AKONTO_TEXT,
  extractionMethod: 'pdftotext', fileSize: 58282, indexedAt: '2026-11-13T11:29:34.371Z', location: 'staged',
}) as Receipt;
const archived = (): Receipt => ({ ...staged(), location: 'archived', date: '2026-07-06', amount: 4078.92, currency: 'CHF' }) as Receipt;

const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Zuger Kantonalbank', date, amount, currency: 'CHF', direction: 'DBIT', description, reference: description, counterparty }) as BankTransaction;
const AKONTO = pay('ZGKB-26-0026', '2026-09-25', 4078.92, 'Ausgleichskasse Zug', 'Akonto Q3 2026 AK-2026-Q3-4471');
/** The ESTV's payment 4.1 % below the bill: the picker's «Skonto?» guess. */
const ESTV = pay('ZGKB-26-0020', '2026-08-27', 3912.45, 'Eidg. Steuerverwaltung ESTV', 'MWST 2. Quartal 2026');
const PAYMENTS = [
  pay('ZGKB-26-0001', '2026-07-01', 520, 'Werkplatz Coworking AG', 'Rechnung WP-26-07-118'),
  pay('ZGKB-26-0004', '2026-07-10', 1740, 'Vorsorgestiftung Zentralschweiz', 'Beitrag Q3 2026 BVG-26-3-0918'),
  pay('ZGKB-26-0008', '2026-07-24', 8602, 'Matthias Kälin', 'Lohn Juli 2026'),
  pay('ZGKB-26-0016', '2026-08-25', 8602, 'Matthias Kälin', 'Lohn August 2026'),
  ESTV,
  pay('ZGKB-26-0025', '2026-09-25', 8602, 'Matthias Kälin', 'Lohn September 2026'),
  AKONTO,
];

const books = (receipts: Receipt[]): Books =>
  ({ receipts, transactions: structuredClone(PAYMENTS), mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;
const port = (b: Books) => ({ read: () => b, update: <T>(fn: (x: Books) => T) => fn(b) });
const chain = (b: Books, stagedNow?: Receipt[]) => runPairChain(port(b), { toChf: (a) => a, firm: FIRM, noReceipt: noReceiptFor(ws), ...(stagedNow && { staged: stagedNow }) });

test('the fund\'s payment is booked without waiting for a receipt, and is still a candidate for its bill', () => {
  const b = books([]);
  const wait = receiptWaitOf(b, AKONTO, loadClassifyContext(ws), receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws), loadFxResolver());
  assert.deepEqual(wait, { wait: false, why: 'business' }, 'the fund\'s file: its payments need no receipt to be booked');
  assert.equal(noReceiptFor(ws)(b)(AKONTO), false, 'but its bill is its receipt: the chain pairs it');
});

test('in the drop: the staged Akonto bill is linked by code to the payment naming AK-2026-Q3-4471, 81 days later, before the payment is booked', async () => {
  const s = staged();
  const early = provisional(s);
  assert.deepEqual(early && [early.date, early.amount, early.currency], ['2026-07-06', 4078.92, 'CHF'], 'code reads the bill\'s day and total');
  const r = await chain(books([s]), [early!]);
  assert.deepEqual(r.staged.map((l) => [l.receipt, l.payment, l.by]), [['akonto', 'ZGKB-26-0026', 'code']]);
});

test('archived: the bill and its payment are linked by their number, nothing else', async () => {
  const b = books([archived()]);
  await chain(b);
  assert.deepEqual(b.mappings.map((m) => [m.receiptId, m.transactionRef]), [['akonto', 'ZGKB-26-0026']]);
  assert.match(b.mappings[0].rule!, /number\+near$/);
});

test('Zahlung verknüpfen: the payment of the same amount that carries the bill\'s own number ranks first, above the ESTV\'s «Skonto?»', () => {
  const index = { ...books([archived()]), transactions: structuredClone(PAYMENTS) } as unknown as Index;
  const l = ledgerOf(index, '2026-07-01');
  const { best } = candidates(l.byId.get('akonto')!, l, (a) => a);
  assert.deepEqual(best.map((c) => c.tx.ref).slice(0, 2), ['ZGKB-26-0026', 'ZGKB-26-0020'], JSON.stringify(best.map((c) => [c.tx.ref, c.fit])));
  assert.equal(best[1].fit?.kind, 'skonto', 'the ESTV payment is still offered, as a guess, below it');
});

test('in the picker a number alone outranks nothing: the same number on a payment of another amount stays below the closer guess', () => {
  const other = { ...AKONTO, ref: 'ZGKB-26-0027', amount: 3500 };
  const index = { ...books([archived()]), transactions: [...PAYMENTS.filter((t) => t !== AKONTO), other] } as unknown as Index;
  const l = ledgerOf(index, '2026-07-01');
  const { best, more } = candidates(l.byId.get('akonto')!, l, (a) => a);
  assert.equal(best[0]?.tx.ref, 'ZGKB-26-0020');
  assert.ok(more.some((c) => c.tx.ref === 'ZGKB-26-0027'));
});
