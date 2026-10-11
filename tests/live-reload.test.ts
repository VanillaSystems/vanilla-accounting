/**
 * The UI follows changes made outside it: the API's watcher (src/server/watch.ts) announces a real
 * change once and its own writes not at all, GET /api/events delivers it, and a write made on books
 * that changed since is refused with `stale` (src/server/books.ts withBooks).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks, saveBooks } from '../src/books/store.js';
import { watchWorkspace, type Watcher } from '../src/server/watch.js';
import { wrote } from '../src/workspace/own-writes.js';
import { BOOKS_VERSION, type WorkspaceChange } from '../src/types/api-error.js';
import type { Index } from '../src/types/index.js';
import { tempWorkspace } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

const FIXTURE = 'tests/fixtures/period-lock-index.json';
const settle = () => new Promise((r) => setTimeout(r, 700));

/** What Claude Code or a CLI does: write the whole file beside it and rename it over the old one. */
function writeOutside(path: string, change: (index: Index) => void): void {
  const index = JSON.parse(readFileSync(path, 'utf8')) as Index;
  change(index);
  writeFileSync(`${path}.outside`, JSON.stringify(index, null, 2));
  renameSync(`${path}.outside`, path);
}

const ws = tempWorkspace('belege-live-');
const got: WorkspaceChange[] = [];
let watcher: Watcher;

before(async () => {
  copyFileSync(FIXTURE, ws.paths.books);
  mkdirSync(ws.paths.inbox);
  await settle();
  watcher = watchWorkspace(ws, (c) => got.push(c), 100);
});
after(() => watcher?.close());

async function changes(): Promise<WorkspaceChange[]> {
  await settle();
  return got.splice(0);
}

test('watch: the API saving the books is no change from outside', async () => {
  const books = loadBooks(ws);
  books.transactions[1].description = 'von der App';
  saveBooks(ws, books);
  assert.deepEqual(await changes(), []);
});

test('watch: a write from outside is one change of the books', async () => {
  writeOutside(ws.paths.books, (i) => { i.transactions[1].description = 'von aussen'; });
  assert.deepEqual(await changes(), [{ kind: 'books', external: true }]);
});

test('watch: a burst of writes is one change', async () => {
  for (let n = 0; n < 5; n++) writeOutside(ws.paths.books, (i) => { i.transactions[1].description = `Nr. ${n}`; });
  assert.deepEqual(await changes(), [{ kind: 'books', external: true }]);
});

test('watch: the same content written again is no change', async () => {
  writeFileSync(ws.paths.books, readFileSync(ws.paths.books));
  assert.deepEqual(await changes(), []);
});

test('watch: a receipt dropped into the inbox and taken out again', async () => {
  const pdf = join(ws.paths.inbox, 'scan.pdf');
  writeFileSync(pdf, '%PDF-1.4 Quittung');
  assert.deepEqual(await changes(), [{ kind: 'inbox', external: true }]);
  rmSync(pdf);
  assert.deepEqual(await changes(), [{ kind: 'inbox', external: true }]);
});

test('watch: a file the API puts into a folder is a change, not from outside', async () => {
  const pdf = join(ws.paths.inbox, 'phone.pdf');
  writeFileSync(pdf, '%PDF-1.4 Foto');
  wrote(pdf);
  assert.deepEqual(await changes(), [{ kind: 'inbox', external: false }]);
});

let api: ApiServer;
before(async () => { api = await startApi(FIXTURE); });
after(() => api?.stop());

const url = (path: string) => `http://127.0.0.1:${api.port}${path}`;
const versionOfFile = () => createHash('sha256').update(readFileSync(api.indexPath)).digest('hex');

/** The events GET /api/events sends within `ms`. */
async function listen(during: () => Promise<void> | void, ms = 1500): Promise<WorkspaceChange[]> {
  const stop = new AbortController();
  const res = await fetch(url('/api/events'), { signal: stop.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const out: WorkspaceChange[] = [];
  let text = '';
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += Buffer.from(value!).toString();
      for (let i; (i = text.indexOf('\n\n')) >= 0; text = text.slice(i + 2)) {
        const data = text.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        if (data) out.push(JSON.parse(data.slice(6)) as WorkspaceChange);
      }
    }
  })();
  await settle();
  await during();
  await new Promise((r) => setTimeout(r, ms));
  stop.abort();
  await reading;
  return out;
}

test('events: a change of the books from outside reaches the page', async () => {
  const seen = await listen(() => writeOutside(api.indexPath, (i) => { i.transactions[1].description = 'Claude Code'; }));
  assert.deepEqual(seen, [{ kind: 'books', external: true }]);
});

test('events: a write through the API sends no event', async () => {
  const seen = await listen(async () => {
    const res = await fetch(url('/api/transactions/O1'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remarks: 'in der App' }) });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen, []);
});

test('books.json names its version', async () => {
  const res = await fetch(url('/books.json'));
  assert.equal(res.headers.get(BOOKS_VERSION), versionOfFile());
});

type Call = { method: string; path: string; body?: unknown };

const writes: Call[] = [
  { method: 'PATCH', path: '/api/transactions/O1', body: { description: 'neu' } },
  { method: 'POST', path: '/api/transactions/manual', body: { date: '2026-08-01', description: 'offen', amount: 1, currency: 'CHF' } },
  { method: 'DELETE', path: '/api/transactions/M2026-002' },
  { method: 'PATCH', path: '/api/receipts/ro', body: { remarks: 'Notiz' } },
  { method: 'DELETE', path: '/api/receipts/ro' },
  { method: 'POST', path: '/api/mapping/remove', body: { receiptId: 'ro', transactionRef: 'O1' } },
  { method: 'POST', path: '/api/mapping/add', body: { receiptId: 'rm', transactionRef: 'O1' } },
  { method: 'PATCH', path: '/api/journal-entries/jo', body: { amount: 12.5 } },
  { method: 'POST', path: '/api/journal-entries', body: { date: '2026-08-31', accountDebit: '6800', accountCredit: '1020', amount: 10, description: 'von Hand' } },
  { method: 'DELETE', path: '/api/journal-entries/jo' },
];

const sendWith = (version: string | undefined, { method, path, body }: Call) => fetch(url(path), {
  method,
  headers: { 'Content-Type': 'application/json', ...(version && { [BOOKS_VERSION]: version }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

let loaded: string;
test('stale: the page loads the books, then they change outside', async () => {
  loaded = (await fetch(url('/books.json'))).headers.get(BOOKS_VERSION)!;
  writeOutside(api.indexPath, (i) => { i.journalEntries!.push({ ...i.journalEntries!.find((j) => j.id === 'jo')!, id: 'jx', description: 'von aussen' }); });
  assert.notEqual(versionOfFile(), loaded);
});

for (const call of writes) {
  test(`stale: ${call.method} ${call.path} on the version loaded before -> 409 stale, books unchanged`, async () => {
    const before = readFileSync(api.indexPath);
    const res = await sendWith(loaded, call);
    const json = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 409, json.error as string);
    assert.equal(json.code, 'stale', 'the UI says it by its code');
    assert.ok(readFileSync(api.indexPath).equals(before), 'books are byte-identical');
  });
}

test('stale: the same write on the current version goes through and names the version it saved', async () => {
  const res = await sendWith(versionOfFile(), writes[0]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(BOOKS_VERSION), versionOfFile());
});

test('stale: a write without a version (CLI, tests) goes through as before', async () => {
  const res = await sendWith(undefined, writes[3]);
  assert.equal(res.status, 200);
});
