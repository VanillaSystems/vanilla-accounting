/**
 * One payable, one rounding (r9n-28): the MWST page shows the figures the return would file
 * (vat().figures: the tax on each rate's total, rounded once, as eCH-0217 computes it), the same
 * the review task and the XML carry, instead of the per-entry sum that can differ by a Rappen.
 * The year overview, which files nothing, keeps the per-entry report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vat } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import type { Index, JournalEntry } from '../src/types/index.js';
import { readFileSync } from 'node:fs';
import { amountOf, formAmount, headline, ratesRoundedApart, rateOf, vatReturn } from '../src/app/areas/vat/model.js';

const { jurisdiction } = loadJurisdiction(APP_ROOT, 'ch');
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };
const je = (id: string, date: string, dr: string, cr: string, amount: number, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: id, date, accountDebit: dr, accountCredit: cr, amount, description: id, ...x });
// Two Bezugsteuer entries of 87.00: 7.05 each per entry (14.10), 14.09 on their total of 174.00.
const books: Index = {
  config: { closedThrough: '2026-06-30' }, receipts: [], transactions: [], mappings: [], bankStatements: [],
  journalEntries: [je('sale', '2026-08-03', '1020', '3400', 1000, { vatCode: 'F1' }), je('ads1', '2026-08-05', '6600', '1020', 87, { vatCode: 'B81-1' }), je('ads2', '2026-09-05', '6600', '1020', 87, { vatCode: 'B81-1' })],
};

test('the MWST page of a filing period shows the tax on each rate\'s total and the payable rounded once, as the XML files them', () => {
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    const filed = vat().figures(books.journalEntries!, '2026-H2', []);
    assert.equal(vat().report(books.journalEntries!, '2026-H2', []).toPay, 59.1, 'the per-entry sum differs by a Rappen');
    assert.equal(filed.payable, 59.09);
    const v = vatReturn(books, '2026-H2', '2026-10-16');
    assert.equal(rateOf(v, '383')!.tax, 14.09, 'the rate row shows the tax on its total');
    assert.equal(amountOf(v, '383'), 14.09);
    assert.equal(amountOf(v, '399'), filed.ziffern['399']);
    assert.equal(amountOf(v, '500'), 59.09);
    assert.equal(v.report.toPay, 59.09);
    assert.deepEqual(headline(v, undefined, books), { kind: 'toPay', amount: 59.09, filed: false });
    const year = vatReturn(books, '2026', '2026-10-16');
    assert.equal(year.report.toPay, 59.1, 'the year overview files nothing and keeps the per-entry sum');
  } finally {
    setJurisdiction(jurisdiction);
  }
});

test('the MWST page notes when the rate rows, each rounded, add up a Rappen off the rounded total; it moves no figure', () => {
  const sale = (id: string, amount: number, vatCode: string): JournalEntry => je(id, '2026-08-03', '1020', '3000', amount, { vatCode });
  const off: Index = { ...books, config: { closedThrough: '2026-03-31' }, journalEntries: [sale('a', 100, 'V81'), sale('b', 100, 'V26')] };
  const even: Index = { ...off, journalEntries: [sale('a', 1081, 'V81'), sale('b', 1026, 'V26')] };
  const v = vatReturn(off, '2026-Q3', '2026-10-16');
  assert.equal(ratesRoundedApart(v), true, '7.49 + 2.53 = 10.02, the total 10.0271 rounds to 10.03');
  assert.equal(amountOf(v, '399'), 10.03, 'the total is the return\'s');
  assert.equal(ratesRoundedApart(vatReturn(even, '2026-Q3', '2026-10-16')), false, 'rows that add up: no note');
  assert.equal(ratesRoundedApart(vatReturn(off, '2026', '2026-10-16')), false, 'a year files nothing');
  for (const l of ['de', 'en', 'fr', 'it']) assert.match(readFileSync(`src/app/i18n/locales/${l}.ts`, 'utf8'), /'vat\.rateRounding'/);
});

test('a rate row\'s turnover on the MWST page is the turnover the return files, not its net plus the tax on the total (#406, webshop-ai-23)', () => {
  // The webshop's 116 lines at 8.1 % in Q3 (two refunds): the nets rounded per entry plus the tax on the total land six Rappen above the gross the bookings hold.
  const amounts = [75, 90, 160, 75, 31, 73, 44, 25.5, 44, 84, 92, 116, 215, 68, 86.5, 102.5, 55, 49, 84, 44, 75, 136, 49, 105, 136, -84, 31, 84, 36, 86, 116, 55, 126, 220, 65, 218, 36, 78, 65, 36, 44, -24, 152, 84, 31, 126, 92, 244, 54.5, 132, 136, 44, 92, 176, 86.5, 84, 136, 49, 85, 36, 31, 73, 268, 184, 142, 136, 154.5, 173, 55, 100.5, 126.5, 95, 84, 108, 124.5, 65, 154.5, 121, 158, 189, 100.5, 178, 173, 73, 215, 152, 25.5, 49, 44, 36, 105, 36, 36, 54.5, 110, 36, 165, 218, 218, 136, 92, 116, 110, 85, 49, 60, 44, 65, 44, 137, 163, 44, 221, 136, 92, 73];
  const entries = amounts.map((a, i) => (a < 0 ? je(`s${i}`, '2026-08-03', '3200', '1093', -a, { vatCode: '-V81' }) : je(`s${i}`, '2026-08-03', '1093', '3200', a, { vatCode: 'V81' })));
  const many: Index = { ...books, config: { closedThrough: '2026-06-30' }, journalEntries: entries };
  const gross = Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
  const v = vatReturn(many, '2026-Q3', '2026-10-16');
  assert.equal(vat().figures(entries, '2026-Q3', []).ziffern['303'], gross, 'the return files the gross the bookings hold');
  const r = rateOf(v, '303')!;
  assert.notEqual(Math.round((r.base + r.tax) * 100) / 100, gross, 'the net rounded per entry plus the tax on the total is off: the case');
  assert.equal(gross, 11376.5);
  assert.equal(formAmount(v, '303'), gross, 'the page shows the filed turnover');
});
