/**
 * The workflow declarations (src/workflows/load.ts, model.ts): every app workflow loads strict and
 * speaks four languages, runnable follows the actions table, a company overlay changes only the
 * field it names, and the graph and the process map are derived the same way every time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { buttonsFor, graphOf, happyPath, hasAi, LANGUAGES, overdue, processMap, stepOf, type Run, type Text, type WorkflowDecl } from '../src/workflows/model.js';

const app = loadWorkflows(APP_ROOT);
const byId = (id: string, ws = app.workflows) => ws.find((w) => w.id === id)!;

test('every app workflow loads with no problem', () => {
  assert.deepEqual(app.problems, []);
  assert.deepEqual(app.workflows.map((w) => w.id).sort(), ['ask', 'bank-import', 'booking', 'collect', 'collection', 'correction', 'evidence', 'new-case', 'receipt-intake', 'vat-filing', 'year-close']);
});

test('every built action names every key it may hand on, so the step that uses it can emit each (#482)', () => {
  const silent = Object.entries(ACTIONS).filter(([, a]) => a.run && !a.emits).map(([id]) => id);
  assert.deepEqual(silent, []);
});

test('asking, booking, the inbox, the VAT filing, the year close and the collection run; every other workflow names the actions it still lacks', () => {
  const RUNS = ['ask', 'booking', 'receipt-intake', 'vat-filing', 'year-close', 'collection', 'collect'];
  for (const id of RUNS) assert.deepEqual(byId(id).runnable, { ok: true }, id);
  for (const w of app.workflows.filter((x) => !RUNS.includes(x.id))) {
    assert.equal(w.runnable.ok, false, `${w.id} should not be runnable yet`);
    if (!w.runnable.ok) assert.ok(w.runnable.missing.length > 0, w.id);
  }
});

test('every text of an app workflow is in de, en, fr and it', () => {
  const texts = (w: WorkflowDecl): Array<[string, Text]> => [
    ['label', w.label], ['desc', w.desc], ['cadence', w.cadence],
    ...w.triggers.flatMap((t): Array<[string, Text]> => (t.kind === 'manual' ? [['trigger', t.label]] : [])),
    ...w.steps.flatMap((s): Array<[string, Text]> => [[`${s.id}.label`, s.label], ...(s.body.kind === 'person' ? [[`${s.id}.task`, s.body.task.title] as [string, Text], ...(s.body.task.why ? [[`${s.id}.why`, s.body.task.why] as [string, Text]] : [])] : [])]),
  ];
  for (const w of app.workflows) for (const [where, t] of texts(w)) for (const l of LANGUAGES) assert.ok(t[l], `${w.id} ${where} has no ${l}`);
});

test('the kind of a step follows from its body: AI, person, call, effect, decision', () => {
  const b = byId('booking');
  assert.deepEqual(b.steps.map((s) => [s.id, s.kind]), [['open', 'decision'], ['classify', 'agent'], ['manual', 'human'], ['confirm', 'decision'], ['book', 'effect']]);
  assert.equal(stepOf(byId('collection'), 'collect')!.kind, 'call');
  assert.equal(stepOf(byId('evidence'), 'wait')!.kind, 'wait');
  assert.equal(hasAi(b, app.workflows), true);
  assert.equal(hasAi(byId('vat-filing'), app.workflows), false);
});

test('a company overlay changes only the field it names, and a workflow of its own loads beside the app\'s', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wf-overlay-'));
  mkdirSync(join(ws, 'workflows/booking/classify'), { recursive: true });
  writeFileSync(join(ws, 'workflows/booking/classify/step.yaml'), 'label: { en: Our classifier, de: Unser Klassierer }\n');
  mkdirSync(join(ws, 'workflows/remind/ask'), { recursive: true });
  writeFileSync(join(ws, 'workflows/remind/workflow.yaml'), 'label: Remind\nphase: book\nfor: company\nsteps: [ask]\n');
  writeFileSync(join(ws, 'workflows/remind/ask/step.yaml'), 'by: person\ntask: { title: Look at it }\noutcomes: { done: done }\n');
  const loaded = loadWorkflows(APP_ROOT, ws);
  assert.deepEqual(loaded.problems, []);
  const mine = byId('booking', loaded.workflows);
  const theirs = byId('booking');
  assert.equal(mine.origin, 'overlaid');
  assert.notEqual(mine.version, theirs.version);
  assert.deepEqual(stepOf(mine, 'classify')!.label, { ...stepOf(theirs, 'classify')!.label, en: 'Our classifier', de: 'Unser Klassierer' });
  assert.deepEqual({ ...stepOf(mine, 'classify')!, label: null }, { ...stepOf(theirs, 'classify')!, label: null }, 'nothing but the label changed');
  assert.equal(byId('remind', loaded.workflows).origin, 'company');
});

test('a company step\'s emits add to what its action hands on, never drop a key of it (#482)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wf-overlay-emits-'));
  mkdirSync(join(ws, 'workflows/booking/classify'), { recursive: true });
  writeFileSync(join(ws, 'workflows/booking/classify/step.yaml'), 'emits: ["entries", "why", "note"]\n');
  const loaded = loadWorkflows(APP_ROOT, ws);
  assert.deepEqual(loaded.problems, [], 'the workspace keeps booking');
  assert.deepEqual([...stepOf(byId('booking', loaded.workflows), 'classify')!.emits].sort(), ['entries', 'note', 'refused', 'why']);
});

test('a folder named like a page of Automatisierung is refused with the reason', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wf-reserved-'));
  mkdirSync(join(ws, 'workflows/queue/x'), { recursive: true });
  writeFileSync(join(ws, 'workflows/queue/workflow.yaml'), 'label: Q\nphase: book\nfor: company\nsteps: [x]\n');
  writeFileSync(join(ws, 'workflows/queue/x/step.yaml'), 'by: person\ntask: { title: X }\noutcomes: { done: done }\n');
  assert.match(loadWorkflows(APP_ROOT, ws).problems.find((p) => p.workflow === 'queue')!.message, /names a page of Automatisierung/);
});

test('the graph: one place per node, back edges marked, the same picture every time', () => {
  for (const w of app.workflows) {
    const g = graphOf(w);
    const places = g.nodes.map((n) => `${n.layer}:${n.row}`);
    assert.equal(new Set(places).size, places.length, `${w.id}: two nodes on one place`);
    assert.deepEqual(graphOf(w), g, `${w.id}: layout is not deterministic`);
  }
  const collect = graphOf(byId('collect'));
  assert.ok(collect.edges.some((e) => e.from === 'login' && e.to === 'pull' && e.back), 'login → pull goes back');
  const booking = graphOf(byId('booking'));
  assert.deepEqual(booking.nodes.filter((n) => n.layer === 0).map((n) => n.id), ['open']);
  assert.deepEqual(happyPath(byId('booking')), ['open', 'classify', 'book']);
});

test('the process map is read from the declarations: phases as columns, events and calls as arrows', () => {
  const map = processMap(app.workflows);
  assert.deepEqual(map.phases.map((p) => p.phase), ['collect', 'book', 'quarter', 'year']);
  assert.ok(map.phases.find((p) => p.phase === 'collect')!.workflows.includes('receipt-intake'));
  assert.deepEqual(map.arrows.filter((a) => a.from === 'evidence'), [{ from: 'evidence', to: 'booking', via: 'transaction.settled', off: true }]);
  assert.ok(map.arrows.some((a) => a.from === 'collection' && a.to === 'collect' && a.via === 'call'));
  assert.ok(map.arrows.some((a) => a.from === 'bank-import' && a.to === 'evidence' && a.off));
});

test('a manual trigger puts a button on its kind of object, marked when an AI decides in it', () => {
  const onTx = buttonsFor(app.workflows, 'transaction', ['unbooked']);
  assert.deepEqual(onTx.map((b) => [b.workflow.id, b.label.de, b.ai, b.runnable]), [['booking', 'Automatisch buchen', true, true]]);
  assert.deepEqual(buttonsFor(app.workflows, 'transaction', ['booked']), [], 'a booked payment shows no «Buchen»');
  assert.deepEqual(buttonsFor(app.workflows, 'year').map((b) => b.workflow.id), ['year-close']);
});

test('a run still open after its workflow\'s deadline is overdue; a finished one never', () => {
  const vat = byId('vat-filing');
  assert.equal(vat.deadline, 'P60D');
  const run = (state: Run['state']) => ({ startedAt: '2026-10-01T08:00:00.000Z', state } as Run);
  const waiting = run({ status: 'waiting', at: 'review', since: '2026-10-01T09:00:00.000Z' });
  assert.equal(overdue(waiting, vat, '2026-11-29T00:00:00.000Z'), false);
  assert.equal(overdue(waiting, vat, '2026-12-01T00:00:00.000Z'), true);
  assert.equal(overdue(run({ status: 'done', finishedAt: '2026-12-02T00:00:00.000Z' }), vat, '2026-12-03T00:00:00.000Z'), false);
  assert.equal(overdue(waiting, byId('booking'), '2027-12-01T00:00:00.000Z'), false, 'no deadline, never overdue');
});
