import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textFacts } from '../src/parsers/receipt-text.js';

// What pdf.js gives for a two-column invoice: the labels first, the amounts after them.
const COLUMNS = `Farbmix AG
Farbweg 3, 9000 St. Gallen
MWST-Nr. CHE-123.456.789 MWST
Malerei Huber GmbH
Rechnung FM-77812
Datum: 28.06.2026
Artikel
Dispersionsfarbe weiss 15 l, 8 Stk
Total exkl. MWST
MWST 8.1%
Total CHF
Zahlbar innert 30 Tagen bis 28.07.2026.
Betrag CHF
682.40
196.00
271.95
1150.35
93.20
1243.55`;

test('a two-column invoice: date, total, currency and the 8.1 % group from the arithmetic, the UID with MWST', () => {
  assert.deepEqual(textFacts(COLUMNS), {
    date: '2026-06-28', amount: 1243.55, currency: 'CHF', vatId: 'CHE-123.456.789',
    vatSummary: [{ ratePercent: 8.1, net: 1150.35, vat: 93.2, gross: 1243.55 }],
  });
});

test('a till receipt: the total on its line, VAT included at 8.1 %, apostrophes in thousands', () => {
  const till = `Baucenter Gossau\nCHE-999.888.777 MWST\nLeiter Alu 3x9 1'209.50\nTOTAL CHF 1'312.90\ninkl. MWST 8.1%: 98.37\n12.08.2026 14:32`;
  assert.deepEqual(textFacts(till), {
    date: '2026-08-12', amount: 1312.9, currency: 'CHF', vatId: 'CHE-999.888.777',
    vatSummary: [{ ratePercent: 8.1, vat: 98.37, gross: 1312.9 }],
  });
});

test('no Swiss VAT shown: the amount and date only, nothing about VAT (absence is decided elsewhere)', () => {
  const premium = `Die Mobiliar\nPrämienrechnung Betriebshaftpflicht\nRechnungsdatum 01.09.2026\nPrämie 01.09.2026–31.08.2027 980.00\nTotal CHF 980.00\nVersicherungsprämien sind von der MWST ausgenommen.`;
  assert.deepEqual(textFacts(premium), { date: '2026-09-01', amount: 980, currency: 'CHF' });
});

test('a UID without MWST next to it is no VAT number; a total without a label is not guessed', () => {
  assert.deepEqual(textFacts('Handelsregister CHE-123.456.789\nIrgendwas 12.50\n7.20'), {});
});

test('euro invoices keep their currency', () => {
  assert.deepEqual(textFacts('Rechnungsdatum: 03.07.2026\nGesamtbetrag 49,90 EUR\n'), { date: '2026-07-03', amount: 49.9, currency: 'EUR' });
});
