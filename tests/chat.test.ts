/**
 * The chat composer: its state machine (src/app/shell/chat/model.ts), the "/" menu's jobs from
 * processes/*.flow.yaml, the message and arguments for the claude CLI, the stream-json parser, and
 * the routes end to end with the claude stub (tests/support/stub-bin/claude).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canSend, chatReducer, initialChat, skillQuery, type ChatAction, type ChatState } from '../src/app/shell/chat/model.js';
import { chatSkills } from '../src/chat/skills.js';
import { chatArgs, chatPrompt, streamParser } from '../src/chat/claude.js';
import { messages as de } from '../src/app/i18n/locales/de.js';
import type { ChatEvent } from '../src/types/chat.js';
import { startApi, type ApiServer } from './support/api-server.js';

const CONV = '0b5e3a2c-1d4f-4e6a-9b7c-8d9e0f1a2b3c';
const run = (actions: ChatAction[], from: ChatState = initialChat(CONV)) => actions.reduce(chatReducer, from);

test('the microphone: idle → recording → transcribing → idle, the transcript added to the draft', () => {
  let s = run([{ type: 'draft', text: 'Bitte' }, { type: 'record' }]);
  assert.equal(s.phase.kind, 'recording');
  s = run([{ type: 'accept' }, { type: 'progress', loaded: 25, total: 100 }], s);
  assert.deepEqual(s.phase, { kind: 'transcribing', progress: 0.25 });
  s = run([{ type: 'transcribed', text: ' buche die Rechnung. ' }], s);
  assert.deepEqual([s.phase.kind, s.draft], ['idle', 'Bitte buche die Rechnung.']);
});

test('discarding a recording keeps the draft; a failure returns to idle and says why', () => {
  assert.deepEqual(run([{ type: 'draft', text: 'x' }, { type: 'record' }, { type: 'discard' }]).draft, 'x');
  const failed = run([{ type: 'record' }, { type: 'failed', message: 'Kein Mikrofon' }]);
  assert.deepEqual([failed.phase.kind, failed.error], ['idle', 'Kein Mikrofon']);
  assert.equal(run([{ type: 'record' }, { type: 'accept' }, { type: 'failed', message: 'nope' }]).phase.kind, 'idle');
});

test('one thing at a time: no recording while busy, no send while recording or transcribing', () => {
  const recording = run([{ type: 'draft', text: 'Frage' }, { type: 'record' }]);
  assert.equal(run([{ type: 'send' }], recording), recording);
  const transcribing = run([{ type: 'accept' }], recording);
  assert.equal(run([{ type: 'send' }, { type: 'record' }], transcribing), transcribing);
  const sending = run([{ type: 'draft', text: 'Frage' }, { type: 'send' }]);
  assert.equal(run([{ type: 'record' }, { type: 'draft', text: 'anders' }, { type: 'fresh', conversation: 'other' }], sending), sending);
});

test('Enter sends only something, and not before every attached file is stored', () => {
  assert.equal(canSend(initialChat(CONV)), false);
  assert.equal(canSend(run([{ type: 'draft', text: '   ' }])), false);
  const attached = run([{ type: 'attach', files: [{ id: 'f1', name: 'rechnung.pdf' }] }]);
  assert.equal(canSend(attached), false);
  assert.equal(canSend(run([{ type: 'stored', id: 'f1', path: `data/chat/${CONV}/rechnung.pdf` }], attached)), true);
  assert.equal(canSend(run([{ type: 'skill', id: 'receipt-intake' }])), true);
});

test('sending moves the draft into the conversation and streams the answer into its turn', () => {
  let s = run([
    { type: 'attach', files: [{ id: 'f1', name: 'a.pdf' }, { id: 'f2', name: 'b.pdf' }] },
    { type: 'stored', id: 'f1', path: `data/chat/${CONV}/a.pdf` },
    { type: 'storeFailed', id: 'f2' },
    { type: 'draft', text: 'Was ist das?' },
    { type: 'send' },
  ]);
  assert.deepEqual([s.phase.kind, s.draft, s.files], ['sending', '', []]);
  assert.deepEqual(s.turns[0], { role: 'user', text: 'Was ist das?', files: ['a.pdf'] });
  const events: ChatEvent[] = [
    { type: 'session', session: 's1' },
    { type: 'tool', name: 'Read', detail: `data/chat/${CONV}/a.pdf` },
    { type: 'text', text: 'Eine ' },
    { type: 'text', text: 'Rechnung.' },
    { type: 'done', isError: false, session: 's2' },
  ];
  s = run(events.map((event) => ({ type: 'event', event })), s);
  assert.equal(s.phase.kind, 'idle');
  assert.equal(s.session, 's2');
  assert.deepEqual(s.turns[1], { role: 'assistant', text: 'Eine Rechnung.', tools: [{ name: 'Read', detail: `data/chat/${CONV}/a.pdf` }], done: true });
  const fresh = run([{ type: 'draft', text: 'weiter' }, { type: 'fresh', conversation: 'next' }], s);
  assert.deepEqual([fresh.conversation, fresh.session, fresh.turns, fresh.draft], ['next', undefined, [], 'weiter']);
});

test('an error or a stop ends the turn and frees the composer', () => {
  const sending = run([{ type: 'draft', text: 'x' }, { type: 'send' }]);
  const failed = run([{ type: 'event', event: { type: 'error', message: 'claude exited 1' } }], sending);
  assert.equal(failed.phase.kind, 'idle');
  assert.equal((failed.turns[1] as { error?: string }).error, 'claude exited 1');
  assert.equal(run([{ type: 'stop' }], sending).phase.kind, 'idle');
});

test('"/" opens the jobs menu until a job is chosen, which replaces the typed "/…"', () => {
  assert.equal(skillQuery(run([{ type: 'draft', text: '/' }])), '');
  assert.equal(skillQuery(run([{ type: 'draft', text: '/eing' }])), 'eing');
  assert.equal(skillQuery(run([{ type: 'draft', text: 'a/b' }])), undefined);
  assert.equal(skillQuery(run([{ type: 'draft', text: '/eing tippen' }])), undefined);
  const chosen = run([{ type: 'draft', text: '/eing' }, { type: 'skill', id: 'receipt-intake' }]);
  assert.deepEqual([chosen.skill, chosen.draft, skillQuery(chosen)], ['receipt-intake', '', undefined]);
});

test('the jobs are the flows of processes/, in the order the quarter runs them, each named in the dictionary', () => {
  const skills = chatSkills();
  const flows = readdirSync('processes').filter((f) => f.endsWith('.flow.yaml')).map((f) => f.replace('.flow.yaml', '')).sort();
  assert.deepEqual(skills.map((s) => s.id).sort(), flows);
  assert.deepEqual(skills.slice(0, 8).map((s) => s.id),
    ['receipt-collection', 'receipt-intake', 'bank-import', 'evidence', 'booking', 'vat-filing', 'year-close', 'quarter-close']);
  for (const s of skills) {
    assert.ok(s.name && s.line, `${s.id} has a name and a discharge`);
    assert.ok(`chat.skill.${s.id}` in de && `chat.skill.${s.id}.line` in de, `chat.skill.${s.id}(.line) in locales/de.ts`);
  }
});

test('the message names the job\'s flow and lists each attached file by its path in the workspace', () => {
  const prompt = chatPrompt({ text: ' Bitte verarbeiten ', skill: 'receipt-intake', files: [`data/chat/${CONV}/a.pdf`, `data/chat/${CONV}/b b.png`] }, chatSkills());
  assert.match(prompt, /^Job: Archive receipts\. Follow \S+\/processes\/receipt-intake\.flow\.yaml\.\n\nBitte verarbeiten\n\nAttached files \(read them with the Read tool\):\n- data\/chat\/.+\/a\.pdf\n- data\/chat\/.+\/b b\.png$/);
  assert.equal(chatPrompt({ text: 'Hallo', files: [] }, []), 'Hallo');
});

test('the CLI streams, continues a session, edits only knowledge/ and answers in the app\'s language', () => {
  const first = chatArgs({ language: 'fr' });
  assert.ok(first.includes('stream-json') && first.includes('--include-partial-messages'));
  assert.ok(!first.includes('--resume'));
  assert.match(first[first.indexOf('--append-system-prompt') + 1], /Answer in French/);
  const allowed = first.slice(first.indexOf('--allowedTools') + 1).filter((a) => !a.startsWith('--'));
  assert.deepEqual(allowed.filter((a) => /^(Edit|Write)/.test(a)), ['Edit(knowledge/**)', 'Write(knowledge/**)']);
  assert.ok(allowed.every((a) => !a.startsWith('Bash') || /^Bash\(npm --prefix .+ run \*\)$/.test(a)), allowed.join(' '));
  const next = chatArgs({ language: 'de', session: 's1' });
  assert.deepEqual(next.slice(next.indexOf('--resume'), next.indexOf('--resume') + 2), ['--resume', 's1']);
});

/** Lines as Claude Code 2.1 writes them with --include-partial-messages (shapes of a real run, trimmed). */
const REAL = [
  { type: 'system', subtype: 'init', cwd: '/ws', session_id: 'abc' },
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read' } } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/ws/knowledge/a.txt' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/private/ws/books.json', old_string: '{}', new_string: '{"a":1}' } }] } },
  { type: 'system', subtype: 'permission_denied', tool_name: 'Edit', tool_use_id: 't2', message: 'Claude requested permissions to write …' },
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Erledigt' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ', bis auf books.json.' } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Erledigt, bis auf books.json.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Erledigt, bis auf books.json.', session_id: 'abd' },
].map((l) => JSON.stringify(l));

