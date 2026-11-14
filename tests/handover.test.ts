/**
 * The hand-over core (docs/specs/e2e-and-fiduciary.md Part B): the content version, the `.vanilla`
 * package, the recipient's Durchsicht copy, his return, and the sharer's three-way merge with its
 * take-over and undo. Made-up books: 2025 closed, 2026-Q1 filed and sealed, Q3 open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { ClosedPeriodError, OwnershipError, PERSON, loadBooks, moduleActor, saveBooks, sealsOf, update, type Books } from '../src/books/store.js';
import { writeSeal } from '../src/books/seal.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { checksumOf, contentChecksum, contentFiles, shortChecksum } from '../src/handover/content.js';
import { currentVersion, heldBy, readVersions, sealedVersion, writeVersion } from '../src/handover/versions.js';
import { PackageError, readPackage } from '../src/handover/package.js';
import { makeShare, planShare } from '../src/handover/share.js';
import { buildReturn, changesOf, markerOf, openPackage, recipientActor, setNote } from '../src/handover/durchsicht.js';
import { applyReturn, decide, HandoverRefused, receiveReturn, reviewOf, undoReturn } from '../src/handover/returns.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import type { JournalEntry } from '../src/types/index.js';

const ERNST = { name: 'Ernst Beispiel', email: 'ernst@example.ch' };
const SANDRA = { name: 'Sandra Muster' };
const receipt = (id: string, date: string) => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: id, extractionMethod: 'pdftotext' as const, fileSize: 10, indexedAt: `${date}T00:00:00Z`, location: 'archived' as const, date, amount: 10, currency: 'CHF' });
const tx = (ref: string, date: string, amount: number) => ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT' as const, description: `Zahlung ${ref}` });
const entry = (id: string, ref: string, date: string, debit: string, amount: number, vatCode?: string): JournalEntry =>
  ({ id, transactionRef: ref, date, accountDebit: debit, accountCredit: '1020', amount, ...(vatCode ? { vatCode } : {}), description: `Buchung ${id}`, origin: 'classify', by: { kind: 'model', model: 'test' } });

/** Sandra's books: 2025 closed, 2026-Q1 filed and sealed, Q3 open; receipt files in each year. */
function sandrasBooks(): Workspace {
  const ws = tempWorkspace('handover-');
  writeIndex(ws, {
    receipts: [receipt('r25', '2025-06-01'), receipt('rq1', '2026-02-10'), receipt('r1', '2026-07-10')],
    transactions: [tx('T25', '2025-06-01', 40), tx('T1', '2026-02-10', 100), tx('T2', '2026-07-10', 50), tx('T3', '2026-08-01', 80), tx('T4', '2026-08-15', 30)],
    mappings: [{ transactionRef: 'T25', receiptId: 'r25' }, { transactionRef: 'T1', receiptId: 'rq1' }, { transactionRef: 'T2', receiptId: 'r1' }],
    journalEntries: [
      entry('e25', 'T25', '2025-06-01', '6500', 40, 'I81'),
      entry('eq1', 'T1', '2026-02-10', '6500', 100, 'I81'),
      entry('e1', 'T2', '2026-07-10', '6500', 50, 'I81'),
      entry('e2', 'T3', '2026-08-01', '6200', 80, 'I81'),
      { ...entry('e3', 'T4', '2026-08-15', '6500', 30, 'I81'), origin: 'manual', by: undefined },
    ],
    config: { closedThrough: '2026-03-31' },
  });
  for (const [year, id] of [['2025', 'r25'], ['2026', 'rq1'], ['2026', 'r1']]) {
    mkdirSync(join(ws.paths.root, 'transactional-data', year, 'receipts'), { recursive: true });
    writeFileSync(join(ws.paths.root, 'transactional-data', year, 'receipts', `${id}.pdf`), `%PDF-1.4 ${id}`);
  }
  writeSeal(ws, loadBooks(ws), '2026-Q1', '2026-04-10');
  return ws;
}

