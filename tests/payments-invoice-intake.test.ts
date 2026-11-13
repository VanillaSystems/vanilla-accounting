/**
 * A provider's monthly Payments Invoice through the whole inbox run (#458): the webshop persona's three
 * bills of July, August and September, dropped together. No payment comes for such a bill (#190), so
 * nothing about it waits for the model's match: code dates it and reads its total off the text, and
 * the booking step books the input tax it shows. Before, the day and the total came only from the
 * model's match answer, and one failed answer left the September bill staged, «fehlt: Datum, Betrag»,
 * its input tax unbooked. The texts are the persona's (.claude/skills/verify/persona-files/webshop.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, moduleActor, PERSON, saveBooks, update } from '../src/books/store.js';
import type { Receipt } from '../src/types/index.js';
import { startApi } from './support/api-server.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { PIPELINE } from '../src/intake/run.js';
import { textFacts } from '../src/parsers/receipt-text.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import './support/jurisdiction.js';

const BILLS = [
  { month: '07', name: 'July', date: '31.07.2026', net: '249.06', vat: '20.17', total: '269.23' },
  { month: '08', name: 'August', date: '31.08.2026', net: '238.04', vat: '19.28', total: '257.32' },
  { month: '09', name: 'September', date: '30.09.2026', net: '275.02', vat: '22.28', total: '297.30' },
];
/** The persona's bill as its PDF reads (Shopify's own UID, as processes/suppliers/shopify.yaml names it). */
const billText = (b: typeof BILLS[number]) => [
  `Shopify Payments Invoice for ${b.name} 2026`,
  'Shopify International Limited, 2nd Floor, 1-2 Victoria Buildings, Haddington Road, Dublin 4, Ireland',
  'VAT number CHE-153.004.184 MWST',
  'Teegarten Wyss GmbH', 'Unterstadt 9', '6210 Sursee',
  `Invoice SP-2026-${b.month}   Invoice date: ${b.date}`,
  `Transaction fees Shopify Payments, ${b.name} 2026 (excl. VAT)   ${b.net}`,
  `VAT 8.1%   ${b.vat}`,
  `Total CHF   ${b.total}`,
  'No payment is due: these fees were deducted from your payouts.',
];

async function dropped(ask: Ask) {
  const dir = mkdtempSync(join(tmpdir(), 'payments-invoice-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-07-01\n  revenue: "3200"\n  fees: { account: "6570", vat: I0 }\n');
  const ws = workspaceAt(dir);
  mkdirSync(ws.paths.inbox, { recursive: true });
  for (const b of BILLS) writeFileSync(join(ws.paths.inbox, `Shopify_Payments_Invoice_2026-${b.month}.pdf`), await textPdf(billText(b)));
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: PIPELINE });
  const books = loadBooks(ws);
  const bills = BILLS.map((b) => books.receipts.find((r) => r.originalFilename === `Shopify_Payments_Invoice_2026-${b.month}.pdf`)!);
  return { books, bills };
}

/** A model that reads the VAT block as the text states it and fails every other question. */
const failing = (asked: string[]): Ask => async (prompt, opts) => {
  asked.push(opts.step);
  if (opts.step === 'receipt-vat') {
    const f = textFacts(prompt);
    return JSON.stringify({ vatId: f.vatId, currency: 'CHF', hasSwissVat: true, vatSummary: f.vatSummary });
  }
  throw new Error('claude exited 1');
};

test('the three Payments Invoices are dated, read and booked by code, whatever the model answers to a match', async () => {
  const asked: string[] = [];
  const { books, bills } = await dropped(failing(asked));
  assert.deepEqual(bills.map((r) => [r.location, r.date, r.amount, r.currency]), [
    ['archived', '2026-07-31', 269.23, 'CHF'],
    ['archived', '2026-08-31', 257.32, 'CHF'],
    ['archived', '2026-09-30', 297.3, 'CHF'],
  ]);
  const vatOf = (id: string) => books.journalEntries.filter((e) => e.receipts?.includes(id)).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode]);
  assert.deepEqual(bills.map((r) => vatOf(r.id)), [
    [['2026-07-31', '', '6570', 20.17, 'I81-2']],
    [['2026-08-31', '', '6570', 19.28, 'I81-2']],
    [['2026-09-30', '', '6570', 22.28, 'I81-2']],
  ], 'each bill\'s input tax once, without a payment');
  assert.equal(asked.includes('receipt-match'), false, 'no bill of a VAT-only correction waits for a match answer');
});

test('«Vorsteuer buchen» on the bill: the date and total she typed are enough; booked once, and refused with why otherwise', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-07-01\n  fees: { account: "6570", vat: I0 }\n');
    const ws = workspaceAt(api.root);
    const b = loadBooks(ws);
    const text = billText(BILLS[2]).join('\n');
    const f = textFacts(text);
    // As the round-5 walk left it: staged, its VAT read, no date and no total until she typed them.
    const bill: Receipt = {
      id: 'sep', filename: 'Shopify_Payments_Invoice_2026-09.pdf', originalFilename: 'Shopify_Payments_Invoice_2026-09.pdf', extractedText: text, extractionMethod: 'pdftotext',
      fileSize: 1, indexedAt: '2026-11-13T11:44:45Z', location: 'staged', vatId: f.vatId, hasSwissVat: true, vatSummary: f.vatSummary, vatExtractedAt: '2026-11-13T11:44:50Z',
    };
    update(b, PERSON, (x) => { x.receipts.push(bill); });
    saveBooks(ws, b);
    const undated = await api.send('POST', '/api/receipts/sep/vat-correction');
    assert.deepEqual([undated.status, undated.json.code, undated.json.params], [409, 'vatCorrection', { why: 'noDate' }]);
    const typed = await api.send('PATCH', '/api/receipts/sep', { date: '2026-09-30', amount: 297.3, currency: 'CHF' });
    assert.equal(typed.status, 200, JSON.stringify(typed.json));
    const first = await api.send('POST', '/api/receipts/sep/vat-correction');
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const after = loadBooks(ws);
    const ref = first.json.ref as string;
    assert.deepEqual(after.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.receipts]), [['2026-09-30', '', '6570', 22.28, 'I81-2', ['sep']]]);
    assert.deepEqual(after.mappings.filter((m) => m.receiptId === 'sep').map((m) => m.transactionRef), [ref]);
    const again = await api.send('POST', '/api/receipts/sep/vat-correction');
    assert.deepEqual([again.status, again.json.code, again.json.params], [409, 'vatCorrection', { why: 'none' }], 'booked once');
  } finally {
    await api.stop();
  }
});
