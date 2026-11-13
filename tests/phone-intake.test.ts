/**
 * A receipt from the phone, end to end in the desktop app: uploaded over the phone's listener with
 * its token, read by the background run with no click, and checked like any other file. A scan of
 * a receipt the books hold already is flagged as a possible copy and paid by nothing; the same
 * bytes sent again leave the inbox with a note in the run. A receipt without a date takes the day
 * the phone took it, marked so, and an undated one never hides.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { readState } from '../src/desktop/state.js';
import { lanAddresses } from '../src/server/phone.js';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { matchStep } from '../src/intake/match.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { ledgerOf, groups, visible } from '../src/app/areas/receipts/model.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { digestOf } from '../src/workflows/model.js';
import { DEMO_ROOT } from './support/workspace.js';

const ORIGINAL = { id: 'c6e7c65f1e2aa867', file: '20260105-example-cloud-invoice-2026-01.pdf', ref: 'CARD-7000001' };
process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'phone-intake-runs-'));
process.env.CLAUDE_BIN = join(process.cwd(), 'tests/support/stub-bin/claude');
// The model reads the phone's copy as the invoice it is, sure of its payment.
process.env.CLAUDE_STUB_ANSWER = JSON.stringify({
  suggestedFilename: '20260105-example-cloud-invoice.pdf', date: '2026-01-05', description: 'Example Cloud, invoice', amount: 39, currency: 'EUR',
  matchedTransactionRefs: [ORIGINAL.ref], confidence: 0.95,
});

const home = mkdtempSync(join(tmpdir(), 'vanilla-phone-intake-'));
mkdirSync(join(home, 'dist'));
writeFileSync(join(home, 'dist', 'index.html'), '<!doctype html>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist: join(home, 'dist'), inboxEveryMs: 200 });
after(() => desktop.phone.set(false));

async function until<T>(what: string, get: () => T | undefined, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('a phone scan of a receipt already in the books is flagged as its copy and linked to nothing; the same bytes again leave the inbox with a note', async () => {
  await desktop.openDemo();
  const { WS } = await import('../src/server/books.js');
  const ws = workspaceAt(WS.paths.root);
  const { port } = await desktop.phone.set(true);
  const { token } = readState(join(home, 'desktop.json')).phone!;
  desktop.startBackground();

  // The phone's scan: the same document, other bytes.
  const scan = Buffer.concat([readFileSync(join(DEMO_ROOT, 'transactional-data/2026/receipts', ORIGINAL.file)), Buffer.from('\n% phone scan\n')]);
  const send = () => fetch(`http://${lanAddresses()[0] ?? '127.0.0.1'}:${port}/api/upload`, {
    method: 'POST', body: scan,
    headers: { 'Content-Type': 'application/pdf', 'X-Captured-At': '2026-10-16T08:12:00', Authorization: `Bearer ${token}` },
  }).then(async (r) => { assert.equal(r.status, 200); return (await r.json() as { filename: string }).filename; });

  const first = await send();
  const copy = await until('the scan is read and filed', () => loadBooks(ws).receipts.find((r) => r.originalFilename === first && r.location === 'archived'));
  const books = loadBooks(ws);
  assert.deepEqual(books.mappings.filter((m) => m.receiptId === copy.id), [], 'the copy pays nothing');
  assert.deepEqual(ledgerOf(books, '2026-04-01').byId.get(copy.id)?.twin?.of, ORIGINAL.id, 'Belege asks «möglicher Doppelbeleg» of the original');

  const again = await send();
  await until('the byte copy leaves the inbox', () => !existsSync(join(ws.paths.inbox, again)) || undefined);
  assert.equal(loadBooks(ws).receipts.filter((r) => r.id === copy.id).length, 1, 'the books hold it once');
  const { engine } = await import('../src/server/routes/automation.js');
  const note = await until('a run says so', () => engine().runs().map((r) => digestOf(r).copies).find((c) => c?.some((x) => x.file === again)));
  assert.deepEqual(note, [{ file: again, of: copy.filename }]);
});

test('a till receipt without a date takes the day the phone took it, marked so, and never a name of zeros', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-date-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  mkdirSync(ws.paths.inbox, { recursive: true });
  const scan = Buffer.concat([readFileSync(join(DEMO_ROOT, 'transactional-data/2026/receipts', ORIGINAL.file)), Buffer.from('\n% till, no date\n')]);
  writeFileSync(join(ws.paths.inbox, '20261016-081200.pdf'), scan);
  const answer = { suggestedFilename: '00000000-baucenter-gossau.pdf', date: '', description: 'Baucenter Gossau', amount: 312.9, currency: 'CHF' };
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: async () => JSON.stringify(answer), steps: [['read', readStep], ['match', matchStep]] });
  const r = loadBooks(ws).receipts.find((x) => x.originalFilename === '20261016-081200.pdf')!;
  assert.deepEqual([r.date, r.dateSource, r.filename], ['2026-10-16', 'captured', '20261016-baucenter-gossau.pdf']);
});

test('a receipt whose date is "" counts as undated: it needs you in the working quarter, whenever it was read', () => {
  const books = loadBooks(workspaceAt(DEMO_ROOT));
  const undated = { ...books.receipts[0], id: 'undated-0000', filename: '00000000-baucenter-gossau.pdf', date: '', amount: 312.9, indexedAt: '2026-10-15T09:00:00.000Z', kind: undefined };
  const l = ledgerOf({ ...books, receipts: [...books.receipts, undated] }, '2026-04-01');
  const q2 = parsePeriod('2026-Q2', '2026-10-16')!;
  const { rows } = visible(l, q2, undefined, undefined);
  const g = groups(rows, l, () => false);
  assert.ok(g.find((x) => x.key === 'need')?.rows.some((v) => v.r.id === 'undated-0000'), 'under «Braucht dich»');
});
