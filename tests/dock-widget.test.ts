/**
 * The Automatisierung widget at the foot of the dock (src/app/automation/widget.ts, shell/Dock.tsx)
 * and the dock's width preference (shell/nav-width.ts): the widget shows only figures the books
 * record, the same waiting count the dock always showed, and the width survives a reload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dockWidget, RUN_NOW } from '../src/app/automation/widget.js';
import type { HomeFigures } from '../src/app/automation/home.js';
import type { AutomationView, RunSummary, Task, WorkflowDecl } from '../src/workflows/model.js';

const figures = (over: Partial<HomeFigures> = {}): HomeFigures => ({
  period: { key: '2026-Q4', from: '2026-10-01', to: '2026-12-31' },
  collected: 46, read: 44, withVat: 30, payable: 40, matched: 39, booked: 38,
  authors: { app: 30, asked: 2, changed: 1, person: 5, unknown: 0 }, filing: { kind: 'running', ends: '2026-12-31' }, ...over,
});
const wf = (over: Partial<WorkflowDecl> = {}): WorkflowDecl => ({
  id: RUN_NOW, label: { en: 'Collect' }, desc: { en: '' }, phase: 'collect', cadence: { en: '' }, for: 'company',
  triggers: [{ kind: 'schedule', cron: '0 22 * * *' }], emits: [], start: 's', steps: [], version: 'v', origin: 'app', runnable: { ok: true }, ...over,
});
const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r1', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' }, mode: 'live', startedAt: '2026-10-21T05:00:00Z', status: 'done', path: [], startedBy: { kind: 'manual' },
  digest: { files: [], receipts: 0, links: 0, entries: 0, poorScans: [] }, ...over,
});
const task = { run: 't1' } as Task;
const view = (over: Partial<AutomationView> = {}): AutomationView => ({ rev: '', workflows: [wf()], problems: [], warnings: [], runs: [], tasks: [], paused: false, limits: { ai: 1, other: 1 }, pending: [], ...over });
const now = new Date(2026, 9, 21, 10, 0);
const keys = (fs: Array<{ key: string }>) => fs.map((f) => f.key);

test('the bar stacks read, booked and what waits; the card adds collected, and «ohne dich» only when the books record who booked', () => {
  const w = dockWidget(figures({ withoutYou: 79 }), view(), 0, now);
  assert.deepEqual(w.stack, [{ key: 'read', n: 44 }, { key: 'booked', n: 38 }, { key: 'waiting', n: 0 }]);
  assert.deepEqual(w.card, [{ key: 'collected', n: 46 }, { key: 'read', n: 44 }, { key: 'booked', n: 38 }, { key: 'withoutYou', pct: 79 }]);
  const unknown = dockWidget(figures({ authors: { app: 0, asked: 0, changed: 0, person: 0, unknown: 38 } }), view(), 0, now);
  assert.deepEqual(keys(unknown.card), ['collected', 'read', 'booked'], 'no share when no booking records its author');
  assert.ok(!keys(unknown.stack).includes('withoutYou'));
});

test('what waits is the old badge\'s count: open tasks, stuck runs and the questions for the viewer', () => {
  const w = dockWidget(figures(), view({ tasks: [task, { run: 't2' } as Task], runs: [run({ id: 's', status: 'stuck' }), run({ id: 'd' })] }), 2, now);
  assert.equal(w.waiting, 5);
  assert.deepEqual(w.stack.at(-1), { key: 'waiting', n: 5 });
  assert.equal(w.state, 'waiting');
  assert.equal(dockWidget(figures(), undefined, 1, now).waiting, 1, 'without the automation loaded, the questions still count');
});

test('a live run going makes the widget run; a dry check does not; with nothing waiting it rests and says the next start', () => {
  const going = dockWidget(figures(), view({ tasks: [task], runs: [run({ id: 'g', status: 'running', at: 'match' })] }), 0, now);
  assert.equal(going.state, 'running', 'a run going wins over what waits');
  assert.equal(going.run?.id, 'g');
  const dry = dockWidget(figures(), view({ runs: [run({ status: 'running', mode: 'dry' })] }), 0, now);
  assert.equal(dry.state, 'idle');
  assert.equal(dry.run, undefined);
  assert.deepEqual(dry.next, { workflow: RUN_NOW, at: new Date(2026, 9, 21, 22, 0) });
  assert.equal(dockWidget(figures(), view({ paused: true }), 0, now).next, undefined, 'paused: nothing starts');
});

test('«Jetzt ausführen» is offered only when the collection workflow is declared and can execute', () => {
  assert.equal(dockWidget(figures(), view(), 0, now).canRun, true);
  assert.equal(dockWidget(figures(), view({ workflows: [wf({ runnable: { ok: false, missing: [{ step: 'due', action: 'source.due' }] } })] }), 0, now).canRun, false);
  assert.equal(dockWidget(figures(), view({ workflows: [wf({ id: 'booking' })] }), 0, now).canRun, false);
  assert.equal(dockWidget(figures(), undefined, 0, now).canRun, false);
});

function withStorage(storage: Partial<Storage> | 'throws', body: () => void) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { if (storage === 'throws') throw new Error('SecurityError'); return storage; } });
  try { body(); } finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete (globalThis as { localStorage?: Storage }).localStorage; }
}

test('the dock is narrow by default, stays wide once chosen, and works when the browser keeps nothing', async () => {
  const { navWideStored, keepNavWide, NAV_WIDE_KEY, NAV_WIDE_CLASS } = await import('../src/app/shell/nav-width.js');
  const kept = new Map<string, string>();
  withStorage({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) }, () => {
    assert.equal(navWideStored(), false);
    keepNavWide(true);
    assert.equal(navWideStored(), true);
    keepNavWide(false);
    assert.equal(navWideStored(), false);
    assert.equal(kept.size, 0, 'narrow leaves nothing behind');
  });
  withStorage('throws', () => {
    assert.equal(navWideStored(), false);
    assert.doesNotThrow(() => keepNavWide(true));
  });
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, new RegExp(`localStorage\\.getItem\\('${NAV_WIDE_KEY.replace('.', '\\.')}'\\) === '1'`), 'index.html reads the same key before the first paint');
  assert.match(html, new RegExp(`classList\\.add\\('${NAV_WIDE_CLASS}'\\)`));
  assert.match(readFileSync('src/app/styles/shell.css', 'utf8'), new RegExp(`html\\.${NAV_WIDE_CLASS} \\{ --abw: var\\(--abw-wide\\); \\}`), 'the class widens the bar the page follows');
});
