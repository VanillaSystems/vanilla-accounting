/**
 * Reports the owner asks for (src/reports): the spec's shape and facts checked at the boundary,
 * and every figure the runner produces recomputed here from the books another way (the trial
 * balance, a plain loop over the entries, the invoices' own totals), on the demo books and a
 * small fixture whose figures are worked by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { accountsOf } from '../src/workspace/reads.js';
import { loadInvoices } from '../src/invoices/store.js';
import { totals as invoiceTotals } from '../src/invoices/rules.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { chfAmount } from '../src/accounting/ledger.js';
import { computeTrialBalance } from '../src/accounting/trial-balance.js';
import type { Postings } from '../src/accounting/index.js';
import { chart, vat } from '../src/engines/index.js';
import type { Index, JournalEntry } from '../src/types/index.js';
import { checkSpec, inRange, parseSpec, specData, type ReportSpec } from '../src/reports/spec.js';
import { fillComment, previewOf, runReport, type ReportResult } from '../src/reports/run.js';
import { DEMO_ROOT } from './support/workspace.js';

const ws = workspaceAt(DEMO_ROOT);
const books = loadBooks(ws);
const invoices = loadInvoices(ws).invoices;
const names = Object.fromEntries((accountsOf(ws) as Array<{ number: string; name: string }>).map((a) => [a.number, a.name]));
const TODAY = '2026-10-16';
const Q3 = parsePeriod('2026-Q3', TODAY)!;
const facts = { accounts: names, takesCode: (c: string) => !!vat().codes.parse(c) };
const cents = (n: number) => Math.round(n * 100);
/** The journal as booked, gross: the movement each account's bookings make, without the statements' VAT split. */
const asBooked = books.journalEntries as unknown as Postings;

function spec(raw: unknown): ReportSpec {
  const p = parseSpec(raw, TODAY);
  assert.ok(p.ok, `parses: ${JSON.stringify(p)}`);
  return p.value;
}
const run = (raw: unknown, period = Q3): ReportResult => runReport(spec(raw), { books, invoices, names }, period);

test('a spec takes defaults: group none, the source\'s columns, accounts as ranges', () => {
  const s = spec({ title: 'Aufwand', period: '2026-Q3', sections: [{ source: 'entries', filter: { accounts: ['6000-6999', 6510, '4000'] } }] });
  assert.equal(s.sections[0].group, 'none');
  assert.deepEqual(s.sections[0].columns, ['date', 'text', 'account', 'counterAccount', 'vatCode', 'amount']);
  assert.deepEqual(s.sections[0].filter.accounts, [{ from: '6000', to: '6999' }, { from: '6510', to: '6510' }, { from: '4000', to: '4000' }]);
  assert.deepEqual(specData(s).sections, [{ source: 'entries', filter: { accounts: ['6000-6999', '6510', '4000'] }, group: 'none', columns: s.sections[0].columns }]);
});

test('a spec the app cannot read is refused with its reason, never half taken', () => {
  const refusal = (raw: unknown) => { const p = parseSpec(raw, TODAY); assert.ok(!p.ok, JSON.stringify(raw)); return p.refusal; };
  const base = { title: 'X', period: '2026-Q3', sections: [{ source: 'entries' }] };
  assert.deepEqual(refusal({ ...base, title: '' }), { code: 'shape', params: { what: 'title' } });
  assert.deepEqual(refusal({ ...base, period: 'Q3' }), { code: 'period', params: { period: 'Q3' } });
  assert.deepEqual(refusal({ ...base, sections: [] }), { code: 'shape', params: { what: 'sections' } });
  assert.deepEqual(refusal({ ...base, sections: [{ source: 'ledger' }] }), { code: 'shape', params: { what: 'sections[0].source' } });
  assert.deepEqual(refusal({ ...base, sections: [{ source: 'receipts', filter: { vatCodes: ['I81'] } }] }), { code: 'notForSource', params: { source: 'receipts', what: 'vatCodes' } });
  assert.deepEqual(refusal({ ...base, sections: [{ source: 'invoices', group: 'account' }] }), { code: 'notForSource', params: { source: 'invoices', what: 'account' } });
  assert.deepEqual(refusal({ ...base, sections: [{ source: 'payments', columns: ['tax'] }] }), { code: 'notForSource', params: { source: 'payments', what: 'tax' } });
  assert.deepEqual(refusal({ ...base, sections: [{ source: 'entries', filter: { accounts: ['sechs'] } }] }), { code: 'shape', params: { what: 'accounts: "sechs"' } });
  assert.deepEqual(refusal({ ...base, comment: 'Total {sum}' }), { code: 'placeholder', params: { name: 'sum' } });
  assert.deepEqual(refusal({ ...base, comment: 'Total {section2.total}' }), { code: 'placeholder', params: { name: 'section2.total' } });
  assert.deepEqual(refusal({ ...base, comment: 'Gesamt rund 4\'200 Franken, genau {total}' }), { code: 'figureInComment', params: { text: '4\'200' } });
  assert.ok(parseSpec({ ...base, comment: 'Im Zeitraum {period}: {count} Buchungen, {section1.total}.' }, TODAY).ok);
});

