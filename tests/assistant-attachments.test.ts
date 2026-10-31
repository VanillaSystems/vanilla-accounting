/**
 * Files given the AI sidebar (src/assistant/attachments.ts, POST /api/assistant/attachments): an
 * upload is refused at the boundary by its type, its bytes and its size, keeps a safe name inside
 * its own folder, waits outside the books and the inbox, moves into its conversation's folder when
 * its message is sent, reaches the model as a path its Read tool opens, and shows in the turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import type { AssistantEvent, Turn } from '../src/types/assistant.js';
import type { Attachment } from '../src/types/attachment.js';
import { startApi } from './support/api-server.js';
import './support/jurisdiction.js';

const REPO = process.cwd();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('an attachment is refused at the boundary, kept outside the books, and read by the model from its conversation\'s folder', async () => {
  const log = mkdtempSync(join(tmpdir(), 'assistant-attach-'));
  const api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_PROMPTS: join(log, 'prompts.txt') });
  const upload = async (name: string, type: string, body: Uint8Array<ArrayBuffer>) => {
    const res = await api.fetch(`/api/assistant/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const reason = (json: Record<string, unknown>) => (json.code === 'attachment' ? (json.params as { reason: string }).reason : `no code: ${JSON.stringify(json)}`);
  try {
    const before = JSON.stringify(loadBooks(api.ws));
    const inbox = existsSync(api.ws.paths.inbox) ? readdirSync(api.ws.paths.inbox).sort() : [];

    const zip = await upload('belege.zip', 'application/zip', PNG);
    assert.equal(zip.status, 400);
    assert.equal(reason(zip.json), 'type');
    const renamed = await upload('notiz.png', 'image/png', new TextEncoder().encode('kein Bild'));
    assert.equal(reason(renamed.json), 'type', 'bytes that are not what the name says are refused');
    const big = await upload('gross.pdf', 'application/pdf', new Uint8Array(21 * 1024 * 1024).fill(0x25));
    assert.equal(big.status, 413);
    assert.equal(reason(big.json), 'size');

    const ok = await upload('../../ledger.json/Kassen:zettel.png', 'image/png', PNG);
    assert.equal(ok.status, 200);
    const a = ok.json as unknown as Attachment;
    assert.equal(a.name, 'Kassen_zettel.png', 'no folders, no reserved characters');
    assert.equal(a.type, 'image/png');
    const pending = join(api.ws.paths.data, 'assistant', 'attachments', 'pending', a.id, a.name);
    assert.deepEqual(readFileSync(pending), Buffer.from(PNG));

    const dropped = (await upload('weg.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.4'))).json as unknown as Attachment;
    assert.equal((await api.fetch(`/api/assistant/attachments/${dropped.id}`, { method: 'DELETE' })).status, 200);
    assert.ok(!existsSync(join(api.ws.paths.data, 'assistant', 'attachments', 'pending', dropped.id)), 'an upload taken off the composer is deleted');

    const post = async (body: unknown) => {
      const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.ok ? (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent) : await res.json() as Record<string, unknown>;
    };
    const gone = await post({ text: 'Was ist das?', language: 'de', context: [], attachments: ['00000000-0000-4000-8000-000000000000'] });
    assert.equal(reason(gone as Record<string, unknown>), 'gone');

    const events = await post({ text: 'Was ist auf dem Bild?', language: 'de', context: [], attachments: [a.id] }) as AssistantEvent[];
    assert.equal(events.at(-1)?.type, 'done');
    const id = (events[0] as Extract<AssistantEvent, { type: 'conversation' }>).id;
    const kept = join(api.ws.paths.data, 'assistant', 'attachments', id, a.id, a.name);
    assert.ok(existsSync(kept) && !existsSync(pending), 'sent, the file moves into its conversation\'s folder');
    const told = readFileSync(join(log, 'prompts.txt'), 'utf8').split('\n').find((l) => l.startsWith(`- ${a.name}: /`));
    assert.ok(told?.endsWith(join('data', 'assistant', 'attachments', id, a.id, a.name)), `the model is told the path to read: ${told}`);

    const { json } = await api.send('GET', `/api/assistant/${id}`);
    const me = (json.turns as Turn[])[0];
    assert.deepEqual(me.role === 'me' && me.attachments, [a]);
    const file = await api.fetch(`/api/assistant/${id}/attachments/${a.id}`);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PNG);
    assert.equal((await api.fetch(`/api/assistant/${id}/attachments/..%2F..%2Fledger.json`)).status, 404);

    assert.equal(JSON.stringify(loadBooks(api.ws)), before, 'the books are unchanged');
    assert.deepEqual(existsSync(api.ws.paths.inbox) ? readdirSync(api.ws.paths.inbox).sort() : [], inbox, 'the inbox is unchanged');
  } finally {
    await api.stop();
  }
});
