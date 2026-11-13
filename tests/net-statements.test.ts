/**
 * Bilanz, Erfolgsrechnung and Saldobilanz net of VAT within the year (owner's decision 16.10.2026,
 * modules/ch/statements.yaml `vat: net`): on each kind of firm the in-year statements are the year
 * close's (`closingLedger`), nothing is written to the journal, and the VAT return does not move.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { chartOf } from '../src/books/year-close.js';
import { accountsOf } from '../src/workspace/reads.js';
import { closingLedger, yearEndAccounts } from '../src/accounting/year-close.js';
import { statementPostings } from '../src/accounting/statement-postings.js';
import { derivePeriod, filingKeyOf, parsePeriod } from '../src/accounting/periods.js';
import { reportView, ledgerOf } from '../src/app/areas/reports/model.js';
import { tableOf } from '../src/export/tables.js';
import { ech0217Xml } from '../src/providers/ech0217/xml.js';
import { filing, filingMethod, statements, vat, vatSetup } from '../src/engines/index.js';
import type { Index, JournalEntry, QuarterKey } from '../src/types/index.js';

function open(demo: string) {
  const ws = workspaceAt(join(APP_ROOT, demo));
  const books = loadBooks(ws);
  const chart = chartOf(ws);
  const names: Record<string, string> = Object.fromEntries((accountsOf(ws) as Array<{ number?: string; name?: string }>).flatMap((a) => (a.number ? [[String(a.number), a.name ?? '']] : [])));
  const year = books.journalEntries.map((e) => e.date).sort().at(-1)!.slice(0, 4);
  const closing = closingLedger(books, year, chart, yearEndAccounts(chart));
  const period = (token: string) => parsePeriod(token, `${year}-12-31`)!;
  return { ws, books, chart, names, year, closing, period };
}

const filingKeys = (year: string): QuarterKey[] => [...new Set(['01', '04', '07', '10'].map((m) => filingKeyOf(`${year}-${m}-01`, filing().length)))] as QuarterKey[];

const words = { t: (key: string, vars?: Record<string, string | number>) => `${key}${vars ? ' ' + JSON.stringify(vars) : ''}`, accountingName: (g: string) => g };

for (const [demo, kind] of [['demo', 'effective'], ['demo-consulting', 'effective'], ['demo-schreinerei', 'net-rate']] as const) {
  test(`${demo} (${kind}): the year's Bilanz balances and its result is the year close's, every account's balance too`, () => {
    const { books, names, year, closing, period } = open(demo);
    assert.equal(statements().vat, 'net');
    assert.equal(vatSetup().registered && (vatSetup() as { method: string }).method, kind);
    assert.equal(closing.residual, 0, 'the closing ledger balances');
    const income = reportView('income', books, period(year), names, false);
    assert.equal(income.headline.value, closing.result, 'the Erfolgsrechnung\'s result is closingLedger\'s');
    assert.deepEqual(income.vat, { shown: 'net', account: yearEndAccounts(Object.keys(names)).vatSettlement });
    const balance = reportView('balance', books, period(year), names, true);
    assert.equal(balance.gap, undefined, 'the Bilanz has no difference');
    const shown = Object.fromEntries(balance.blocks.flatMap((b) => (b.kind === 'group' ? b.rows : [])).filter((r) => r.value !== 0).map((r) => [r.account, r.value]));
    const closed = Object.fromEntries(Object.entries(closing.balances).filter(([a]) => a < '3'));
    assert.deepEqual(shown, closed, 'each Bilanz account holds its closing balance');
    assert.equal(balance.headline.value, closing.totalAssets);
  });

  test(`${demo} (${kind}): every filing period's Bilanz balances within the year, and its Saldobilanz too`, () => {
    const { books, names, year, period } = open(demo);
    const keys = filingKeys(year);
    for (const key of keys) {
      assert.equal(reportView('balance', books, period(key), names, false).gap, undefined, `${key}: no difference`);
      assert.equal(reportView('trial', books, period(key), names, false).balanced, true, `${key}: debits equal credits`);
    }
  });

  test(`${demo} (${kind}): an account's ledger closes on its statement figure; the derived tax links to its entry`, () => {
    const { books, names, year, closing, period } = open(demo);
    const account = yearEndAccounts(Object.keys(names)).vatSettlement;
    const l = ledgerOf(books, account, period(year), names);
    assert.equal(l.closing, closing.balances[account] ?? 0, 'the VAT account\'s ledger closes on the year close\'s balance');
    const derived = l.rows.filter((r) => r.derived);
    assert.ok(derived.length > 0, 'the VAT account shows the tax the codes split off');
    assert.ok(derived.every((r) => r.entry && r.entryId === `vat:${r.entry.id}` && r.entry.vatCode), 'each derived row links to the coded entry it comes from');
  });

  test(`${demo} (${kind}): nothing is written to the journal and the VAT return reads the codes alone`, () => {
    const { ws, books, chart } = open(demo);
    const before = JSON.stringify(books.journalEntries);
    const postings = statementPostings(books.journalEntries, chart);
    assert.ok(postings.length > books.journalEntries.length, 'tax postings are derived');
    assert.equal(JSON.stringify(books.journalEntries), before, 'the journal is untouched');
    const adjustments = books.config.vatAdjustments ?? [];
    const xml = (entries: JournalEntry[], key: QuarterKey) => {
      const { from, to } = derivePeriod(key)!;
      const { ziffern, payable } = vat().figures(entries, key, adjustments);
      return ech0217Xml({ uid: ws.company.uid!, organisationName: ws.company.name, period: { key, from, to }, ziffern, payable, form: vat().form, rateRows: vat().rateRows, method: filingMethod(), generationTime: '2026-10-16T00:00:00' }).xml;
    };
    for (const year of new Set(books.journalEntries.map((e) => e.date.slice(0, 4)))) {
      for (const key of [...filingKeys(year), year]) {
        assert.deepEqual(vat().report([...postings], key, adjustments), vat().report(books.journalEntries, key, adjustments), `${key}: the return is the same with the tax postings beside the journal`);
      }
      for (const key of filingKeys(year)) {
        assert.deepEqual(vat().figures([...postings], key, adjustments), vat().figures(books.journalEntries, key, adjustments), `${key}: the figures a filing sends`);
        assert.equal(xml([...postings], key), xml(books.journalEntries, key), `${key}: the eCH-0217 file is byte-identical`);
      }
    }
  });
}

test('demo-coiffeur (not registered): no tax is derived, the figures stay as booked and no VAT line is shown', () => {
  const { books, chart, names, year, closing, period } = open('demo-coiffeur');
  assert.equal(vatSetup().registered, false);
  assert.deepEqual([...statementPostings(books.journalEntries, chart)], books.journalEntries, 'the postings are the journal');
  const income = reportView('income', books, period(year), names, false);
  assert.equal(income.vat, undefined, 'no VAT line');
  assert.equal(income.headline.value, closing.result);
  assert.equal(reportView('balance', books, period(year), names, false).vat, undefined);
  const tb = tableOf('income', { books: books as Index, period: period(year), names, words: words as never, filed: {}, filingLength: filing().length });
  assert.equal(tb.note, undefined, 'the export carries no VAT note');
});