test('the firm\'s facts: an account a filter names is in the chart, a VAT code is one the form takes', () => {
  const s = (filter: object) => spec({ title: 'X', period: '2026', sections: [{ source: 'entries', filter }] });
  assert.equal(checkSpec(s({ accounts: ['6000-6999'], vatCodes: ['I81', '-V81'] }), facts), undefined);
  assert.deepEqual(checkSpec(s({ accounts: ['6599'] }), facts), { code: 'unknownAccount', params: { account: '6599' } });
  assert.deepEqual(checkSpec(s({ accounts: ['9900-9950'] }), facts), { code: 'unknownAccount', params: { account: '9900-9950' } });
  assert.deepEqual(checkSpec(s({ vatCodes: ['X99'] }), facts), { code: 'unknownVatCode', params: { code: 'X99' } });
  assert.ok(inRange('6510', { from: '6000', to: '6999' }) && !inRange('7000', { from: '6000', to: '6999' }) && !inRange('', { from: '1', to: '9' }));
});

test('Aufwand by account in Q3: each account\'s total is its trial balance movement, the overall total the plain sum of the entries', () => {
  const r = run({ title: 'Aufwand', period: '2026-Q3', sections: [{ source: 'entries', filter: { accounts: ['6000-6999'] }, group: 'account' }] });
  const entries = books.journalEntries.filter((e) => e.date >= Q3.from && e.date <= Q3.to);
  const tb = computeTrialBalance(asBooked, Q3.from, Q3.to, {}, names);
  const expense = tb.rows.filter((x) => x.account >= '6000' && x.account <= '6999' && (x.debitTotal || x.creditTotal));
  assert.ok(expense.length >= 3, 'the demo has expenses on several accounts in Q3');
  assert.deepEqual(r.sections[0].groups.map((g) => [g.key, cents(g.totals[0].amount)]), expense.map((x) => [x.account, cents(x.debitTotal - x.creditTotal)]));
  let plain = 0;
  let count = 0;
  for (const e of entries) {
    const d = e.accountDebit >= '6000' && e.accountDebit <= '6999';
    const c = e.accountCredit >= '6000' && e.accountCredit <= '6999';
    plain += (d ? cents(chfAmount(e)) : 0) - (c ? cents(chfAmount(e)) : 0);
    count += Number(d) + Number(c);
  }
  assert.deepEqual(r.totals, [{ currency: 'CHF', count, amount: plain / 100, net: r.totals[0].net, tax: r.totals[0].tax }]);
  assert.equal(r.sections[0].groups[0].label, names[r.sections[0].groups[0].key]);
});

test('sales on 3xxx count on their normal side: positive, a refund against them; net and tax as the VAT engine splits each booking', () => {
  const r = run({ title: 'Umsatz', period: '2026-Q3', sections: [{ source: 'entries', filter: { accounts: ['3000-3999'] }, group: 'vatCode', columns: ['date', 'text', 'amount', 'net', 'tax'] }] });
  const tb = computeTrialBalance(asBooked, Q3.from, Q3.to, {}, names).rows.filter((x) => x.account >= '3000' && x.account <= '3999');
  assert.equal(cents(r.totals[0].amount), tb.reduce((n, x) => n + cents(x.creditTotal - x.debitTotal), 0));
  assert.ok(r.totals[0].amount > 0);
  let tax = 0;
  for (const e of books.journalEntries.filter((x) => x.date >= Q3.from && x.date <= Q3.to && x.accountCredit >= '3000' && x.accountCredit <= '3999')) {
    tax += cents(Math.abs(vat().vatLine(e)?.tax ?? 0));
  }
  assert.equal(cents(r.totals[0].tax), tax);
  assert.equal(cents(r.totals[0].net), cents(r.totals[0].amount) - tax);
  assert.ok(r.vat && r.vat.owed > 0, 'the bookings hold VAT the year close settles');
});

