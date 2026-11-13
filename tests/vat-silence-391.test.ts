/**
 * #391: silence on a receipt is «MWST noch nicht gelesen», never «keine CH-MWST». The VAT step
 * records `hasSwissVat: false` only from words that say so (textFacts `noSwissVat`) or from a
 * model; a receipt it could not read stays without facts, so a later model run reads it. The
 * VAT indicator finds a VAT word as a word (no «USt» inside «August»), TVA and IVA, and a
 * Swiss UID with a space or dots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks, type Books } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { Ask, BooksPort } from '../src/intake/pipeline.js';
import { vatCandidates, vatStep } from '../src/intake/vat.js';
import { hasVatIndicator } from '../src/parsers/receipt-text.js';
import { isUnreadable, linkedOf } from '../src/accounting/receipt-due.js';
import { rateShown } from '../src/booking/rule-vat.js';
import type { Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

test('a VAT word inside another word is no VAT indicator', () => {
  for (const text of ['Gerüst August 2026\nTotal CHF 1120.00', 'Muster AG\nTotal 50.00', 'Industrie Bedarf GmbH\nTotal 80.00', 'Privatbezug 40.00', 'Kunstharz Lack 12.00']) {
    assert.equal(hasVatIndicator(text), false, text);
  }
});

test('TVA, IVA, a VAT word beside «inkl.» and a Swiss UID with spaces or dots are VAT indicators', () => {
  for (const text of ['Peinture SA\nCHE 111.222.333 TVA\nTotal 108.10', 'Total CHF 54.00 TVA incluse', 'Totale CHF 54.00 IVA inclusa', 'Total CHF 54.00 MWST inkl.', 'USt-IdNr. DE123456789', 'MwSt. 19 %', 'CHE 111 222 333', 'CHE-111.222.333 MWST']) {
    assert.equal(hasVatIndicator(text), true, text);
  }
});

const SILENT: Receipt = {
  id: 'vat-391-silent', filename: '20260814-geruest-juli.pdf', originalFilename: 'Geruest_Juli.pdf',
  extractedText: 'Gerüstbau Brunner AG\nRechnung 4711\nGerüstmiete Juli 2026\nTotal CHF 1120.00\nzahlbar innert 30 Tagen', extractionMethod: 'pdftotext',
  fileSize: 2000, indexedAt: '2026-08-14T00:00:00.000Z', location: 'archived', date: '2026-08-14', amount: 1120, currency: 'CHF',
};

function demo(...receipts: Receipt[]) {
  const books: Books = JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT))));
  books.receipts.push(...receipts.map((r) => structuredClone(r)));
  const port: BooksPort = { read: () => structuredClone(books), update: (fn) => fn(books) };
  const run = (ask?: Ask) => vatStep()({ ws: undefined as never, books: port, ask, progress: () => {}, log: () => {} });
  return { books, run, get: (id: string) => books.receipts.find((r) => r.id === id)! };
}

test('without a model a silent receipt is «noch nicht gelesen»: no facts, counted as waiting for the model', async () => {
  const { books, run, get } = demo(SILENT);
  const { notes } = await run();
  const r = get(SILENT.id);
  assert.deepEqual([r.hasSwissVat, r.vatExtractedAt, r.vatSummary], [undefined, undefined, undefined], 'no «keine CH-MWST» from silence');
  const waiting = notes.find((n) => n.code === 'noModel');
  assert.ok(waiting && waiting.code === 'noModel' && waiting.waiting >= 1, 'the receipt waits for the model and the note says so');
  // What it does to its payment: it is no unreadable receipt (#57), its payment does not wait for the person on it.
  assert.equal(isUnreadable(r), false);
  assert.equal(linkedOf([r]), 'read');
  // A rule drafted on it does not fill «no Swiss VAT»: the receipt decides no rate.
  assert.equal(rateShown(r), undefined);
  assert.equal(vatCandidates(books).some((x) => x.id === SILENT.id), true, 'the next run takes it up again');
});

test('words that say so give «keine CH-MWST» without a model', async () => {
  const texts = [
    'Atelier Klein\nRechnung 12\nTotal CHF 300.00\nBetrag ohne MWST, da nicht MWST-pflichtig.',
    'Design Studio Ltd\nInvoice 88\nTotal CHF 300.00\nThis service is not subject to Swiss VAT.',
    'Die Mobiliar\nPrämienrechnung\nTotal CHF 980.00\nVersicherungsprämien sind von der MWST ausgenommen.',
  ];
  const receipts = texts.map((extractedText, i) => ({ ...SILENT, id: `vat-391-words-${i}`, extractedText }));
  const { run, get } = demo(...receipts);
  await run();
  for (const r of receipts) assert.equal(get(r.id).hasSwissVat, false, r.extractedText);
});

test('a later model run reads a silent receipt, and its answer is kept', async () => {
  const { books, run, get } = demo(SILENT);
  await run();
  assert.equal(get(SILENT.id).hasSwissVat, undefined);
  const asked: string[] = [];
  const answer = { vatId: 'CHE-111.222.333', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 83.98, gross: 1120 }] };
  await run(async (prompt) => { asked.push(prompt); return JSON.stringify(answer); });
  assert.ok(asked.some((p) => p.includes('Gerüstbau Brunner AG')), 'the model is asked about the silent receipt');
  const r = get(SILENT.id);
  assert.deepEqual([r.hasSwissVat, r.vatId, !!r.vatExtractedAt], [true, 'CHE-111.222.333', true]);
  assert.equal(vatCandidates(books, false, true).some((x) => x.id === SILENT.id), false, 'and is not asked again');
});

test('with a model a silent receipt is the model\'s to read, never code\'s «no Swiss VAT»', async () => {
  const { run, get } = demo(SILENT);
  const asked: string[] = [];
  await run(async (prompt) => { asked.push(prompt); return JSON.stringify({ vatId: '', hasSwissVat: false, vatSummary: [] }); });
  assert.ok(asked.some((p) => p.includes('Gerüstbau Brunner AG')));
  assert.deepEqual([get(SILENT.id).hasSwissVat, !!get(SILENT.id).vatExtractedAt], [false, true], 'the model said so');
});
