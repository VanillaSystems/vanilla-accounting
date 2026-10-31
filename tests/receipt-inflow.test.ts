/**
 * The strip above Belege states facts: whether the phone can deliver, how the last «Belege holen»
 * went (each source's own run counted), which source needs a person, and how many of the period's
 * payments have their receipt. Each test names the wrong fact it would catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRunOf, coverageOf, mailWays, phoneWayOf, sourceChips } from '../src/app/areas/receipts/inflow.js';
import type { RunSummary } from '../src/workflows/model.js';
import type { SourcesView } from '../src/platform/sources/model.js';
import type { BankTransaction } from '../src/types/index.js';

const run = (id: string, workflow: string, status: RunSummary['status'], startedAt: string, more: Partial<RunSummary> = {}): RunSummary => ({
  id, workflow, status, startedAt, item: { kind: 'company', id: 'company' }, mode: 'live', path: [], startedBy: { kind: 'manual' },
  digest: { files: [], receipts: 0, links: 0, entries: 0, poorScans: [] }, ...more,
});
const child = (id: string, parent: string, source: string, status: RunSummary['status'], at: string) =>
  run(id, 'collect', status, at, { item: { kind: 'source', id: source }, startedBy: { kind: 'parent', run: parent, step: 'collect' }, finishedAt: at });

test('the phone: no Mac app is the scan page; never switched on, off and on are told apart', () => {
  assert.equal(phoneWayOf(undefined, false), 'browser');
  assert.equal(phoneWayOf(undefined, true), 'loading');
  assert.equal(phoneWayOf({ on: false, addresses: [] }, true), 'never');
  assert.equal(phoneWayOf({ on: false, addresses: [], port: 51234 }, true), 'off', 'a paired phone that reaches nothing must not read as «not paired»');
  assert.equal(phoneWayOf({ on: true, addresses: ['192.168.1.2'], port: 51234 }, true), 'on');
});

test('the last collection counts its sources\' runs, not its own', () => {
  assert.deepEqual(collectRunOf([]), { kind: 'never' });
  const runs = [
    run('c1', 'collection', 'done', '2026-10-17T08:00:00Z', { finishedAt: '2026-10-17T08:00:05Z' }),
    run('c2', 'collection', 'done', '2026-10-17T09:00:00Z', { finishedAt: '2026-10-17T09:00:02Z' }),
    child('k1', 'c2', 'info', 'waiting', '2026-10-17T09:00:09Z'),
    child('k2', 'c2', 'shop', 'done', '2026-10-17T09:00:07Z'),
    child('k0', 'c1', 'info', 'done', '2026-10-17T08:00:04Z'),
  ];
  assert.deepEqual(collectRunOf(runs), { kind: 'done', run: 'c2', at: '2026-10-17T09:00:09Z', failed: 1, of: 2 });
});

test('a collection is under way while any source of it still runs', () => {
  const runs = [run('c1', 'collection', 'done', '2026-10-17T09:00:00Z'), child('k1', 'c1', 'info', 'running', '2026-10-17T09:00:01Z')];
  assert.deepEqual(collectRunOf(runs), { kind: 'running', run: 'c1' });
});

test('a collection with no source due is no run for the person, and a discarded one is not the last', () => {
  const nothing = run('c1', 'collection', 'done', '2026-10-17T09:00:00Z', { finishedAt: '2026-10-17T09:00:01Z' });
  assert.deepEqual(collectRunOf([nothing, run('c2', 'collection', 'discarded', '2026-10-17T10:00:00Z')]), { kind: 'never' }, '«Letzter Lauf» must not show a check that fetched nothing');
  const fetched = [run('c0', 'collection', 'done', '2026-10-17T07:00:00Z', { finishedAt: '2026-10-17T07:00:03Z' }), child('k0', 'c0', 'info', 'done', '2026-10-17T07:00:02Z'), nothing];
  assert.deepEqual(collectRunOf(fetched), { kind: 'done', run: 'c0', at: '2026-10-17T07:00:03Z', failed: 0, of: 1 });
});

test('a collection stopped before it found its sources is a failure the person sees', () => {
  assert.deepEqual(collectRunOf([run('c1', 'collection', 'stuck', '2026-10-17T09:00:00Z')]), { kind: 'done', run: 'c1', at: '2026-10-17T09:00:00Z', failed: 1, of: 1 });
});

test('a source needs a person when its password is missing, its last run stopped, or it is not switched on', () => {
  const decl = (id: string) => ({ id, label: { en: id, de: `${id} (de)` }, origin: 'company' as const, code: { kind: 'app' as const, id: 'imap' }, settings: {}, reach: {}, feeds: [{ id: 'attachments', output: { kind: 'document' as const }, every: 'daily' as const }], version: 'v1' });
  const view: SourcesView = {
    secretsInApp: true, secretsWhere: '', runsHere: true,
    rows: [
      { verdict: { kind: 'ready', decl: decl('ok') }, secrets: [{ channel: 'mail', present: true }] },
      { verdict: { kind: 'ready', decl: decl('nopw') }, secrets: [{ channel: 'mail', present: false }] },
      { verdict: { kind: 'ready', decl: decl('broke') }, secrets: [{ channel: 'mail', present: true }] },
      { verdict: { kind: 'pending', decl: decl('new'), reachDiff: { added: [], removed: [] } }, secrets: [] },
    ],
  };
  const runs = [child('k1', 'c1', 'broke', 'stuck', '2026-10-17T09:00:00Z'), child('k0', 'c0', 'ok', 'done', '2026-10-17T08:00:00Z')];
  assert.deepEqual(sourceChips(view, runs, 'de'), [
    { id: 'ok', label: 'ok (de)', every: ['daily'], run: 'k0', last: '2026-10-17T08:00:00Z' },
    { id: 'nopw', label: 'nopw (de)', every: ['daily'], warn: 'login' },
    { id: 'broke', label: 'broke (de)', every: ['daily'], warn: 'failed', run: 'k1', last: '2026-10-17T09:00:00Z' },
    { id: 'new', label: 'new (de)', every: ['daily'], warn: 'pending' },
  ]);
});

test('coverage counts the period\'s payments that need a receipt, and those with one linked', () => {
  const tx = (ref: string, date: string, more: Partial<BankTransaction> = {}) => ({ ref, date, amount: 10, currency: 'CHF', direction: 'DBIT', bank: 'Bank', description: '', ...more }) as BankTransaction;
  const books = {
    transactions: [tx('a', '2026-07-03'), tx('b', '2026-08-01'), tx('fee', '2026-08-01', { type: 'wise-fee' }), tx('none', '2026-08-02', { noReceiptNeeded: true }), tx('zero', '2026-08-03', { amount: 0 }), tx('old', '2026-06-30')],
    mappings: [{ transactionRef: 'a', receiptId: 'r1' }, { transactionRef: 'old', receiptId: 'r2' }],
  } as unknown as Parameters<typeof coverageOf>[0];
  assert.deepEqual(coverageOf(books, { from: '2026-07-01', to: '2026-09-30' }), { covered: 1, total: 2 });
});

test('the business mailbox is read whole first; the mail program is never the proposal', () => {
  assert.deepEqual(mailWays('browser'), ['imap', 'forward']);
  assert.deepEqual(mailWays('apple'), ['imap', 'forward', 'client']);
  assert.deepEqual(mailWays('outlook'), ['imap', 'forward', 'client']);
});
