/**
 * Issue #284: a legible phone photo of a till receipt whose stored text is an old local OCR's noise.
 * Noise proves no «no VAT»: the VAT step never stamps it so, the read step lets the model read the
 * photo again once, and a photo the model cannot read either reaches the #57 question. The audit
 * names a linked receipt whose VAT is not read as such, never as «no receipt» or «no Swiss MWST».
 * The fuel receipt here is made up.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageToPdf } from '../src/parsers/image-pdf.js';
import { textProves, waitsForReading } from '../src/parsers/receipt-text.js';
import { readStep } from '../src/intake/read.js';
import { vatStep } from '../src/intake/vat.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { isUnreadable } from '../src/accounting/receipt-due.js';
import { auditVat } from '../src/reconcile/vat-consistency.js';
import { yearPaths } from '../src/workspace/workspace.js';
import type { Index, Receipt } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const NOISE = '=\n.;\nx!\n\nEX dr ir\nale\na\ncs\na';
const PHOTO_TEXT = [
  'Tankquittung', '', 'Tankstelle Muster AG', 'Bahnhofstrasse 1', '8000 Zürich', 'Rechnung 4711#',
  'Bleifrei 95  30,000  52,50', 'Tankzeit: 14.08.2026 08:56:44', 'ZWISCHENSUMME 52,50',
  'Netto MwSt. Brutto', '8,10 % 48,57 3,93 52,50', 'Tankstelle Muster AG', 'CHE-123.456.789 MWST', 'SUMME CHF 52,50',
].join('\n');
const UNREADABLE = 'Nicht lesbar. Das Foto ist verwackelt, keine Zeile ist zu erkennen.';
const FACTS = { vatId: 'CHE-123.456.789', currency: 'CHF', total: 52.5, hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 48.57, vat: 3.93, gross: 52.5 }] };

// 2 x 2 pixels: a photo, no text of its own.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBAB7FA/+WnI5aAAAAAElFTkSuQmCC', 'base64');

test('a receipt waits for the model\'s reading while its text is empty or noise no model read, and nobody entered its date and amount', () => {
  const r = (extractedText: string, extractionMethod: 'tesseract' | 'pdftotext' | 'claude-vision', rest: { date?: string; amount?: number; kind?: 'noise' | 'duplicate' | 'statement' | 'invoice' } = {}) => ({ extractedText, extractionMethod, ...rest });
  assert.equal(waitsForReading(r('', 'tesseract')), true, 'a photo without text');
  assert.equal(waitsForReading(r('', 'claude-vision')), true, 'also after a model call that failed and left nothing');
  assert.equal(waitsForReading(r(NOISE, 'tesseract', { date: '2026-08-14' })), true, 'an OCR\'s noise, with only the day the phone took it: what the list showed as read on a firm without VAT');
  assert.equal(waitsForReading(r(NOISE, 'tesseract', { date: '2026-08-14', amount: 52.5 })), false, 'date and amount entered by hand: it waits no more');
  assert.equal(waitsForReading(r(UNREADABLE, 'claude-vision')), false, 'the model read it and said it is illegible: reading again changes nothing');
  assert.equal(waitsForReading(r(PHOTO_TEXT, 'claude-vision')), false, 'read');
  assert.equal(waitsForReading(r('Lieferschein Muster AG, drei Kartons', 'pdftotext')), false, 'a PDF\'s own text');
  for (const kind of ['noise', 'duplicate', 'statement'] as const) assert.equal(waitsForReading(r('', 'tesseract', { kind })), false, `${kind}: set aside, waits for nothing`);
});

test('a reading of a picture proves something only when it is legible; a PDF\'s own text says what the document says', () => {
  const ocr = (extractedText: string) => ({ extractedText, extractionMethod: 'tesseract' as const });
  assert.equal(textProves(ocr(NOISE)), false, '28 characters of noise');
  assert.equal(textProves(ocr('mit Tankstelle\n|')), false);
  assert.equal(textProves(ocr('Total 52,50 ale cs ir')), false, 'one real word beside an amount');
  assert.equal(textProves({ extractedText: UNREADABLE, extractionMethod: 'claude-vision' }), false, 'the model saying it cannot read the photo');
  assert.equal(textProves({ extractedText: PHOTO_TEXT, extractionMethod: 'claude-vision' }), true);
  assert.equal(textProves({ extractedText: 'Lieferschein Muster AG, drei Kartons', extractionMethod: 'pdftotext' }), true, 'own text without an amount');
  assert.equal(textProves({ extractedText: 'mit Tankstelle\n|', extractionMethod: 'pdftotext' }), false, 'own text too short');
});

/** A temp workspace whose receipts/ holds a photo PDF, and books holding it as an old OCR left it (`over` changes that). */
async function photoBooks(over: Partial<Receipt> = {}, closedThrough = '2026-06-30') {
  const ws = tempWorkspace('photo-read-');
  const bytes = Buffer.from(await imageToPdf(PNG, 'IMG_0001.PNG'));
  const id = createHash('sha256').update(bytes).digest('hex').substring(0, 16);
  const dir = yearPaths(ws.paths, '2026').receipts;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '20260814-tankstelle.pdf'), bytes);
  const receipt: Receipt = {
    id, filename: '20260814-tankstelle.pdf', originalFilename: 'IMG_0001.pdf', extractedText: NOISE, extractionMethod: 'tesseract',
    fileSize: bytes.length, indexedAt: '2026-08-14T10:00:00.000Z', location: 'archived', date: '2026-08-14',
    hasSwissVat: false, vatSummary: [], vatExtractedAt: '2026-08-15T00:00:00.000Z', ...over,
  };
  writeIndex(ws, { config: { closedThrough }, receipts: [receipt], journalEntries: [] });
  return { ws, id };
}

