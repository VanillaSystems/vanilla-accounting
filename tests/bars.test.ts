/**
 * The folding bars (src/app/shell/bars.ts, docs/0.4.0/views.md "Both bars"): open while new, folded
 * once after three uses with a tip, pinned open by the pin or «Immer zeigen», folded again by unpinning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEW_BAR, reduce, staysOpen, USES_BEFORE_FOLD, type BarEvent, type BarState } from '../src/app/shell/bars.js';

const run = (events: BarEvent[], from: BarState = NEW_BAR) => events.reduce(reduce, from);
const used = (n: number): BarEvent[] => Array.from({ length: n }, () => ({ kind: 'used' }));

test('a new bar stays open until it was used three times, then folds once with the tip', () => {
  assert.equal(USES_BEFORE_FOLD, 3);
  assert.deepEqual(run(used(2)), { mode: 'new', uses: 2, tip: false });
  assert.equal(staysOpen(run(used(2))), true);
  assert.deepEqual(run(used(3)), { mode: 'auto', uses: 3, tip: true });
  assert.equal(staysOpen(run(used(3))), false);
});

test('the tip shows once: «Verstanden» keeps it folding, «Immer zeigen» pins it', () => {
  assert.deepEqual(run([...used(3), { kind: 'tip-ok' }, ...used(5)]), { mode: 'auto', uses: 3, tip: false });
  assert.deepEqual(run([...used(3), { kind: 'tip-always' }]), { mode: 'always', uses: 3, tip: false });
});

test('the pin keeps a bar open either way, and unpinning lets it fold', () => {
  assert.equal(staysOpen(run([{ kind: 'pin', on: true }])), true);
  assert.equal(run([{ kind: 'pin', on: true }, ...used(9)]).mode, 'always', 'using a pinned bar never folds it');
  assert.deepEqual(run([{ kind: 'pin', on: true }, { kind: 'pin', on: false }]), { mode: 'auto', uses: 0, tip: false });
  assert.equal(run([...used(3), { kind: 'pin', on: true }]).tip, false, 'pinning answers the tip');
});
