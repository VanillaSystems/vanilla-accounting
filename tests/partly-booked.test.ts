/**
 * One truth for «gebucht» (r9k-2): a payment is booked when its lines add up to what the bank
 * paid (src/accounting/payment-entries.ts bookedState). Undoing one line of a split in Änderungen
 * leaves the payment partly booked: it is listed under Aufgaben again, the bank list marks it, and
 * the hand form books the rest (not the whole payment twice); a fully booked payment still refuses
 * a second booking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initRepository } from '../src/workspace/git.js';
import { loadBooks, periodLock } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { bookedState } from '../src/accounting/payment-entries.js';
import { unbookedPayments } from '../src/app/areas/bank/model.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import type { AutomationView } from '../src/workflows/model.js';
import { startApi } from './support/api-server.js';
import './support/jurisdiction.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';

test('undoing one line of a split leaves the payment partly booked: task back, listed as unbooked, the rest bookable, never the whole twice', async () => {
  const api = await startApi('demo');
  try {
    const ws = workspaceAt(api.root);
    const books = loadBooks(ws);
    const lock = periodLock(books);
    const tx = books.transactions.find((t) => !lock.isClosed(t.date) && t.direction === 'DBIT' && t.bank !== 'manual' && t.amount > 100 && books.journalEntries.some((e) => e.transactionRef === t.ref))!;
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

    const bank = ws.bankAccounts.find((b) => b.bank === tx.bank && b.currency === tx.currency)!.account;
    const part = 50;
    const split = [
      { accountDebit: '6500', accountCredit: bank, amount: Math.round((tx.amount - part) * 100) / 100, description: 'Teil 1' },
      { accountDebit: '6510', accountCredit: bank, amount: part, description: 'Teil 2' },
    ];
    const booked = await api.send('POST', `/api/transactions/${tx.ref}/entries`, { lines: split });
    assert.equal(booked.status, 200, JSON.stringify(booked.json));
    assert.equal((await api.send('POST', '/api/automation', { kind: 'answer', run: task.run, outcome: 'booked' })).json.ok, true);
    await taskOn(tx.ref, false);
    assert.equal(bookedState(loadBooks(ws), tx.ref, ws.bankAccounts), 'booked');

    const second = loadBooks(ws).journalEntries.find((e) => e.transactionRef === tx.ref && e.amount === part)!;
    const undone = await api.send('POST', `/api/journal-entries/${second.id}/as-saved`);
    assert.equal(undone.status, 200, JSON.stringify(undone.json));
    const half = loadBooks(ws);
    assert.equal(half.journalEntries.filter((e) => e.transactionRef === tx.ref).length, 1, 'the first line stays');
    assert.equal(bookedState(half, tx.ref, ws.bankAccounts), 'partly');
    assert.ok(unbookedPayments(half, ws.bankAccounts).some((t) => t.ref === tx.ref), 'Aufgaben and the bank list see a payment that is not fully booked');
    const back = await taskOn(tx.ref, true);
    assert.ok(back?.outcomes.includes('booked'), 'the hand-booking task is back');
    const draft = bookingDraft(half, tx.ref, ws.bankAccounts)!;
    assert.deepEqual(draft.lines.map((l) => l.amount), [part], 'the form opens with the rest, not the whole payment');

    const whole = await api.send('POST', `/api/transactions/${tx.ref}/entries`, { lines: [{ accountDebit: '6500', accountCredit: bank, amount: tx.amount, description: 'alles' }] });
    assert.deepEqual([whole.status, whole.json.code], [400, 'paymentBalance'], 'the whole payment on top of the first line would overbook it');
    const rest = await api.send('POST', `/api/transactions/${tx.ref}/entries`, { lines: [split[1]] });
    assert.equal(rest.status, 200, JSON.stringify(rest.json));
    const full = loadBooks(ws);
    assert.equal(bookedState(full, tx.ref, ws.bankAccounts), 'booked');
    assert.ok(!unbookedPayments(full, ws.bankAccounts).some((t) => t.ref === tx.ref));
    const again = await api.send('POST', `/api/transactions/${tx.ref}/entries`, { lines: [split[1]] });
    assert.deepEqual([again.status, again.json.code], [409, 'hasEntries'], 'a booked payment is not booked twice');
  } finally {
    await api.stop();
  }
});