const home = () => mkdtempSync(join(tmpdir(), 'durchsicht-'));
const reopen = (ws: Workspace) => workspaceAt(ws.paths.root);

/** Ernst corrects on his copy as a person with his name: an account, a split, a deletion, his «Warum?». */
function ernstCorrects(copy: Workspace): void {
  const m = markerOf(copy.paths.root)!;
  const books = loadBooks(copy);
  update(books, recipientActor(m), (b) => {
    const e1 = b.journalEntries.find((e) => e.id === 'e1')!;
    Object.assign(e1, { accountDebit: '6510', origin: 'manual', by: { kind: 'person', at: '2026-11-15T10:00:00Z', was: { accountDebit: '6500' } } });
    const e2 = b.journalEntries.find((e) => e.id === 'e2')!;
    Object.assign(e2, { amount: 56, origin: 'manual', by: { kind: 'person', at: '2026-11-15T10:01:00Z' } });
    b.journalEntries.push({ id: 'e2p', transactionRef: 'T3', date: '2026-08-01', accountDebit: '2451', accountCredit: '1020', amount: 24, description: 'Privatanteil 30 %', origin: 'manual' });
    b.journalEntries = b.journalEntries.filter((e) => e.id !== 'e3');
  });
  saveBooks(copy, books);
  setNote(copy.paths.root, 'entry:e1', 'Telefon, nicht Büromaterial.');
}

test('the content version: share, take-over and seal each add one line; a plain save adds none', () => {
  const ws = sandrasBooks();
  assert.equal(currentVersion(ws.paths), undefined, 'books without the log are at no version');
  const v1 = writeVersion(ws.paths, { reason: 'handover', to: ERNST });
  assert.equal(v1.n, 1);
  assert.match(v1.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(ws.paths.root, 'versions.jsonl'), 'utf8').split('\n')[0], '{"schema":1}');
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { b.journalEntries.find((e) => e.id === 'e1')!.description = 'neu'; });
  saveBooks(ws, books);
  assert.equal(readVersions(ws.paths).length, 1, 'a plain save writes no version');
  assert.equal(sealedVersion(ws, '2026-Q1')?.n, 2);
  assert.equal(readVersions(ws.paths)[1].period, '2026-Q1');
  assert.equal(heldBy(ws.paths, ERNST)?.n, 1);
  assert.equal(heldBy(ws.paths, { name: 'Jemand' }), undefined);
  assert.equal(shortChecksum('sha256:a3f9c21e07bd99'), 'a3f9 c21e 07bd');
  // The checksum is the books' content: the version log itself does not count.
  assert.equal(contentChecksum(ws.paths).checksum, checksumOf(contentFiles(ws.paths.root).map((f) => ({ path: f.path, sha256: f.path ? readSha(ws, f.path) : '' }))));
});

const readSha = (ws: Workspace, path: string) => (contentChecksum(ws.paths).files.find((f) => f.path === path)!.sha256);

