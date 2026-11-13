import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textFacts, type TextFacts } from '../src/parsers/receipt-text.js';

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

test('no Swiss VAT said in words: the amount and date, and «no Swiss VAT» as a read fact', () => {
  const premium = `Die Mobiliar\nPrämienrechnung Betriebshaftpflicht\nRechnungsdatum 01.09.2026\nPrämie 01.09.2026–31.08.2027 980.00\nTotal CHF 980.00\nVersicherungsprämien sind von der MWST ausgenommen.`;
  assert.deepEqual(textFacts(premium), { date: '2026-09-01', amount: 980, currency: 'CHF', noSwissVat: true });
});

test('silence is no «no Swiss VAT»: a total without any VAT line says nothing about VAT', () => {
  assert.deepEqual(textFacts('Rechnung 7\nDatum: 02.07.2026\nBeiträge Q3\nTotal CHF\n\n1740.00\n1740.00'), { date: '2026-07-02', amount: 1740, currency: 'CHF' });
});

test('«ohne MWST» on a net line is no «no Swiss VAT»; a Swiss rate on the receipt rules it out', () => {
  const t = 'Rechnung 9\nDatum: 02.07.2026\nPreis ohne MWST 100.00\nMWST 8.1% 8.10\nTotal CHF 108.10\nReverse charge does not apply';
  assert.equal(textFacts(t).noSwissVat, undefined);
});

test('unclear stays unread: a statement, a down payment below the largest amount, two invoices in one PDF', () => {
  const statement = 'Zuger Kantonalbank\nKontoauszug 01.07.2026 – 30.09.2026\nSaldovortrag\nTotal\n\n100.00\n50.00';
  assert.equal(textFacts(statement).amount, undefined);
  const deposit = 'Rechnung 12\nDatum: 01.07.2026\nTotal\nAnzahlung\nZu zahlen\n\n1000.00\n400.00\n600.00';
  assert.equal(textFacts(deposit).amount, undefined);
  const two = 'Rechnung 1\nTotal CHF\n\n100.00\n\fRechnung 2\nTotal CHF\n\n200.00';
  assert.equal(textFacts(two).amount, undefined);
});

/**
 * Every text PDF of the three personas (.claude/skills/verify/persona-files.mjs, `--persona huber`,
 * `webshop`, `consulting`), as pdf.js reads it (src/parsers/pdf-text.ts, the copies « (1)» left out):
 * what a person reads off each without a model. `noSwissVat` only where the document says so; a
 * foreign VAT (19 %, an Irish VAT of 0.00) is no Swiss VAT read, the model reads those.
 */
