/**
 * Review of PR #441 (#391): a readable receipt that names no VAT is «not read yet», and nothing
 * books input tax on it. The company's `unreadReceipt` counts only a receipt that could not be
 * read; a payment whose receipts nobody has read waits for the VAT step instead of the model's
 * code; a model's rate code on such a receipt is lowered to the zero code; the rule card does not
 * warn of «input tax withheld» on it. «No Swiss VAT» in words is no answer beside «inkl. MWST» or a
 * superseded rate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, ruleBookingLines, type ClassifyContext } from '../src/booking/classify.js';
import { businessVat } from '../src/booking/purchase-vat.js';
import { nationalCodes, overrideOf } from '../src/booking/national-vat.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { vatStep } from '../src/intake/vat.js';
import { textFacts } from '../src/parsers/receipt-text.js';
import { loadBooks, saveBooks, type Books } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { startApi } from './support/api-server.js';
import type { BooksPort } from '../src/intake/pipeline.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
const STATION = `id: station\nname: Tankstelle Berg\nmatch: { tx: [ "tankstelle berg" ] }\n`;
const HOUSE = `id: station\nsteps:\n  booking.guide.yaml#purchase_vat:\n    rules:\n      - id: station-unread\n        when: a receipt that stays unreadable\n        then: charged at 8.1\n        apply: { unreadReceipt: 8.1 }\n        source: decision 2026-10-21\n`;

function knowledge(house: boolean) {
  const app = mkdtempSync(join(tmpdir(), 'r441-app-'));
  const ws = mkdtempSync(join(tmpdir(), 'r441-ws-'));
  mkdirSync(join(app, 'processes', 'suppliers'), { recursive: true });
  writeFileSync(join(app, 'processes', 'suppliers', 'station.yaml'), STATION);
  mkdirSync(join(ws, 'knowledge', 'suppliers'), { recursive: true });
  if (house) writeFileSync(join(ws, 'knowledge', 'suppliers', 'station.yaml'), HOUSE);
  return loadKnowledge(app, ws);
}
const ctx = (house: boolean): ClassifyContext => {
  const k = knowledge(house);
  return { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }], counterparties: k.counterparties, purchaseVat: businessVat(k) };
};
const tx: BankTransaction = { ref: 'P1', bank: 'Raiffeisen', date: '2026-10-17', amount: 80, currency: 'CHF', direction: 'DBIT', description: 'Tankstelle Berg Dorf' } as BankTransaction;
const SILENT = (): Receipt => ({ id: 'r1', filename: '20261017-tankstelle.pdf', kind: 'invoice', date: '2026-10-17', amount: 80, currency: 'CHF',
  extractedText: 'Tankstelle Berg Dorf\nRechnung 4711\nBenzin Oktober 2026\nTotal CHF 80.00\nzahlbar innert 30 Tagen', extractionMethod: 'pdftotext' } as Receipt);
/** A receipt the VAT step tried and could not read (#57): what `unreadReceipt` speaks of. */
const UNREADABLE = (): Receipt => ({ ...SILENT(), needsVisionReview: true });

function booksWith(r: Receipt): Books {
  return { transactions: [tx], receipts: [r], mappings: [{ transactionRef: tx.ref, receiptId: r.id }], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-09-30' } } as unknown as Books;
}
const port = (b: Books): BooksPort => ({ read: () => structuredClone(b), update: (fn) => fn(b) });
const classifyModel = (vat: string) => async (prompt: string) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [{ accountDebit: '6200', accountCredit: '', amount: 80, vatCode: vat, description: 'Benzin' }], reason: 'Modell' }])));
};

/** The VAT step (no model, a model that reads «no Swiss VAT», or one that fails), then the classifier with the model's code. */
async function run(house: boolean, vatAnswer: 'none' | 'ok' | 'fail', classifyVat?: string) {
  const b = booksWith(SILENT());
  const vatAsk = vatAnswer === 'none' ? undefined : async () => (vatAnswer === 'ok' ? JSON.stringify({ vatId: '', hasSwissVat: false, vatSummary: [] }) : 'kaputt');
  await vatStep()({ ws: undefined as never, books: port(b), ask: vatAsk as never, progress: () => {}, log: () => {} });
  const outcome = await classifyTransactions(b, [tx], { ask: classifyVat ? (classifyModel(classifyVat) as never) : undefined, fx, context: ctx(house) });
  return { codes: b.journalEntries.map((e) => e.vatCode ?? ''), outcome, receipt: b.receipts[0] };
}

test('no model: the payment of a silent receipt is left to the person or a later run, nothing booked', async () => {
  const { codes, outcome } = await run(true, 'none');
  assert.deepEqual(codes, []);
  assert.deepEqual(outcome.unasked, [tx.ref]);
});

test('the model read «no Swiss VAT»: booked at the zero code, the company\'s unreadReceipt does not count a read receipt', async () => {
  const { codes } = await run(true, 'ok', 'I0');
  assert.deepEqual(codes, ['I0']);
});