test('payments are summed per currency, never EUR into CHF; a with-receipt filter keeps only paid-with-proof ones', () => {
  const r = run({ title: 'Zahlungen', period: '2026', sections: [{ source: 'payments', group: 'month' }] }, parsePeriod('2026', TODAY)!);
  for (const cur of ['CHF', 'EUR']) {
    const own = books.transactions.filter((t) => t.currency === cur);
    const t = r.totals.find((x) => x.currency === cur)!;
    assert.equal(t.count, own.length, cur);
    assert.equal(cents(t.amount), own.reduce((n, x) => n + (x.direction === 'DBIT' ? -1 : 1) * cents(x.amount), 0), cur);
  }
  assert.equal(r.totals[0].currency, 'CHF', 'the books\' currency first');
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const w = run({ title: 'Mit Beleg', period: '2026', sections: [{ source: 'payments', filter: { receipt: 'with' } }] }, parsePeriod('2026', TODAY)!);
  assert.equal(w.count, books.transactions.filter((t) => linked.has(t.ref)).length);
  assert.ok(w.count > 0 && w.count < books.transactions.length);
});

test('invoices: the issued ones of the period, their totals the invoices\' own; drafts and October\'s left out', () => {
  const r = run({ title: 'Rechnungen', period: '2026-Q3', sections: [{ source: 'invoices', group: 'counterparty' }] });
  const issued = invoices.filter((i) => i.status === 'issued' && i.date <= Q3.to && i.date >= Q3.from);
  assert.equal(r.count, issued.length);
  assert.deepEqual(r.totals.map((t) => t.currency), ['CHF', 'EUR'], 'the EUR invoice apart, the credit note in CHF with its minus');
  for (const t of r.totals) {
    const own = issued.filter((i) => i.currency === t.currency);
    assert.equal(cents(t.amount), own.reduce((n, i) => n + cents(invoiceTotals(i.lines).gross), 0), t.currency);
    assert.equal(cents(t.tax), own.reduce((n, i) => n + cents(invoiceTotals(i.lines).vat), 0), t.currency);
  }
});

test('receipts dated in the period, with the VAT their MWST block shows', () => {
  const r = run({ title: 'Belege', period: '2026-Q3', sections: [{ source: 'receipts' }] });
  assert.ok(r.count > 0);
  for (const row of r.sections[0].groups[0].rows) {
    assert.ok(row.date >= Q3.from && row.date <= Q3.to);
    const rec = books.receipts.find((x) => x.id === row.link.id)!;
    assert.equal(cents(row.tax), (rec.vatSummary ?? []).reduce((n, g) => n + cents(g.vat), 0));
  }
});

/** A fixture worked by hand: a purchase with 8.1 %, its partial refund, a booking in EUR, a sale, all on one payment each. */
const fixture: Index = {
  receipts: [{ id: 'r1', filename: 'kabel.pdf' } as Index['receipts'][number]],
  mappings: [{ receiptId: 'r1', transactionRef: 'p1' } as Index['mappings'][number]],
  bankStatements: [],
  transactions: [
    { ref: 'p1', bank: 'UBS', date: '2026-07-03', amount: 108.1, currency: 'CHF', direction: 'DBIT', description: 'Kabelhaus AG' },
    { ref: 'p2', bank: 'UBS', date: '2026-07-20', amount: 54.05, currency: 'CHF', direction: 'CRDT', description: 'Kabelhaus AG Gutschrift' },
    { ref: 'p3', bank: 'Wise EUR', date: '2026-08-02', amount: 100, currency: 'EUR', direction: 'DBIT', description: 'Hosting GmbH' },
    { ref: 'p4', bank: 'UBS', date: '2026-08-15', amount: 1081, currency: 'CHF', direction: 'CRDT', description: 'Kunde Meier' },
  ],
  journalEntries: [
    { id: 'e1', transactionRef: 'p1', date: '2026-07-03', accountDebit: '6510', accountCredit: '1020', amount: 108.1, vatCode: 'I81', description: 'Kabel', origin: 'classify' },
    { id: 'e2', transactionRef: 'p2', date: '2026-07-20', accountDebit: '1020', accountCredit: '6510', amount: 54.05, vatCode: '-I81', description: 'Kabel Gutschrift', origin: 'manual' },
    { id: 'e3', transactionRef: 'p3', date: '2026-08-02', accountDebit: '6570', accountCredit: '1025', amount: 100, exchangeCurrency: 'EUR', exchangeRate: 0.95, vatCode: 'I0', description: 'Hosting' },
    { id: 'e4', transactionRef: 'p4', date: '2026-08-15', accountDebit: '1020', accountCredit: '3200', amount: 1081, vatCode: 'V81', description: 'Verkauf Meier' },
  ] as JournalEntry[],
};
const fix = (raw: unknown) => runReport(spec(raw), { books: fixture, invoices: [], names: { '6510': 'Telefon', '6570': 'Informatik', '3200': 'Handel', '1020': 'Bank' } }, Q3);