test('stream-json: the session, each tool with its file in the workspace, a refused edit, the text once, the end', () => {
  const parse = streamParser(['/ws', '/private/ws']);
  assert.deepEqual([...REAL, 'not json', ''].flatMap(parse), [
    { type: 'session', session: 'abc' },
    { type: 'tool', name: 'Read', detail: 'knowledge/a.txt' },
    { type: 'tool', name: 'Edit', detail: 'books.json' },
    { type: 'tool', name: 'Edit', detail: 'books.json', denied: true },
    { type: 'text', text: 'Erledigt' },
    { type: 'text', text: ', bis auf books.json.' },
    { type: 'done', isError: false, session: 'abd' },
  ]);
});

test('stream-json: text without partial messages comes whole; text after a tool is set apart; a failed run says why', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Ich lese.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Grep', input: { pattern: 'Swisscom' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Gefunden.' }] } },
    { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's' },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(lines.flatMap(streamParser(['/ws'])), [
    { type: 'text', text: 'Ich lese.' },
    { type: 'tool', name: 'Grep', detail: 'Swisscom' },
    { type: 'text', text: '\n\nGefunden.' },
    { type: 'error', message: 'error_max_turns' },
    { type: 'done', isError: true, session: 's' },
  ]);
});

describeRoutes();

