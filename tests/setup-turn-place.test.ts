/**
 * Typed messages in the setup conversation before the books (#385, round 2 with an AI, r2-ai-6): a
 * message stays at the step that waited when it was sent, and one whose step is gone goes to the open
 * step, so the open question never stands above her newest message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeTurns } from '../src/app/onboarding/turn-place.js';

test('a message stays with the step it was typed at', () => {
  const steps = [{ key: 'vatMethod', open: false }, { key: 'basis', open: true }];
  assert.deepEqual([...placeTurns(steps, [{ at: 'vatMethod' }])], [['vatMethod', [0]]]);
});

test('the round-2 walk: a question, a wrong click, a correction that takes the net rates back', () => {
  // «weiss nöd» at the method; a click on Saldosteuersatz opened the net rates; the correction typed
  // there made the method effective again, so the rates step is gone and «Abrechnungsart» is open.
  const steps = [{ key: 'vatMethod', open: false }, { key: 'basis', open: true }];
  const placed = placeTurns(steps, [{ at: 'vatMethod' }, { at: 'netRates' }]);
  assert.deepEqual(placed.get('vatMethod'), [0]);
  // Before the fix the correction stood after the open question, at the end.
  assert.deepEqual(placed.get('basis'), [1]);
  assert.equal(placed.get(''), undefined);
});

test('messages keep the order they were typed in at the open step', () => {
  const steps = [{ key: 'firm', open: false }, { key: 'review', open: true }];
  assert.deepEqual(placeTurns(steps, [{ at: 'gone' }, { at: 'review' }, { at: 'gone2' }]).get('review'), [0, 1, 2]);
});
