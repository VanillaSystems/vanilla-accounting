/**
 * What the UI shows for a foreign entry: its CHF figure is the books' roundCHF(amount × rate), and
 * a rate that is not the ESTV sell rate of the payment date is flagged (ADR 0001).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import { chfAmount, roundCHF } from '../src/accounting/index.js';
import { readEstvRateTable } from '../src/accounting/fx-rates.js';
import { conversionOf, estvRates, paymentDateOf, ratesUsed } from '../src/accounting/fx-conversion.js';
import type { JournalEntry } from '../src/types/index.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';

const rates = estvRates(readEstvRateTable());

for (const demo of ['demo', 'demo-consulting']) {
  test(`${demo}: every foreign entry shows CHF = roundCHF(amount × rate) at the ESTV rate of its payment date`, () => {
    const books = loadBooks(workspaceAt(join(APP_ROOT, demo)));
    const txDates = new Map(books.transactions.map((tx) => [tx.ref, tx.date]));
    const foreign = books.journalEntries.filter((e) => e.exchangeCurrency && e.exchangeCurrency !== 'CHF');
    assert.ok(foreign.length >= 10, `${demo} books foreign entries`);
    for (const e of foreign) {
      const c = conversionOf(e, paymentDateOf(e, txDates), rates)!;
      assert.equal(c.chf, roundCHF(e.amount * e.exchangeRate!), e.id);
      assert.equal(c.chf, chfAmount(e), `${e.id}: the figure shown is the one the ledger counts`);
      assert.equal(c.check.kind, 'estv', `${e.id} carries the ESTV rate of ${c.paymentDate}`);
    }
    const uses = [...ratesUsed(books.journalEntries, (e) => paymentDateOf(e, txDates), rates).values()].flat();
    assert.equal(uses.reduce((n, u) => n + u.entries.length, 0), foreign.length, 'the Kurse view lists each foreign entry once');
  });
}

const entry = (over: Partial<JournalEntry>): JournalEntry => ({
  id: 'J1', transactionRef: 'T1', date: '2026-08-14', accountDebit: '6500', accountCredit: '1021', amount: 50,
  exchangeCurrency: 'EUR', exchangeRate: rates.on('EUR', '2026-08-14')!.rate, ...over,
});

test('a planted flat rate is flagged with the ESTV rate it should have been', () => {
  const estv = rates.on('EUR', '2026-08-14')!;
  const c = conversionOf(entry({ exchangeRate: 0.91 }), '2026-08-14', rates)!;
  assert.deepEqual(c.check, { kind: 'differs', estv });
  assert.equal(c.chf, roundCHF(50 * 0.91), 'the figure is still what the books count');
  assert.equal(conversionOf(entry({ exchangeRate: undefined }), '2026-08-14', rates)!.check.kind, 'differs', 'no stored rate');
  assert.equal(conversionOf(entry({}), '2026-08-14', rates)!.check.kind, 'estv');
});

test('the payment date decides, not the entry date; a split ref uses its base transaction', () => {
  const txDates = new Map([['T1', '2026-04-07']]);
  const e = entry({ transactionRef: 'T1~fee', exchangeRate: rates.on('EUR', '2026-08-14')!.rate });
  assert.equal(paymentDateOf(e, txDates), '2026-04-07');
  assert.equal(conversionOf(e, paymentDateOf(e, txDates), rates)!.check.kind, 'differs', 'the August rate on an April payment');
  assert.equal(paymentDateOf(entry({ transactionRef: 'M1' }), txDates), '2026-08-14', 'no bank transaction: the entry date');
});

test('CHF entries convert to nothing; a currency or date without an ESTV rate is unknown', () => {
  assert.equal(conversionOf(entry({ exchangeCurrency: undefined, exchangeRate: undefined }), '2026-08-14', rates), undefined);
  assert.equal(conversionOf(entry({ exchangeCurrency: 'GBP', exchangeRate: 1.1 }), '2026-08-14', rates)!.check.kind, 'unknown');
  assert.equal(conversionOf(entry({}), '2020-01-02', rates)!.check.kind, 'unknown');
});

test('the 31.12. rate appears only once the table reaches that day', () => {
  const table = { fetchedAt: '2026-10-01T12:00:00Z', rates: { '2025-12-31': { EUR: 0.938, src: 'datum 2025-12-30' }, '2026-09-30': { EUR: 0.95 } } };
  const r = estvRates(table);
  assert.deepEqual(r.yearEnd('EUR', '2025'), { currency: 'EUR', rate: 0.938, validOn: '2025-12-31', source: 'datum 2025-12-30' });
  assert.equal(r.yearEnd('EUR', '2026'), undefined, 'the latest rate is not the year-end rate');
});
