import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundCHF, toRappen } from '../src/accounting/rappen.js';

test('a half Rappen rounds away from zero, so a storno mirrors its original', () => {
  assert.equal(toRappen(0.125), 13);
  assert.equal(toRappen(-0.125), -13);
  for (const x of [0.005, 0.125, 1.375, 2.5, 1234.565]) assert.equal(roundCHF(-x), -roundCHF(x), `${x}`);
});

test('a negative amount that rounds to nothing is +0, not -0', () => {
  assert.ok(Object.is(roundCHF(-0.001), 0));
});
