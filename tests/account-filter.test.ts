/**
 * The Kontoauszug's account search (src/app/lib/account-filter.ts): digits match the number's
 * start, words match the name ignoring case and accents, and the highlight marks what matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAccounts } from '../src/app/lib/account-filter.js';

const chart = [
  { number: '1020', name: 'Bank CHF' },
  { number: '1021', name: 'Bank EUR' },
  { number: '2200', name: 'Geschuldete MWST' },
  { number: '4000', name: 'Materialaufwand' },
  { number: '4099', name: 'Einkaufsrabatte' },
  { number: '4100', name: 'Handelswaren' },
  { number: '6500', name: 'Büromaterial' },
  { number: '6510', name: 'Téléphone et internet' },
  { number: '8400', name: 'Bank 40 Zinsen' },
];
const numbers = (q: string) => filterAccounts(chart, q).map((m) => m.account.number);

test('digits: the number starts with them (40 finds 4000 to 4099, not 4100 or a 40 in a name)', () => {
  assert.deepEqual(numbers('40'), ['4000', '4099']);
  assert.deepEqual(numbers('1020'), ['1020']);
  assert.deepEqual(numbers(' 2 '), ['2200']);
});

test('words: a substring of the name, any case', () => {
  assert.deepEqual(numbers('bank'), ['1020', '1021', '8400']);
  assert.deepEqual(numbers('MWST'), ['2200']);
  assert.deepEqual(numbers('bank eur'), ['1021']);
  assert.deepEqual(numbers('1020 bank'), ['1020'], 'number and name together');
});

test('umlauts and accents fold both ways', () => {
  assert.deepEqual(numbers('buro'), ['6500']);
  assert.deepEqual(numbers('büro'), ['6500']);
  assert.deepEqual(numbers('telephone'), ['6510']);
  assert.deepEqual(numbers('TÉLÉ'), ['6510']);
});

test('no match is an empty list; an empty query keeps every account in chart order', () => {
  assert.deepEqual(numbers('omega'), []);
  assert.deepEqual(numbers('99'), []);
  assert.deepEqual(numbers(''), chart.map((a) => a.number));
});

test('the highlight marks the matched characters of "number name"', () => {
  const [m] = filterAccounts(chart, 'büro');
  const shown = `${m.account.number} ${m.account.name}`;
  assert.equal(shown.slice(...m.highlight!), 'Büro');
  assert.deepEqual(filterAccounts(chart, '40')[0].highlight, [0, 2]);
});