/** A model that reads the photo as `photo` and its text's VAT as FACTS, counting the calls per step. */
function model(photo: string) {
  const calls: Record<string, number> = {};
  const ask: Ask = async (_prompt, opts) => {
    calls[opts.step] = (calls[opts.step] ?? 0) + 1;
    if (opts.step === 'receipt-vision') return photo;
    if (opts.step === 'receipt-vat') return JSON.stringify(FACTS);
    throw new Error(`unexpected step ${opts.step}`);
  };
  return { ask, calls };
}

const intake = (ws: ReturnType<typeof tempWorkspace>, ask?: Ask) =>
  runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep], ['vat', vatStep()]], ...(ask ? { ask } : {}) });

test('an old OCR\'s noise, stamped «no VAT», is read again by the model once: the photo\'s VAT facts replace the stamp', async () => {
  const { ws, id } = await photoBooks();
  const m = model(PHOTO_TEXT);
  const job = await intake(ws, m.ask);
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done'], JSON.stringify(job.steps.map((s) => s.notes)));
  const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
  assert.deepEqual([r.extractionMethod, r.extractedText], ['claude-vision', PHOTO_TEXT]);
  assert.deepEqual([r.hasSwissVat, r.vatId, r.vatSummary], [true, 'CHE-123.456.789', FACTS.vatSummary]);
  assert.equal(r.date, '2026-08-14', 'a day the receipt has stays: it may be a person\'s');
  assert.deepEqual([r.amount, r.currency], [52.5, 'CHF'], 'a total it lacks is taken from what the text states plainly');
  assert.deepEqual(m.calls, { 'receipt-vision': 1, 'receipt-vat': 1 });

  await intake(ws, m.ask);
  assert.deepEqual(m.calls, { 'receipt-vision': 1, 'receipt-vat': 1 }, 'a second run asks nothing');
});

test('a photo the model cannot read either waits for the person as «Beleg nicht lesbar» (#57), never «no VAT», and is not asked again', async () => {
  const { ws, id } = await photoBooks();
  const m = model(UNREADABLE);
  const job = await intake(ws, m.ask);
  assert.ok(job.steps[1].notes.some((n) => n.code === 'poorScan'), JSON.stringify(job.steps[1].notes));
  const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
  assert.deepEqual([r.hasSwissVat, r.vatSummary, r.vatExtractedAt, r.needsVisionReview], [undefined, undefined, undefined, true]);
  assert.equal(isUnreadable(r), true);
  await intake(ws, m.ask);
  assert.deepEqual(m.calls, { 'receipt-vision': 1 }, 'the model reads the photo once; noise goes to no VAT prompt');
});

