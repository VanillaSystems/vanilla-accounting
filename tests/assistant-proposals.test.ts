/**
 * The model hears what became of its earlier proposals from code, not from its own memory (#362,
 * first-ai-25: after «Behalten» on the Swisscom rule it said «Meine Swisscom-Regel von vorhin ist
 * noch nicht behalten»). On the real API server with the claude stub: an answer drafts a rule (its
 * Write tool), the person keeps it on its card, and the next message's prompt says it is kept and
 * lists no open proposal; a discarded draft is said discarded; a draft still waiting is said so.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import type { AssistantEvent } from '../src/types/assistant.js';

const REPO = process.cwd();
const log = mkdtempSync(join(tmpdir(), 'assistant-proposals-'));
const PROMPTS = join(log, 'prompts.txt');
const TOOLS = join(log, 'tools.json');
const RULES = 'knowledge/rules/booking.guide.yaml';
const RULE = 'process: booking\nsteps:\n  classify:\n    rules:\n      - { id: swisscom-telefon, when: { text: "Swisscom", direction: out }, then: { account: "6570", vat: 81 }, source: wish 2026-11-12, why: "Swisscom immer auf Telefon" }\n';

let api: ApiServer;
before(async () => {
  api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_PROMPTS: PROMPTS, CLAUDE_STUB_TOOLS: TOOLS });
});
after(() => { api?.stop(); rmSync(log, { recursive: true, force: true }); });

/** The answer drafts `drafted` (the stub reports a Write of each; the file is written as the model would). */
async function say(text: string, conversation?: string, drafted: string[] = []): Promise<{ id: string; prompt: string }> {
  for (const path of drafted) {
    const file = join(api.ws.paths.data, 'draft', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, RULE);
  }
  writeFileSync(TOOLS, JSON.stringify(drafted.map((p) => ({ name: 'Write', input: { file_path: join(realpathSync(api.ws.paths.root), 'data', 'draft', p) } }))));
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

test('a kept rule reaches the next message as kept, and no proposal is listed as open', async () => {
  const first = await say('Swisscom immer auf Telefon buchen', undefined, [RULES]);
  assert.doesNotMatch(first.prompt, /What became of the proposals/, 'the first message has nothing earlier to report');

  const waiting = await say('und jetzt?', first.id);
  assert.match(waiting.prompt, /What became of the proposals of your earlier answers/);
  assert.match(waiting.prompt, new RegExp(`Your answer 1: the rule you drafted in ${RULES} is still a draft`), 'a draft not decided yet is said so');

  await keep();
  assert.ok(existsSync(join(api.ws.paths.root, RULES)), 'the rule stands');
  const after = await say('was muss ich jetzt no mache?', first.id);
  assert.match(after.prompt, new RegExp(`Your answer 1: the rule you drafted in ${RULES} is KEPT: the person pressed «Behalten»`));
  assert.doesNotMatch(after.prompt, /still a draft|not decided yet/, 'no proposal is listed as open');
  assert.ok(after.prompt.indexOf('What became of the proposals') < after.prompt.indexOf('Where the oldest period not filed stands'), 'the state comes before the open work');
});

test('a discarded rule reaches the next message as discarded', async () => {
  const first = await say('Swisscom immer auf Telefon buchen', undefined, [RULES]);
  assert.equal((await api.send('POST', '/api/rules/draft', { kind: 'discard', path: RULES })).json.ok, true);
  const next = await say('was muss ich jetzt no mache?', first.id);
  assert.match(next.prompt, new RegExp(`Your answer 1: the rule you drafted in ${RULES} is DISCARDED: the person pressed «Verwerfen»`), 'discarded, though the file of the rule kept earlier stands');
});
