/**
 * The model hears what became of each rule its earlier answers drafted, rule by rule, from code
 * (#362, first-ai-25: after «Behalten» on the Swisscom rule it said «Meine Swisscom-Regel von vorhin
 * ist noch nicht behalten»). Every rule without a business shares knowledge/rules/booking.guide.yaml,
 * so the state is the rule's, never the file's: another draft of the same file open, discarded or
 * drafted later changes nothing about a rule kept; a rule switched off or removed since says so; a
 * draft the app has no record of is unknown, never guessed. On the real API server with the claude stub.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import type { AssistantEvent, Turn } from '../src/types/assistant.js';
import { PROPOSALS_TOLD, proposalsNote } from '../src/assistant/proposals.js';
import type { Workspace } from '../src/workspace/workspace.js';

const REPO = process.cwd();
const log = mkdtempSync(join(tmpdir(), 'assistant-proposals-'));
const PROMPTS = join(log, 'prompts.txt');
const TOOLS = join(log, 'tools.json');
const RULES = 'knowledge/rules/booking.guide.yaml';
const A = '      - { id: swisscom-telefon, when: { text: "Swisscom", direction: out }, then: { account: "6570", vat: 81 }, source: wish 2026-11-12, why: "Swisscom immer auf Telefon" }\n';
const B = '      - { id: post-porto, when: { text: "Post CH", direction: out }, then: { account: "6570", vat: 81 }, source: wish 2026-11-12, why: "Post immer auf Porto" }\n';
const file = (...rules: string[]) => `process: booking\nsteps:\n  classify:\n    rules:\n${rules.join('')}`;

let api: ApiServer;
before(async () => {
  api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_PROMPTS: PROMPTS, CLAUDE_STUB_TOOLS: TOOLS });
});
after(() => { api?.stop(); rmSync(log, { recursive: true, force: true }); });

/** One message; its answer drafts `draft` as the whole new text of the rules file (the stub reports the Write). */
async function say(text: string, conversation?: string, draft?: string): Promise<{ id: string; prompt: string }> {
  if (draft !== undefined) {
    const path = join(api.ws.paths.data, 'draft', RULES);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, draft);
  }
  writeFileSync(TOOLS, JSON.stringify(draft === undefined ? [] : [{ name: 'Write', input: { file_path: join(realpathSync(api.ws.paths.root), 'data', 'draft', RULES) } }]));
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ text, language: 'de', context: [], ...(conversation ? { conversation } : {}) }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const prompts = readFileSync(PROMPTS, 'utf8').split('\n\0\n').filter((p) => p.trim());
  return { id: (events[0] as { id: string }).id, prompt: prompts.at(-1)! };
}

const keep = async () => {
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(RULES)}`)).json as unknown as { basis: string; confirm: boolean };
  const r = await api.send('POST', '/api/rules/draft', { kind: 'keep', path: RULES, basis: card.basis, confirm: card.confirm });
  assert.equal(r.json.ok, true, String(r.json.message));
};
const discard = async () => assert.equal((await api.send('POST', '/api/rules/draft', { kind: 'discard', path: RULES })).json.ok, true);
const command = async (kind: 'off' | 'delete') => assert.equal((await api.send('POST', '/api/rules', { kind, file: RULES, step: 'booking.guide.yaml#classify', id: 'swisscom-telefon' })).json.ok, true);
const lineOf = (prompt: string, n: number, id: string) => prompt.split('\n').find((l) => l.startsWith(`- Your answer ${n}: the rule ${id} `)) ?? '';

test('each rule keeps its own state while other drafts of the same file come and go, and a removal or a switch-off since is said', async () => {
  const first = await say('Swisscom immer auf Telefon buchen', undefined, file(A));
  assert.doesNotMatch(first.prompt, /What became of the proposals/, 'nothing earlier to report');

  const waiting = await say('und jetzt?', first.id);
  assert.match(lineOf(waiting.prompt, 1, 'swisscom-telefon'), /still a draft/);

  await keep();
  const kept = await say('was muss ich jetzt no mache?', first.id);
  assert.match(lineOf(kept.prompt, 1, 'swisscom-telefon'), /is KEPT and in effect/);
  assert.doesNotMatch(kept.prompt, /still a draft/, 'no proposal is listed as open');
  assert.ok(kept.prompt.indexOf('What became of the proposals') < kept.prompt.indexOf('Where the oldest period not filed stands'), 'the state comes before the open work');

  // A later answer drafts another rule into the same shared file: A stays kept while B waits.
  const later = await say('Post immer auf Porto', first.id, file(A, B));
  assert.match(lineOf(later.prompt, 1, 'swisscom-telefon'), /is KEPT and in effect/);
  const open = await say('und?', first.id);
  assert.match(lineOf(open.prompt, 1, 'swisscom-telefon'), /is KEPT and in effect/, 'another draft of the file open: A is still kept');
  assert.match(lineOf(open.prompt, 4, 'post-porto'), /still a draft/);

  await discard();
  const gone = await say('und jetzt?', first.id);
  assert.match(lineOf(gone.prompt, 1, 'swisscom-telefon'), /is KEPT and in effect/, 'the other draft discarded: A is still kept');
  assert.match(lineOf(gone.prompt, 4, 'post-porto'), /is DISCARDED/);

  await command('off');
  const off = await say('und?', first.id);
  assert.match(lineOf(off.prompt, 1, 'swisscom-telefon'), /KEPT, but switched off since/);

  await command('delete');
  const removed = await say('und?', first.id);
  assert.match(lineOf(removed.prompt, 1, 'swisscom-telefon'), /KEPT, then removed since/);
  assert.ok(!existsSync(join(api.ws.paths.data, 'draft', RULES)));
});

test('the note tells the newest proposals one by one and the older ones as a count; a rule drafted again points to the later answer', () => {
  const ws = { paths: { root: log, data: join(log, 'data') } } as Pick<Workspace, 'paths'>;
  const answer = (id: string): Turn => ({ role: 'ai', text: '', at: '2026-11-12T10:00:00Z', tools: [], done: true, drafted: [{ path: RULES, section: 'classify', id, change: 'added' }] });
  const turns = Array.from({ length: PROPOSALS_TOLD + 3 }, (_, i) => answer(i === PROPOSALS_TOLD + 2 ? 'r0' : `r${i}`));
  const note = proposalsNote(ws, { turns });
  assert.equal(note.split('\n').filter((l) => l.startsWith('- Your answer')).length, PROPOSALS_TOLD);
  assert.match(note, /- 3 older proposals are not listed/);
  assert.match(proposalsNote(ws, { turns: [answer('r0'), answer('r0')] }), /Your answer 1: the rule r0 [^\n]*drafted again by a later answer/);
});

test('a draft gone without a record is unknown, never guessed, and the list does not claim to be the truth about it', async () => {
  const first = await say('Swisscom immer auf Telefon buchen', undefined, file(A));
  rmSync(join(api.ws.paths.data, 'draft', RULES));
  const next = await say('und?', first.id);
  assert.match(lineOf(next.prompt, 1, 'swisscom-telefon'), /UNKNOWN/);
  assert.match(next.prompt, /where it says UNKNOWN, read the file/);
});
