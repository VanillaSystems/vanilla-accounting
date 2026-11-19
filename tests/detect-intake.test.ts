/**
 * A copy of a receipt that reaches the inbox past the drop (a photo, the Finder, the mail) is
 * caught once its facts are read: the matching step links it to nothing, and Belege asks. Runs
 * the real API server on a copy of the demo with tests/support/stub-bin/claude as the model.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Index } from '../src/types/index.js';
import type { CommandResult, RunDetail } from '../src/workflows/model.js';
import { ledgerOf } from '../src/app/areas/receipts/model.js';
import { startApi } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
const SEPT = '20260910-gruenkaffee-muster-rechnung-2026-09.pdf';
/** The payment the September invoice is linked to in the demo (its ref follows the demo's other payments). */
const PAID = (() => {
  const dir = join(DEMO_ROOT, 'transactional-data/2026/books');
  const lines = (f: string) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>);
  const id = lines('receipts.jsonl').find((r) => r.filename === SEPT)!.id;
  return lines('mappings.jsonl').find((m) => m.receiptId === id)!.transactionRef;
})();
// The model reads the copy as what it is: the September invoice, paid by the payment its original pays.
const ANSWER = { suggestedFilename: '20260910-gruenkaffee-kopie.pdf', date: '2026-09-10', description: 'Grünkaffee Muster', amount: 2888.3, currency: 'CHF', confidence: 0.95, matchedTransactionRefs: [PAID] };

test('a copy read by the run gets no link and no booking; Belege shows it as a possible duplicate of the original', async () => {
  const api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(ANSWER) });
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    mkdirSync(join(api.root, 'beleg-import'));
    copyFileSync(join(api.root, 'transactional-data/2026/receipts', SEPT), join(api.root, 'beleg-import', 'Scan 12.pdf'));
    appendFileSync(join(api.root, 'beleg-import', 'Scan 12.pdf'), '\n% scanned\n');
    const started = (await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } })).json as unknown as CommandResult & { run: string };
    let run: RunDetail | undefined;
    for (let i = 0; i < 1500 && (!run || run.status === 'queued' || run.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      run = (await api.send('GET', `/api/automation/runs/${started.run}`)).json as unknown as RunDetail;
    }
    assert.equal(run?.status, 'done');
    const books = (await (await api.fetch('/books.json')).json()) as Index;
    const copy = books.receipts.find((r) => r.filename === '20260910-gruenkaffee-kopie.pdf')!;
    const original = books.receipts.find((r) => r.filename === SEPT)!;
    assert.ok(copy, 'read, named and archived');
    assert.deepEqual(books.mappings.filter((m) => m.receiptId === copy.id), [], 'no second link');
    assert.deepEqual(books.mappings.filter((m) => m.transactionRef === PAID).map((m) => m.receiptId), [original.id], 'the payment keeps its one receipt');
    assert.deepEqual(ledgerOf(books, '2026-07-01').byId.get(copy.id)?.twin, { of: original.id, why: 'same-text', relation: 'duplicate' });
  } finally {
    await api.stop();
  }
});
