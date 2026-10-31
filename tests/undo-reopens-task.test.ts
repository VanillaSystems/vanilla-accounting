/**
 * Änderungen › «Rückgängig» of a booking made by hand since the last save leaves the payment
 * without a booking: the question the person had answered by booking it («Bewegung von Hand
 * buchen») comes back under Aufgaben (r8k-6). The booking workflow starts on the payment again;
 * without a model it holds at the hand step, with one it books the payment as it would any other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initRepository } from '../src/workspace/git.js';
import { loadBooks, periodLock } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { AutomationView } from '../src/workflows/model.js';
import { startApi } from './support/api-server.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';

test('undoing a hand booking in Änderungen brings the payment\'s task back', async () => {
  const api = await startApi('demo');
  try {
    const ws = workspaceAt(api.root);
    const books = loadBooks(ws);
    const lock = periodLock(books);
    const tx = books.transactions.find((t) => !lock.isClosed(t.date) && t.direction === 'DBIT' && t.bank !== 'manual' && books.journalEntries.some((e) => e.transactionRef === t.ref))!;
    for (const e of books.journalEntries.filter((e) => e.transactionRef === tx.ref)) assert.equal((await api.send('DELETE', `/api/journal-entries/${e.id}`)).status, 200);
    await initRepository(api.ws.paths.repository, 'Workspace set up');

    const view = async () => (await (await api.fetch('/api/automation')).json()) as AutomationView;
    const taskOn = async (ref: string, want: boolean) => {
      for (let i = 0; i < 100; i++) {
        const v = await view();
        const has = v.tasks.some((t) => t.item.kind === 'transaction' && t.item.id === ref);
        if (has === want) return v.tasks.find((t) => t.item.id === ref);
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no task on ${ref} became ${want}`);
    };
    const started = await api.send('POST', '/api/automation', { kind: 'start', workflow: 'booking', item: { kind: 'transaction', id: tx.ref } });
    assert.equal(started.json.ok, true, JSON.stringify(started.json));
    const task = (await taskOn(tx.ref, true))!;
    assert.ok(task.outcomes.includes('booked'), 'without a model the run waits for the hand booking');

    const bank = ws.bankAccounts.find((b) => b.bank === tx.bank && b.currency === tx.currency)!.account;
    const booked = await api.send('POST', `/api/transactions/${tx.ref}/entries`, { lines: [{ accountDebit: '6500', accountCredit: bank, amount: tx.amount, description: 'von Hand' }] });
    assert.equal(booked.status, 200, JSON.stringify(booked.json));
    assert.equal((await api.send('POST', '/api/automation', { kind: 'answer', run: task.run, outcome: 'booked' })).json.ok, true);
    await taskOn(tx.ref, false);

    const hand = loadBooks(ws).journalEntries.find((e) => e.transactionRef === tx.ref)!;
    const undone = await api.send('POST', `/api/journal-entries/${hand.id}/as-saved`);
    assert.equal(undone.status, 200, JSON.stringify(undone.json));
    assert.equal(loadBooks(ws).journalEntries.some((e) => e.transactionRef === tx.ref), false, 'the payment is unbooked again');
    const back = await taskOn(tx.ref, true);
    assert.ok(back?.outcomes.includes('booked'), 'the hand-booking task is back');
  } finally {
    await api.stop();
  }
});
