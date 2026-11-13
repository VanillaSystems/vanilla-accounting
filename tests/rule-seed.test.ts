/**
 * #383 review: a rule started from the hand-booking form takes its account, and its VAT only when a
 * receipt gave the rate or the person typed it. A proposal's zero code (a payment without a receipt
 * yet, after a precedent at 8.1 %) would book every later payment without input tax.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedOf } from '../src/app/areas/journal/rule-seed.js';
import type { DraftLine } from '../src/accounting/manual-booking.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { EFFECTIVE_QUARTERLY } from '../src/workspace/vat-setup.js';

setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction, EFFECTIVE_QUARTERLY);

const line = (vat: string, from?: 'precedent' | 'receipt' | 'rule'): DraftLine => ({ accountDebit: '6510', accountCredit: '1020', amount: 89, vat, description: 'Swisscom', ...(from ? { source: { account: { from: 'precedent', date: '2026-07-15' }, vat: { from } } } : {}) });
const form = (fields: Record<string, string>) => [Object.keys(fields), (name: string) => fields[name] ?? ''] as const;
const seed = (fields: Record<string, string>, lines: DraftLine[], owner?: string) => seedOf(...form(fields), lines, 'accountDebit', owner);

test('a proposal\'s zero code stays with the one booking: the rule gets the account only', () => {
  assert.deepEqual(seed({ 'accountDebit-0': '6510', 'accountCredit-0': '1020', 'vatCode-0': 'I0', 'amount-0': '89.00' }, [line('I0', 'precedent')]), { account: '6510' });
});

test('a receipt\'s rate goes with the rule', () => {
  assert.deepEqual(seed({ 'accountDebit-0': '6510', 'accountCredit-0': '1020', 'vatCode-0': '8.1', 'amount-0': '89.00' }, [line('8.1', 'receipt')]), { account: '6510', vat: '8.1' });
});

test('a code she typed herself goes with the rule', () => {
  assert.deepEqual(seed({ 'accountDebit-0': '6510', 'accountCredit-0': '1020', 'vatCode-0': 'I81', 'amount-0': '89.00' }, [line('I0', 'precedent')]), { account: '6510', vat: 'I81' });
});

test('a line on the owner\'s account is her share', () => {
  const fields = { 'accountDebit-0': '6510', 'accountCredit-0': '1020', 'vatCode-0': '', 'amount-0': '60.00', 'accountDebit-1': '2850', 'accountCredit-1': '1020', 'vatCode-1': '', 'amount-1': '40.00' };
  assert.deepEqual(seed(fields, [line('', undefined)], '2850'), { account: '6510', share: '40' });
});
