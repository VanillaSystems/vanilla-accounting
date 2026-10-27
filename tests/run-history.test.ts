/**
 * «Verlauf» (#215, src/workflows/history.ts): an object's runs from the run log. A run belongs to
 * a receipt, a payment or an entry when the object is its item or when it wrote it (a payment: an
 * entry booking it, or a link to it); one row per run with its latest event; newest first; cut at
 * the limit with the total told; and whether the run store still holds its details.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyOf, linesOfRun } from '../src/workflows/history.js';
import type { RunLogLine } from '../src/workflows/runlog.js';

const line = (l: Partial<RunLogLine> & Pick<RunLogLine, 'run' | 'item' | 'at' | 'event'>): RunLogLine =>
  ({ workflow: 'receipt-intake', version: 'v1', host: 'local', ...l });

const LOG: RunLogLine[] = [
  // An intake run for the receipt: it read it and linked it to payment P1.
  line({ run: 'r1', item: { kind: 'receipt', id: 'R1' }, at: '2026-10-01T08:00:00Z', event: 'done', wrote: { receipts: ['R1'], mappings: ['P1:R1'] } }),
  // A booking run for P1 that waited for a person, then booked entry E1.
  line({ run: 'r2', workflow: 'payment-booking', item: { kind: 'transaction', id: 'P1' }, at: '2026-10-02T08:00:00Z', event: 'waiting', step: 'ask' }),
  line({ run: 'r2', workflow: 'payment-booking', item: { kind: 'transaction', id: 'P1' }, at: '2026-10-03T08:00:00Z', event: 'done', wrote: { entries: ['E1'] } }),
  // A collection round for the company that booked E2 for P2: P2's run only by what it wrote.
  line({ run: 'r3', workflow: 'collect', item: { kind: 'company', id: 'company' }, at: '2026-10-04T08:00:00Z', event: 'done', wrote: { entries: ['E2'] } }),
  // A run that got stuck on another receipt.
  line({ run: 'r4', item: { kind: 'receipt', id: 'R2' }, at: '2026-10-05T08:00:00Z', event: 'stuck', step: 'read', reason: 'unreadable' }),
];

const all = () => true;

test('a receipt: its own runs and the runs that linked it, newest first', () => {
  const h = historyOf(LOG, { kind: 'receipt', id: 'R1', entries: [] }, all);
  assert.deepEqual(h.runs.map((r) => [r.run, r.via]), [['r1', 'item']]);
  assert.deepEqual(h.runs[0].wrote, { entries: [], mappings: ['P1:R1'], receipts: ['R1'] });
  assert.deepEqual(historyOf(LOG, { kind: 'receipt', id: 'R2', entries: [] }, all).runs.map((r) => [r.run, r.event, r.step, r.reason]), [['r4', 'stuck', 'read', 'unreadable']]);
});

test('a payment: the run for it, the run that linked a receipt to it, and a run that only wrote its entry', () => {
  const p1 = historyOf(LOG, { kind: 'payment', id: 'P1', entries: ['E1'], receipts: ['R1'] }, all);
  assert.deepEqual(p1.runs.map((r) => [r.run, r.via]), [['r2', 'item'], ['r1', 'wrote']], 'newest first');
  assert.equal(p1.runs[0].event, 'done', 'the latest line says where the run stands');
  assert.equal(p1.runs[0].at, '2026-10-03T08:00:00Z');
  assert.deepEqual(p1.runs[0].wrote.entries, ['E1']);
  const p2 = historyOf(LOG, { kind: 'payment', id: 'P2', entries: ['E2'], receipts: [] }, all);
  assert.deepEqual(p2.runs.map((r) => [r.run, r.workflow, r.via]), [['r3', 'collect', 'wrote']]);
  assert.deepEqual(historyOf(LOG, { kind: 'payment', id: 'P2', entries: [], receipts: [] }, all).runs, [], 'without the entry the company run is not the payment\'s');
});

test('an entry: the run that wrote it, and the run that linked a receipt to its payment', () => {
  assert.deepEqual(historyOf(LOG, { kind: 'entry', id: 'E1', payment: 'P1' }, all).runs.map((r) => r.run), ['r2', 'r1']);
  assert.deepEqual(historyOf(LOG, { kind: 'entry', id: 'E1' }, all).runs.map((r) => r.run), ['r2']);
  assert.deepEqual(historyOf(LOG, { kind: 'entry', id: 'E9' }, all), { runs: [], total: 0 });
});

test('the list is cut at the limit and tells the total; without a limit it is whole', () => {
  const many = Array.from({ length: 25 }, (_, i) => line({ run: `m${String(i).padStart(2, '0')}`, item: { kind: 'receipt', id: 'R9' }, at: `2026-10-${String(i + 1).padStart(2, '0')}T08:00:00Z`, event: 'done', wrote: { receipts: ['R9'] } }));
  const cut = historyOf(many, { kind: 'receipt', id: 'R9', entries: [] }, all);
  assert.equal(cut.runs.length, 20);
  assert.equal(cut.total, 25);
  assert.equal(cut.runs[0].run, 'm24', 'the newest are kept');
  assert.equal(historyOf(many, { kind: 'receipt', id: 'R9', entries: [] }, all, Infinity).runs.length, 25);
});

test('a run the store no longer holds is marked so; its lines stay readable', () => {
  const h = historyOf(LOG, { kind: 'payment', id: 'P1', entries: ['E1'], receipts: ['R1'] }, (run) => run === 'r2');
  assert.deepEqual(h.runs.map((r) => [r.run, r.stored]), [['r2', true], ['r1', false]]);
  assert.deepEqual(linesOfRun(LOG, 'r2').map((l) => l.event), ['waiting', 'done']);
});

// #233: an inbox run that read a drop of 30 receipts, linked 20 of them to payments and booked 20 entries.
const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const BATCH: RunLogLine[] = [
  line({ run: 'b', workflow: 'inbox', item: { kind: 'company', id: 'company' }, at: '2026-10-10T08:00:00Z', event: 'done',
    wrote: { receipts: ids('BR', 30), mappings: ids('', 20).map((i) => `BP${i}:BR${i}`), entries: ids('BE', 20) } }),
];

test('a batch run shows on one receipt only that receipt, its link and its payment\'s entry; the rest is counted', () => {
  const h = historyOf(BATCH, { kind: 'receipt', id: 'BR3', entries: ['BE3'] }, all);
  assert.deepEqual(h.runs.map((r) => [r.run, r.via]), [['b', 'wrote']]);
  assert.deepEqual(h.runs[0].wrote, { entries: ['BE3'], mappings: ['BP3:BR3'], receipts: ['BR3'] });
  assert.deepEqual(h.runs[0].rest, { receipts: 29, entries: 19 });
  const only = historyOf(BATCH, { kind: 'receipt', id: 'BR29', entries: [] }, all).runs[0];
  assert.deepEqual(only.wrote, { entries: [], mappings: [], receipts: ['BR29'] }, 'a receipt the run only read');
  assert.deepEqual(only.rest, { receipts: 29, entries: 20 });
});

test('a batch run shows on one payment only its entries, its link and the receipt linked to it', () => {
  const h = historyOf(BATCH, { kind: 'payment', id: 'BP5', entries: ['BE5'], receipts: ['BR5'] }, all);
  assert.deepEqual(h.runs[0].wrote, { entries: ['BE5'], mappings: ['BP5:BR5'], receipts: ['BR5'] });
  assert.deepEqual(h.runs[0].rest, { receipts: 29, entries: 19 });
  assert.deepEqual(historyOf(BATCH, { kind: 'payment', id: 'BP99', entries: [], receipts: [] }, all).runs, [], 'a payment the run did not touch');
});

test('a batch run shows on one entry only the entry and its payment\'s link', () => {
  const h = historyOf(BATCH, { kind: 'entry', id: 'BE7', payment: 'BP7' }, all);
  assert.deepEqual(h.runs[0].wrote, { entries: ['BE7'], mappings: ['BP7:BR7'], receipts: [] });
  assert.deepEqual(h.runs[0].rest, { receipts: 29, entries: 19 });
});
