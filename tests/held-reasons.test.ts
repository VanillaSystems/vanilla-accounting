/**
 * Why the KI sidebar holds an answer's bookings for «Übernehmen» (src/assistant/held.ts
 * holdReasons): the card says what the answer does, and only that (persona round 7, r7h-26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdReasons } from '../src/assistant/held.js';
import type { HeldRow } from '../src/types/assistant.js';

const line = (accountDebit: string, accountCredit: string, vatCode?: string) => ({ accountDebit, accountCredit, amount: 10, ...(vatCode ? { vatCode } : {}) });
const row = (entry: string, ref: string, before?: ReturnType<typeof line>, after?: ReturnType<typeof line>): HeldRow => ({ entry, ref, date: '2026-10-21', text: entry, ...(before ? { before } : {}), ...(after ? { after } : {}) } as HeldRow);

test('deleting two bookings of two payments is held as deletions only, never as «bucht 2 Zahlungen um»', () => {
  assert.deepEqual(holdReasons([row('a', 'RB-1', line('1000', '1020')), row('b', 'RB-2', line('6100', '1020', 'I0'))]), ['deletes']);
});

test('rebooking two payments booked differently today is held as a rebooking', () => {
  assert.deepEqual(holdReasons([row('a', 'RB-1', line('1000', '1020'), line('6100', '1020')), row('b', 'RB-2', line('6100', '1020', 'I0'), line('6100', '1020', 'I81'))]), ['payments']);
});
