/**
 * The AI sidebar (src/assistant/): its file tools write only into the draft's copy of the
 * customizing (never the books, never in place, never the approvals), no settings are loaded that
 * could allow more, the stream parser keeps text and tools apart, and the route end to end with
 * the claude stub: a conversation is stored, continued by its session, and its context read; the
 * changes to the books an answer asks for are applied, each undone on its own, and refused whole
 * when one touches a filed quarter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantArgs, draftPatterns, streamParser } from '../src/assistant/claude.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { AssistantEvent, MadeChange } from '../src/types/assistant.js';
import type { Index } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

const REPO = process.cwd();
const listAfter = (args: string[], flag: string) => {
  const at = args.indexOf(flag);
  const end = args.findIndex((a, i) => i > at && a.startsWith('--'));
  return args.slice(at + 1, end < 0 ? undefined : end);
};

test('its file tools write only into the draft, and only the customizing: never the books, no Bash, no settings', () => {
  const args = assistantArgs({ language: 'de' }, 's1', '/repo');
  const allowed = listAfter(args, '--allowedTools');
  const writes = allowed.filter((t) => /^(Edit|Write)\(/.test(t));
  assert.deepEqual(allowed.filter((t) => !writes.includes(t)), ['Read', 'Glob', 'Grep']);
  assert.ok(writes.length > 0);
  assert.ok(writes.every((t) => /^(Edit|Write)\(data\/draft\/[^)]+\)$/.test(t)), writes.join(' '));
  assert.ok(writes.some((t) => t === 'Edit(data/draft/knowledge/**)'));
  assert.ok(writes.some((t) => t === 'Write(data/draft/workflows/**)'));
  for (const p of draftPatterns()) assert.ok(!/transactional-data|ledger\.json|invoices\.json|data\/draft\/data/.test(p), p);
  assert.ok(listAfter(args, '--disallowedTools').includes('Bash'));
  assert.deepEqual(listAfter(args, '--setting-sources'), ['']);
  assert.deepEqual(listAfter(args, '--resume'), ['s1']);
  assert.equal(assistantArgs({ language: 'de' }, undefined, '/repo').includes('--resume'), false);
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
    const first = await post({ text: 'Warum so gebucht?', language: 'de', context: [{ kind: 'workflow', id: 'booking', label: 'Buchen' }] });
    const id = (first[0] as Extract<AssistantEvent, { type: 'conversation' }>).id;
    assert.equal(first.at(-1)?.type, 'done');
    assert.match(first.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), /Stub-Antwort auf «Warum so gebucht\?»\. Ein neues Gespräch\./);
    assert.match(readFileSync(join(log, 'prompts.txt'), 'utf8'), /Workflow booking \(Buchen\)/, 'the context is read into the message');
    const second = await post({ conversation: id, text: 'Und jetzt?', language: 'de', context: [] });
    assert.equal((second[0] as { id: string }).id, id);
    const args = readFileSync(join(log, 'args.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.ok(args[1].includes('--resume'), 'the second message continues the first one\'s session');
    const { json } = await api.send('GET', `/api/assistant/${id}`);
    const turns = json.turns as Array<{ role: string; text: string; done?: boolean }>;
    assert.deepEqual(turns.map((t) => t.role), ['me', 'ai', 'me', 'ai']);
    assert.ok(turns[3].done && /geht weiter/.test(turns[3].text));
    const list = await api.send('GET', '/api/assistant');
    assert.deepEqual((list.json as unknown as Array<{ id: string; title: string; context: string[] }>).map((c) => [c.id, c.title, c.context]), [[id, 'Warum so gebucht?', ['Buchen']]]);
    assert.equal((await api.send('POST', '/api/assistant', { text: ' ', context: [] })).status, 400);
  } finally {
    api.stop();
  }
});

test('the changes an answer asks for are made at once, each undone on its own; one on a filed quarter refuses them all', async () => {
  const demo = loadBooks(workspaceAt(DEMO_ROOT));
  const closedThrough = demo.config.closedThrough!;
  const dateOf = (ref: string) => demo.transactions.find((x) => x.ref === ref)?.date ?? '';
  const linkedTo = (id: string) => demo.mappings.filter((m) => m.receiptId === id).map((m) => dateOf(m.transactionRef));
  const open = demo.receipts.find((r) => { const d = linkedTo(r.id); return d.length > 0 && d.every((x) => x > closedThrough); })!;
  const filed = demo.receipts.find((r) => { const d = linkedTo(r.id); return d.length > 0 && d.every((x) => x <= closedThrough); })!;
  assert.ok(open && filed, 'the demo has a receipt of the open quarter and one of a filed quarter');

  const log = mkdtempSync(join(tmpdir(), 'assistant-changes-'));
  const changes = join(log, 'changes.json');
  const api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: changes });
  try {
    const books = async () => (await (await fetch(`http://127.0.0.1:${api.port}/books.json`)).json()) as Index;
    const post = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    };
    const vat = { hasSwissVat: true, vatId: 'CHE-123.456.789', vatSummary: [{ ratePercent: 8.1, net: 100, vat: 8.1, gross: 108.1 }] };
    writeFileSync(changes, JSON.stringify([{ kind: 'receipt', id: open.id, set: { date: '2026-06-28', amount: 108.1, currency: 'CHF', vat } }]));
    const events = await post({ text: 'Bitte richtig eintragen', language: 'de', context: [{ kind: 'receipt', id: open.id, label: 'Beleg' }] });
    assert.deepEqual(events.slice(-2).map((e) => e.type), ['changes', 'done'], 'the changes come before done');
    const made = (events.at(-2) as Extract<AssistantEvent, { type: 'changes' }>).changes;
    assert.equal(made.length, 1);
    const after = (await books()).receipts.find((r) => r.id === open.id)!;
    assert.deepEqual([after.date, after.amount, after.currency, after.hasSwissVat, after.vatSummary, after.vatId], ['2026-06-28', 108.1, 'CHF', true, vat.vatSummary, vat.vatId]);
    const id = (events[0] as { id: string }).id;
    const stored = (await api.send('GET', `/api/assistant/${id}`)).json.turns as Array<{ role: string; text: string; changes?: MadeChange[] }>;
    assert.doesNotMatch(stored[1].text, /vanilla-changes/, 'the person never sees the block');

    const undo = await api.send('POST', `/api/assistant/${id}/changes/${made[0].id}/undo`);
    assert.equal(undo.status, 200);
    const back = (await books()).receipts.find((r) => r.id === open.id)!;
    for (const k of ['date', 'amount', 'currency', 'hasSwissVat', 'vatSummary', 'vatId'] as const) assert.deepEqual(back[k], open[k], k);

    writeFileSync(changes, JSON.stringify([{ kind: 'receipt', id: open.id, set: { description: 'neu' } }, { kind: 'receipt', id: filed.id, set: { amount: 1, currency: 'CHF' } }]));
    const refused = await post({ text: 'Beides ändern', language: 'de', context: [] });
    assert.ok(refused.some((e) => e.type === 'refused' && /geschlossen/.test(e.message)), 'the filed quarter refuses');
    const untouched = await books();
    assert.equal(untouched.receipts.find((r) => r.id === open.id)!.description, open.description, 'nothing of a refused answer is written');
    assert.equal(untouched.receipts.find((r) => r.id === filed.id)!.amount, filed.amount);
  } finally {
    api.stop();
    rmSync(log, { recursive: true, force: true });
  }
});

test('the block is cut from what the person reads, also half-streamed; a block that is not a list of known changes is refused', async () => {
  const { changesIn, withoutChanges } = await import('../src/assistant/changes.js');
  assert.equal(withoutChanges('Erledigt.\n\n```vanilla-changes\n[{"kind":"link"'), 'Erledigt.');
  assert.deepEqual(changesIn('Nichts zu tun.'), []);
  assert.deepEqual(changesIn('ok\n```vanilla-changes\n[{"kind":"link","receipt":"r1","payment":"p1"}]\n```'), [{ kind: 'link', receipt: 'r1', payment: 'p1' }]);
  for (const bad of ['{"kind":"link"}', '[{"kind":"delete","id":"r1"}]', '[{"kind":"receipt","id":"r1","set":{"date":"28.06.2026"}}]', '[{"kind":"receipt","id":"r1","set":{}}]', '[{"kind":"receipt","id":"r1","set":{"vat":{"hasSwissVat":true}}}]']) {
    assert.throws(() => changesIn('```vanilla-changes\n' + bad + '\n```'), bad);
  }
});