test('a photo dropped fresh that the model cannot read is asked of no other prompt and stays a receipt «nicht lesbar», never noise', async () => {
  const ws = tempWorkspace('photo-drop-');
  mkdirSync(ws.paths.inbox, { recursive: true });
  const bytes = Buffer.from(await imageToPdf(PNG, 'IMG_0002.PNG'));
  writeFileSync(join(ws.paths.inbox, 'IMG_0002.pdf'), bytes);
  writeIndex(ws, { config: { closedThrough: '2026-06-30' }, journalEntries: [] });
  const m = model(UNREADABLE);
  await intake(ws, m.ask);
  assert.deepEqual(m.calls, { 'receipt-vision': 1 }, 'its kind is not asked off a reading that proves nothing');
  const r = loadBooks(ws).receipts.find((x) => x.id === createHash('sha256').update(bytes).digest('hex').substring(0, 16))!;
  assert.deepEqual([r.kind, r.hasSwissVat, r.needsVisionReview], [undefined, undefined, true]);
  assert.equal(isUnreadable(r), true);
});

test('without a model the noise is not stamped «no VAT»: the stamp is forgotten and the receipt is «nicht lesbar»', async () => {
  const fresh = await photoBooks({ hasSwissVat: undefined, vatSummary: undefined, vatExtractedAt: undefined });
  const stamped = await photoBooks();
  for (const { ws, id } of [fresh, stamped]) {
    await intake(ws);
    const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
    assert.deepEqual([r.extractedText, r.hasSwissVat, r.vatExtractedAt, r.needsVisionReview], [NOISE, undefined, undefined, true]);
    assert.equal(isUnreadable(r), true);
  }
});

test('a receipt of a filed quarter keeps its text and its facts', async () => {
  const { ws, id } = await photoBooks({}, '2026-09-30');
  const m = model(PHOTO_TEXT);
  await intake(ws, m.ask);
  const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
  assert.deepEqual([r.extractedText, r.extractionMethod, r.hasSwissVat, r.needsVisionReview], [NOISE, 'tesseract', false, undefined]);
  assert.deepEqual(m.calls, {});
});

test('the audit names a linked receipt whose VAT is not read as such, not as «no receipt» or «no Swiss MWST»', () => {
  const receipt = (id: string, over: Partial<Receipt>) => ({ id, extractedText: NOISE, extractionMethod: 'tesseract', ...over });
  const index = {
    transactions: ['T-UNREAD', 'T-STAMPED', 'T-READ', 'T-NONE'].map((ref) => ({ ref, date: '2026-08-14', amount: -52.5, currency: 'CHF' })),
    receipts: [
      receipt('unread', {}),
      receipt('stamped', { hasSwissVat: false, vatSummary: [], vatExtractedAt: '2026-08-15' }),
      receipt('read', { extractedText: 'Hotel Muster, Zimmer 2 Nächte, Total EUR 210,00', extractionMethod: 'claude-vision', hasSwissVat: false, vatSummary: [], vatExtractedAt: '2026-08-15' }),
    ],
    mappings: [{ transactionRef: 'T-UNREAD', receiptId: 'unread' }, { transactionRef: 'T-STAMPED', receiptId: 'stamped' }, { transactionRef: 'T-READ', receiptId: 'read' }],
    journalEntries: ['T-UNREAD', 'T-STAMPED', 'T-READ', 'T-NONE'].map((ref) => ({ id: ref, transactionRef: ref, date: '2026-08-14', accountDebit: '6200', accountCredit: '1020', amount: 52.5, vatCode: 'I81', description: ref })),
  } as unknown as Index;
  const report = auditVat(index);
  const refs = (lines: string[]) => lines.map((l) => l.split('  ')[0]);
  assert.deepEqual(refs(report.rateCodeVatNotRead), ['T-UNREAD', 'T-STAMPED']);
  assert.deepEqual(refs(report.rateCodeNoSwissReceipt), ['T-READ']);
  assert.deepEqual(refs(report.rateCodeNoReceipt), ['T-NONE']);
});
