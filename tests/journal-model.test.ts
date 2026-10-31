/**
 * Buchungen and MWST-Codes (src/app/areas/journal/model.ts, src/app/areas/codes/model.ts): what a
 * period lists, in which order, what the filters, the code filter and the search keep, which
 * payments still wait for a receipt, and how the catalogue groups and counts the codes.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, JournalEntry } from '../src/types/index.js';
import { parsePeriod, type Period } from '../src/accounting/periods.js';
import { firstRowTakesOver, journalOf, rowsOf, type Journal } from '../src/app/areas/journal/model.js';
import { journalFields } from '../src/app/areas/journal/filter.js';
import { wordsIn } from '../src/export/texts.js';
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
/** The count line's shortcuts and the origin buttons, as the chips they set (#211). */
const FIELDS = journalFields(name, undefined, { say: wordsIn('de').t, monthName: (d) => d.slice(0, 7) });
const CHIP = { ohneBeleg: { field: 'receipt', value: 'missing' }, korrekturen: { field: 'corrects', value: 'yes' } } as const;
const rowsBy = (j: Journal, p: Period, filter?: 'ohneBeleg' | 'korrekturen', vat?: string, q?: string, nm = name, origin?: string) =>
  rowsOf(j, p, [...(filter ? [CHIP[filter]] : []), ...(origin ? [{ field: 'who', value: origin }] : [])], FIELDS, vat, q, nm);
const ids = (filter?: 'ohneBeleg' | 'korrekturen', vat?: string, q?: string) => rowsBy(journalOf(books), q3, filter, vat, q, name).rows.map((v) => v.e.id);

test('the period newest first, one payment\'s entries together; the filed quarter stays out', () => {
  assert.deepEqual(ids(), ['fee', 'open-a', 'open-b', 'ok', 'none', 'corr']);
});

test('a payment waits for a receipt unless it has one, is a fee or needs none; filed entries are locked', () => {
  const j = journalOf(books);
  assert.deepEqual(j.views.filter((v) => v.missing).map((v) => v.e.id), ['open-a', 'open-b']);
  assert.deepEqual(j.views.filter((v) => v.locked).map((v) => v.e.id), ['filed']);
  assert.deepEqual(rowsBy(j, q3, undefined, undefined, undefined, name).counts, { alle: 6, ohneBeleg: 2, korrekturen: 1 });
});

test('the origin filter lists what Claude booked, what a person did, within the period and with the other filters (treuhaender-43)', () => {
  const by = (origin: Record<string, JournalEntry['origin']>) => ({ ...books, journalEntries: books.journalEntries!.map((e) => (origin[e.id] ? { ...e, origin: origin[e.id] } : e)) });
  const b = by({ ok: 'classify', 'open-a': 'classify', 'open-b': 'manual', none: 'invoice', filed: 'classify' });
  const j = journalOf(b);
  const r = rowsBy(j, q3, undefined, undefined, undefined, name, 'classify');
  assert.deepEqual(r.rows.map((v) => v.e.id), ['open-a', 'ok'], 'the filed quarter\'s entry is outside the period');
  assert.deepEqual(r.origins, { classify: 2, rule: 0, code: 0, manual: 1, assistant: 0, invoice: 1, 'year-close': 0 });
  // A change the AI sidebar made on a wish is origin manual with by.kind assistant: counted as KI, not as by hand (r6h-29).
  const ai = journalOf(by({ ok: 'classify', 'open-a': 'classify', 'open-b': 'manual', none: 'manual', filed: 'classify' }));
  ai.views.find((v) => v.e.id === 'none')!.e.by = { kind: 'assistant', at: '2026-10-16T08:00:00Z', conversation: 'c1' };
  assert.deepEqual(rowsBy(ai, q3, undefined, undefined, undefined, name).origins, { classify: 2, rule: 0, code: 0, manual: 1, assistant: 1, invoice: 0, 'year-close': 0 });
  assert.deepEqual(rowsBy(ai, q3, undefined, undefined, undefined, name, 'assistant').rows.map((v) => v.e.id), ['none']);
  assert.deepEqual(rowsBy(ai, q3, undefined, undefined, undefined, name, 'manual').rows.map((v) => v.e.id), ['open-b']);
  assert.deepEqual(rowsBy(j, q3, 'ohneBeleg', undefined, undefined, name, 'classify').rows.map((v) => v.e.id), ['open-a'], 'with «Ohne Beleg»');
  const sept = parsePeriod('2026-09-11..2026-09-30', '2026-10-11')!;
  assert.deepEqual(rowsBy(j, sept, undefined, undefined, undefined, name, 'classify').rows.map((v) => v.e.id), ['open-a'], 'a date range is the period');
  assert.deepEqual(rowsBy(j, q3, undefined, undefined, undefined, name, 'year-close').rows, []);
});

