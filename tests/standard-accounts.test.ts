import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardAccounts } from '../src/workspace/chart.js';

test('the standard accounts an account field offers: an account of some legal forms only when the firm\'s form is known and one of them', () => {
  const of = (form?: Parameters<typeof standardAccounts>[0]) => new Map(standardAccounts(form).map((a) => [a.number, a.name]));
  assert.equal(of().get('6600'), 'Werbeaufwand');
  assert.equal(of().has('2850'), false, 'a firm without a known form (a GmbH whose manifest names none) is not offered Privat');
  assert.equal(of('GmbH').has('2850'), false);
  assert.equal(of('Einzelfirma').get('2850'), 'Privat');
  assert.equal(of('Einzelfirma').get('2800'), 'Eigenkapital', 'named for the form');
});
