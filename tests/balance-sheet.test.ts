/**
 * A balance sheet dropped among the receipts (#427, persona rounds 4: webshop-ai-r2-11, consulting-ai-r2-14):
 * the fiduciary's «Bilanz per 31.12.2025» and «Zwischenbilanz per 30.06.2026» were taken as receipts with
 * their total as the amount, waiting for a payment. By its words it is a balance sheet: kept beside the
 * receipts like an order confirmation, never paid, and the one of the last day of the year before is
 * offered for the opening of the books' first year.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents } from '../src/engines/index.js';
import { documentKind } from '../src/intake/document-kind.js';
import { recognize } from '../src/intake/recognize.js';
import { statementFacts } from '../src/books/statement-facts.js';
import { balanceSheetOf, noneWhyOf } from '../src/app/areas/receipts/model.js';
import { closingGroupOf } from '../src/app/shell/drop-summary.js';
import type { DropRow } from '../src/types/drop.js';
import type { Index, Receipt } from '../src/types/index.js';
import { textPdf } from './support/text-pdf.js';

const W = documents();

// As the app reads the persona's PDF (src/intake/recognize.ts firstPages): the columns one after the other.
const BILANZ = ['Kälin Advisory GmbH', 'Baarerstrasse 41, 6300 Zug', 'Bilanz per 31.12.2025', 'Aktiven', '1020', '1021', '1520', 'Total Aktiven', 'Passiven', '2201', '2451', '2800', '2970', '',
  'Zuger Kantonalbank', 'Wise EUR (EUR 1\'200.00)', 'Informatik', '', '29\'118.40', '1\'126.01', '2\'400.00', '32\'644.41', '',
  'Abrechnungskonto MWST (4. Quartal 2025)', 'Kontokorrent Matthias Kälin', 'Stammkapital', 'Gewinnvortrag', 'Total Passiven',
  'Erstellt durch Treuhand Zugersee AG, Zug. Fremdwährungskonten zum ESTV-Devisenkurs des Stichtags.', '', '3\'104.80', '1\'250.00', '20\'000.00', '8\'289.61', '32\'644.41'];
const ZWISCHEN = ['Teegarten Wyss GmbH', 'Unterstadt 9, 6210 Sursee', 'Zwischenbilanz per 30.06.2026', 'Aktiven', '1020', '1093', '1200', 'Total Aktiven', 'Passiven', '2201', '2800', '2970', '',
  'Luzerner Kantonalbank', 'Guthaben Shopify Payments', 'Warenlager', '', '21\'460.25', '1\'236.18', '8\'400.00', '31\'096.43', '', 'Total Passiven', '31\'096.43'];

test('a balance sheet, also an interim one, is told by its title: kept beside the receipts, never a receipt to pay', () => {
  assert.deepEqual(documentKind(BILANZ.join('\n'), W), { is: 'supporting', why: 'balance-sheet' });
  assert.deepEqual(documentKind(ZWISCHEN.join('\n'), W), { is: 'supporting', why: 'balance-sheet' });
  assert.equal(statementFacts({ extractedText: BILANZ.join('\n'), filename: 'Bilanz_31.12.2025_Treuhand.pdf', originalFilename: 'Bilanz_31.12.2025_Treuhand.pdf' }, W), undefined, 'no bank statement');
  assert.deepEqual(documentKind('Bilan au 31.12.2025\nActifs\nBanque 12\'000.00\nTotal des actifs 12\'000.00', W), { is: 'supporting', why: 'balance-sheet' }, 'in French too');
});

test('the fiduciary\'s invoice for making the balance sheet stays an invoice, whatever word comes first (PR #433 review)', () => {
  const tail = '\nMWST 8.1 % 138.62\nTotal CHF 1\'850.00\nZahlbar innert 30 Tagen';
  const invoices = {
    'invoice title first': 'Treuhand Zugersee AG\nRechnung 2026-031\nJahresabschluss 2025: Bilanz und Erfolgsrechnung 1\'711.38' + tail,
    'Honorarrechnung … inkl. Bilanz': 'Treuhand Zugersee AG\nHonorarrechnung Jahresabschluss 2025 inkl. Bilanz' + tail,
    'Honorarrechnung Bilanz': 'Honorarrechnung Bilanz 2025\nTreuhand Zugersee AG\nTotal CHF 1\'850.00\nMWST 8.1 % 138.62\nZahlbar innert 30 Tagen',
    'a letterhead named Bilanz': 'Bilanz Treuhand GmbH\nSeestrasse 1, 6300 Zug\nRechnung Nr. 55\nBuchführung 2025 1\'000.00\nMWST 8.1 % 81.00\nTotal CHF 1\'081.00\nZahlbar innert 30 Tagen',
    'what it was for, then its title': 'Treuhand Zugersee AG\nLeistungen: Erstellung Bilanz und Erfolgsrechnung 2025\nRechnung 2026-12' + tail,
    'Italian': 'Studio Fiduciario Lugano\nOnorario bilancio 2025\nFattura n. 12\nIVA 8.1 % 81.00\nTotale CHF 1\'081.00',
    'Rechnung für Bilanzerstellung': 'Rechnung für Bilanzerstellung\nTreuhand Zugersee AG' + tail,
    'French': 'Facture – bilan annuel\nFiduciaire Léman SA\nTVA 8.1 % 81.00\nTotal CHF 1\'081.00\nPayable jusqu\'au 30.09.2026',
  };
  for (const [name, text] of Object.entries(invoices)) assert.equal(documentKind(text, W).is, 'receipt', name);
});

test('dropped as a PDF, its row names it a balance sheet', async () => {
  const r = await recognize(await textPdf(BILANZ.filter(Boolean)), 'Bilanz_31.12.2025_Treuhand.pdf');
  assert.deepEqual([r.kind, r.state, r.document], ['receipt', 'take', 'balance-sheet']);
});

const receipt = (date: string): Receipt => ({
  id: date, filename: `${date.replace(/-/g, '')}-bilanz.pdf`, originalFilename: 'Bilanz.pdf', extractedText: BILANZ.join('\n'), extractionMethod: 'pdftotext',
  fileSize: 1, indexedAt: '2026-11-13T09:00:00Z', location: 'archived', date, amount: 32644.41, kind: 'supporting', kindBy: 'rule', kindRule: 'document:balance-sheet',
});
const books = (over: Partial<Index> = {}): Index => ({
  receipts: [], mappings: [], bankStatements: [], journalEntries: [], config: {},
  transactions: [{ ref: 't', bank: 'ZKB', date: '2026-07-03', amount: 10, currency: 'CHF', direction: 'DBIT', description: 't' }],
  ...over,
});

test('the balance sheet of the last day of the year before is the opening of the books\' first year; another one is not', () => {
  assert.equal(noneWhyOf(receipt('2025-12-31')), 'balance-sheet');
  assert.deepEqual(balanceSheetOf(receipt('2025-12-31'), books(), '2026-11-13'), { date: '2025-12-31', year: '2026', opens: true });
  assert.deepEqual(balanceSheetOf(receipt('2026-06-30'), books(), '2026-11-13'), { date: '2026-06-30', year: '2026', opens: false });
  assert.deepEqual(balanceSheetOf(receipt('2025-12-31'), books({ config: { closedThrough: '2026-12-31' } }), '2027-02-01')?.opens, false, 'a closed year keeps its opening: no link into a refusal');
  assert.equal(balanceSheetOf({ ...receipt('2025-12-31'), kind: 'invoice', kindRule: undefined, kindBy: 'human' }, books(), '2026-11-13'), undefined, 'a person said it is a receipt');
  assert.deepEqual(balanceSheetOf({ ...receipt('2025-12-31'), date: undefined }, books(), '2026-11-13'), { date: '2025-12-31', year: '2026', opens: true }, 'not read by a model: its day as code reads it off «Bilanz per 31.12.2025»');
});

test('the drop\'s closing lines count it apart, never as a receipt read without a payment', () => {
  const row = { state: 'taken' } as DropRow;
  assert.equal(closingGroupOf(row, { kind: 'balanceSheet' }), 'balanceSheet');
});