test('a full package: the books and the open years\' receipts, the closed year\'s left out with their checksums; round trip and tampering', async () => {
  const ws = sandrasBooks();
  const made = await makeShare(ws, { to: ERNST, message: 'Kannst du Q3 durchsehen?' }, SANDRA, new Date('2026-11-14T15:42:00Z'));
  assert.equal(made.index.kind, 'full');
  assert.equal(made.version.n, 1);
  assert.equal(made.name, `${ws.company.name} – Buchhaltung v1 (2026-11-14).vanilla`);
  const carried = made.index.files.map((f) => f.path);
  assert.ok(carried.includes('transactional-data/2026/receipts/r1.pdf'));
  assert.ok(carried.includes('transactional-data/2026/filings/seal-Q1.json'), 'seals go along');
  assert.ok(carried.includes('transactional-data/2025/books/entries.jsonl'), 'a closed year\'s books go along');
  assert.deepEqual(made.index.omitted?.map((f) => f.path), ['transactional-data/2025/receipts/r25.pdf']);
  assert.equal(made.index.version.checksum, contentChecksum(ws.paths).checksum, 'the version\'s checksum counts the omitted files');
  const back = readPackage(made.bytes);
  assert.deepEqual(back.index, made.index);
  assert.equal(back.files.size, made.index.files.length);
  // A file changed on the way, or one the index does not name, is refused.
  const members = unzipSync(made.bytes);
  members['files/transactional-data/2026/receipts/r1.pdf'] = strToU8('%PDF-1.4 other');
  assert.throws(() => readPackage(zipSync(members)), (e) => e instanceof PackageError && e.code === 'shareTampered');
  const extra = unzipSync(made.bytes);
  extra['files/evil.txt'] = strToU8('x');
  assert.throws(() => readPackage(zipSync(extra)), (e) => e instanceof PackageError && e.code === 'shareTampered');
  assert.throws(() => readPackage(strToU8('no zip')), (e) => e instanceof PackageError && e.code === 'shareNotPackage');
  // With «mit Archiv 2025» the closed year's receipts go along.
  assert.equal(planShare(ws, { to: { name: 'Neu' }, archive: ['2025'] }).omitted.length, 0);
});

test('Durchsicht: the copy proves its version, keeps the seals, and writes as the recipient through the write door', async () => {
  const ws = sandrasBooks();
  const made = await makeShare(ws, { to: ERNST }, SANDRA);
  const opened = openPackage(made.bytes, new Date(), home());
  assert.equal(opened.kind, 'full');
  const copy = workspaceAt(opened.root);
  assert.notEqual(copy.paths.root, ws.paths.root);
  assert.deepEqual(markerOf(copy.paths.root)?.me, { ...ERNST, role: 'fiduciary' });
  const books = loadBooks(copy);
  assert.deepEqual(sealsOf(books).checks.map((c) => `${c.quarter} ${c.status}`), ['2026-Q1 intact']);
  // A filed quarter stays filed on his copy too.
  const actor = recipientActor(markerOf(copy.paths.root)!);
  assert.deepEqual(actor, { kind: 'person', name: ERNST.name, email: ERNST.email, role: 'fiduciary' });
  assert.throws(() => update(books, actor, (b) => { b.journalEntries.find((e) => e.id === 'eq1')!.accountDebit = '6510'; }), ClosedPeriodError);
  ernstCorrects(copy);
  // A later run of the app (a module) leaves his entries alone.
  const after = loadBooks(copy);
  assert.throws(() => update(after, moduleActor('intake'), (b) => { b.journalEntries.find((e) => e.id === 'e1')!.accountDebit = '6500'; }), OwnershipError);
  const changes = changesOf(copy.paths.root);
  assert.deepEqual(changes.map((c) => `${c.kind}:${c.key}`).sort(), ['journalEntries:e1', 'journalEntries:e2', 'journalEntries:e2p', 'journalEntries:e3']);
  assert.equal(changes.find((c) => c.key === 'e1')?.why, 'Telefon, nicht Büromaterial.');
  // A package of the copy's books is never written by the copy: no onward share from the files it holds.
  assert.equal(made.index.to.role, 'fiduciary');
});

