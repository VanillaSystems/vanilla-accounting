/**
 * A receipt the inbox's run still works on is in processing (#218): Belege shows it in its own
 * group «Wird verarbeitet», not under «Braucht dich», and the badge does not count it; queued
 * behind another run it says how many files go before it; once the run came to rest it needs the
 * person when it still lacks something, and a run that stopped says so. A fact a person enters
 * while the run reads the receipt is hers: the matching step never writes over it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './support/jurisdiction.js';
import { bookingRun, inProcess, processingOf, type Processing } from '../src/workflows/processing.js';
import type { RunSummary } from '../src/workflows/model.js';
import { badgeCount, groups, ledgerOf, needsYou } from '../src/app/areas/receipts/model.js';
import type { Index, Receipt } from '../src/types/index.js';
import { loadBooks, moduleActor, saveBooks, update } from '../src/books/store.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { keepHand, matchStep } from '../src/intake/match.js';
import { findFile, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({
  id, workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' }, mode: 'live', startedAt: `2026-10-28T10:00:0${id.slice(-1)}Z`,
  status: 'running', path: [], startedBy: { kind: 'outside', file: 'x.pdf' }, digest: { files: [], receipts: 0, links: 0, entries: 0, poorScans: [] }, ...over,
});
const arrived = (...ids: string[]) => ids.map((id) => ({ kind: 'receipt' as const, file: `${id}.pdf`, id }));
const receipt = (id: string, over: Partial<Receipt> = {}): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: 'Rechnung', extractionMethod: 'pdftotext', fileSize: 1000,
  indexedAt: '2026-10-28T10:00:00Z', location: 'staged', ...over,
} as Receipt);

test('the run its file came with decides: running at its step, queued behind the files before it, stopped, or done', () => {
  const runs = [
    run('r1', { status: 'running', at: 'match', path: ['read', 'facts', 'match'], arrived: arrived('a', 'b', 'c') }),
    run('r2', { status: 'queued', at: 'read', reason: 'lane', arrived: arrived('d', 'e') }),
  ];
  const p = processingOf(runs, []);
  assert.deepEqual(p.get('a'), { kind: 'running', run: 'r1', step: 'match' });
  assert.deepEqual(p.get('d'), { kind: 'queued', run: 'r2', ahead: 3, reason: 'lane' }, 'three files of the run before it go first');
  assert.ok(inProcess(p.get('a')) && inProcess(p.get('e')));

  const stuck = processingOf([run('r1', { status: 'stuck', at: 'facts', path: ['read', 'facts'], error: 'model failed', arrived: arrived('a') })], []);
  assert.deepEqual(stuck.get('a'), { kind: 'stuck', run: 'r1', step: 'facts', error: 'model failed' });
  assert.equal(inProcess(stuck.get('a')), false, 'a stopped run works on nothing: the receipt needs the person');

  assert.equal(processingOf([run('r1', { status: 'done', arrived: arrived('a') })], []).has('a'), false);
  // A newer run that took the same file to rest wins over the older one that stopped.
  assert.equal(processingOf([run('r1', { status: 'stuck', arrived: arrived('a') }), run('r2', { status: 'done', arrived: arrived('a') })], []).has('a'), false);
  // Dry runs and other workflows say nothing about the inbox.
  assert.equal(processingOf([run('r1', { mode: 'dry', arrived: arrived('a') }), run('r2', { workflow: 'booking', arrived: arrived('b') })], []).size, 0);
});

test('a receipt not read to the end (staged) is worked on by any open run before the matching step; stuck when the newest run stopped', () => {
  const staged = [receipt('s'), receipt('done', { location: 'archived' })];
  assert.deepEqual(processingOf([run('r1', { status: 'running', at: 'facts', path: ['read', 'facts'] })], staged).get('s'), { kind: 'running', run: 'r1', step: 'facts' });
  assert.equal(processingOf([run('r1', { status: 'running', at: 'facts' })], staged).has('done'), false, 'an archived receipt of another run is not this one\'s');
  assert.equal(processingOf([run('r1', { status: 'running', at: 'book', path: ['read', 'facts', 'match', 'book'] })], staged).has('s'), false, 'past matching: this run will not read it');
  assert.deepEqual(processingOf([run('r1', { status: 'stuck', at: 'match', error: 'x' })], staged).get('s'), { kind: 'stuck', run: 'r1', step: 'match', error: 'x' });
  assert.equal(processingOf([run('r1', { status: 'done' })], staged).has('s'), false, 'no run open, none stopped: it waits for the person (or the AI, when it is off)');
});

test('the open payments are booked by the open run; with none open they wait for the person', () => {
  assert.deepEqual(bookingRun([run('r1', { status: 'running', at: 'book' })]), { kind: 'running', run: 'r1', step: 'book' });
  assert.equal(bookingRun([run('r1', { status: 'done' }), run('r2', { status: 'stuck' })]), undefined);
});

/** Books with one receipt that has neither date nor amount yet, as the read step leaves it. */
const books = (): Index => ({
  receipts: [receipt('new', { date: undefined }), receipt('old', { location: 'archived', date: '2026-10-02', amount: 50, currency: 'CHF' })],
  transactions: [], mappings: [], journalEntries: [], bankStatements: [], config: { closedThrough: '2026-09-30' },
} as unknown as Index);

