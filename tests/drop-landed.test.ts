/**
 * Where a drop's files landed and what came of them (src/app/shell/drop-summary.ts, F10, #341): the
 * page behind the drop window moves to the period most of the taken files landed in, unless the
 * period on screen holds it; a receipt without a date of its own does not decide; the window's
 * last lines count the payments and receipts from the books; the bar moves with the run's step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSING_GROUPS, CLOSING_SENTENCE, OTHER_SENTENCES, RECEIPT_SENTENCES, closingCounts, closingGroupOf, receiptStateOf, datesIn, dropProgress, dropSummary, landedPeriod, majorityPeriod, ownDate, type ClosingCounts, type ClosingGroup, type FileState } from '../src/app/shell/drop-summary.js';
import { parsePeriod } from '../src/accounting/periods.js';
import type { DropRow } from '../src/types/drop.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import type { Question } from '../src/questions/model.js';
import de from '../src/app/i18n/locales/de.js';
import en from '../src/app/i18n/locales/en.js';
import fr from '../src/app/i18n/locales/fr.js';
import it from '../src/app/i18n/locales/it.js';

const TODAY = '2026-11-12';

/** The group a row gets from the books alone, as the dialog's rows give it: a statement, else its receipt's state. */
const groupOf = (books: { mappings: Array<{ receiptId: string }> }, receiptOf: (r: DropRow) => Receipt | undefined, isCopy: (id: string) => boolean = () => false) => (r: DropRow): ClosingGroup => {
  if (r.state !== 'taken') return closingGroupOf(r, undefined);
  if (r.statement) return 'statement';
  const x = receiptOf(r);
  return x ? receiptStateOf(x, books.mappings.filter((m) => m.receiptId === x.id).length, isCopy(x.id)) : 'working';
};
/** The counts with only the named groups, the rest 0. */
const only = (over: Partial<ClosingCounts>): ClosingCounts => ({ ...Object.fromEntries(CLOSING_GROUPS.map((g) => [g, 0])), ...over }) as ClosingCounts;
const q = (token: string) => parsePeriod(token, TODAY)!;
const row = (key: string, extra: Partial<DropRow> = {}): DropRow => ({ key, id: key, name: `${key}.pdf`, size: 1, state: 'taken', ...extra });
const statement = row('s', { kind: 'camt', facts: { from: '2026-10-01', to: '2026-10-31' }, statement: { file: 's.xml', refs: ['a'] } });
const dates: Record<string, string[]> = { r1: ['2026-06-12'], r2: ['2026-10-21'], s: ['2026-10-31'] };
const datesOf = (r: DropRow) => dates[r.id] ?? [];

test('an October statement dropped while Q2 is shown moves the page to Q4', () => {
  assert.equal(landedPeriod([statement], datesOf, q('2026-Q2'), TODAY, 'quarter')?.token, '2026-Q4');
});

test('the period on screen holds where the files landed: the page stays', () => {
  assert.equal(landedPeriod([statement], datesOf, q('2026-Q4'), TODAY, 'quarter'), undefined);
  assert.equal(landedPeriod([statement], datesOf, q('2026'), TODAY, 'quarter'), undefined);
});

test('a receipt counts once it has its date; a file not taken does not count', () => {
  assert.equal(landedPeriod([row('r9')], datesOf, q('2026-Q2'), TODAY, 'quarter'), undefined, 'not read yet');
  assert.equal(landedPeriod([row('r1'), row('r2', { state: 'duplicate' })], datesOf, q('2026-Q4'), TODAY, 'quarter')?.token, '2026-Q2');
  assert.equal(landedPeriod([row('r2')], datesOf, q('2026-Q2'), TODAY, 'half')?.token, '2026-H2');
});

