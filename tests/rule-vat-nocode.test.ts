/**
 * #383 review: a rule on an account that takes no VAT code (the wage account, a debt) or for wages
 * books without a code, unasked, but a receipt that shows Swiss VAT wins: then the card asks. The
 * wage account counts only while the firm's own account of that number is an expense account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleVatOf, takesNoCode } from '../src/booking/rule-vat.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { EFFECTIVE_QUARTERLY } from '../src/workspace/vat-setup.js';

setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction, EFFECTIVE_QUARTERLY);

const swiss = { kind: 'invoice' as const, hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 8.1 }] };
const none = { kind: 'invoice' as const, hasSwissVat: false };

test('no code where the account takes none, and no receipt says otherwise', () => {
  assert.deepEqual(ruleVatOf('5000', [], true), { kind: 'fill', vat: 'none' });
  assert.deepEqual(ruleVatOf('5000', [none], true), { kind: 'fill', vat: 'none' });
});

test('a receipt with Swiss VAT wins over the account: the card asks', () => {
  const v = ruleVatOf('5000', [swiss], true);
  assert.equal(v.kind, 'ask');
  assert.deepEqual(v.kind === 'ask' && v.choices, [0, 8.1, 3.8, 2.6]);
});

test('the wage account counts only as the firm\'s expense account', () => {
  assert.equal(takesNoCode('5000', undefined, () => 'expense'), true);
  assert.equal(takesNoCode('5000', undefined, () => 'asset'), false, 'a firm whose 5000 is something else');
  assert.equal(takesNoCode('5000', undefined, () => undefined), false, 'a firm without 5000');
  assert.equal(takesNoCode('6510', undefined, () => 'expense'), false);
});