test('an update carries the books and only the new receipts; on a copy without its base it is refused, changing nothing', async () => {
  const ws = sandrasBooks();
  const first = await makeShare(ws, { to: ERNST }, SANDRA);
  const at = home();
  const opened = openPackage(first.bytes, new Date(), at);
  ernstCorrects(workspaceAt(opened.root));
  // Sandra keeps booking: a new receipt and a payment.
  writeFileSync(join(ws.paths.root, 'transactional-data/2026/receipts/r9.pdf'), '%PDF-1.4 r9');
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { b.receipts.push(receipt('r9', '2026-09-01')); b.transactions.push(tx('T9', '2026-09-01', 9)); b.journalEntries.push(entry('e9', 'T9', '2026-09-01', '6500', 9, 'I81')); });
  saveBooks(ws, books);
  const plan = planShare(reopen(ws), { to: ERNST });
  assert.equal(plan.kind, 'update');
  assert.equal(plan.base?.n, 1);
  assert.deepEqual(plan.files.filter((f) => f.path.includes('/receipts/')).map((f) => f.path), ['transactional-data/2026/receipts/r9.pdf']);
  const second = await makeShare(reopen(ws), { to: ERNST }, SANDRA);
  assert.equal(second.index.kind, 'update');
  assert.throws(() => openPackage(second.bytes, new Date(), home()), (e) => e instanceof PackageError && e.code === 'shareBaseMissing');
  const moved = openPackage(second.bytes, new Date(), at);
  assert.equal(moved.kind, 'update');
  const copy = workspaceAt(moved.root);
  const now = loadBooks(copy);
  assert.ok(now.journalEntries.some((e) => e.id === 'e9'), 'her new booking arrived');
  assert.equal(now.journalEntries.find((e) => e.id === 'e1')?.accountDebit, '6510', 'his change stayed');
  assert.ok(existsSync(join(copy.paths.root, 'transactional-data/2026/receipts/r9.pdf')));
  assert.equal(markerOf(copy.paths.root)?.version.n, 2);
});

interface Scene { ws: Workspace; ret: Uint8Array }
async function scene(): Promise<Scene> {
  const ws = sandrasBooks();
  const made = await makeShare(ws, { to: ERNST }, SANDRA);
  const copy = workspaceAt(openPackage(made.bytes, new Date(), home()).root);
  ernstCorrects(copy);
  const ret = buildReturn(copy, 'Hallo Sandra, vier Punkte.', new Date('2026-11-16T20:12:00Z'));
  assert.equal(ret.index.kind, 'return');
  assert.equal(ret.index.from.name, ERNST.name, 'the return names its sender');
  assert.equal(ret.index.version.n, 1, 'based on the version he got');
  return { ws: reopen(ws), ret: ret.bytes };
}

const entryOf = (books: Books, id: string) => books.journalEntries.find((e) => e.id === id);

test('three-way merge: his only changes apply, hers stay, both changed is a conflict; one take-over, a version, undone whole', async () => {
  const { ws, ret } = await scene();
  // Sandra books meanwhile: e2 (which he split) gets another code, and a new entry of her own.
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    entryOf(b, 'e2')!.vatCode = 'I0';
    b.transactions.push(tx('T7', '2026-09-03', 7));
    b.journalEntries.push({ ...entry('e7', 'T7', '2026-09-03', '6500', 7), origin: 'manual' });
  });
  saveBooks(ws, books);
  const got = receiveReturn(ws, ret);
  assert.equal(got.changes, 4);
  assert.equal(receiveReturn(ws, ret).id, got.id, 'the same file is the same return');
  const review = reviewOf(ws, got.id);
  const row = (key: string) => review.rows.find((r) => r.key === key)!;
  assert.equal(row('e1').status, 'apply');
  assert.equal(row('e1').group, 'account');
  assert.equal(row('e1').why, 'Telefon, nicht Büromaterial.');
  assert.equal(row('e2').status, 'conflict');
  assert.equal(row('e2').group, 'split');
  assert.equal(row('e2p').group, 'split');
  assert.equal(row('e3').group, 'deleted');
  assert.ok(!review.rows.some((r) => r.key === 'e7'), 'what only she changed is no row');
  const q3 = review.effect.find((e) => e.period === '2026-Q3');
  assert.ok(q3 && !q3.filed && q3.before !== q3.after, 'the effect on the open quarter\'s payable');

  const applied = applyReturn(ws, got.id, 'all', new Date('2026-11-17T09:00:00Z'));
  assert.equal(applied.applied, 3, 'e1, e2p, e3; the conflict waits for her pick');
  assert.equal(applied.version.n, 2);
  assert.equal(applied.version.reason, 'return-applied');
  assert.deepEqual(applied.version.from, ERNST);
  let now = loadBooks(ws);
  assert.equal(entryOf(now, 'e1')?.accountDebit, '6510');
  assert.equal(entryOf(now, 'e3'), undefined);
  assert.equal(entryOf(now, 'e2')?.vatCode, 'I0', 'her version stands until she picks');
  assert.equal(entryOf(now, 'e7')?.amount, 7, 'hers stays');
  assert.ok(reviewOf(ws, got.id).learn.includes('T2'), '«Immer so?» for the account he corrected');

  const undone = undoReturn(ws, got.id);
  assert.equal(undone.version.reason, 'return-undone');
  now = loadBooks(ws);
  assert.equal(entryOf(now, 'e1')?.accountDebit, '6500');
  assert.ok(entryOf(now, 'e3'));
  assert.equal(entryOf(now, 'e2p'), undefined);

  // She picks his version of the conflict, and takes all over again.
  decide(ws, got.id, 'journalEntries\u0000e2', 'theirs');
  decide(ws, got.id, 'journalEntries\u0000e3', 'skip');
  applyReturn(ws, got.id, 'all');
  now = loadBooks(ws);
  assert.equal(entryOf(now, 'e2')?.amount, 56);
  assert.equal(entryOf(now, 'e2')?.vatCode, 'I81', 'his record, as he left it');
  assert.ok(entryOf(now, 'e3'), 'left out');
  // A record changed after the take-over: the undo is refused, nothing taken back.
  const later = loadBooks(ws);
  update(later, PERSON, (b) => { entryOf(b, 'e1')!.description = 'später'; });
  saveBooks(ws, later);
  assert.throws(() => undoReturn(ws, got.id), HandoverRefused);
  assert.equal(entryOf(loadBooks(ws), 'e2p')?.amount, 24);
});