// The persona's drop (#341): a Q3 statement with 23 payments, receipts of Q3, one till photo dated today.
const payments = Array.from({ length: 23 }, (_, i): BankTransaction => ({
  ref: `p${i}`, date: i < 8 ? '2026-07-15' : i < 16 ? '2026-08-15' : '2026-09-15', amount: 100 + i, currency: 'CHF', direction: i % 5 ? 'DBIT' : 'CRDT', bank: 'Raiffeisen', description: `Zahlung ${i}`,
  ...(i >= 12 && i < 20 ? { waitsForReceipt: { since: '2026-11-12' } } : {}),
} as BankTransaction));
const READ = { amount: 12.5, extractedText: 'Muster AG Rechnung Total CHF 12.50 inkl. MWST 8.1%', extractionMethod: 'pdftotext' } as const;
const receipts: Array<Pick<Receipt, 'id' | 'date' | 'dateSource' | 'location' | 'amount'> & Partial<Pick<Receipt, 'extractedText' | 'extractionMethod'>>> = [
  { id: 'a', date: '2026-07-03', location: 'archived', ...READ }, { id: 'b', date: '2026-08-06', location: 'archived', ...READ }, { id: 'c', date: '2026-06-28', location: 'archived', ...READ },
  { id: 'today', date: TODAY, location: 'archived', ...READ }, { id: 'phone', date: TODAY, dateSource: 'captured', location: 'archived', ...READ }, { id: 'staged', location: 'staged' },
];
const rows = [row('q3', { kind: 'camt', facts: { from: '2026-07-01', to: '2026-09-30' }, statement: { file: 'q3.xml', refs: payments.map((p) => p.ref) } }), ...receipts.map((r) => row(r.id)), row('dup', { state: 'duplicate' })];
const receiptOf = (r: DropRow) => receipts.find((x) => x.id === r.id);
const books = { transactions: payments, mappings: [{ receiptId: 'a', transactionRef: 'p1' }, { receiptId: 'b', transactionRef: 'p9' }] as never };

test('the page goes where most of the drop landed, not where its newest file is dated', () => {
  const of = datesIn(books, receiptOf);
  assert.equal(majorityPeriod(rows, of, TODAY, 'quarter')?.token, '2026-Q3', '23 payments and two receipts of Q3 against one receipt dated today');
  assert.equal(landedPeriod(rows, of, q('2026-Q4'), TODAY, 'quarter')?.token, '2026-Q3', 'the empty books stood on today\'s quarter');
  assert.equal(landedPeriod(rows, of, q('2026-Q3'), TODAY, 'quarter'), undefined);
});

test('a receipt dated by the day it was taken has no date of its own and decides nothing', () => {
  assert.equal(ownDate({ date: TODAY, dateSource: 'captured' }), undefined);
  assert.equal(ownDate({ date: '2026-07-03' }), '2026-07-03');
  const of = datesIn({ transactions: [] }, receiptOf);
  assert.deepEqual(of(row('phone')), []);
  assert.equal(majorityPeriod([row('phone'), row('a')], of, TODAY, 'quarter')?.token, '2026-Q3', 'the one receipt with its own date');
  assert.equal(majorityPeriod([row('phone')], of, TODAY, 'quarter'), undefined, 'nothing dated: the page stays');
});

test('a statement whose payments the page has not loaded yet counts by its last day', () => {
  assert.deepEqual(datesIn({ transactions: [] }, receiptOf)(rows[0]), ['2026-09-30']);
});

test('the summary counts the drop\'s payments and receipts from the books', () => {
  const booked = new Set(payments.slice(0, 12).map((p) => p.ref));
  const questions = [{ id: 'q1', status: 'open', on: { kind: 'payment', id: 'p20' } }, { id: 'q2', status: 'closed', on: { kind: 'payment', id: 'p21' } }] as unknown as Question[];
  const held = new Set(payments.filter((p) => p.waitsForReceipt).map((p) => p.ref));
  const s = dropSummary(rows, books, (t) => !booked.has(t.ref), held, questions, groupOf(books, receiptOf as never));
  assert.deepEqual(s.payments, { n: 23, from: '2026-07-15', to: '2026-09-15', booked: 12, waitReceipt: 8, asked: 1, unbooked: 2, openFrom: '2026-08-15' });
  assert.deepEqual(s.files, only({ statement: 1, matched: 2, read: 3, unread: 1, known: 1 }), 'the staged file without text waits for its reading; the copy not taken is counted too');
  assert.deepEqual(dropSummary([row('dup', { state: 'duplicate' })], books, () => true, new Set(), [], groupOf(books, receiptOf as never)), { files: only({ known: 1 }) }, 'nothing taken: no payments, the file still counted');
  // A photo without text, archived on a Mac without an AI: Belege says it waits for reading (#343), so the drop does not call it read.
  const photo = { id: 'photo', location: 'archived' as const, extractedText: '', extractionMethod: 'tesseract' as const };
  const withPhoto = (r: DropRow) => (r.id === 'photo' ? photo : receiptOf(r));
  assert.deepEqual(dropSummary([row('photo'), row('c')], books, () => true, new Set(), [], groupOf(books, withPhoto as never)).files, only({ read: 1, unread: 1 }));
});