test('Belege: in processing it is its own group first, not under «Braucht dich», and the badge does not count it; after the run it needs the person', () => {
  const working = new Map<string, Processing>([['new', { kind: 'running', run: 'r1', step: 'read' }]]);
  const l = ledgerOf(books(), '2026-10-01', working);
  const v = l.byId.get('new')!;
  assert.equal(needsYou(v, l), false);
  assert.equal(badgeCount(l), 1, 'only the old receipt without a payment');
  const { groups: gs } = groups(l.views, l, false, () => false);
  assert.deepEqual(gs.map((g) => [g.key, g.rows.map((x) => x.r.id)]), [['working', ['new']], ['need', ['old']]]);

  const after = ledgerOf(books(), '2026-10-01', new Map());
  assert.equal(needsYou(after.byId.get('new')!, after), true, 'the run came to rest: what it still lacks is the person\'s');
  assert.equal(badgeCount(after), 2);
  assert.deepEqual(groups(after.views, after, false, () => false).groups.map((g) => g.key), ['need']);

  const stopped = ledgerOf(books(), '2026-10-01', new Map([['new', { kind: 'stuck', run: 'r1', error: 'x' } as Processing]]));
  assert.equal(needsYou(stopped.byId.get('new')!, stopped), true, 'a stopped run hands it to the person');
});

test('what a person entered while the run read the receipt stays; the mark goes once it is filed', () => {
  const r = receipt('x', { handSet: ['amount', 'description'] });
  assert.deepEqual(keepHand(r, { date: '2026-10-01', amount: 9, currency: 'EUR', description: 'read', title: { vendor: 'V', what: 'W' } }), { date: '2026-10-01' });
  assert.equal(r.handSet, undefined);
  assert.deepEqual(keepHand(receipt('y'), { amount: 9, currency: 'CHF' }), { amount: 9, currency: 'CHF' });
});

/** The demo's Post invoice of May and the payment that pays it, open quarter. */
const RECEIPT = '7cde279c427e1f41';

test('the matching step keeps the date, amount and words a person entered while the receipt was staged (#218)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'processing-hand-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const was = loadBooks(ws);
  const file = findFile(ws.paths, 'receipts', was.receipts.find((x) => x.id === RECEIPT)!.filename)!;
  const pdf = readFileSync(file);
  rmSync(file);
  update(was, moduleActor('test'), (b) => {
    b.receipts = b.receipts.filter((x) => x.id !== RECEIPT);
    b.mappings = b.mappings.filter((m) => m.receiptId !== RECEIPT);
  });
  saveBooks(ws, was);
  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'scan-post.pdf'), pdf);
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]] });

  // While the run is still to match it, the person enters the facts (PATCH /api/receipts/:id marks them as hers).
  const staged = loadBooks(ws);
  update(staged, moduleActor('test'), (b) => {
    const r = b.receipts.find((x) => x.originalFilename === 'scan-post.pdf' && x.location === 'staged')!;
    Object.assign(r, { date: '2026-05-20', amount: 199, currency: 'CHF', description: 'Post, von Hand', handSet: ['date', 'amount', 'description'] });
  });
  saveBooks(ws, staged);

  // A model that reads other facts and names the receipt otherwise.
  const ask: Ask = async (prompt, opts) => {
    if (opts.step === 'receipt-titles') return JSON.stringify(Object.fromEntries([...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => [m[1], { v: 'Post CH', w: 'Pakete' }])));
    if (opts.step === 'receipt-match') return JSON.stringify({ suggestedFilename: '20260512-post-ch.pdf', date: '2026-05-12', description: 'Post CH', amount: 208.7, currency: 'CHF', matchedTransactionRefs: [], confidence: 0.2 });
    if (opts.step === 'receipt-pair') return '[]';
    return '{}';
  };
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: [['match', matchStep]] });
  const r = loadBooks(ws).receipts.find((x) => x.originalFilename === 'scan-post.pdf')!;
  assert.equal(r.location, 'archived');
  assert.deepEqual([r.date, r.amount, r.currency, r.description, r.title], ['2026-05-20', 199, 'CHF', 'Post, von Hand', undefined], 'hers, not what the step read');
  assert.match(r.filename, /^20260520-/, 'her date names the file');
  assert.equal(r.handSet, undefined, 'the mark goes once it is filed');
});