test('a change into a period filed meanwhile is never applied; booked as a correction with corrects it is', async () => {
  const { ws, ret } = await scene();
  const books = loadBooks(ws);
  update(books, PERSON, () => undefined);
  books.config.closedThrough = '2026-09-30';
  saveBooks(ws, books);
  writeSeal(ws, loadBooks(ws), '2026-Q3', '2026-10-10');
  const got = receiveReturn(ws, ret);
  const review = reviewOf(ws, got.id);
  const e1 = review.rows.find((r) => r.key === 'e1')!;
  assert.equal(e1.status, 'sealed');
  assert.equal(e1.period, '2026-Q3');
  assert.throws(() => applyReturn(ws, got.id, 'all'), HandoverRefused, 'nothing to take: every row lies in the filed quarter');
  assert.equal(entryOf(loadBooks(ws), 'e1')?.accountDebit, '6500');
  decide(ws, got.id, 'journalEntries\u0000e1', 'correction');
  const effect = reviewOf(ws, got.id).effect.find((e) => e.period === '2026-Q3');
  assert.ok(effect?.filed, 'the correction\'s effect is on the filed quarter');
  const r = applyReturn(ws, got.id, 'all');
  assert.equal(r.corrections, 2, 'hers reversed, his booked anew');
  const now = loadBooks(ws);
  assert.equal(entryOf(now, 'e1')?.accountDebit, '6500', 'the filed entry stays as filed');
  const corr = now.journalEntries.filter((e) => e.corrects === '2026-Q3');
  assert.equal(corr.length, 2);
  assert.ok(corr.every((e) => e.date === '2026-10-01' && e.description?.includes('e1')));
  assert.deepEqual(sealsOf(now).checks.map((c) => c.status), ['intact', 'intact']);
});

test('a return of another firm is refused', async () => {
  const { ws, ret } = await scene();
  const members = unzipSync(ret);
  members['index.json'] = strToU8(JSON.stringify({ ...readPackage(ret).index, firm: { name: 'Andere AG' } }));
  assert.throws(() => receiveReturn(ws, zipSync(members)), (e) => e instanceof PackageError && e.code === 'shareOtherCompany');
});