test('without a model, text PDFs whose facts code read count as read, as their rows show them; photos wait for the AI; no receipt is counted apart (#361)', () => {
  // The persona's drop on a Mac without an AI: ten text PDFs, one paired by code, the rest still in the inbox (no model names them), six photos.
  const pdfs = Array.from({ length: 10 }, (_, i) => ({ id: `pdf${i}`, date: '2026-07-10', amount: 88.98 + i, location: i ? 'staged' as const : 'archived' as const, extractedText: `Maler Muster AG Rechnung R-${i} Total CHF ${88.98 + i}`, extractionMethod: 'pdftotext' as const }));
  const photos = Array.from({ length: 6 }, (_, i) => ({ id: `img${i}`, location: 'archived' as const, extractedText: '', extractionMethod: 'claude-vision' as const, needsVisionReview: true }));
  // A holiday photo the model read: «Kein Beleg», set aside as noise.
  const holiday = { id: 'holiday', location: 'archived' as const, extractedText: 'Kein Beleg: Strand in Rimini', extractionMethod: 'claude-vision' as const, kind: 'noise' as const };
  const all = [...pdfs, ...photos, holiday];
  const of = (r: DropRow) => all.find((x) => x.id === r.id);
  const s = dropSummary(all.map((r) => row(r.id)), { transactions: [] }, () => true, new Set(), [], groupOf({ mappings: [{ receiptId: 'pdf0' }] }, of as never));
  assert.deepEqual(s.files, only({ matched: 1, read: 9, unread: 6, none: 1 }));
});

test('a row and the closing sentence give one state for one receipt (#361)', () => {
  const r = (over: Partial<Receipt>) => ({ id: 'x', extractedText: 'Muster AG Rechnung Total CHF 12.50', extractionMethod: 'pdftotext', location: 'staged', ...over }) as Receipt;
  assert.equal(receiptStateOf(r({ date: '2026-10-02', amount: 12.5 }), 0, false), 'read', 'in the inbox without an AI, its date and amount read by code: read, as the summary counts it');
  assert.equal(receiptStateOf(r({ date: '2026-10-02' }), 0, false), 'incomplete', 'a date but no amount: read, with what it lacks as its own state (#385 review)');
  assert.equal(receiptStateOf(r({ amount: 12.5 }), 0, false), 'incomplete');
  assert.equal(receiptStateOf(r({ date: '2026-10-02', amount: 12.5 }), 1, false), 'matched');
  assert.equal(receiptStateOf(r({ date: '2026-10-02', amount: 12.5 }), 0, true), 'copy');
  assert.equal(receiptStateOf(r({ extractedText: '', extractionMethod: 'claude-vision' }), 0, false), 'unread');
  assert.equal(receiptStateOf(r({ kind: 'noise' }), 0, false), 'none');
  const rows = ['a', 'b', 'c'].map((id) => row(id));
  const files: Record<string, Receipt> = { a: r({ id: 'a', date: '2026-10-02' }), b: r({ id: 'b', date: '2026-10-02', amount: 9 }), c: r({ id: 'c', date: '2026-10-02', amount: 9 }) };
  const s = dropSummary(rows, { transactions: [] }, () => true, new Set(), [], groupOf({ mappings: [] }, (x) => files[x.id], (id) => id === 'c'));
  assert.deepEqual(s.files, only({ read: 1, copy: 1, incomplete: 1 }));
  assert.equal(receiptStateOf(r({ kind: 'supporting', amount: 0, date: '2026-07-24' }), 0, false), 'supporting', 'an order confirmation is no «kein Beleg» (#384)');
});

/** Every state a row can show: the ones not taken, and a taken one's FileState. */
const ROW_STATES: Array<[DropRow['state'], Partial<DropRow>, FileState | undefined]> = [
  ['take', {}, undefined], ['undone', {}, undefined], ['refused', {}, undefined], ['locked', {}, undefined], ['unclear', {}, undefined], ['asks', {}, undefined],
  ['quarantine', { reason: 'not-receipt' }, undefined], ['quarantine', { reason: 'private' }, undefined], ['duplicate', {}, undefined], ['duplicate', { reason: 'possible-duplicate' }, undefined],
  ['taken', { readAs: { file: 'a.xml' } }, { kind: 'statement' }],
  ...([{ kind: 'working' }, { kind: 'read' }, { kind: 'unread' }, { kind: 'matched' }, { kind: 'waits' }, { kind: 'orderPage', provider: 'p' }, { kind: 'stuck', run: 'r' }, { kind: 'statement' }, { kind: 'report' },
    { kind: 'refused', reason: 'x' }, { kind: 'none', why: '' }, { kind: 'twin', of: 'o', name: 'n', why: 'number' }, { kind: 'supporting' }] as FileState[]).map((x): [DropRow['state'], Partial<DropRow>, FileState] => ['taken', {}, x]),
];

