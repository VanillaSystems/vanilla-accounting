/**
 * Switched on = approved (src/workflows/switch-on.ts, direct.ts, the engine's check and approve):
 * the structure decides how a change takes effect; a company part that changed since it was
 * switched on never runs live, only dry, until a person switches it on outside the workspace;
 * a schedule applies at once; a check runs the latest cases dry and says which went otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS } from '../src/workflows/actions.js';
import { openEngine } from '../src/workflows/engine.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { setSchedule } from '../src/workflows/direct.js';
import { approvalsPath, baseline, caseCheck, classifyChange, openSwitch } from '../src/workflows/switch-on.js';
import type { Run } from '../src/workflows/model.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { loadBooks, saveBooks, update, PERSON } from '../src/books/store.js';
import { DEMO_ROOT, tempWorkspace } from './support/workspace.js';

/** The demo's books in a temp folder: an engine needs books to run on. */
function books(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  return workspaceAt(dir);
}

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'switch-runs-'));
process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'switch-approvals-'));

ACTIONS['so.book'] = {
  outcomes: ['booked'], effects: ['ledger.book'],
  run: (input, fx) => {
    const t = input.transaction as { ref: string; date: string; amount: number };
    fx['ledger.book']!([{ id: `so-${t.ref}`, transactionRef: t.ref, date: t.date, accountDebit: '6500', accountCredit: '1020', amount: Math.abs(t.amount) }]);
    return { outcome: 'booked' };
  },
};
ACTIONS['so.think'] = { outcomes: ['ok', 'other'], effects: [], ai: true, run: (_i, _fx) => ({ outcome: 'ok' }) };

/** An app with one AI step that reads the company's house rules and its suppliers. */
function app(): string {
  const root = mkdtempSync(join(tmpdir(), 'switch-app-'));
  mkdirSync(join(root, 'workflows', 'thinker', 'think'), { recursive: true });
  writeFileSync(join(root, 'workflows', 'thinker', 'workflow.yaml'), 'label: { en: Thinker }\nphase: book\nfor: transaction\nsteps: [think]\n');
  writeFileSync(join(root, 'workflows', 'thinker', 'think', 'step.yaml'), 'uses: so.think\nguide: house.guide.yaml#think\nknowledge: ["suppliers/*"]\noutcomes: { ok: done, other: done }\n');
  mkdirSync(join(root, 'workflows', 'booker', 'open'), { recursive: true });
  mkdirSync(join(root, 'workflows', 'booker', 'book'));
  writeFileSync(join(root, 'workflows', 'booker', 'workflow.yaml'), 'label: { en: Booker }\nphase: book\nfor: transaction\nsteps: [open, book]\n');
  writeFileSync(join(root, 'workflows', 'booker', 'open', 'step.yaml'), 'uses: ledger.transaction-state\nreads: [transaction, books]\noutcomes: { open: book, booked: done, closed: done }\n');
  writeFileSync(join(root, 'workflows', 'booker', 'book', 'step.yaml'), 'uses: so.book\nreads: [transaction]\neffects: [ledger.book]\noutcomes: { booked: done }\n');
  return root;
}

const workflows = loadWorkflows(APP_ROOT).workflows;

test('the structure decides how a change takes effect', () => {
  const wf = 'label: { en: A }\nphase: book\nfor: transaction\nsteps: [a]\ntriggers:\n  - schedule: { cron: "0 6 * * *" }\n';
  assert.equal(classifyChange('workflows/booking/workflow.yaml', wf, wf.replace('0 6', '0 7').replace('en: A', 'en: B'), workflows), 'applies-now');
  assert.equal(classifyChange('workflows/booking/classify/step.yaml', 'label: { en: A }\noutcomes: { ok: done }\n', 'label: { en: A }\noutcomes: { ok: done, new: done }\n', workflows), 'needs-switch-on');
  assert.equal(classifyChange('workflows/booking/classify/run.ts', '', 'export {}', workflows), 'needs-maintainer');
  assert.equal(classifyChange('knowledge/rules/booking.guide.yaml', '', 'rules: []', workflows), 'needs-switch-on', 'a guide an AI step reads is part of its prompt');
  assert.equal(classifyChange('knowledge/suppliers/new-shop.yaml', '', 'name: x', workflows), 'needs-switch-on', 'so is the knowledge it cites');
  assert.equal(classifyChange('modules/ch/invoice/sheet.html', '<a>', '<b>', workflows), 'applies-now');
  assert.equal(classifyChange('belege.workspace.yaml', 'a: 1', 'a: 2', workflows), 'applies-now');
});

