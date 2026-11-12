/**
 * A task about a payment names it everywhere a task is shown (#365): the server gives the task its
 * payment, and the corner shows the tasks of one step as one line once there are GROUP_FROM of
 * them («11 Zahlungen von Hand buchen»), with the list behind it under Aufgaben.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { GROUP_FROM, taskGroups, type Task, type TaskDecl } from '../src/workflows/model.js';
import { manyText, paymentWords } from '../src/app/areas/automation/task-words.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { companyPart, openSwitch } from '../src/workflows/switch-on.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const decl = (loadWorkflows(APP_ROOT, APP_ROOT).workflows.find((w) => w.id === 'ask')!.steps.find((s) => s.id === 'byHand')!.body as { task: TaskDecl }).task;
const task = (run: string, over: Partial<Task> = {}): Task => ({
  run, workflow: 'ask', step: 'byHand', item: { kind: 'transaction', id: run }, title: decl.title, many: decl.many, since: '2026-11-12T20:00:00Z', outcomes: ['booked'],
  payment: { counterparty: 'Marco Rossi', description: 'Lohn Juli 2026', amount: 5200, currency: 'CHF', date: '2026-07-25', direction: 'DBIT' }, ...over,
});

test('the hand-booking task names its payment: who, how much (out with its minus), when', () => {
  assert.equal(decl.title.de, 'Zahlung von Hand buchen');
  assert.match(paymentWords(task('a')), /^Marco Rossi, CHF -5.200\.00, 25\.07\.2026$/);
  assert.match(paymentWords(task('b', { payment: { description: 'Gutschrift Familie Keller', amount: 4860, currency: 'CHF', date: '2026-07-02', direction: 'CRDT' } })), /^Familie Keller, CHF 4.860\.00, 02\.07\.2026$/);
  assert.equal(paymentWords(task('c', { payment: undefined })), '');
});

test(`from ${GROUP_FROM} tasks of one step on, the corner shows one line «n Zahlungen von Hand buchen»; fewer stay one line each`, () => {
  assert.deepEqual(taskGroups([task('a'), task('b')]).map((l) => l.kind), ['one', 'one']);
  const other = task('x', { workflow: 'vat', step: 'review', many: undefined, payment: undefined });
  const eleven = taskGroups([other, ...Array.from({ length: 11 }, (_, i) => task(`p${i}`))]);
  assert.deepEqual(eleven.map((l) => l.kind), ['one', 'many']);
  const g = eleven[1] as Extract<(typeof eleven)[number], { kind: 'many' }>;
  assert.equal(g.tasks.length, 11);
  assert.equal(manyText(g.many, g.tasks.length, 'de'), '11 Zahlungen von Hand buchen');
  assert.equal(manyText(g.many, g.tasks.length, 'fr'), 'Comptabiliser 11 paiements à la main');
});

test('the four languages say the title and the group', () => {
  assert.deepEqual(Object.keys(decl.title).sort(), ['de', 'en', 'fr', 'it']);
  assert.deepEqual(Object.keys(decl.many!).sort(), ['de', 'en', 'fr', 'it']);
  for (const v of Object.values(decl.many!)) assert.match(v, /\{n\}/);
});

test('the app\'s own step.yaml is no company part: changing its title makes no install wait for «Einschalten»', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-'));
  const ask = loadWorkflows(APP_ROOT, root).workflows.find((w) => w.id === 'ask')!;
  assert.equal(companyPart(ask, root), undefined, 'only the workspace\'s overlay and the guides its AI steps cite are approved');
  assert.equal(openSwitch({ paths: { root } } as never).pending(ask), undefined);
});
