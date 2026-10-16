/**
 * Änderungen lists what a person changed by hand since the last save, beside the runs, and
 * «Rückgängig» puts each back as the save holds it (corner-5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { changesView, handEdits, recordDeletion } from '../src/saving/changes.js';
import { loadBooks, moduleActor, saveBooks, update, PERSON } from '../src/books/store.js';
import type { JournalEntry } from '../src/types/index.js';
import { addEntry, deleteEntry, restoreSaved, setEntry } from '../src/server/edits.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';

async function company(): Promise<Workspace> {
  const repo = mkdtempSync(join(tmpdir(), 'hand-edits-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  await initRepository(repo, 'Workspace set up');
  return workspaceAt(join(repo, APP_FOLDER));
}

test('a change by hand and a booking by hand wait in Änderungen; «Rückgängig» puts each back as saved', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.config.closedThrough ?? '';
  const target = books.journalEntries.find((e) => e.date > closed && e.vatCode && e.origin !== 'manual')!;
  const saved = structuredClone(target);
  let added = '';
  update(books, PERSON, (b) => {
    setEntry(b, target.id, { vatCode: target.vatCode === 'I0' ? 'I81' : 'I0' });
    added = addEntry(b, { date: target.date, accountDebit: '6500', accountCredit: '1020', amount: 12, description: 'Porto', origin: 'manual', by: { kind: 'person', at: new Date().toISOString() } }).id;
  });
  saveBooks(ws, books);

  const view = await changesView(ws);
  assert.deepEqual(view.books.hand.map((h) => [h.id, !!h.saved]).sort(), [[added, false], [target.id, true]].sort());
  assert.deepEqual(view.books.hand.find((h) => h.id === target.id)!.saved, saved, 'the booking as the last save holds it');

  const again = loadBooks(ws);
  update(again, PERSON, (b) => { for (const h of view.books.hand) restoreSaved(b, h.id, h.saved); });
  saveBooks(ws, again);
  const now = loadBooks(ws);
  assert.deepEqual(now.journalEntries.find((e) => e.id === target.id), saved, 'back as saved, with who decided and why');
  assert.equal(now.journalEntries.some((e) => e.id === added), false, 'a booking made since is taken out');
  assert.deepEqual(await handEdits(ws), []);
});

test('a booking deleted by hand waits in Änderungen too, and «Rückgängig» puts it back; one a re-booking replaced is listed by its new bookings (r6h-28)', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.config.closedThrough ?? '';
  const open = books.journalEntries.filter((e) => e.date > closed && e.origin !== 'manual');
  const gone = open[0];
  const rebooked = open.find((e) => e.transactionRef !== gone.transactionRef)!;
  const saved = structuredClone(gone);
  let fresh = '';
  update(books, PERSON, (b) => {
    deleteEntry(b, gone.id);
    deleteEntry(b, rebooked.id);
    fresh = addEntry(b, { ...rebooked, id: undefined as unknown as string, accountDebit: '6500', origin: 'manual', by: { kind: 'person', at: new Date().toISOString() } }).id;
  });
  saveBooks(ws, books);

  const hand = (await changesView(ws)).books.hand;
  assert.deepEqual(hand.map((h) => [h.id, !!h.deleted, !!h.saved]).sort(), [[fresh, false, false], [gone.id, true, true]].sort(), 'the deletion is listed; the replaced booking only through its new one');
  assert.deepEqual(hand.find((h) => h.id === gone.id)!.saved, saved);

  const again = loadBooks(ws);
  update(again, PERSON, (b) => restoreSaved(b, gone.id, saved));
  saveBooks(ws, again);
  assert.deepEqual(loadBooks(ws).journalEntries.find((e) => e.id === gone.id), saved, 'back as saved');
  assert.equal((await handEdits(ws)).some((h) => h.id === gone.id), false);
});

test('a booking a run made since the last save and a person deleted waits in Änderungen too, and its restore takes out what the app booked on the payment meanwhile (r7h-31, r7h-3)', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.config.closedThrough ?? '';
  const tx = { ref: 'OPEN-1', bank: 'Raiffeisen', date: '2026-10-05', amount: 89, currency: 'CHF', direction: 'DBIT' as const, description: 'Swisscom Natel Sep' };
  assert.ok(tx.date > closed);
  const run: JournalEntry = { id: 'run-made', transactionRef: tx.ref, date: tx.date, accountDebit: '6513', accountCredit: '1021', amount: tx.amount, vatCode: 'I0', description: 'vom Lauf gebucht', origin: 'classify', run: 'run-1' };
  update(books, moduleActor('intake'), (b) => { b.transactions.push(tx); b.journalEntries.push(run); });
  saveBooks(ws, books);
  assert.deepEqual(await handEdits(ws), [], 'a run\'s booking is no hand edit');

  const del = loadBooks(ws);
  update(del, PERSON, (b) => { const gone = deleteEntry(b, run.id); recordDeletion(ws, gone, b.journalEntries.filter((e) => e.transactionRef === gone.transactionRef).map((e) => e.id)); });
  saveBooks(ws, del);
  const listed = await handEdits(ws);
  assert.deepEqual(listed.map((h) => [h.id, h.deleted, h.saved, h.kept]), [[run.id, true, run, []]], 'the deletion is listed, with the booking as it was');

  // The next run books the payment differently meanwhile.
  const again = loadBooks(ws);
  update(again, moduleActor('intake'), (b) => { b.journalEntries.push({ ...run, id: 'run-again', accountDebit: '4000', vatCode: 'M81', run: 'run-2' }); });
  saveBooks(ws, again);
  const still = await handEdits(ws);
  assert.deepEqual(still.map((h) => [h.id, h.deleted]), [[run.id, true]], 'still listed');

  const back = loadBooks(ws);
  update(back, PERSON, (b) => restoreSaved(b, run.id, still[0].saved, still[0].kept));
  saveBooks(ws, back);
  assert.deepEqual(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === tx.ref), [run], 'back as it was, the later booking of the payment gone');
  assert.deepEqual(await handEdits(ws), [], 'nothing waits once it is back');
});

test('a filed booking is never put back: the write door refuses a restore into a closed period', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.journalEntries.find((e) => e.date <= (books.config.closedThrough ?? ''))!;
  assert.throws(() => update(books, PERSON, (b) => restoreSaved(b, closed.id, { ...closed, amount: closed.amount + 1 })));
});
