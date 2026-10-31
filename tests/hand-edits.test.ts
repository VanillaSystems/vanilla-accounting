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
import { RequestError } from '../src/server/books.js';
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

test('a booking a run made since the last save and a person deleted waits in Änderungen too (r7h-31, r7h-3); its «Rückgängig» never books the payment twice: refused, naming what stands, while the payment has bookings it did not have at the deletion (a run\'s rebooking, a rule\'s split, a hand booking), back as it was once the payment is free again (r8h-23)', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.config.closedThrough ?? '';
  const tx = { ref: 'OPEN-1', bank: 'Raiffeisen', date: '2026-10-15', amount: 1412.35, currency: 'CHF', direction: 'CRDT' as const, description: 'SumUp Auszahlung PO-88213' };
  assert.ok(tx.date > closed);
  const run: JournalEntry = { id: 'run-made', transactionRef: tx.ref, date: tx.date, accountDebit: '1021', accountCredit: '3400', amount: tx.amount, vatCode: 'V81', description: 'vom Lauf gebucht', origin: 'classify', run: 'run-1' };
  update(books, moduleActor('intake'), (b) => { b.transactions.push(tx); b.journalEntries.push(run); });
  saveBooks(ws, books);
  assert.deepEqual(await handEdits(ws), [], 'a run\'s booking is no hand edit');

  const del = loadBooks(ws);
  update(del, PERSON, (b) => { const gone = deleteEntry(b, run.id); recordDeletion(ws, gone, b.journalEntries.filter((e) => e.transactionRef === gone.transactionRef).map((e) => e.id)); });
  saveBooks(ws, del);
  const listed = await handEdits(ws);
  assert.deepEqual(listed.map((h) => [h.id, h.deleted, h.saved, h.kept]), [[run.id, true, run, []]], 'the deletion is listed, with the booking as it was');

  const onPayment = () => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === tx.ref).map((e) => e.id).sort();
  /** «Rückgängig» as the route does it: the listed edit, the restore inside the write door; the refusal, or undefined once it went through. */
  const tryRestore = async () => {
    const edit = (await handEdits(ws)).find((h) => h.id === run.id)!;
    assert.ok(edit?.deleted, 'the deletion stays listed while the payment is booked otherwise');
    const b = loadBooks(ws);
    try { update(b, PERSON, (x) => restoreSaved(x, run.id, edit.saved, edit.kept)); } catch (e) { return e; }
    saveBooks(ws, b);
    return undefined;
  };
  const line = (id: string, accountDebit: string, accountCredit: string, amount: number, vatCode: string): JournalEntry => ({ id, transactionRef: tx.ref, date: tx.date, accountDebit, accountCredit, amount, vatCode, description: 'SumUp', origin: 'classify', rule: 'sumup-umsatz', by: { kind: 'rule', rule: 'sumup-umsatz' } });

  // (a) The next run books the payment again meanwhile, this time by a rule as a split of three.
  const again = loadBooks(ws);
  update(again, moduleActor('intake'), (b) => { b.journalEntries.push(line('s-1', '1021', '3400', 1480, 'V81'), line('s-2', '3400', '1021', 40, '-V81'), line('s-3', '6840', '1021', 27.65, 'I0')); });
  saveBooks(ws, again);
  const refusedSplit = await tryRestore();
  assert.ok(refusedSplit instanceof RequestError && refusedSplit.status === 409, `refused: ${String(refusedSplit)}`);
  assert.deepEqual(refusedSplit.refusal, { code: 'bookedSince', params: { payment: tx.ref, entries: 3, by: 'app' } });
  assert.deepEqual(onPayment(), ['s-1', 's-2', 's-3'], 'the rule\'s split stands; the old booking is not put back over it');

  // (b) A person books the payment by hand instead.
  const hand = loadBooks(ws);
  update(hand, PERSON, (b) => { for (const id of ['s-1', 's-2', 's-3']) deleteEntry(b, id); addEntry(b, { transactionRef: tx.ref, date: tx.date, accountDebit: '1021', accountCredit: '3400', amount: tx.amount, vatCode: 'V81', description: 'von Hand', origin: 'manual', by: { kind: 'person', at: new Date().toISOString() } }); });
  saveBooks(ws, hand);
  const refusedHand = await tryRestore();
  assert.ok(refusedHand instanceof RequestError && refusedHand.status === 409, `refused: ${String(refusedHand)}`);
  assert.deepEqual(refusedHand.refusal, { code: 'bookedSince', params: { payment: tx.ref, entries: 1, by: 'person' } });
  assert.equal(onPayment().length, 1, 'the hand booking stands alone: the payment is not booked twice');

  // (c) The payment has no booking again: the restore puts the deleted one back as it was.
  const free = loadBooks(ws);
  update(free, PERSON, (b) => { for (const e of b.journalEntries.filter((x) => x.transactionRef === tx.ref)) deleteEntry(b, e.id); });
  saveBooks(ws, free);
  assert.equal(await tryRestore(), undefined, 'restored');
  assert.deepEqual(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === tx.ref), [run], 'back as it was');
  assert.deepEqual(await handEdits(ws), [], 'nothing waits once it is back');
});

test('a filed booking is never put back: the write door refuses a restore into a closed period', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.journalEntries.find((e) => e.date <= (books.config.closedThrough ?? ''))!;
  assert.throws(() => update(books, PERSON, (b) => restoreSaved(b, closed.id, { ...closed, amount: closed.amount + 1 })));
});

test('r10k-2: a rule booking a person changed before any save holds it is listed as a change, and «Rückgängig» puts the rule\'s booking back instead of deleting it', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const closed = books.config.closedThrough ?? '';
  const ref = books.transactions.find((t) => t.date > closed)!.ref;
  let id = '';
  update(books, moduleActor('intake'), (b) => {
    id = addEntry(b, { date: b.transactions.find((t) => t.ref === ref)!.date, transactionRef: ref, accountDebit: '1020', accountCredit: '3400', amount: 412.8, description: 'TWINT Sammelgutschrift', origin: 'classify', by: { kind: 'rule', rule: 'twint-umsatz' }, rule: 'twint-umsatz', reason: 'Regel: Text enthält «TWINT» → Konto 3400' }).id;
  });
  update(books, PERSON, (b) => { setEntry(b, id, { accountCredit: '3200' }); });
  saveBooks(ws, books);
  const row = (await handEdits(ws)).find((h) => h.id === id);
  assert.ok(row?.saved, 'the row is a change of the rule\'s booking, not a booking by hand');
  assert.deepEqual([row.saved.accountCredit, row.saved.origin, row.saved.by, row.saved.rule], ['3400', 'classify', { kind: 'rule', rule: 'twint-umsatz' }, 'twint-umsatz'], 'the booking as the rule made it');
  const after = loadBooks(ws);
  update(after, PERSON, (b) => restoreSaved(b, id, row.saved, row.kept));
  const back = after.journalEntries.find((e) => e.id === id)!;
  assert.deepEqual([back.accountCredit, back.by, back.amount], ['3400', { kind: 'rule', rule: 'twint-umsatz' }, 412.8], 'the rule\'s booking is back, the payment stays booked');
});