function describeRoutes(): void {
  let api: ApiServer;
  let scratch = '';
  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-routes-'));
    api = await startApi('tests/fixtures/classify-index.json', {
      PATH: `${join(process.cwd(), 'tests/support/stub-bin')}:${process.env.PATH}`,
      CLAUDE_STUB_ARGS: join(scratch, 'args.jsonl'), CLAUDE_STUB_PROMPTS: join(scratch, 'prompts.txt'),
    });
  });
  after(() => { api?.stop(); rmSync(scratch, { recursive: true, force: true }); });

  const base = () => `http://127.0.0.1:${api.port}`;
  async function chat(body: unknown): Promise<{ status: number; events: ChatEvent[] }> {
    const res = await fetch(`${base()}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, events: res.ok ? text.trim().split('\n').map((l) => JSON.parse(l) as ChatEvent) : [] };
  }

  test('POST /api/chat/files keeps the file under data/chat/<conversation>/, a second of the name beside it', async () => {
    const post = (name: string) => fetch(`${base()}/api/chat/files?conversation=${CONV}&name=${encodeURIComponent(name)}`, { method: 'POST', body: 'PDF' });
    const first = await (await post('../../books.json')).json() as { path: string };
    const second = await (await post('books.json')).json() as { path: string };
    assert.deepEqual([first.path, second.path], [`data/chat/${CONV}/books.json`, `data/chat/${CONV}/books-2.json`]);
    assert.equal(readFileSync(join(api.root, second.path), 'utf8'), 'PDF');
    assert.equal((await fetch(`${base()}/api/chat/files?conversation=nope&name=a`, { method: 'POST', body: 'x' })).status, 400);
  });

  test('POST /api/chat streams the answer, runs in the workspace and continues its session', async () => {
    const file = `data/chat/${CONV}/books.json`;
    const first = await chat({ conversation: CONV, text: 'Was ist das?', files: [file], language: 'de' });
    assert.equal(first.status, 200);
    const session = (first.events[0] as { session: string }).session;
    assert.deepEqual(first.events.filter((e) => e.type === 'tool'), [{ type: 'tool', name: 'Read', detail: file }]);
    assert.equal(first.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''),
      'Stub-Antwort auf «Was ist das?». Eine neue Unterhaltung.');
    assert.deepEqual(first.events.at(-1), { type: 'done', isError: false, session });

    const second = await chat({ conversation: CONV, session, text: 'Und weiter?', files: [], language: 'de' });
    assert.match(second.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), /geht weiter/);
    const args = readFileSync(join(scratch, 'args.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(args.at(-1)!.slice(args.at(-1)!.indexOf('--resume'), args.at(-1)!.indexOf('--resume') + 2), ['--resume', session]);
    const ledger = readFileSync(join(api.root, 'data/llm-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { step: string });
    assert.deepEqual(ledger.map((r) => r.step), ['chat', 'chat']);
  });

  test('POST /api/chat refuses an empty message and files outside the conversation\'s folder', async () => {
    assert.equal((await chat({ conversation: CONV, text: ' ', files: [] })).status, 400);
    assert.equal((await chat({ conversation: CONV, text: 'x', files: ['books.json'] })).status, 400);
    assert.equal((await chat({ conversation: CONV, text: 'x', files: [`data/chat/${CONV}/../../../books.json`] })).status, 400);
  });

  test('GET /api/chat/skills lists the flows', async () => {
    const skills = await (await fetch(`${base()}/api/chat/skills`)).json() as Array<{ id: string }>;
    assert.ok(skills.some((s) => s.id === 'quarter-close'));
  });
}