test('fixture: the refund counts against the purchase, the EUR booking in CHF at its rate, tax and net to the Rappen', () => {
  const r = fix({ title: 'Aufwand', period: '2026-Q3', sections: [{ source: 'entries', filter: { accounts: ['6000-6999'] }, group: 'account', columns: ['date', 'text', 'amount', 'net', 'tax', 'currency', 'receipt'] }] });
  const [phone, it] = r.sections[0].groups;
  assert.deepEqual(phone.rows.map((x) => [x.link.id, x.amount, x.net, x.tax, x.receipt]), [['e1', 108.1, 100, 8.1, 'kabel.pdf'], ['e2', -54.05, -50, -4.05, '']]);
  assert.deepEqual(phone.totals, [{ currency: 'CHF', count: 2, amount: 54.05, net: 50, tax: 4.05 }]);
  assert.deepEqual(it.rows.map((x) => [x.amount, x.currency, x.counterAccount]), [[95, 'CHF', '1025']], 'a booking in EUR counts in the books\' currency at its rate');
  assert.deepEqual(r.totals, [{ currency: 'CHF', count: 3, amount: 149.05, net: 145, tax: 4.05 }]);
  assert.equal(fix({ title: 'X', period: '2026-Q3', sections: [{ source: 'entries', filter: { currencies: ['eur'] } }] }).count, 1);
  assert.equal(fix({ title: 'X', period: '2026-Q3', sections: [{ source: 'entries', filter: { accounts: ['6510'], origins: ['manual'] } }] }).count, 1);
  assert.equal(fix({ title: 'X', period: '2026-Q3', sections: [{ source: 'entries', filter: { receipt: 'without', accounts: ['6000-6999'] } }] }).count, 2);
  assert.equal(fix({ title: 'X', period: '2026-Q3', sections: [{ source: 'entries', filter: { text: 'gutschrift' } }] }).sections[0].groups[0].rows[0].link.id, 'e2');
  assert.equal(fix({ title: 'X', period: '2026-07', sections: [{ source: 'entries' }] }).count, 4, 'the spec\'s period is the default; the run takes the one it is given');
});

test('fixture: without an account filter each booking is one row; a transfer inside the filtered accounts nets to zero', () => {
  const r = fix({ title: 'Alles', period: '2026-Q3', sections: [{ source: 'entries' }] });
  assert.deepEqual(r.sections[0].groups[0].rows.map((x) => [x.account, x.counterAccount, x.amount]), [['6510', '1020', 108.1], ['1020', '6510', 54.05], ['6570', '1025', 95], ['1020', '3200', 1081]]);
  const both = fix({ title: 'Bank und Telefon', period: '2026-Q3', sections: [{ source: 'entries', filter: { accounts: ['1020', '6510'] }, group: 'account' }] });
  assert.equal(both.sections[0].groups.find((g) => g.key === '1020')!.totals[0].amount, -108.1 + 54.05 + 1081);
});

test('the comment\'s placeholders are filled from the result, one amount per currency; a preview keeps every row\'s totals', () => {
  const raw = { title: 'Zwei', period: '2026-Q3', comment: '{title} {period}: {count} Zeilen, {section1.total}; Zahlungen {section2.total}.', sections: [{ source: 'entries', filter: { accounts: ['6510'] } }, { source: 'payments' }] };
  const r = fix(raw);
  const money = (n: number, c: string) => `${c} ${n.toFixed(2)}`;
  assert.equal(fillComment(r, money, { period: 'Q3 2026', date: (d) => d }), 'Zwei Q3 2026: 6 Zeilen, CHF 54.05; Zahlungen CHF 1026.95 · EUR -100.00.');
  const p = previewOf(r, 1);
  assert.equal(p.sections[0].groups[0].rows.length, 1);
  assert.deepEqual(p.sections[0].totals, r.sections[0].totals);
  assert.equal(chart().isDebitNormal('6510'), true);
});