test('chips (#211): an account on either side, the code\'s rate, currency, receipt, correction; AND across fields, OR within one', () => {
  const j = journalOf(books);
  const by = (...chips: Array<[string, string]>) => rowsOf(j, q3, chips.map(([field, value]) => ({ field, value })), FIELDS, undefined, undefined, name).rows.map((v) => v.e.id).sort();
  assert.deepEqual(by(['account', '6580']), ['open-b'], 'the debit side');
  assert.deepEqual(by(['account', '1020']), ['corr', 'fee', 'none', 'ok', 'open-a', 'open-b'], 'the credit side');
  assert.deepEqual(by(['rate', '0']), ['none']);
  assert.deepEqual(by(['rate', 'none']), ['fee', 'open-a'], 'without a code');
  assert.deepEqual(by(['rate', '8.1'], ['over', '50']), ['corr', 'ok'], 'a minus code has its rate too, and over 50');
  assert.deepEqual(by(['rate', '8.1'], ['rate', '0'], ['under', '50']), ['none', 'open-b'], '8.1 or 0, and under 50');
  assert.deepEqual(by(['currency', 'EUR']), ['corr']);
  assert.deepEqual(by(['receipt', 'yes']), ['ok']);
  assert.deepEqual(by(['receipt', 'missing']), ['open-a', 'open-b']);
  assert.deepEqual(by(['corrects', 'yes']), ['corr']);
  assert.deepEqual(by(['month', '2026-08']), ['none']);
  assert.deepEqual(by(['who', 'other']), ['corr', 'fee', 'none', 'ok', 'open-a', 'open-b'], 'no writer named: imported');
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

test('a booking a company rule or the app\'s code decided counts as theirs in the Herkunft filter, not as Claude\'s (r9n-32)', () => {
  const by = (kind: 'rule' | 'code' | 'model', extra: Record<string, unknown> = {}) => ({ kind, ...extra }) as JournalEntry['by'];
  const entries: JournalEntry[] = [
    { id: 'r1', transactionRef: 'R1', date: '2026-08-01', accountDebit: '1020', accountCredit: '3400', amount: 100, description: 'rule', origin: 'classify', rule: 'anzahlung-3400', by: by('rule', { rule: 'anzahlung-3400' }) },
    { id: 'c1', transactionRef: 'C1', date: '2026-08-02', accountDebit: '1020', accountCredit: '3400', amount: 100, description: 'code', origin: 'classify', by: by('code', { check: 'saleCode' }) },
    { id: 'm1', transactionRef: 'M1', date: '2026-08-03', accountDebit: '6500', accountCredit: '1020', amount: 100, description: 'model', origin: 'classify', by: by('model', { model: 'sonnet' }) },
    { id: 'h1', transactionRef: 'H1', date: '2026-08-04', accountDebit: '6500', accountCredit: '1020', amount: 100, description: 'hers', origin: 'manual', by: by('rule', { rule: 'x' }) },
  ];
  const b: Index = { config: {}, receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: entries };
  const r = rowsBy(journalOf(b), q3, undefined, undefined, undefined, name);
  assert.deepEqual(r.origins, { classify: 1, rule: 1, code: 1, manual: 1, assistant: 0, invoice: 0, 'year-close': 0 });
  assert.deepEqual(rowsBy(journalOf(b), q3, undefined, undefined, undefined, name, 'rule').rows.map((v) => v.e.id), ['r1']);
  assert.deepEqual(rowsBy(journalOf(b), q3, undefined, undefined, undefined, name, 'classify').rows.map((v) => v.e.id), ['m1'], 'Claude is only what the model decided');
});

test('a link that names no entry selects the first row, nothing held or deleted (#62)', () => {
  assert.equal(firstRowTakesOver(undefined, [undefined, undefined], undefined), true, 'no link, nothing pending, nothing deleted');
  assert.equal(firstRowTakesOver(undefined, ['j9', 'j8'], undefined), true);
  assert.equal(firstRowTakesOver('j9', ['j9', undefined], 'j9'), false, 'an entry just booked holds the selection');
  assert.equal(firstRowTakesOver('j8', [undefined, 'j8'], 'j8'), false, 'an entry just deleted keeps its place');
  assert.equal(firstRowTakesOver('j7', [undefined, undefined], 'j7'), true, 'an entry shown before that went away hands it on');
  assert.equal(firstRowTakesOver('j6', [undefined, undefined], undefined), false, 'a link to an entry never here keeps its place');
});
