/**
 * Änderungen lists what a person did to receipts since the last save, each with its «Rückgängig»
 * (r8k-7, r8h-25): a deletion (back from the trash), a link made or taken back by hand, fields
 * edited, «Privat oder bar bezahlt». A run's links are not listed; an outlay a person booked on
 * by hand is listed without its undo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { changesView, receiptChanges } from '../src/saving/changes.js';
import { loadBooks, moduleActor, periodLock, receiptFile, saveBooks, update, PERSON } from '../src/books/store.js';
import { removeReceipt } from '../src/accounting/classify-force.js';
import { deletionsOf, trashReceipt } from '../src/books/receipt-trash.js';
import { addEntry, link, privatePayment, setReceipt, unlink } from '../src/server/edits.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';

const DAY = '2026-10-05';
const receipt = (id: string): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: id, extractionMethod: 'pdftotext', fileSize: 10, indexedAt: `${DAY}T08:00:00Z`, location: 'archived', date: DAY, amount: 10, currency: 'CHF', description: `Beleg ${id}` });
const tx = (ref: string) => ({ ref, bank: 'Raiffeisen', date: DAY, amount: 10, currency: 'CHF', direction: 'DBIT' as const, description: `Zahlung ${ref}` });

/** The demo with six open receipts and three open payments of its own, two receipts linked, as the last save holds them. */
async function company(): Promise<Workspace> {
  const repo = mkdtempSync(join(tmpdir(), 'receipt-changes-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  const ws = workspaceAt(join(repo, APP_FOLDER));
  const books = loadBooks(ws);
  assert.ok(!periodLock(books).isClosed(DAY));
  update(books, moduleActor('intake'), (b) => {
    b.receipts.push(...['gone', 'unlinked', 'edited', 'outlay', 'byrun', 'byhand'].map(receipt));
    b.transactions.push(tx('T1'), tx('T2'), tx('T3'), tx('T4'));
    b.mappings.push({ transactionRef: 'T1', receiptId: 'gone', by: 'rule', rule: 'r' }, { transactionRef: 'T2', receiptId: 'unlinked', by: 'rule', rule: 'r' });
  });
  saveBooks(ws, books);
  await initRepository(repo, 'Workspace set up');
  return ws;
}

test('a deletion, a link by hand, an unlink, an edit and a private outlay wait in Änderungen; a run\'s link does not', async () => {
  const ws = await company();
  const books = loadBooks(ws);
  const [gone, unlinked, edited, outlay, byRun, byHand] = ['gone', 'unlinked', 'edited', 'outlay', 'byrun', 'byhand'].map((id) => books.receipts.find((r) => r.id === id)!);
  const payment = books.transactions.find((t) => t.ref === 'T3')!;
  const other = books.transactions.find((t) => t.ref === 'T4')!;
  const unlinkedFrom = 'T2';

  let outlayRef = '';
  update(books, PERSON, (b) => {
    unlink(b, unlinked.id, unlinkedFrom);
    setReceipt(b, edited.id, { description: 'Neuer Text' });
    outlayRef = privatePayment(b, outlay.id, {}, loadFxResolver()).ref;
    link(b, byHand.id, payment.ref);
  });
  update(books, moduleActor('intake'), (b) => { b.mappings.push({ transactionRef: other.ref, receiptId: byRun.id, by: 'rule', rule: 'r' }); });
  const pdf = receiptFile(ws, books, gone);
  writeFileSync(pdf, '%PDF-1.4 gone');
  const trashed = update(books, PERSON, (b) => {
    const mappings = b.mappings.filter((m) => m.receiptId === gone.id);
    const had = b.journalEntries;
    removeReceipt(b, gone.id);
    return { deletedAt: new Date().toISOString(), receipt: gone, mappings, file: relative(ws.paths.root, pdf), entries: had.filter((e) => !b.journalEntries.includes(e)) };
  });
  const deletion = trashReceipt(ws, trashed, pdf);
  saveBooks(ws, books);

  const listed = (await changesView(ws)).books.receipts;
  const by = (kind: string) => listed.filter((c) => c.kind === kind);
  assert.deepEqual(by('deleted').map((c) => [c.id, c.kind === 'deleted' && c.deletion]), [[gone.id, deletion]], 'the deletion, with the trash record its restore names');
  assert.deepEqual(by('unlinked').map((c) => [c.id, c.kind === 'unlinked' && c.payment]), [[unlinked.id, unlinkedFrom]]);
  assert.deepEqual(by('linked').map((c) => [c.id, c.kind === 'linked' && c.payment]), [[byHand.id, payment.ref]], 'the link by hand, not the run\'s');
  assert.deepEqual(by('edited').map((c) => [c.id, c.kind === 'edited' && c.back]), [[edited.id, { description: 'Beleg edited' }]], 'the patch that puts the field back');
  assert.deepEqual(by('privateOutlay').map((c) => [c.id, c.kind === 'privateOutlay' && c.payment, c.kind === 'privateOutlay' && c.blocked]), [[outlay.id, outlayRef, undefined]]);
  assert.ok(listed.every((c) => c.text && c.at), 'each says what and when');

  // A person's booking on the private payment blocks its undo (deleting the payment would take her booking).
  const again = loadBooks(ws);
  update(again, PERSON, (b) => { addEntry(b, { transactionRef: outlayRef, date: outlay.date!, accountDebit: '6500', accountCredit: '2451', amount: outlay.amount!, description: 'von Hand', origin: 'manual', by: { kind: 'person', at: new Date().toISOString() } }); });
  saveBooks(ws, again);
  assert.equal((await receiptChanges(ws)).find((c) => c.kind === 'privateOutlay')?.blocked, 'personsBooking');

  // Each undo takes its change off the list; the deletion stays until the restore route brings the receipt back.
  const undo = loadBooks(ws);
  update(undo, PERSON, (b) => {
    link(b, unlinked.id, unlinkedFrom);
    setReceipt(b, edited.id, { description: 'Beleg edited' });
    unlink(b, byHand.id, payment.ref);
    b.journalEntries = b.journalEntries.filter((e) => e.transactionRef !== outlayRef);
    b.transactions = b.transactions.filter((t) => t.ref !== outlayRef);
    b.mappings = b.mappings.filter((m) => m.transactionRef !== outlayRef);
  });
  saveBooks(ws, undo);
  assert.deepEqual((await receiptChanges(ws)).map((c) => c.kind), ['deleted']);
  assert.deepEqual(deletionsOf(ws, gone.id), [deletion]);
});
