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
import { changesView, handEdits } from '../src/saving/changes.js';
import { loadBooks, saveBooks, update, PERSON } from '../src/books/store.js';
import { addEntry, restoreSaved, setEntry } from '../src/server/edits.js';
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

test('a filed booking is never put back: the write door refuses a restore into a closed period', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.journalEntries.find((e) => e.date <= (books.config.closedThrough ?? ''))!;
  assert.throws(() => update(books, PERSON, (b) => restoreSaved(b, closed.id, { ...closed, amount: closed.amount + 1 })));
});
