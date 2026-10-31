/**
 * A bank statement in the inbox (issue #151): the read step types it by code and dates it on its
 * period's last day; the VAT step leaves it, nothing links it to a payment, and a model that reads
 * another day off it does not move its date.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import type { Receipt } from '../src/types/index.js';

const KONTOAUSZUG = ['Raiffeisenbank Beispieldorf', 'Kontoauszug 01.08.2026 - 31.08.2026', 'Beispiel Kaffee GmbH, Bahnhofweg 1, 8000 Zürich', 'IBAN CH65 8080 8000 0000 0000 1, Währung CHF', '',
  'Saldovortrag 01.08.2026: 18 500.00', '03.08.2026 | Zahlung Swisscom | -89.00 | Ref. R-1', 'Schlusssaldo 31.08.2026: 18 411.00'];
const WISE = ['Wise Europe SA', 'EUR statement', 'Beispiel Kaffee GmbH', 'Balance brought forward 1,200.00 EUR',
  'Description | Incoming | Outgoing | Amount', 'Card transaction Beispiel Shop | | -220.00 | 980.00', 'Closing balance 980.00 EUR'];
const WISE_NAME = 'statement_12345678_EUR_2026-08-01_2026-08-31.pdf';

type Books = { receipts: Receipt[]; mappings: Array<{ receiptId: string; transactionRef: string }>; transactions: Array<{ ref: string; date: string }> };
const booksOf = async (api: ApiServer) => (await (await api.fetch('/books.json')).json()) as Books;

/** The demo with both statements in its inbox, the receipt-intake run started and come to rest. */
async function intake(api: ApiServer) {
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  const inbox = join(api.root, 'beleg-import');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'Kontoauszug.pdf'), await textPdf(KONTOAUSZUG));
  writeFileSync(join(inbox, WISE_NAME), await textPdf(WISE));
  const started = await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } });
  assert.equal(started.status, 200);
  await api.rest();
  const books = await booksOf(api);
  const of = (name: string) => books.receipts.find((r) => r.originalFilename === name);
  return { books, raiffeisen: of('Kontoauszug.pdf'), wise: of(WISE_NAME) };
}

const typed = (r: Receipt | undefined) => r && { kind: r.kind, kindBy: r.kindBy, kindRule: r.kindRule, date: r.date };
const STATEMENT = { kind: 'statement', kindBy: 'rule', kindRule: 'document:statement', date: '2026-08-31' };

test('without a model, a Kontoauszug and a Wise statement in the inbox are typed as statements and dated on the period\'s last day, from the text or the name', async () => {
  const api = await startApi('demo');
  try {
    const { books, raiffeisen, wise } = await intake(api);
    assert.deepEqual(typed(raiffeisen), STATEMENT);
    assert.deepEqual(typed(wise), STATEMENT);
    for (const r of [raiffeisen!, wise!]) {
      assert.equal(r.vatExtractedAt, undefined, `${r.originalFilename}: the VAT step left it`);
      assert.equal(r.hasSwissVat, undefined, `${r.originalFilename}: no VAT facts`);
      assert.ok(!books.mappings.some((m) => m.receiptId === r.id), `${r.originalFilename}: linked to no payment`);
    }
  } finally {
    await api.stop();
  }
});

test('a model that reads another day off a statement and names a payment neither moves its date nor links it', async () => {
  const probe = await startApi('demo');
  const open = await booksOf(probe).then((b) => b.transactions.find((t) => t.date > '2026-07-01' && !b.mappings.some((m) => m.transactionRef === t.ref)));
  await probe.stop();
  assert.ok(open, 'the demo has an open payment without a receipt');
  const answer = { suggestedFilename: '20260905-kontoauszug.pdf', date: '2026-09-05', description: 'Kontoauszug', amount: 18411, currency: 'CHF', confidence: 0.95, matchedTransactionRefs: [open.ref] };
  const api = await startApi('demo', { PATH: `${join(process.cwd(), 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(answer) });
  try {
    const { books, raiffeisen } = await intake(api);
    assert.deepEqual(typed(raiffeisen), STATEMENT);
    assert.ok(!books.mappings.some((m) => m.receiptId === raiffeisen!.id), 'not linked to the payment the model named');
  } finally {
    await api.stop();
  }
});