const TEXTS: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('./fixtures/persona-receipt-texts.json', import.meta.url), 'utf8'));
const g = (ratePercent: number, net: number | undefined, vat: number, gross: number) => ({ ratePercent, ...(net !== undefined ? { net } : {}), vat, gross });
const READ: Record<string, Record<string, Omit<TextFacts, 'vatId'>>> = {
  huber: {
    'Farbmix_AGB_2026.pdf': {},
    'Farbmix_Auftragsbestaetigung_AB-5521.pdf': { date: '2026-07-24' },
    'Farbmix_Herbstaktion.pdf': {},
    'Farbmix_Rechnung_FM-77812.pdf': { date: '2026-06-28', amount: 1243.55, currency: 'CHF', vatSummary: [g(8.1, 1150.35, 93.2, 1243.55)] },
    'Farbmix_Rechnung_FM-78230.pdf': { date: '2026-07-30', amount: 2410.85, currency: 'CHF', vatSummary: [g(8.1, 2230.2, 180.65, 2410.85)] },
    'Farbmix_Rechnung_FM-79010.pdf': { date: '2026-09-28', amount: 1537.22, currency: 'CHF', vatSummary: [g(8.1, 1422.02, 115.2, 1537.22)] },
    'Geruest_August.pdf': { date: '2026-08-01', amount: 1120, currency: 'CHF', vatSummary: [g(8.1, 1036.1, 83.9, 1120)] },
    // A German supplier's 19 %: the total in euro, no Swiss VAT to read off it.
    'Malerbedarf_Konstanz_RE-4471.pdf': { date: '2026-09-29', amount: 412.3, currency: 'EUR' },
    // The premium prints no currency.
    'Mobiliar Police.pdf': { date: '2026-09-01', amount: 980, noSwissVat: true },
    'Rechnung_2026-029_Treppenhaus.pdf': { date: '2026-07-10', amount: 12450, currency: 'CHF', vatSummary: [g(8.1, 11517.1, 932.9, 12450)] },
    // Her own invoice of a sale abroad: «Leistungsort Deutschland: nicht der schweizerischen MWST unterstellt».
    'Rechnung_2026-031_Konstanz.pdf': { date: '2026-09-25', amount: 3200, currency: 'CHF', noSwissVat: true },
    'swisscom_juli.pdf': { date: '2026-07-10', amount: 88.98, currency: 'CHF', vatSummary: [g(8.1, 82.33, 6.65, 88.98)] },
  },
  webshop: {
    // The courier's bill: its own 8.1 % on its fee, the import tax passed on at 0 %.
    'DHL_Zollrechnung_5310772941.pdf': { date: '2026-07-13', amount: 156.49, currency: 'CHF', vatSummary: [g(8.1, 25, 2.03, 27.03), g(0, 129.46, 0, 129.46)] },
    // Export from Japan: no VAT line at all, so nothing about VAT.
    'Invoice_KTW-26-0712.pdf': { date: '2026-07-06', amount: 1960, currency: 'USD' },
    'Kartonage_Rigi_RE-26-4410.pdf': { date: '2026-07-08', amount: 492.29, currency: 'CHF', vatSummary: [g(8.1, 455.4, 36.89, 492.29)] },
    'PostCH_Rechnung_77401180.pdf': { date: '2026-08-03', amount: 1086.42, currency: 'CHF', vatSummary: [g(8.1, 783, 63.42, 846.42), g(0, 240, 0, 240)] },
    'PostCH_Rechnung_77401181.pdf': { date: '2026-09-02', amount: 1070.86, currency: 'CHF', vatSummary: [g(8.1, 702, 56.86, 758.86), g(0, 312, 0, 312)] },
    'Shopify_Payments_Invoice_2026-07.pdf': { date: '2026-07-31', amount: 269.23, currency: 'CHF', vatSummary: [g(8.1, 249.06, 20.17, 269.23)] },
    'Shopify_Payments_Invoice_2026-08.pdf': { date: '2026-08-31', amount: 257.32, currency: 'CHF', vatSummary: [g(8.1, 238.04, 19.28, 257.32)] },
    'Shopify_Payments_Invoice_2026-09.pdf': { date: '2026-09-30', amount: 297.3, currency: 'CHF', vatSummary: [g(8.1, 275.02, 22.28, 297.3)] },
    'Shopify_Rechnung_August_2026.pdf': { date: '2026-08-12', amount: 49.62, currency: 'CHF', vatSummary: [g(8.1, 45.9, 3.72, 49.62)] },
    'Shopify_Rechnung_Juli_2026.pdf': { date: '2026-07-12', amount: 49.62, currency: 'CHF', vatSummary: [g(8.1, 45.9, 3.72, 49.62)] },
    'Shopify_Rechnung_September_2026.pdf': { date: '2026-09-12', amount: 49.62, currency: 'CHF', vatSummary: [g(8.1, 45.9, 3.72, 49.62)] },
    'Teeimport_Basel_R-88213.pdf': { date: '2026-08-18', amount: 1374.84, currency: 'CHF', vatSummary: [g(2.6, 1340, 34.84, 1374.84)] },
    // The customs assessment: its import tax as its total; its facts as proof come from src/booking/customs-invoice.ts.
    'Veranlagungsverfuegung_26CHWI000047118823.pdf': { date: '2026-07-10', amount: 129.46, currency: 'CHF' },
  },
  consulting: {
    // A card statement: several dated amounts, no one total of a receipt.
    'Alpencard_Abrechnung_August_2026.pdf': { date: '2026-08-07' },
    'Alpentel_Rechnung_2026-07.pdf': { date: '2026-07-05', amount: 84.35, currency: 'CHF', vatSummary: [g(8.1, undefined, 6.32, 84.35)] },
    'Alpentel_Rechnung_2026-08.pdf': { date: '2026-08-05', amount: 97.2, currency: 'CHF', vatSummary: [g(8.1, undefined, 7.28, 97.2)] },
    'Alpentel_Rechnung_2026-09.pdf': { date: '2026-09-05', amount: 79.9, currency: 'CHF', vatSummary: [g(8.1, undefined, 5.99, 79.9)] },
    'Ausgleichskasse_Akonto_Q3_2026.pdf': { date: '2026-07-06', amount: 3750.2, currency: 'CHF', noSwissVat: true },
    'BVG_Beitragsrechnung_Q3_2026.pdf': { date: '2026-07-02', amount: 1740, currency: 'CHF' },
    'Cloudhaven_Invoice_2026-07.pdf': { date: '2026-07-06', amount: 48, currency: 'USD', noSwissVat: true },
    'Cloudhaven_Invoice_2026-08.pdf': { date: '2026-08-04', amount: 48, currency: 'USD', noSwissVat: true },
    'Cloudhaven_Invoice_2026-09.pdf': { date: '2026-09-04', amount: 48, currency: 'USD', noSwissVat: true },
    // 3.8 % on the night with breakfast, the tourist tax without VAT.
    'Hotel_Pilatusblick_Rechnung.pdf': { date: '2026-08-19', amount: 164, currency: 'CHF', vatSummary: [g(3.8, 152.22, 5.78, 158), g(0, 6, 0, 6)] },
    'Linkly_Ads_Invoice_2026-08.pdf': { date: '2026-08-07', amount: 180, currency: 'USD', noSwissVat: true },
    // An Irish VAT of 0.00: no Swiss VAT said in words, the model reads it.
    'Notably_Receipt_2026-07.pdf': { date: '2026-07-13', amount: 12, currency: 'EUR' },
    'Notably_Receipt_2026-08.pdf': { date: '2026-08-13', amount: 12, currency: 'EUR' },
    'Notably_Receipt_2026-09.pdf': { date: '2026-09-14', amount: 12, currency: 'EUR' },
    'Planwise_Rechnung_2026-07.pdf': { date: '2026-07-08', amount: 34, currency: 'CHF', vatSummary: [g(8.1, 31.45, 2.55, 34)] },
    'Planwise_Rechnung_2026-08.pdf': { date: '2026-08-10', amount: 34, currency: 'CHF', vatSummary: [g(8.1, 31.45, 2.55, 34)] },
    'Planwise_Rechnung_2026-09.pdf': { date: '2026-09-08', amount: 34, currency: 'CHF', vatSummary: [g(8.1, 31.45, 2.55, 34)] },
    'Promptly_Invoice_2026-07.pdf': { date: '2026-07-21', amount: 20, currency: 'USD', noSwissVat: true },
    'Promptly_Invoice_2026-08.pdf': { date: '2026-08-21', amount: 20, currency: 'USD', noSwissVat: true },
    'Promptly_Invoice_2026-09.pdf': { date: '2026-09-21', amount: 20, currency: 'USD', noSwissVat: true },
    'Rechnung_RE-2026-031_Braendli.pdf': { date: '2026-07-01', amount: 7783.2, currency: 'CHF', vatSummary: [g(8.1, 7200, 583.2, 7783.2)] },
    'Rechnung_RE-2026-032_Stiftung.pdf': { date: '2026-07-20', amount: 12431.5, currency: 'CHF', vatSummary: [g(8.1, 11500, 931.5, 12431.5)] },
    'Rechnung_RE-2026-033_Braendli.pdf': { date: '2026-08-03', amount: 7783.2, currency: 'CHF', vatSummary: [g(8.1, 7200, 583.2, 7783.2)] },
    // Her own invoice to Berlin: place of supply abroad, in euro.
    'Rechnung_RE-2026-034_Nordwerk.pdf': { date: '2026-08-10', amount: 9400, currency: 'EUR', noSwissVat: true },
    'Rechnung_RE-2026-035_Praxis.pdf': { date: '2026-08-28', amount: 1783.65, currency: 'CHF', vatSummary: [g(8.1, 1650, 133.65, 1783.65)] },
    'Rechnung_RE-2026-036_Braendli.pdf': { date: '2026-09-01', amount: 7783.2, currency: 'CHF', vatSummary: [g(8.1, 7200, 583.2, 7783.2)] },
    'SBB_Billett_Zug-Basel.pdf': { date: '2026-07-08', amount: 72.4, currency: 'CHF', vatSummary: [g(8.1, undefined, 5.42, 72.4)] },
    'SBB_Billett_Zug-Bern.pdf': { date: '2026-08-19', amount: 58, currency: 'CHF', vatSummary: [g(8.1, undefined, 4.35, 58)] },
    'SBB_Billett_Zug-Zuerich.pdf': { date: '2026-09-09', amount: 53.6, currency: 'CHF', vatSummary: [g(8.1, undefined, 4.02, 53.6)] },
    'Werkplatz_Rechnung_2026-07.pdf': { date: '2026-06-26', amount: 520, currency: 'CHF', vatSummary: [g(8.1, undefined, 38.96, 520)] },
    'Werkplatz_Rechnung_2026-08.pdf': { date: '2026-07-27', amount: 520, currency: 'CHF', vatSummary: [g(8.1, undefined, 38.96, 520)] },
    'Werkplatz_Rechnung_2026-09.pdf': { date: '2026-08-27', amount: 520, currency: 'CHF', vatSummary: [g(8.1, undefined, 38.96, 520)] },
    // The bank's statement PDF: no total of a receipt.
    'ZugerKB_Kontoauszug_Q3_2026.pdf': { date: '2026-06-30' },
  },
};

for (const [persona, files] of Object.entries(TEXTS)) {
  test(`every text PDF of the persona ${persona}: date, total, currency and VAT as a person reads them`, () => {
    assert.deepEqual(Object.keys(files).sort(), Object.keys(READ[persona]).sort(), 'one expectation per PDF');
    for (const [file, text] of Object.entries(files)) {
      const { vatId: _, ...read } = textFacts(text);
      assert.deepEqual(read, READ[persona][file], file);
    }
  });
}

test('a UID without MWST next to it is no VAT number; a total without a label is not guessed', () => {
  assert.deepEqual(textFacts('Handelsregister CHE-123.456.789\nIrgendwas 12.50\n7.20'), {});
});

test('euro invoices keep their currency', () => {
  assert.deepEqual(textFacts('Rechnungsdatum: 03.07.2026\nGesamtbetrag 49,90 EUR\n'), { date: '2026-07-03', amount: 49.9, currency: 'EUR' });
});
