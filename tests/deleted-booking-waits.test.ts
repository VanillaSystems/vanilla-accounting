/**
 * A booking deleted on purpose stays deleted (r10h-5): a person who deletes a payment's booking
 * («die buche ich selber neu»), by hand or through the KI sidebar, means to book it herself. The
 * payment is marked as waiting for her, the next inbox run leaves it alone, and the mark goes when
 * she books it, or asks the app to with «Automatisch buchen».
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { CommandResult, RunDetail } from '../src/workflows/model.js';
import type { JournalEntry } from '../src/types/index.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
let api: ApiServer;

before(async () => {
  api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}` });
  // The inbox run reads the bank again: with the demo's statements in place it finds the same payments.
  cpSync(join(DEMO_ROOT, 'transactional-data/2026/bank-statements'), join(api.root, 'transactional-data/2026/bank-statements'), { recursive: true });
});
after(async () => { await api?.stop(); });

const books = () => loadBooks(workspaceAt(api.root));
const payment = (ref: string) => books().transactions.find((t) => t.ref === ref)!;
const entriesOf = (ref: string) => books().journalEntries.filter((e) => e.transactionRef === ref);
/** A bank payment of the open period the demo books with one entry that is not a person's. */
function openBooked(): { ref: string; entry: JournalEntry } {
  const b = books();
  const closed = b.config.closedThrough ?? '';
  const one = b.journalEntries.filter((e) => e.origin !== 'manual' && e.date > closed && b.journalEntries.filter((x) => x.transactionRef === e.transactionRef).length === 1);
  const entry = one.find((e) => b.transactions.some((t) => t.ref === e.transactionRef && t.bank !== 'manual'))!;
  return { ref: entry.transactionRef, entry };
}
async function inboxRun(): Promise<RunDetail> {
  const started = (await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } })).json as unknown as CommandResult & { run: string };
  for (let i = 0; i < 1500; i++) {
    const r = (await api.send('GET', `/api/automation/runs/${started.run}`)).json as unknown as RunDetail;
    if (r.status !== 'queued' && r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail('timed out waiting for the inbox run');
}

test('a deleted booking marks its payment as waiting for the person; the inbox run leaves it; booking it by hand or «Automatisch buchen» takes the mark off', async () => {
  const { ref, entry } = openBooked();
  assert.equal(payment(ref).waitsForPerson, undefined);

  assert.equal((await api.send('DELETE', `/api/journal-entries/${entry.id}`)).status, 200);
  assert.deepEqual(payment(ref).waitsForPerson?.why, 'bookingDeleted', 'the payment waits for the person');

  const run = await inboxRun();
  assert.equal(run.status, 'done', JSON.stringify(run.steps?.map((s) => [s.step, s.outcome])));
  assert.deepEqual(entriesOf(ref), [], 'the run booked nothing on it');
  assert.ok(payment(ref).waitsForPerson, 'and it still waits');

  const asked = await api.send('POST', `/api/journal-entries/classify/${ref}`, {});
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.ok(entriesOf(ref).length >= 1, '«Automatisch buchen» books it');
  assert.equal(payment(ref).waitsForPerson, undefined, 'and the mark is gone');

  for (const e of entriesOf(ref)) assert.equal((await api.send('DELETE', `/api/journal-entries/${e.id}`)).status, 200);
  assert.ok(payment(ref).waitsForPerson);
  const { accountDebit, accountCredit, amount, vatCode, exchangeCurrency, exchangeRate } = entry;
  const byHand = await api.send('POST', '/api/journal-entries', { transactionRef: ref, date: entry.date, accountDebit, accountCredit, amount, ...(vatCode && { vatCode }), description: 'Von Hand', ...(exchangeCurrency && { exchangeCurrency, exchangeRate }) });
  assert.equal(byHand.status, 200, JSON.stringify(byHand.json));
  assert.equal(payment(ref).waitsForPerson, undefined, 'a booking by hand takes the mark off');
});
