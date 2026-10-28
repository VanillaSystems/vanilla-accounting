/**
 * The chat sees the selection (#216): while rows are picked the composer's chip is the selection,
 * the message carries its ids, taking the chip off sends the message without them, and the
 * server tells the model each picked object in one line. A selection above the batch limit is refused.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { messageOf, type Thread } from '../src/app/assistant/thread.js';
import { contextText } from '../src/assistant/context.js';
import type { ContextRef } from '../src/types/assistant.js';
import { startApi, type ApiServer } from './support/api-server.js';

const picked: ContextRef = { kind: 'selection', id: 'entry', ids: ['jo', 'jc'], label: '2 Buchungen ausgewählt' };
const thread: Thread = { open: true, conversation: 'c1', turns: [], extra: [], pageOff: false };

test('the message carries the picked ids as its reference', () => {
  assert.deepEqual(messageOf(thread, picked).context, [picked]);
});

test('the chip taken off: the message goes without the selection', () => {
  assert.deepEqual(messageOf({ ...thread, pageOff: true }, picked).context, []);
});

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

test('the model reads each picked object in one line, and what «alle ausgewählten» means', () => {
  const [text] = contextText(api.ws, [picked]);
  assert.match(text, /picked these 2 bookings/);
  assert.match(text, /alle ausgewählten/);
  assert.match(text, /"id":"jo".*"vatCode":"I81"/);
  assert.match(text, /"id":"jc"/);
});

test('a selection above the batch limit is refused before the model is asked', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `e${i}`);
  const r = await api.send('POST', '/api/assistant', { text: 'mach das mit allen', context: [{ kind: 'selection', id: 'entry', ids, label: 'x' }] });
  assert.equal(r.status, 400);
  const bad = await api.send('POST', '/api/assistant', { text: 'mach das', context: [{ kind: 'selection', id: 'invoice', ids: ['a'], label: 'x' }] });
  assert.equal(bad.status, 400, 'only the lists that pick rows');
});
