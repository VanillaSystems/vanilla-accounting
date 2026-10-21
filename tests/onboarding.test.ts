/**
 * The setup as a conversation (docs/0.4.0/onboarding.md): the checklist the code owns, kept in the
 * workspace's onboarding.json; the AI's `setupTopic` change and its undo; the person's routes; and
 * the prompt that makes the AI the setup specialist. Each test names the wrong behaviour it catches.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETUP_TOPICS, emptyProgress, markedStates, nextTopic, parseProgress, settledCount, withTopic } from '../src/onboarding/model.js';
import { ONBOARDING_FILE, markTopic, readProgress, rememberConversation, setupView, startSetup } from '../src/onboarding/store.js';
import { setupSpecialist } from '../src/onboarding/prompt.js';
import { changesIn, ChangesError } from '../src/assistant/changes.js';
import { applyWorkspaceChange } from '../src/server/workspace-edits.js';
import { assistantSystem } from '../src/assistant/claude.js';
import { wordsIn } from '../src/export/texts.js';
import { workspaceAt, LAYOUT } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { KEPT_CONVERSATION, KEPT_PURPOSE, startThread } from '../src/app/assistant/thread.js';

const NOW = '2026-10-21T09:00:00.000Z';
const empty = { transactions: [], receipts: [], journalEntries: [] };
const block = (changes: unknown[]) => `Erledigt.\n\`\`\`vanilla-changes\n${JSON.stringify(changes)}\n\`\`\``;

test('a checklist on disk keeps what it knows and drops a topic or state it does not, instead of failing to open', () => {
  const p = parseProgress({ started: NOW, conversation: 'c1', topics: { firm: { state: 'done', at: NOW }, bank: { state: 'finished' }, payroll: { state: 'done' }, opening: { state: 'open', at: NOW } } });
  assert.equal(p.topics.firm.state, 'done');
  assert.equal(p.topics.bank.state, 'open', 'an unknown state reads as open');
  assert.equal(p.topics.opening.at, undefined, 'an open topic carries no date');
  assert.ok(!('payroll' in p.topics), 'a topic of another version is not taken in');
  assert.deepEqual(Object.keys(p.topics), [...SETUP_TOPICS]);
  assert.equal(p.conversation, 'c1');
  assert.deepEqual(parseProgress('nonsense'), emptyProgress());
});

test('the next topic is the first open one in the checklist order, and skipped topics count as settled', () => {
  let p = emptyProgress();
  assert.equal(nextTopic(markedStates(p)), 'firm');
  p = withTopic(p, 'firm', 'done', NOW);
  p = withTopic(p, 'periods', 'skipped', NOW);
  assert.equal(nextTopic(markedStates(p)), 'history', 'the old program comes before the opening, whose balance sheet it holds');
  assert.equal(settledCount(markedStates(p)), 2);
  p = withTopic(p, 'periods', 'open', NOW);
  assert.equal(nextTopic(markedStates(p)), 'periods', 'a topic taken up again is next once more');
  assert.equal(p.topics.periods.at, undefined);
  for (const k of SETUP_TOPICS) p = withTopic(p, k, 'done', NOW);
  assert.equal(nextTopic(markedStates(p)), undefined);
});

test('an empty workspace opens the setup once: after it started, the first start is over and progress survives a restart', () => {
  const ws = tempWorkspace('onboarding-');
  assert.equal(setupView(ws, empty).firstStart, true);
  assert.equal(setupView(ws, { ...empty, transactions: [{}] as never }).firstStart, false, 'books in use before the setup existed never open it by themselves');
  startSetup(ws, NOW);
  assert.ok(existsSync(join(ws.paths.root, ONBOARDING_FILE)));
  assert.equal(setupView(ws, empty).firstStart, false);
  assert.equal(startSetup(ws, '2027-01-01T00:00:00.000Z').started, NOW, 'starting again keeps the first start date');

  assert.deepEqual(markTopic(ws, 'bank', 'done', NOW).was, 'open');
  rememberConversation(ws, 'conv-1', NOW);
  const again = readProgress(workspaceAt(ws.paths.root));
  assert.equal(again.topics.bank.state, 'done');
  assert.equal(again.topics.bank.at, NOW);
  assert.equal(again.conversation, 'conv-1');
  const before = readFileSync(join(ws.paths.root, ONBOARDING_FILE), 'utf8');
  assert.equal(markTopic(ws, 'bank', 'done', '2027-01-01T00:00:00.000Z').was, 'done');
  assert.equal(readFileSync(join(ws.paths.root, ONBOARDING_FILE), 'utf8'), before, 'marking a topic as it is writes nothing (its date stays)');
  assert.equal(LAYOUT.top['onboarding.json'], 'app', 'the file is one of the workspace layout\'s names, so doctor does not call it foreign');
});

test('a broken onboarding.json reads as a fresh checklist instead of breaking the app', () => {
  const ws = tempWorkspace('onboarding-');
  writeFileSync(join(ws.paths.root, ONBOARDING_FILE), '{ not json');
  assert.deepEqual(readProgress(ws), emptyProgress());
});

test('the AI marks a topic only with a checked change, and its undo puts back the state it had', () => {
  assert.deepEqual(changesIn(block([{ kind: 'setupTopic', topic: 'receipts', state: 'skipped' }])), [{ kind: 'setupTopic', topic: 'receipts', state: 'skipped' }]);
  assert.throws(() => changesIn(block([{ kind: 'setupTopic', topic: 'payroll', state: 'done' }])), ChangesError, 'a topic the checklist does not have');
  assert.throws(() => changesIn(block([{ kind: 'setupTopic', topic: 'bank', state: 'finished' }])), ChangesError, 'a state the checklist does not have');

  const ws = tempWorkspace('onboarding-');
  markTopic(ws, 'firm', 'skipped', NOW);
  const applied = applyWorkspaceChange(ws, { journalEntries: [] } as never, { kind: 'setupTopic', topic: 'firm', state: 'done' });
  assert.equal(readProgress(ws).topics.firm.state, 'done');
  assert.deepEqual(applied.undo, { kind: 'setupTopic', topic: 'firm', state: 'skipped' });
  applyWorkspaceChange(ws, { journalEntries: [] } as never, applied.undo!);
  assert.equal(readProgress(ws).topics.firm.state, 'skipped');
});

test('the specialist section names every topic and the change that records it, and is part of the system prompt', () => {
  const { t } = wordsIn('de');
  const section = setupSpecialist(t);
  for (const k of SETUP_TOPICS) assert.match(section, new RegExp(`\\b${k} \\(`), `topic ${k} is explained`);
  assert.match(section, /"kind":"setupTopic"/);
  assert.match(section, /History is evidence, not knowledge/);
  assert.match(section, /never write/, 'the company\'s settings stay the person\'s');
  assert.ok(assistantSystem('de', '2850', '').includes(section));
});

test('the setup opened but not yet started stays the setup across a reload of the window; a sent conversation takes its purpose from the server', () => {
  const kept = (m: Record<string, string>) => (k: string) => m[k] ?? null;
  assert.deepEqual(startThread(kept({ [KEPT_PURPOSE]: 'onboarding' })), { purpose: 'onboarding', pageOff: true });
  assert.deepEqual(startThread(kept({ [KEPT_PURPOSE]: 'something-else' })), {}, 'an unknown purpose is not taken');
  assert.deepEqual(startThread(kept({ [KEPT_CONVERSATION]: 'c1', [KEPT_PURPOSE]: 'onboarding' })), { conversation: 'c1' });
});

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/fresh-books-index.json'); });
after(async () => { await api?.stop(); });

test('the API: an empty workspace\'s first start, start once, a topic marked by the person and kept on disk; unknown topics and states refused', async () => {
  let r = await api.send('GET', '/api/onboarding');
  assert.equal(r.status, 200);
  assert.equal(r.json.firstStart, true);
  r = await api.send('POST', '/api/onboarding/start');
  assert.equal(r.json.firstStart, false);
  r = await api.send('PUT', '/api/onboarding/topics/bank', { state: 'done' });
  assert.equal(r.status, 200);
  assert.equal((r.json.progress as { topics: Record<string, { state: string }> }).topics.bank.state, 'done');
  assert.equal(readProgress(api.ws).topics.bank.state, 'done', 'written to the workspace');
  assert.equal((await api.send('PUT', '/api/onboarding/topics/payroll', { state: 'done' })).status, 404);
  assert.equal((await api.send('PUT', '/api/onboarding/topics/bank', { state: 'finished' })).status, 400);
  assert.equal((await api.send('PUT', '/api/onboarding/topics/bank', { state: 'done', by: 'ai' })).status, 400, 'only the state');
  assert.equal(readProgress(api.ws).topics.bank.state, 'done');
});
