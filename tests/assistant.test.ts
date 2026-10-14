/**
 * The AI sidebar (src/assistant/): Fragen cannot write, Ändern writes only into the draft's copy of
 * the customizing (never the books, never in place, never the approvals), no settings are loaded
 * that could allow more, the stream parser keeps text and tools apart, and the route end to end
 * with the claude stub: a conversation is stored, continued by its session, and its context read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantArgs, draftPatterns, streamParser } from '../src/assistant/claude.js';
import type { AssistantEvent } from '../src/types/assistant.js';
import { startApi } from './support/api-server.js';

const REPO = process.cwd();
const listAfter = (args: string[], flag: string) => {
  const at = args.indexOf(flag);
  const end = args.findIndex((a, i) => i > at && a.startsWith('--'));
  return args.slice(at + 1, end < 0 ? undefined : end);
};

test('Fragen reads only: no Edit, Write or Bash, and no settings that could allow them', () => {
  const args = assistantArgs({ mode: 'ask', language: 'de' }, undefined, '/repo');
  assert.deepEqual(listAfter(args, '--allowedTools'), ['Read', 'Glob', 'Grep']);
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(listAfter(args, '--disallowedTools').includes(t), t);
  assert.deepEqual(listAfter(args, '--setting-sources'), ['']);
  assert.equal(args.includes('--resume'), false);
});

test('Ändern writes only into the draft, and only the customizing: never the books', () => {
  const args = assistantArgs({ mode: 'change', language: 'de' }, 's1', '/repo');
  const writes = listAfter(args, '--allowedTools').filter((t) => /^(Edit|Write)\(/.test(t));
  assert.ok(writes.length > 0);
  assert.ok(writes.every((t) => /^(Edit|Write)\(data\/draft\/[^)]+\)$/.test(t)), writes.join(' '));
  assert.ok(writes.some((t) => t === 'Edit(data/draft/knowledge/**)'));
  assert.ok(writes.some((t) => t === 'Write(data/draft/workflows/**)'));
  for (const p of draftPatterns()) assert.ok(!/transactional-data|ledger\.json|invoices\.json|data\/draft\/data/.test(p), p);
  assert.ok(listAfter(args, '--disallowedTools').includes('Bash'));
  assert.equal(listAfter(args, '--disallowedTools').includes('Edit'), false);
  assert.deepEqual(listAfter(args, '--resume'), ['s1']);
});

test('the stream parser gives the text in pieces, tools with their file, and refusals', () => {
  const parse = streamParser(['/ws']);
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ich lese ' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/ws/ledger.json' } }] } },
    { type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 't1' },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fertig.' } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's2' },
  ];
  const events = lines.flatMap((l) => parse(JSON.stringify(l)));
  assert.deepEqual(events, [
    { type: 'session', session: 's1' },
    { type: 'text', text: 'Ich lese ' },
    { type: 'tool', name: 'Write', detail: 'ledger.json' },
    { type: 'tool', name: 'Write', detail: 'ledger.json', denied: true },
    { type: 'text', text: '\n\n' },
    { type: 'text', text: 'Fertig.' },
    { type: 'done', isError: false, session: 's2' },
  ] satisfies AssistantEvent[]);
});

test('a message streams its answer, is stored, reads its context, and the next one continues the session', async () => {
  const log = mkdtempSync(join(tmpdir(), 'assistant-stub-'));
  const api = await startApi('demo/vanilla-accounting', {
    PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`,
    CLAUDE_STUB_PROMPTS: join(log, 'prompts.txt'), CLAUDE_STUB_ARGS: join(log, 'args.txt'),
  });
  try {
    const post = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    };
    const first = await post({ text: 'Warum so gebucht?', mode: 'ask', language: 'de', context: [{ kind: 'workflow', id: 'booking', label: 'Buchen' }] });
    const id = (first[0] as Extract<AssistantEvent, { type: 'conversation' }>).id;
    assert.equal(first.at(-1)?.type, 'done');
    assert.match(first.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), /Stub-Antwort auf «Warum so gebucht\?»\. Ein neues Gespräch\./);
    assert.match(readFileSync(join(log, 'prompts.txt'), 'utf8'), /Workflow booking \(Buchen\)/, 'the context is read into the message');
    const second = await post({ conversation: id, text: 'Und jetzt?', mode: 'change', language: 'de', context: [] });
    assert.equal((second[0] as { id: string }).id, id);
    const args = readFileSync(join(log, 'args.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.ok(args[1].includes('--resume'), 'the second message continues the first one\'s session');
    const { json } = await api.send('GET', `/api/assistant/${id}`);
    const turns = json.turns as Array<{ role: string; text: string; done?: boolean }>;
    assert.deepEqual(turns.map((t) => t.role), ['me', 'ai', 'me', 'ai']);
    assert.ok(turns[3].done && /geht weiter/.test(turns[3].text));
    const list = await api.send('GET', '/api/assistant');
    assert.deepEqual((list.json as unknown as Array<{ id: string; title: string; context: string[] }>).map((c) => [c.id, c.title, c.context]), [[id, 'Warum so gebucht?', ['Buchen']]]);
    assert.equal((await api.send('POST', '/api/assistant', { text: 'x', mode: 'write', context: [] })).status, 400);
  } finally {
    api.stop();
  }
});
