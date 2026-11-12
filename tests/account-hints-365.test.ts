/**
 * The words a layperson types into an account field find the account she means (#365): for a sale
 * «Umsatz», «Einnahme», «Verkauf», «Kunde», «Malerarbeiten»; for common costs «Miete», «Benzin»,
 * «Telefon», «Versicherung», «Material», «Werkzeug», «Lohn». The words come from data: the chart's
 * names, the class words of the dictionary (#356), and the Swiss chart's `hints` (modules/ch/accounts.yaml).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankAccounts, type AccountContext } from '../src/app/lib/account-filter.js';
import { chartFor, loadChart, standardAccounts, type AccountType } from '../src/workspace/chart.js';
import de from '../src/app/i18n/locales/de.js';

const chart = loadChart();
const standard = standardAccounts('GmbH');
const messages = de.messages as unknown as Record<string, string>;
const ctx = (prefer: AccountType): AccountContext<AccountType> => ({
  typeOf: (n) => chart.accounts.find((a) => a.number === n)?.type, prefer, defaults: prefer === 'revenue' ? ['3400'] : [],
  words: { revenue: messages['accounts.words.revenue'].split(/\s+/), expense: messages['accounts.words.expense'].split(/\s+/) },
  hints: (n) => standard.find((a) => a.number === n)?.hints,
});
/** What the field lists first: the books' accounts (a GmbH's chart for both profiles), then the standard chart's to add. */
const first = (word: string, prefer: AccountType, profile: 'services' | 'goods' | 'both' = 'both') => {
  const have = chartFor(chart, profile, 'GmbH');
  const add = standard.filter((a) => !have.some((h) => h.number === a.number));
  return [...rankAccounts(have, word, ctx(prefer)), ...rankAccounts(add, word, ctx(prefer))][0]?.account.number;
};

test('money in: the words for a sale find the firm\'s revenue account first', () => {
  for (const w of ['Umsatz', 'Einnahme', 'Einnahmen', 'Verkauf', 'Kunde', 'Malerarbeiten']) assert.equal(first(w, 'revenue'), '3400', w);
});

test('money out: the words for common costs find their expense account first', () => {
  const expected: Record<string, string> = { Miete: '6000', Benzin: '6200', Diesel: '6200', Telefon: '6510', Versicherung: '6300', Material: '4000', Werkzeug: '6100', Lohn: '5000', Büromiete: '6000', Strom: '6400', Porto: '6513' };
  for (const [w, account] of Object.entries(expected)) assert.equal(first(w, 'expense'), account, w);
});

test('a firm of services without a material account still finds «Material» among its costs, and «Werkzeug» on its costs before the asset', () => {
  assert.equal(chart.accounts.find((a) => a.number === first('Material', 'expense', 'services'))?.type, 'expense');
  assert.equal(first('Werkzeug', 'expense', 'services'), '6100');
});

test('a hint never hides a name: «Tel» still finds 6510 by its name, digits keep their order', () => {
  assert.equal(first('Tel', 'expense'), '6510');
  assert.equal(first('62', 'expense'), '6200');
});

test('the chart refuses a hint of fewer than three letters', () => {
  assert.ok(standard.every((a) => (a.hints ?? []).every((h) => h.length >= 3)));
});
