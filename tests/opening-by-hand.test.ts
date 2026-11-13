/**
 * Opening balances typed by hand (persona test «treuhaender», findings 10, 23, 30): a firm whose
 * earlier books were kept elsewhere opens its first year in Firma › Eröffnung, account by
 * account, retained earnings taking the difference, so the Bilanz balances. Only balance-sheet
 * accounts in the base currency, only the books' first year, and only until the year is closed
 * through its last day: a filed quarter does not stop it (r5h-30), since an opening balance is in
 * no VAT return and no seal.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { openingLock } from '../src/accounting/opening-balance.js';
import { checkSeals, closedPart, writeSeal } from '../src/books/seal.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { reportView } from '../src/app/areas/reports/model.js';
import { booksOnDisk } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/fresh-books-index.json'); });
after(() => api?.stop());

const books = () => loadBooks(workspaceAt(api.ws.paths.root));
const names = { 1021: 'Bank', 1500: 'Maschinen', 2800: 'Aktienkapital', 2970: 'Gewinnvortrag', 6000: 'Raumaufwand' };

test('an asset and a liability typed for the first year: retained earnings carries the difference, the Bilanz balances, taking one back restores the rest', async () => {
  const empty = booksOnDisk(api.ws);
  for (const [account, amount] of [['1021', 18420.15], ['1500', 12000], ['2800', 20000]] as const) {
    const r = await api.send('PUT', `/api/opening-balances/2026/${account}`, { amount });
    assert.equal(r.status, 200, String(r.json.error));
  }
  assert.deepEqual(books().config?.openingBalances, { 2026: { 1021: 18420.15, 1500: 12000, 2800: 20000, 2970: 10420.15 } }, 'assets 30\'420.15 = 2800 20\'000 + 2970 10\'420.15');
  const balance = reportView('balance', books(), parsePeriod('2026', '2026-10-16')!, names, false);
  assert.equal(balance.gap, undefined, 'Aktiven = Passiven');
  assert.equal(balance.headline.value, 30420.15);

  await api.send('PUT', '/api/opening-balances/2026/2800', { amount: null });
  assert.deepEqual(books().config?.openingBalances, { 2026: { 1021: 18420.15, 1500: 12000, 2970: 30420.15 } });
  for (const account of ['1021', '1500']) await api.send('PUT', `/api/opening-balances/2026/${account}`, { amount: null });
  assert.deepEqual(booksOnDisk(api.ws), empty, 'every opening taken back: the books as before');
});

test('refused: an income-statement account, retained earnings itself, a foreign-currency account without its balance in its currency', async () => {
  const before = booksOnDisk(api.ws);
  for (const [account, reason] of [['6000', 'notBalanceSheet'], ['2970', 'equity'], ['1023', 'foreign']]) {
    const { status, json } = await api.send('PUT', `/api/opening-balances/2026/${account}`, { amount: 100 });
    assert.deepEqual([status, json.code, (json.params as { reason: string }).reason], [400, 'openingAccount', reason], account);
    assert.doesNotMatch(String(json.error), /npm/, 'a refusal names no terminal command');
  }
  assert.deepEqual(booksOnDisk(api.ws), before);
});

test('a foreign-currency bank account opens with its value in CHF and its balance in its currency, as the balance sheet shows both (r2-26)', async () => {
  const empty = booksOnDisk(api.ws);
  const r = await api.send('PUT', '/api/opening-balances/2026/1023', { amount: 1126.01, native: 1200 });
  assert.equal(r.status, 200, String(r.json.error));
  assert.deepEqual(books().config?.openingBalances, { 2026: { 1023: 1126.01, 2970: 1126.01 } }, 'the CHF value in the Bilanz, retained earnings the other side');
  assert.deepEqual(books().config?.openingBalancesNative, { 2026: { 1023: { amount: 1200, currency: 'EUR' } } }, 'the EUR balance the statements are checked against');
  await api.send('PUT', '/api/opening-balances/2026/1023', { amount: null });
  assert.deepEqual(booksOnDisk(api.ws), empty, 'taken back: both values go');
});

test('refused: a year an earlier year of the books opens', async () => {
  const booked = await api.send('POST', '/api/journal-entries', { date: '2025-12-31', accountDebit: '6000', accountCredit: '1021', amount: 50, description: 'Miete Dezember' });
  assert.equal(booked.status, 200, String(booked.json.error));
  const { status, json } = await api.send('PUT', '/api/opening-balances/2026/1021', { amount: 100 });
  assert.deepEqual([status, json.code], [400, 'openingNotFirstYear']);
  assert.equal(books().config?.openingBalances, undefined);
  const id = (booked.json.entry as { id: string }).id;
  assert.equal((await api.send('DELETE', `/api/journal-entries/${id}`)).status, 200);
});

test('which years take openings by hand: the first one of the books, until it is closed through its last day', () => {
  const at = (config: object, dates: string[] = []) => ({ config, journalEntries: dates.map((date) => ({ id: date, transactionRef: date, date, accountDebit: '6000', accountCredit: '1021', amount: 1 })) });
  assert.equal(openingLock(at({}), '2026'), undefined);
  assert.equal(openingLock(at({ openingBalances: { 2026: { 1021: 5 } } }), '2026'), undefined, 'its own openings stay editable');
  assert.equal(openingLock(at({ closedThrough: '2026-09-30' }), '2026'), undefined, 'a filed quarter changes no figure when the year opens (r5h-30)');
  assert.equal(openingLock(at({ closedThrough: '2026-12-31' }), '2026'), 'closed', 'a year closed through 31.12. keeps its openings: the next one opens from them');
  assert.equal(openingLock(at({ openingBalances: { 2025: { 1021: 5 } } }), '2026'), 'notFirstYear');
  assert.equal(openingLock(at({}, ['2025-11-03']), '2026'), 'notFirstYear');
});

test('after a quarter is filed and sealed, the year still takes its opening: the seal stays intact and no filed record changes (r5h-30)', async () => {
  const filed = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const ws = workspaceAt(filed.ws.paths.root);
    writeSeal(ws, loadBooks(ws), '2026-Q2', '2026-07-11');
    const sealedPart = JSON.stringify(closedPart(loadBooks(ws), '2026-06-30'), (_k, v) => (v instanceof Map ? [...v] : v));
    const r = await filed.send('PUT', '/api/opening-balances/2026/1021', { amount: 18420.15 });
    assert.equal(r.status, 200, String(r.json.error));
    const after = loadBooks(ws);
    assert.equal(after.config.openingBalances?.['2026']?.['1021'], 18420.15);
    assert.deepEqual(checkSeals(ws, after).checks.map((c) => c.status), ['intact']);
    assert.equal(JSON.stringify(closedPart(after, '2026-06-30'), (_k, v) => (v instanceof Map ? [...v] : v)), sealedPart, 'no entry, payment or link of the filed quarter changed');
  } finally {
    await filed.stop();
  }
});
