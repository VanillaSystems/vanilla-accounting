/**
 * A rate typed into a booking's VAT field (src/accounting/vat-codes.ts codeForRate): the entry's
 * accounts choose the code, a sale's on revenue, input tax on expense, material and investment
 * accounts, the minus on a refund. Swiss codes from modules/ch, then the made-up xx jurisdiction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import './support/jurisdiction.js';
import { codeForRate, parseRate } from '../src/accounting/vat-codes.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

test('a rate is read the ways a person types it', () => {
  assert.deepEqual(parseRate('8.1'), { rate: 8.1, negative: false });
  assert.deepEqual(parseRate('8,1 %'), { rate: 8.1, negative: false });
  assert.deepEqual(parseRate(' 2.6%'), { rate: 2.6, negative: false });
  assert.deepEqual(parseRate('-8.1'), { rate: 8.1, negative: true });
  assert.equal(parseRate('V81'), null);
  assert.equal(parseRate(''), null);
});

test('ch: the account decides between sale, material and operating input tax', () => {
  assert.equal(codeForRate(8.1, '1020', '3400'), 'V81', 'revenue on the credit side: a sale');
  assert.equal(codeForRate(2.6, '1020', '3200'), 'V26');
  assert.equal(codeForRate(8.1, '4400', '1020'), 'M81', 'material and goods: Ziffer 400');
  assert.equal(codeForRate(8.1, '6510', '1020'), 'I81', 'operating cost: Ziffer 405');
  assert.equal(codeForRate(8.1, '1510', '1020'), 'I81', 'an investment: Ziffer 405');
});

test('ch: a refund gets the code with its minus, and a typed minus turns it', () => {
  assert.equal(codeForRate(8.1, '3400', '1020'), '-V81', 'a sale paid back');
  assert.equal(codeForRate(8.1, '1020', '6510'), '-I81', 'an expense refunded');
  assert.equal(codeForRate(8.1, '1020', '4400'), '-M81');
  assert.equal(codeForRate(8.1, '1020', '6510', true), 'I81');
});

test('ch: no code for a rate the jurisdiction does not have, for zero, or for accounts that say nothing', () => {
  assert.equal(codeForRate(5, '1020', '3400'), null);
  assert.equal(codeForRate(0, '1020', '3400'), null, 'zero has several meanings (export, no receipt): the person picks the code');
  assert.equal(codeForRate(8.1, '2000', '2800'), null);
});

test('another jurisdiction: its own codes and boxes, nothing of ch', () => {
  setJurisdiction(loadJurisdiction(join(APP_ROOT, 'tests', 'fixtures'), 'xx').jurisdiction);
  try {
    assert.equal(codeForRate(20, '1800', '4000'), 'S20');
    assert.equal(codeForRate(5, '1800', '4100'), 'S5');
    assert.equal(codeForRate(20, '6000', '1800'), 'P20');
    assert.equal(codeForRate(20, '1800', '6000'), '-P20');
  } finally {
    setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction);
  }
});
