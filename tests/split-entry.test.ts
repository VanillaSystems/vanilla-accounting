/**
 * A Sammelbuchung typed by hand (#567, src/server/edits.ts addEntries): its lines are booked under
 * one new ref of the person's, each a balanced pair on the shared account, all or none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { startApi } from './support/api-server.js';
import { booksOnDisk } from './support/workspace.js';
import { parseSwissDate } from '../src/accounting/periods.js';

const LINES = [
  { accountDebit: '6800', accountCredit: '1020', amount: 216.2, description: 'Sammel' },
  { accountDebit: '6570', accountCredit: '1020', amount: 300, vatCode: 'I81', description: 'Sammel, Software' },
];

test('the lines of a Sammelbuchung share one new ref, the date, and are the person\'s', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const { status, json } = await api.send('POST', '/api/journal-entries/lines', { date: '2026-08-31', lines: LINES });
    assert.equal(status, 200, String(json.error));
    const sent = json.entries as Array<{ id: string; transactionRef: string }>;
    assert.equal(sent.length, 2);
    const booked = loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.filter((e) => e.transactionRef === sent[0].transactionRef).sort((a, b) => a.amount - b.amount);
    assert.match(sent[0].transactionRef, /^M2026-\d{3}$/);
    assert.deepEqual(booked.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.date, e.origin, e.by?.kind]), [
      ['6800', '1020', 216.2, undefined, '2026-08-31', 'manual', 'person'],
      ['6570', '1020', 300, 'I81', '2026-08-31', 'manual', 'person'],
    ]);
    // Undone line by line, as the toast's «Rückgängig» does.
    for (const e of sent) assert.equal((await api.send('DELETE', `/api/journal-entries/${e.id}`)).status, 200);
    assert.ok(!loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.some((e) => e.transactionRef === sent[0].transactionRef));
  } finally {
    await api.stop();
  }
});

test('one bad line refuses the whole Sammelbuchung and writes nothing', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const before = JSON.stringify(booksOnDisk(api.ws));
    const noText = await api.send('POST', '/api/journal-entries/lines', { date: '2026-08-31', lines: [LINES[0], { ...LINES[1], description: ' ' }] });
    assert.deepEqual([noText.status, noText.json.code], [400, 'noDescription']);
    const oneSide = await api.send('POST', '/api/journal-entries/lines', { date: '2026-08-31', lines: [LINES[0], { ...LINES[1], accountCredit: '' }] });
    assert.equal(oneSide.status, 400, 'a line without its other side moves nothing in balance');
    const closed = await api.send('POST', '/api/journal-entries/lines', { date: '2026-06-30', lines: LINES });
    assert.equal(closed.status, 403);
    assert.equal(JSON.stringify(booksOnDisk(api.ws)), before);
  } finally {
    await api.stop();
  }
});

test('a short date is the given year\'s; without a year only the whole date counts', () => {
  assert.equal(parseSwissDate('6.12.', '2026'), '2026-12-06');
  assert.equal(parseSwissDate('6.12', '2026'), '2026-12-06');
  assert.equal(parseSwissDate('6.12.25', '2026'), '2025-12-06');
  assert.equal(parseSwissDate('31.2.', '2026'), null);
  assert.equal(parseSwissDate('6.12.'), null);
  assert.equal(parseSwissDate('06.12.2026'), '2026-12-06');
});