test('a changed company part runs only dry until a person switches it on, outside the workspace', async () => {
  const ws = books('switch-ws-');
  const appRoot = app();
  mkdirSync(join(ws.paths.root, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'house.guide.yaml'), 'rules: [one]\n');
  const sw = openSwitch(ws);
  const thinker = () => loadWorkflows(appRoot, ws.paths.root).workflows.find((w) => w.id === 'thinker')!;
  assert.equal(baseline(ws, [thinker()]), true, 'the first time, today\'s version counts as switched on');
  assert.equal(baseline(ws, [thinker()]), false, 'and never again');
  assert.ok(!approvalsPath(ws).startsWith(ws.paths.root), 'approvals lie outside the workspace');
  assert.equal(sw.isApproved(thinker()), true);
  writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'house.guide.yaml'), 'rules: [one, two]\n');
  assert.deepEqual(sw.pending(thinker())?.files, ['knowledge/rules/house.guide.yaml'], 'only what changed since it was switched on');
  const engine = openEngine(() => ws, { appRoot, isApproved: sw.isApproved, approve: sw.approve });
  const item = { kind: 'transaction' as const, id: 'T1' };
  assert.deepEqual(await engine.command({ kind: 'start', workflow: 'thinker', item }), { ok: false, refusal: 'not-approved', detail: thinker().version });
  assert.equal((await engine.command({ kind: 'start', workflow: 'thinker', item, mode: 'dry' })).ok, true, 'a dry run is allowed');
  assert.deepEqual(await engine.command({ kind: 'approve', workflow: 'thinker' }), { ok: true });
  assert.equal(sw.isApproved(thinker()), true);
  assert.equal((await engine.command({ kind: 'start', workflow: 'thinker', item })).ok, true);
  await engine.idle();
});

test('a schedule applies at once: written into the overlay, never waiting to be switched on', () => {
  const ws = tempWorkspace('switch-sched-');
  const sw = openSwitch(ws);
  const collection = () => loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((w) => w.id === 'collection')!;
  baseline(ws, [collection()]);
  setSchedule(ws, collection(), '0 7 * * *');
  assert.deepEqual(collection().triggers.filter((t) => t.kind === 'schedule'), [{ kind: 'schedule', cron: '0 7 * * *' }]);
  assert.ok(collection().triggers.some((t) => t.kind === 'manual'), 'the other triggers stay');
  assert.equal(sw.isApproved(collection()), true);
  setSchedule(ws, collection(), null);
  assert.deepEqual(collection().triggers.filter((t) => t.kind === 'schedule'), [{ kind: 'schedule', cron: '0 7 * * *', off: true }]);
  assert.match(readFileSync(join(ws.paths.root, 'workflows', 'collection', 'workflow.yaml'), 'utf8'), /off: true/);
  assert.throws(() => setSchedule(ws, collection(), '0 25 * * *'));
});

test('a case is the same when the dry run takes the same steps and would book the same', () => {
  const step = (outcome: string, would?: unknown) => ({ step: 'book', startedAt: '', input: {}, outcome, llm: [], effects: would ? [{ effect: 'ledger.book', key: 'k', applied: false, wrote: {}, would }] : [] });
  const run = (id: string, steps: Run['steps'], status: 'done' | 'running' = 'done') => ({ id, steps, item: { kind: 'transaction', id: 'T1' }, state: status === 'done' ? { status: 'done', finishedAt: '' } : { status: 'running', at: 'book', since: '' } }) as unknown as Run;
  const entry = { id: 'e1', transactionRef: 'T1', date: '2026-09-01', accountDebit: '6500', accountCredit: '1020', amount: 7, vatCode: 'I81', run: 'r1' };
  const same = caseCheck(run('r1', [step('booked')]), run('d1', [step('booked', [{ ...entry, id: 'x' }])]), [entry]);
  assert.equal(same.status, 'same');
  const other = caseCheck(run('r1', [step('booked')]), run('d1', [step('booked', [{ ...entry, accountDebit: '4040', vatCode: undefined }])]), [entry]);
  assert.deepEqual([other.status, other.detail], ['different', '6500/1020 7.00 I81 → 4040/1020 7.00 -']);
  assert.equal(caseCheck(run('r1', [step('booked')]), run('d1', [step('manual')]), [entry]).detail, 'book:booked → book:manual');
  assert.equal(caseCheck(run('r1', []), run('d1', [], 'running'), []).status, 'running');
});

test('a check runs the latest case of each item dry, on the version as it is now', async () => {
  const ws = books('switch-check-');
  const appRoot = app();
  const engine = openEngine(() => ws, { appRoot });
  assert.deepEqual(await engine.command({ kind: 'check', workflow: 'thinker' }), { ok: false, refusal: 'no-cases' });
  for (const id of ['A', 'B', 'A']) await engine.command({ kind: 'start', workflow: 'thinker', item: { kind: 'transaction', id } });
  await engine.idle();
  const r = await engine.command({ kind: 'check', workflow: 'thinker' });
  assert.equal(r.ok && r.runs?.length, 2, 'one case per item');
  await engine.idle();
  const checks = engine.runs().filter((x) => x.startedBy.kind === 'check');
  assert.deepEqual(checks.map((x) => [x.mode, x.state.status]).sort(), [['dry', 'done'], ['dry', 'done']]);
});

