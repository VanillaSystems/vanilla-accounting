/**
 * «Zurücknehmen» on an answered question is offered only while the answer's booking can change
 * (r7f-36, r8f-35): a question about a payment of a filed period keeps its answer, and the button
 * that would run into a 403 is not shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoable, type Question } from '../src/questions/model.js';

const q = (on: Question['on']): Pick<Question, 'on'> => ({ on });
const books = {
  config: { closedThrough: '2026-06-30' },
  transactions: [{ ref: 'sealed', date: '2026-05-10' }, { ref: 'open', date: '2026-08-10' }],
  journalEntries: [{ id: 'e-sealed', transactionRef: 'sealed', date: '2026-05-10' }, { id: 'e-open', transactionRef: 'open', date: '2026-08-10' }],
};

test('an answer on a payment or booking of a filed period cannot be taken back; one of the open period can', () => {
  assert.equal(undoable(q({ kind: 'payment', id: 'sealed' }), books), false);
  assert.equal(undoable(q({ kind: 'entry', id: 'e-sealed' }), books), false);
  assert.equal(undoable(q({ kind: 'payment', id: 'open' }), books), true);
  assert.equal(undoable(q({ kind: 'entry', id: 'e-open' }), books), true);
  assert.equal(undoable(q({ kind: 'receipt', id: 'r1' }), books), true, 'a receipt has no period of its own');
  assert.equal(undoable(q({ kind: 'payment', id: 'sealed' }), { ...books, config: {} }), true, 'nothing filed: everything open');
});