for (const [name, house, code] of [
  ['the classifier writes I0, the company counts unread receipts at 8.1', true, 'I0'],
  ['the classifier writes I81, no company rule', false, 'I81'],
  ['the classifier writes I81, the company counts unread receipts at 8.1', true, 'I81'],
] as const) {
  test(`the VAT read failed, ${name}: the payment waits for the reading, never booked with input tax`, async () => {
    const { codes, outcome, receipt } = await run(house, 'fail', code);
    assert.equal(receipt.hasSwissVat, undefined, 'still not read');
    assert.deepEqual(codes, [], 'nothing booked: no I81 by code or by the model');
    assert.deepEqual([outcome.vatNotRead, outcome.failed], [[tx.ref], []], 'counted as waiting, not as failed');
  });
}

test('the next run reads the receipt, and the payment is booked then', async () => {
  const b = booksWith(SILENT());
  await vatStep()({ ws: undefined as never, books: port(b), ask: (async () => 'kaputt') as never, progress: () => {}, log: () => {} });
  await classifyTransactions(b, [tx], { ask: classifyModel('I81') as never, fx, context: ctx(false) });
  assert.equal(b.journalEntries.length, 0);
  await vatStep()({ ws: undefined as never, books: port(b), ask: (async () => JSON.stringify({ vatId: '', hasSwissVat: false, vatSummary: [] })) as never, progress: () => {}, log: () => {} });
  await classifyTransactions(b, [tx], { ask: classifyModel('I81') as never, fx, context: ctx(false) });
  assert.deepEqual(b.journalEntries.map((e) => e.vatCode), ['I0'], 'read «no Swiss VAT»: the model\'s I81 lowered by the evidence check');
});

test('a rule\'s rate code on a silent receipt books the zero code', () => {
  assert.deepEqual(ruleBookingLines(tx, { account: '6200', vat: 'I81' } as never, [SILENT()], undefined), [{ account: '6200', vat: 'I0', amount: 80 }]);
});

test('a rate code on receipts nobody has read is lowered to the zero code (the national rules a rule card compares with)', () => {
  const codes = nationalCodes(tx, [{ accountDebit: '6200', accountCredit: '', amount: 80, vatCode: 'I81' }] as never, [SILENT()], {} as never, ctx(false));
  assert.deepEqual(codes, ['I0']);
});

test('the rule card does not warn «ohne Vorsteuer, obwohl der Beleg Schweizer MWST zeigt» on a silent receipt; on one that could not be read the company\'s rate still counts', () => {
  const silent = nationalCodes(tx, [{ accountDebit: '6200', accountCredit: '', amount: 80, vatCode: 'I0' }] as never, [SILENT()], {} as never, ctx(true));
  assert.deepEqual(silent, ['I0']);
  assert.equal(overrideOf('I0', silent[0]), undefined, 'no departure to warn about');
  const unreadable = nationalCodes(tx, [{ accountDebit: '6200', accountCredit: '', amount: 80, vatCode: 'I0' }] as never, [UNREADABLE()], {} as never, ctx(true));
  assert.deepEqual(unreadable, ['I81'], 'the company\'s unreadReceipt for a receipt that could not be read');
});

test('«Buchen» on one payment whose receipt nobody has read reads its VAT first, in the same click, then books on it', async () => {
  const api = await startApi('tests/fixtures/classify-index.json', { PATH: `${join(process.cwd(), 'tests/support/stub-bin')}:${process.env.PATH}` });
  try {
    const ws = workspaceAt(api.ws.paths.root);
    const b = loadBooks(ws);
    const rw = b.receipts.find((r) => r.id === 'rw')!;
    for (const k of ['hasSwissVat', 'vatSummary', 'vatId', 'vatExtractedAt'] as const) delete rw[k];
    saveBooks(ws, b);
    const { status, json } = await api.send('POST', '/api/journal-entries/classify/W1');
    assert.equal(status, 200, String(json.error));
    const saved = loadBooks(ws);
    const read = saved.receipts.find((r) => r.id === 'rw')!;
    assert.deepEqual([read.hasSwissVat, !!read.vatExtractedAt], [false, true], 'the stub model read its VAT in the click');
    assert.deepEqual(saved.journalEntries.filter((e) => e.transactionRef === 'W1').map((e) => e.vatCode), ['I0'], 'booked on what it read');
  } finally {
    await api.stop();
  }
});

test('«no Swiss VAT» in words is no answer beside «inkl. MWST» or a superseded Swiss rate; alone it is', () => {
  assert.equal(textFacts('Druckerei Blatt AG\nRechnung 12\nFlyer inkl. MWST 108.10\nPorto nicht MWST-pflichtig 9.00\nTotal 117.10').noSwissVat, undefined);
  assert.equal(textFacts('Druckerei Blatt AG\nRechnung 2023-12\nTotal 107.70\nnicht MWST-pflichtig\nMWST 7.7 % 7.70').noSwissVat, undefined);
  assert.equal(textFacts('Druckerei Blatt AG\nRechnung 12\nFlyer 100.00 Porto ohne MWST 9.00\nTotal 109.00').noSwissVat, undefined, '«ohne MWST» alone says nothing');
  assert.equal(textFacts('Atelier Klein\nRechnung 12\nTotal CHF 300.00\nnicht MWST-pflichtig').noSwissVat, true);
  assert.equal(textFacts('Design Studio Ltd\nInvoice 88\nTotal CHF 300.00\nThis service is not subject to Swiss VAT.').noSwissVat, true);
});
