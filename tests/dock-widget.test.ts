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
  collected: 46, read: 44, withVat: 30, matched: 39, booked: 38, payments: 45, paymentsBooked: 41,
  authors: { app: 30, asked: 2, changed: 1, person: 5, unknown: 0 }, waitingReceipt: 0, filing: { kind: 'running', ends: '2026-12-31' }, ...over,
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

test('the bar shows the payments booked of the period\'s payments and what waits; the card a line for the receipts, one for the payments, and «ohne dich» only when the books record who booked (#398)', () => {
  const w = dockWidget(figures({ withoutYou: 79 }), view(), 0, now);
  assert.deepEqual(w.stack, [{ key: 'payments', n: 41, of: 45 }, { key: 'waiting', n: 0 }], 'how far the period is, in payments');
  assert.deepEqual(w.card, [{ key: 'receipts', collected: 46, read: 44, booked: 38 }, { key: 'payments', n: 41, of: 45 }, { key: 'withoutYou', pct: 79 }]);
  const unknown = dockWidget(figures({ authors: { app: 0, asked: 0, changed: 0, person: 0, unknown: 38 } }), view(), 0, now);
  assert.deepEqual(keys(unknown.card), ['receipts', 'payments'], 'no share when no booking records its author');
  assert.deepEqual(keys(dockWidget(figures({ payments: 0, paymentsBooked: 0 }), view(), 0, now).card), ['receipts', 'payments'], 'both lines always, also before the first statement');
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

test('before the automation is loaded the widget knows the figures and nothing about runs or schedules', () => {
  const w = dockWidget(figures(), undefined, 0, now);
  assert.equal(w.loaded, false);
  assert.deepEqual([w.run, w.next, w.paused], [undefined, undefined, false]);
  assert.deepEqual(keys(w.stack), ['payments', 'waiting']);
  assert.equal(dockWidget(figures(), view(), 0, now).loaded, true);
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

test('«Aufgaben» is one count in the dock and the corner (#385 review): open tasks and stuck runs (openCount), and the questions for the viewer', async () => {
  const { corner } = await import('../src/workflows/model.js');
  const v = view({ tasks: [task], runs: [run({ id: 's', status: 'stuck' })] });
  assert.deepEqual(corner(v), { kind: 'needs-you', count: dockWidget(figures(), v, 0, now).waiting }, 'a stuck run counts in the corner as in the dock');
  assert.deepEqual(corner(view({ runs: [run({ id: 's', status: 'stuck' })] })), { kind: 'needs-you', count: 1 });
});

test('one word, one unit (#398): in every state of the books the bar\'s label and the card\'s lines name what they count, in four languages, and the bar never switches to receipts', async () => {
  const { formatIn } = await import('../src/app/i18n/core.js');
  const { figureLabel, cardLine, dockLine } = await import('../src/app/automation/words.js');
  const units: Record<string, { payments: RegExp; receipts: RegExp; tasks: RegExp }> = {
    de: { payments: /Zahlung/, receipts: /Beleg/, tasks: /Aufgabe/ },
    en: { payments: /payment/i, receipts: /receipt/i, tasks: /task/ },
    fr: { payments: /paiement/i, receipts: /justificatif/i, tasks: /tâche/ },
    it: { payments: /pagament/i, receipts: /giustificativ/i, tasks: /compit/ },
  };
  const states = [
    figures(),
    figures({ read: 0, booked: 0, matched: 0, paymentsBooked: 11, payments: 23 }),
    figures({ read: 7, booked: 1, paymentsBooked: 7, payments: 23 }),
    figures({ read: 0, booked: 0, paymentsBooked: 0, payments: 23 }),
    figures({ collected: 0, read: 0, booked: 0, matched: 0, payments: 0, paymentsBooked: 0 }),
  ];
  for (const code of ['de', 'en', 'fr', 'it'] as const) {
    const dict = (await import(`../src/app/i18n/locales/${code}.js`)).default;
    const say = (key: string, vars: Record<string, string | number> = {}) => formatIn({ code, ...dict }, key as never, vars);
    for (const f of states) {
      const w = dockWidget(f, view({ tasks: [task] }), 0, now);
      assert.deepEqual(keys(w.stack), ['payments', 'waiting'], `${code}: the bar is payments and tasks in every state`);
      assert.match(figureLabel(say, w.stack[0]), units[code].payments, `${code}: the bar's figure names its unit`);
      assert.match(figureLabel(say, w.stack[1]), units[code].tasks);
      const lines = w.card.map((x) => cardLine(say, x));
      assert.match(lines[0], units[code].receipts, `${code}: «${lines[0]}» names receipts`);
      if (f.collected) assert.match(lines[0], new RegExp(`${f.read}\\D+${f.booked}`), 'read and booked receipts on one line');
      assert.match(lines[1], units[code].payments, `${code}: «${lines[1]}» names payments`);
      if (f.payments) assert.match(lines[1], new RegExp(`${f.paymentsBooked}\\D+${f.payments}`));
      // A period without any says so (#398 review): never «0 von 0», on the card nor in the tip.
      for (const line of [...lines, dockLine(say, w)]) assert.doesNotMatch(line, /\b0 (von|of|sur|su) 0\b/, `${code}: «${line}»`);
      if (!f.collected) assert.doesNotMatch(lines[0], /\d/, `${code}: «${lines[0]}» says there are none`);
      assert.match(dockLine(say, w), units[code].payments);
      assert.doesNotMatch(figureLabel(say, w.stack[0]), /\{/, 'no placeholder left');
    }
  }
});

test('the payments figure keeps its words in a short window, so the bar never shows two bare numbers', () => {
  const css = readFileSync('src/app/styles/shell.css', 'utf8');
  const rule = css.split('\n').find((l) => l.startsWith('@media (max-height: 620px)') && l.includes('.autow'))!;
  assert.ok(rule, 'the short-window rule of the bar');
  assert.match(rule, /\.autow \.n:not\(\.payments\) span \{ display: none; \}/, 'only the other labels go');
});