test('the closing lines count every dropped file once, for any mix of row states (#384)', () => {
  // Every state has a group, and every group but the read ones a sentence of its own (DropDialog SENTENCE, a record over the groups).
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647);
  for (let round = 0; round < 200; round++) {
    const picks = Array.from({ length: 1 + (next() % 30) }, (_, i) => { const [state, extra, x] = ROW_STATES[next() % ROW_STATES.length]; return { r: row(`f${i}`, { state, ...extra }), x }; });
    const xs = new Map(picks.map((p) => [p.r, p.x]));
    const counts = closingCounts(picks.map((p) => p.r), (r) => closingGroupOf(r, xs.get(r)));
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), picks.length);
  }
  // The persona's drop of round 2 (23 files, no AI): two statements, a CSV that asks, sixteen receipts, the .docx, a copy, two files set aside.
  const persona = [
    ...['camt-q3', 'camt-okt'].map((k) => ({ r: row(k, { kind: 'camt' as const }), x: { kind: 'statement' } as FileState })),
    { r: row('csv', { state: 'asks', reason: 'csv-columns' }), x: undefined },
    ...Array.from({ length: 2 }, (_, i) => ({ r: row(`m${i}`), x: { kind: 'matched' } as FileState })),
    ...Array.from({ length: 4 }, (_, i) => ({ r: row(`r${i}`), x: { kind: 'read' } as FileState })),
    ...Array.from({ length: 3 }, (_, i) => ({ r: row(`w${i}`), x: { kind: 'waits' } as FileState })),
    ...Array.from({ length: 6 }, (_, i) => ({ r: row(`p${i}`), x: { kind: 'unread' } as FileState })),
    { r: row('ab'), x: { kind: 'supporting', why: 'Auftragsbestätigung', of: { id: 'fm', name: 'Farbmix FM-78230' } } as FileState },
    { r: row('docx', { state: 'refused' }), x: undefined }, { r: row('dup', { state: 'duplicate' }), x: undefined },
    { r: row('agb', { state: 'quarantine', reason: 'not-receipt' }), x: undefined }, { r: row('herbst', { state: 'quarantine', reason: 'not-receipt' }), x: undefined },
  ];
  const xs = new Map(persona.map((p) => [p.r, p.x]));
  const counts = closingCounts(persona.map((p) => p.r), (r) => closingGroupOf(r, xs.get(r)));
  assert.equal(persona.length, 23);
  assert.deepEqual(counts, only({ statement: 2, asks: 1, matched: 2, read: 4, incomplete: 3, unread: 6, supporting: 1, refused: 1, known: 1, none: 2 }));
});

test('the bar moves with the part of the run that is done, not only with files at rest', () => {
  assert.equal(dropProgress([]), 0);
  assert.equal(dropProgress([1, ...Array(16).fill(0)]), 6, 'the statement at rest, sixteen receipts queued');
  assert.equal(dropProgress([1, ...Array(16).fill((2 + 8 / 16) / 4)]), 65, 'their run is in its third step of four, half of them read');
  assert.equal(dropProgress(Array(17).fill(1)), 100);
});

test('every closing group has its sentence, said in each language, and in one of the lines (review of #384)', () => {
  const rendered = new Set<ClosingGroup>(['statement', 'matched', 'read', ...RECEIPT_SENTENCES, ...OTHER_SENTENCES]);
  assert.deepEqual(CLOSING_GROUPS.filter((g) => !rendered.has(g)), [], 'a group no line names');
  assert.equal(RECEIPT_SENTENCES.length + OTHER_SENTENCES.length, Object.keys(CLOSING_SENTENCE).length, 'each sentence in one line');
  for (const [lang, locale] of Object.entries({ de, en, fr, it })) {
    for (const key of [...Object.values(CLOSING_SENTENCE), 'drop.sum.unreadNoAi']) assert.ok(key in locale.messages, `${lang}: ${key}`);
  }
});

test('a drop of only refused or asking files still has its closing lines; a document beside an invoice not in the books is said so', () => {
  const refused = [row('docx', { state: 'refused' }), row('csv', { state: 'asks', reason: 'csv-columns' })];
  assert.deepEqual(dropSummary(refused, { transactions: [] }, () => true, new Set(), [], (r) => closingGroupOf(r, undefined)).files, only({ refused: 1, asks: 1 }));
  assert.equal(closingGroupOf(row('ab'), { kind: 'supporting', why: 'Auftragsbestätigung' }), 'beside', 'no invoice of it in the books: «kommt neben ihre Rechnung»');
  assert.equal(closingGroupOf(row('ab'), { kind: 'supporting', why: 'Auftragsbestätigung', of: { id: 'fm', name: 'FM-78230' } }), 'supporting');
});
