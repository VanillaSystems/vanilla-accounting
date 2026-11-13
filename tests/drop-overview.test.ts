/**
 * The overview of a drop of many files (#453, src/app/shell/drop-overview.ts): every file in exactly
 * one stage, the stages adding up to the files; what needs her is what the closing lines say waits
 * for her; the files still uploading are worked on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSING_GROUPS, closingGroupOf, overStoppedRun, waitsAfterDrop, type ClosingGroup, type FileState } from '../src/app/shell/drop-summary.js';
import { STAGES, STAGE_OF, doingOf, doingsIn, overviewOf, stagesIn } from '../src/app/shell/drop-overview.js';
import { needsYou } from '../src/app/shell/drop-tabs.js';
import type { DropRow, DropState } from '../src/types/drop.js';

const row = (state: DropState, extra: Partial<DropRow> = {}): DropRow => ({ key: state, id: state, name: `${state}.pdf`, size: 1, state, ...extra });

const of = (...groups: ClosingGroup[]) => groups.map((group) => ({ group }));

test('the stages add up to the files, the uploading ones worked on', () => {
  const o = overviewOf(of('asks', 'working', 'statement', 'matched', 'matched', 'read', 'report', 'known'), 3);
  assert.equal(o.n, 11);
  assert.deepEqual(o.counts, { needs: 1, working: 4, statements: 1, matched: 2, read: 1, other: 1, out: 1 });
  assert.equal(Object.values(o.counts).reduce((a, b) => a + b, 0), o.n);
  assert.equal(o.done, 7, 'done: every file not worked on any more, the one waiting for her among them');
  assert.deepEqual(stagesIn(overviewOf(of('matched', 'working'), 0)), ['working', 'matched'], 'only stages with files, in their order');
});

test('the files worked on, by what is done with them now: the parts add up to «in Arbeit»', () => {
  const o = overviewOf([
    { group: 'working', doing: 'uploading' }, { group: 'working', doing: doingOf({ kind: 'queued' }) }, { group: 'working', doing: doingOf({ kind: 'queued' }) },
    { group: 'working', doing: doingOf({ kind: 'running', step: 'read' }) }, { group: 'working', doing: doingOf({ kind: 'running', step: 'facts' }) },
    { group: 'working', doing: doingOf({ kind: 'running', step: 'match' }) }, { group: 'working', doing: doingOf({ kind: 'running', step: 'company-step' }) },
    { group: 'working' }, { group: 'matched', doing: 'reading' },
  ], 35);
  assert.deepEqual(o.doing, { uploading: 36, waiting: 2, reading: 2, matching: 1, booking: 0, other: 2 });
  assert.equal(Object.values(o.doing).reduce((a, b) => a + b, 0), o.counts.working);
  assert.deepEqual(doingsIn(o), ['uploading', 'waiting', 'reading', 'matching', 'other'], 'a part without files is left out');
});

test('what needs her in the overview is what the closing lines and the tabs say waits for her', () => {
  // A taken receipt's states: those waitsAfterDrop counts are exactly the ones in «braucht dich».
  const taken: FileState[] = [{ kind: 'waits' }, { kind: 'stuck', run: 'r' }, { kind: 'unread' }, { kind: 'twin', of: 'x', name: 'x', why: 'same-text' },
    { kind: 'read' }, { kind: 'matched' }, { kind: 'working' }, { kind: 'statement' }, { kind: 'report' }, { kind: 'none', why: '' }, { kind: 'supporting' }, { kind: 'orderPage', provider: 'p' }, { kind: 'feeBill', provider: 'p' }];
  for (const x of taken) {
    const needs = STAGE_OF[closingGroupOf(row('taken'), x)] === 'needs';
    assert.equal(needs, waitsAfterDrop([x], 0).receipts === 1, `${x.kind}: in «braucht dich» exactly when it waits for her`);
  }
  // A row that asks in the dialog (the tabs' dot) needs her too.
  for (const state of ['locked', 'unclear', 'asks'] as const) {
    assert.ok(needsYou(row(state)));
    assert.equal(STAGE_OF[closingGroupOf(row(state), undefined)], 'needs', state);
  }
  assert.equal(STAGE_OF[closingGroupOf(row('duplicate', { reason: 'possible-duplicate' }), undefined)], 'needs', '«schon da?» asks her');
  assert.equal(STAGE_OF[closingGroupOf(row('duplicate', { reason: 'duplicate' }), undefined)], 'out');
});

test('#483: a file whose run stopped says what the books made of it: a balance sheet, no receipt, a document beside an invoice, a copy stay so; only a receipt still waiting says the run stopped', () => {
  const settled: FileState[] = [{ kind: 'balanceSheet' }, { kind: 'none', why: 'ein Produktfoto' }, { kind: 'supporting' }, { kind: 'twin', of: 'x', name: 'x', why: 'same-text' }, { kind: 'orderPage', provider: 'p' }];
  for (const x of settled) assert.deepEqual(overStoppedRun(x, 'run-1'), x, `${x.kind}: the books' word stands`);
  for (const x of [{ kind: 'waits' }, { kind: 'read' }, { kind: 'unread' }] as FileState[]) assert.deepEqual(overStoppedRun(x, 'run-1'), { kind: 'stuck', run: 'run-1' }, `${x.kind}: its run stopped`);
  assert.equal(waitsAfterDrop([overStoppedRun({ kind: 'balanceSheet' }, 'r'), overStoppedRun({ kind: 'none', why: '' }, 'r')], 0).receipts, 0, 'neither is counted as waiting for her');
});

test('every closing group has its stage', () => {
  for (const g of CLOSING_GROUPS) assert.ok(STAGES.includes(STAGE_OF[g]), g);
});
