/**
 * The words a layperson types into an account field find the account she means (#365): for a sale
 * «Umsatz», «Einnahme», «Verkauf», «Kunde», «Malerarbeiten»; for common costs «Miete», «Benzin»,
 * «Telefon», «Versicherung», «Material», «Werkzeug», «Lohn». The words come from data: the chart's
 * names, the class words of the dictionary (#356), and the Swiss chart's `hints` (modules/ch/accounts.yaml).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstPick, rankAccounts, type AccountContext } from '../src/app/lib/account-filter.js';
import { hintsOf, setAccounts, setStandardAccounts } from '../src/app/lib/accounts.js';
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
  for (const w of ['Umsatz', 'Einnahme', 'Einnahmen', 'Verkauf', 'Kunde', 'Honorar', 'Dienstleistung']) assert.equal(first(w, 'revenue'), '3400', w);
});

test('money out: the words for common costs find their expense account first', () => {
  const expected: Record<string, string> = { Miete: '6000', Benzin: '6200', Diesel: '6200', Telefon: '6510', Versicherung: '6300', Material: '4000', Werkzeug: '6100', Lohn: '5000', Strom: '6400', Porto: '6513', Arbeitslosenversicherung: '5700', Autoversicherung: '6200', Arbeitskleider: '5880', Versich: '6300' };
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

/** The rows the field lists for a word on a cost field, and the row ↵ takes (firstPick: -1 is none). */
const onCosts = (word: string) => {
  const have = chartFor(chart, 'both', 'GmbH');
  const add = standard.filter((a) => !have.some((h) => h.number === a.number));
  const rows = [...rankAccounts(have, word, ctx('expense')), ...rankAccounts(add, word, ctx('expense'))];
  return { rows: rows.map((m) => m.account.number), pick: firstPick(rows, ctx('expense')) };
};

test('a hint is a whole typed word, never a part inside a longer one: no revenue for work, gardening or repairs on a cost field', () => {
  for (const w of ['Arbeitskleider', 'Gartenarbeit', 'Reparaturarbeiten', 'arb']) {
    const { rows, pick } = onCosts(w);
    const first = rows[pick];
    assert.notEqual(chart.accounts.find((a) => a.number === first)?.type, 'revenue', `${w}: ↵ never takes revenue (${rows.join(', ')})`);
    assert.ok(!rows.includes('3400'), `${w}: no hint inside the word lists 3400 (${rows.join(', ')})`);
  }
});

test("a hint on the other side of the payment is listed after the field's own side, and ↵ does not take it", () => {
  const rows = rankAccounts([{ number: '3400', name: 'Dienstleistungserlöse' }, { number: '6000', name: 'Mietaufwand' }], 'Honorar', ctx('expense'));
  assert.deepEqual(rows.map((m) => [m.account.number, m.hint]), [['3400', true]]);
  assert.equal(firstPick(rows, ctx('expense')), -1, 'only a revenue row by its hint on a cost field: none is chosen');
  assert.equal(firstPick(rows, ctx('revenue')), 0);
});

test('hints follow the standard account, not its number: a renamed account has none', () => {
  setStandardAccounts([{ number: '4400', name: 'Aufwand für bezogene Dienstleistungen', hints: ['Subunternehmer'] }, { number: '3400', name: 'Dienstleistungserlöse', hints: ['Honorar'] }]);
  setAccounts([{ number: '4400', name: 'Verbrauchsmaterial Salon' }, { number: '3400', name: 'Dienstleistungserlöse' }]);
  assert.equal(hintsOf('4400'), undefined);
  assert.deepEqual(hintsOf('3400'), ['Honorar']);
  setAccounts([{ number: '3400', name: 'Ertrag Webshop' }]);
  assert.equal(hintsOf('3400'), undefined);
});

test('a chart made since 0.4.0 with the names the comma cut keeps its hints («Telefon» for «Telefon, Internet»)', () => {
  setStandardAccounts([{ number: '6510', name: 'Telefon, Internet', hints: ['Handy'] }, { number: '6100', name: 'Unterhalt, Reparaturen, Ersatz', hints: ['Werkzeug'] }]);
  setAccounts([{ number: '6510', name: 'Telefon' }, { number: '6100', name: 'Unterhalt' }]);
  assert.deepEqual(hintsOf('6510'), ['Handy']);
  assert.deepEqual(hintsOf('6100'), ['Werkzeug']);
  setAccounts([{ number: '6510', name: 'Telefon, Internet' }]);
  assert.deepEqual(hintsOf('6510'), ['Handy'], 'the whole name too');
});

test('the chart refuses a hint of fewer than three letters', () => {
  assert.ok(standard.every((a) => (a.hints ?? []).every((h) => h.length >= 3)));
});
