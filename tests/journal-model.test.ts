/**
 * Buchungen and MWST-Codes (src/app/areas/journal/model.ts, src/app/areas/codes/model.ts): what a
 * period lists, in which order, what the filters, the code filter and the search keep, which
 * payments still wait for a receipt, and how the catalogue groups and counts the codes.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, JournalEntry } from '../src/types/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { journalOf, rowsOf } from '../src/app/areas/journal/model.js';
import { NO_VAT, codeGroups, splitCodes, vatStats } from '../src/app/areas/codes/model.js';

const tx = (ref: string, date: string, amount: number, x: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: 'DBIT', description: ref, ...x });
const je = (id: string, ref: string, date: string, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: ref, date, accountDebit: '6500', accountCredit: '1020', amount: 108.1, vatCode: 'I81', description: `Muster AG, ${id}`, ...x });

const books: Index = {
  config: { closedThrough: '2026-06-30' },
  receipts: [{ id: 'r1', filename: 'r1.pdf', originalFilename: 'r1.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived' }],
  transactions: [tx('T-ok', '2026-09-10', 108.1), tx('T-open', '2026-09-12', 50), tx('T-fee', '2026-09-12', 1, { type: 'wise-fee' }), tx('T-none', '2026-08-02', 9, { noReceiptNeeded: true })],
  mappings: [{ receiptId: 'r1', transactionRef: 'T-ok' }],
  bankStatements: [],
  journalEntries: [
    je('ok', 'T-ok', '2026-09-10'),
    je('open-a', 'T-open', '2026-09-12', { vatCode: undefined, amount: 40 }),
    je('open-b', 'T-open', '2026-09-12', { vatCode: '-I81', amount: 10, accountDebit: '6580' }),
    je('fee', 'T-fee', '2026-09-12', { vatCode: undefined, amount: 1 }),
    je('none', 'T-none', '2026-08-02', { vatCode: 'M0', amount: 9 }),
    je('corr', 'M2026-001', '2026-07-05', { corrects: '2026-Q2', exchangeCurrency: 'EUR', exchangeRate: 0.9, amount: 100 }),
    je('filed', 'T-filed', '2026-06-20'),
  ],
};
const q3 = parsePeriod('2026-Q3', '2026-10-11')!;
const name = (n: string) => ({ '6580': 'Webshopaufwand' } as Record<string, string>)[n] ?? '';
const ids = (filter?: 'ohneBeleg' | 'korrekturen', vat?: string, q?: string) => rowsOf(journalOf(books), q3, filter, vat, q, name).rows.map((v) => v.e.id);

test('the period newest first, one payment\'s entries together; the filed quarter stays out', () => {
  assert.deepEqual(ids(), ['fee', 'open-a', 'open-b', 'ok', 'none', 'corr']);
});

test('a payment waits for a receipt unless it has one, is a fee or needs none; filed entries are locked', () => {
  const j = journalOf(books);
  assert.deepEqual(j.views.filter((v) => v.missing).map((v) => v.e.id), ['open-a', 'open-b']);
  assert.deepEqual(j.views.filter((v) => v.locked).map((v) => v.e.id), ['filed']);
  assert.deepEqual(rowsOf(j, q3, undefined, undefined, undefined, name).counts, { alle: 6, ohneBeleg: 2, korrekturen: 1 });
});

test('the origin filter lists what Claude booked, what a person did, within the period and with the other filters (treuhaender-43)', () => {
  const by = (origin: Record<string, JournalEntry['origin']>) => ({ ...books, journalEntries: books.journalEntries!.map((e) => (origin[e.id] ? { ...e, origin: origin[e.id] } : e)) });
  const b = by({ ok: 'classify', 'open-a': 'classify', 'open-b': 'manual', none: 'invoice', filed: 'classify' });
  const j = journalOf(b);
  const r = rowsOf(j, q3, undefined, undefined, undefined, name, 'classify');
  assert.deepEqual(r.rows.map((v) => v.e.id), ['open-a', 'ok'], 'the filed quarter\'s entry is outside the period');
  assert.deepEqual(r.origins, { classify: 2, manual: 1, assistant: 0, invoice: 1, 'year-close': 0 });
  // A change the AI sidebar made on a wish is origin manual with by.kind assistant: counted as KI, not as by hand (r6h-29).
  const ai = journalOf(by({ ok: 'classify', 'open-a': 'classify', 'open-b': 'manual', none: 'manual', filed: 'classify' }));
  ai.views.find((v) => v.e.id === 'none')!.e.by = { kind: 'assistant', at: '2026-10-16T08:00:00Z', conversation: 'c1' };
  assert.deepEqual(rowsOf(ai, q3, undefined, undefined, undefined, name).origins, { classify: 2, manual: 1, assistant: 1, invoice: 0, 'year-close': 0 });
  assert.deepEqual(rowsOf(ai, q3, undefined, undefined, undefined, name, 'assistant').rows.map((v) => v.e.id), ['none']);
  assert.deepEqual(rowsOf(ai, q3, undefined, undefined, undefined, name, 'manual').rows.map((v) => v.e.id), ['open-b']);
  assert.deepEqual(rowsOf(j, q3, 'ohneBeleg', undefined, undefined, name, 'classify').rows.map((v) => v.e.id), ['open-a'], 'with «Ohne Beleg»');
  const sept = parsePeriod('2026-09-11..2026-09-30', '2026-10-11')!;
  assert.deepEqual(rowsOf(j, sept, undefined, undefined, undefined, name, 'classify').rows.map((v) => v.e.id), ['open-a'], 'a date range is the period');
  assert.deepEqual(rowsOf(j, q3, undefined, undefined, undefined, name, 'year-close').rows, []);
});

test('filters, the code filter (a minus code is its own, none means without) and the search', () => {
  assert.deepEqual(ids('ohneBeleg'), ['open-a', 'open-b']);
  assert.deepEqual(ids('korrekturen'), ['corr']);
  assert.deepEqual(ids(undefined, 'I81'), ['ok', 'corr']);
  assert.deepEqual(ids(undefined, '-I81'), ['open-b']);
  assert.deepEqual(ids(undefined, NO_VAT), ['fee', 'open-a']);
  assert.deepEqual(ids(undefined, undefined, 'webshop'), ['open-b'], 'an account\'s name finds its entries');
  assert.deepEqual(ids(undefined, undefined, '02.08.2026'), ['none'], 'the date as shown');
  assert.deepEqual(ids(undefined, undefined, '90.00'), ['corr'], 'a foreign entry by its CHF');
});

test('per code: entries, CHF and the VAT in them signed as the return counts it', () => {
  const stats = vatStats(books.journalEntries!, q3);
  assert.deepEqual(stats.find((s) => s.code === 'I81'), { code: 'I81', n: 2, chf: 198.1, tax: 14.84 });
  assert.deepEqual(stats.find((s) => s.code === '-I81'), { code: '-I81', n: 1, chf: 10, tax: -0.75 });
  assert.deepEqual(stats.find((s) => s.code === NO_VAT), { code: NO_VAT, n: 2, chf: 41, tax: 0 });
});

test('the catalogue: families in form order, a used minus code beside its code, used only, search', () => {
  const stats = vatStats(books.journalEntries!, q3);
  const all = codeGroups(stats, () => '');
  assert.deepEqual(all.map((g) => g.family), ['V', 'VS', 'F', 'B', 'M', 'I', 'K', 'Z']);
  const i = all.find((g) => g.family === 'I')!.rows.map((r) => r.code);
  assert.equal(i[i.indexOf('I81') + 1], '-I81');
  assert.ok(i.indexOf('I0') < i.indexOf('I26'));
  assert.deepEqual(codeGroups(stats, () => '', undefined, true).flatMap((g) => g.rows.map((r) => `${r.code}:${r.n}`)), ['M0:1', 'I81:2', '-I81:1']);
  assert.deepEqual(codeGroups(stats, (r) => r.entry.bananaText ?? '', 'b81').flatMap((g) => g.rows.map((r) => r.code)), ['B81', 'B81-1', 'B81-2']);
});

test('codes named in a text are split out to link them', () => {
  assert.deepEqual(splitCodes('Kunde im Ausland (V0-E), sonst V81.'), [
    { text: 'Kunde im Ausland (' }, { text: 'V0-E', code: 'V0-E' }, { text: '), sonst ' }, { text: 'V81', code: 'V81' }, { text: '.' },
  ]);
});
