/**
 * The AI sidebar keeps its conversation (src/app/assistant/thread.ts): a message after a look at
 * another page, or after the window was loaded again, goes into the same conversation; «Mit KI …»
 * adds its object to the open one; only «Neu», or «Mit KI …» with the sidebar closed, starts anew (wishes3-9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEPT_CONVERSATION, afterSend, askAboutThread, messageOf, newThread, startThread, type Thread } from '../src/app/assistant/thread.js';
import type { ContextRef } from '../src/types/assistant.js';

const receipt: ContextRef = { kind: 'receipt', id: 'r1', label: 'Farbmix FM-77812' };
const reports: ContextRef = { kind: 'file', id: 'reports', label: 'Bilanz & ER' };
const open: Thread = { open: true, conversation: 'c1', turns: [{ role: 'me', text: 'farbmix ist material', at: '', context: [receipt] }], extra: [], pageOff: false };

test('a message after a page change goes into the open conversation, with the page shown now', () => {
  assert.deepEqual(messageOf(open, reports), { conversation: 'c1', context: [reports] });
});

test('after the window is loaded again, the remembered conversation is the one continued', () => {
  const memory = new Map([[KEPT_CONVERSATION, 'c1']]);
  const start = { ...newThread(), open: true, ...startThread((k) => memory.get(k) ?? null) };
  assert.equal(messageOf(start, reports).conversation, 'c1');
  assert.deepEqual(startThread(() => null), {}, 'nothing remembered: a new conversation');
});

test('«Mit KI …» adds its object to the open conversation; with the sidebar closed it starts a new one about it; «Neu» starts anew', () => {
  const asked = { ...open, ...askAboutThread(open, receipt) };
  assert.deepEqual(messageOf(asked, reports), { conversation: 'c1', context: [reports, receipt] });
  const closed = { ...open, open: false, ...askAboutThread({ ...open, open: false }, receipt) };
  assert.deepEqual([closed.open, closed.conversation, closed.turns, messageOf(closed, reports).context], [true, undefined, [], [receipt]]);
  assert.equal(messageOf({ ...open, ...newThread() }, reports).conversation, undefined);
});

test('a button with a purpose starts a new conversation without the page, and the page stays off for its next messages until «+» adds it', () => {
  const setup: Thread = { ...open, ...newThread('collection-setup') };
  assert.equal(setup.conversation, undefined, 'a new conversation, not the open one');
  assert.equal(setup.purpose, 'collection-setup');
  assert.deepEqual(messageOf(setup, receipt).context, [], 'the receipt on the page must not go with the setup request');
  const answered = { ...setup, conversation: 'c2', ...afterSend(setup) };
  assert.deepEqual(messageOf(answered, receipt).context, [], 'nor with the person\'s answer after it');
  const added = { ...answered, pageOff: false };
  assert.deepEqual(messageOf({ ...added, ...afterSend(added) }, receipt).context, [receipt], 'the person added the page with «+»: it stays');
  const plain = { ...open, ...newThread() };
  assert.equal(plain.purpose, undefined);
  const off = { ...plain, pageOff: true };
  assert.deepEqual(messageOf({ ...off, ...afterSend(off) }, receipt).context, [receipt], 'a plain conversation takes the page again after a message, as before');
});