test('a check sees the books as they were before its case, so a booked case can go its way again', async () => {
  const ws = books('switch-booked-');
  const appRoot = app();
  const all = loadBooks(ws);
  const t = all.transactions.find((x) => x.date > all.config.closedThrough!)!;
  update(all, PERSON, (b) => { b.journalEntries = b.journalEntries.filter((e) => e.transactionRef !== t.ref); });
  saveBooks(ws, all);
  const engine = openEngine(() => ws, { appRoot });
  await engine.command({ kind: 'start', workflow: 'booker', item: { kind: 'transaction', id: t.ref } });
  await engine.idle();
  const original = engine.runs().find((r) => r.workflow === 'booker')!;
  assert.deepEqual(original.steps.map((x) => x.outcome), ['open', 'booked']);
  await engine.command({ kind: 'check', workflow: 'booker' });
  await engine.idle();
  const dry = engine.runs().find((r) => r.startedBy.kind === 'check')!;
  assert.deepEqual(dry.steps.map((x) => x.outcome), ['open', 'booked'], 'not "already booked": the case\'s own booking is hidden from it');
  assert.equal(caseCheck(original, dry, loadBooks(ws).journalEntries).status, 'same');
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === t.ref).length, 1, 'the check wrote nothing');
});

test('#413: a record from before booking read the customers\' files takes such a file met the first time as switched on; one changed after waits', () => {
  const ws = tempWorkspace('switch-413-');
  const booking = () => loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((w) => w.id === 'booking')!;
  mkdirSync(join(ws.paths.root, 'knowledge', 'suppliers'), { recursive: true });
  mkdirSync(join(ws.paths.root, 'knowledge', 'customers'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'a.yaml'), 'id: a\n');
  const sw = openSwitch(ws);
  sw.approve(booking());
  // The record as written before #413: no `cited`, the customers' file not in it.
  const path = approvalsPath(ws);
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  delete rec.booking.cited;
  writeFileSync(path, JSON.stringify(rec));
  writeFileSync(join(ws.paths.root, 'knowledge', 'customers', 'c.yaml'), 'id: c\n');
  assert.equal(sw.pending(booking()), undefined, 'met the first time: switched on');
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).booking.cited.includes('knowledge/customers'), 'the record learns what it covers');
  writeFileSync(join(ws.paths.root, 'knowledge', 'customers', 'c.yaml'), 'id: c\nname: C\n');
  assert.deepEqual(sw.pending(booking())?.files, ['knowledge/customers/c.yaml'], 'changed after: waits');
  // A supplier's file new by hand still waits, as before.
  sw.approve(booking());
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'b.yaml'), 'id: b\n');
  assert.deepEqual(sw.pending(booking())?.files, ['knowledge/suppliers/b.yaml']);
});

/** A booking record as written before #413: the supplier's file switched on, no `cited`. */
function oldBookingRecord(prefix: string) {
  const ws = tempWorkspace(prefix);
  const booking = () => loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((w) => w.id === 'booking')!;
  mkdirSync(join(ws.paths.root, 'knowledge', 'suppliers'), { recursive: true });
  mkdirSync(join(ws.paths.root, 'knowledge', 'customers'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'a.yaml'), 'id: a\n');
  const sw = openSwitch(ws);
  sw.approve(booking());
  const path = approvalsPath(ws);
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  delete rec.booking.cited;
  writeFileSync(path, JSON.stringify(rec));
  return { ws, sw, booking, path };
}

test('#413: an old record is migrated at its first check; a customer\'s file written any time after it waits and is listed', () => {
  const { ws, sw, booking, path } = oldBookingRecord('switch-413b-');
  assert.equal(sw.pending(booking()), undefined, 'no customer file at the update');
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).booking.cited.includes('knowledge/customers'), 'migrated at the first check, though nothing changed');
  writeFileSync(join(ws.paths.root, 'knowledge', 'customers', 'new.yaml'), 'id: new\n');
  assert.deepEqual(sw.pending(booking())?.files, ['knowledge/customers/new.yaml'], 'a customer file written later waits');
});

test('#413: an old record with a supplier\'s change waiting, then a customer\'s file by hand: both are listed, and neither is taken as seen', () => {
  const { ws, sw, booking } = oldBookingRecord('switch-413c-');
  writeFileSync(join(ws.paths.root, 'knowledge', 'suppliers', 'a.yaml'), 'id: a\nname: A\n');
  assert.deepEqual(sw.pending(booking())?.files, ['knowledge/suppliers/a.yaml']);
  writeFileSync(join(ws.paths.root, 'knowledge', 'customers', 'studer.yaml'), 'id: studer\n');
  assert.deepEqual(sw.pending(booking())?.files, ['knowledge/customers/studer.yaml', 'knowledge/suppliers/a.yaml']);
});
