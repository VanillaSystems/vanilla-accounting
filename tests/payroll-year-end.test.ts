/**
 * The payroll's checks of the year-end (src/payroll/year-end.ts, docs/specs/payroll.md §6.7, §10.2 A7, §15.4
 * A-3): a year closed with payslips and payments shows no difference anywhere; a person's change of one
 * payslip's entry by CHF 10 shows exactly that on that person and month; a December payout not paid by 31.12.
 * is what the clearing account holds; an insurer whose year is open without a final statement is a fact; the
 * social insurances' year-end step is booked by the final statements.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, JournalEntry, Mapping } from '../src/types/index.js';
import { chart } from '../src/engines/index.js';
import { bookingOf } from '../src/payroll/booking.js';
import { entriesOf } from '../src/payroll/close.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import { lohnausweisOf } from '../src/payroll/documents.js';
import { insurerRows } from '../src/payroll/insurers.js';
import type { PayslipClose } from '../src/payroll/model.js';
import { payrollYearEnd, wageCheck, type PayrollYearEndInput } from '../src/payroll/year-end.js';
import { insurerState, payrollStates, statementState } from '../src/app/areas/close/payroll-state.js';
import { settlementsOf } from '../src/accounting/year-close.js';
import { ch, closedThrough, firm } from './support/payroll.js';

let n = 0;
const id = () => `x${++n}`;

/** A year of the owner's twelve payslips, each booked, its payout paid on the payday, every insurer paid what it accrued, the statement issued. */
function year(opts: { unpaid?: string[]; unpaidInsurer?: string } = {}) {
  const store = firm();
  const closes = (closedThrough(store, '2026-13') as PayslipClose[]).map((c) => ({ ...c, receiptId: `r-${c.id}` }));
  const journalEntries: JournalEntry[] = [];
  const transactions: BankTransaction[] = [];
  const mappings: Mapping[] = [];
  for (const c of closes) {
    journalEntries.push(...entriesOf({ booking: bookingOf(c, ch.payroll!, store) }, id, c.receiptId));
    if (opts.unpaid?.includes(c.month)) continue;
    const ref = `PAY-${c.month}`;
    transactions.push({ ref, bank: 'Bank', date: c.payday, amount: -c.payout, currency: 'CHF', direction: 'DBIT', description: `Lohn ${c.month}`, counterparty: c.person.name });
    journalEntries.push({ id: id(), transactionRef: ref, date: c.payday, accountDebit: ch.payroll!.clearing, accountCredit: '1020', amount: c.payout, by: { kind: 'code', check: 'payroll' }, receipts: [c.receiptId!] });
    mappings.push({ transactionRef: ref, receiptId: c.receiptId! });
  }
  for (const r of insurerRows({ journalEntries }, ch.payroll!, store, '2026')) {
    if (r.id === opts.unpaidInsurer) continue;
    const ref = `INS-${r.id}`;
    transactions.push({ ref, bank: 'Bank', date: '2026-12-20', amount: -r.accrued, currency: 'CHF', direction: 'DBIT', description: r.name, counterparty: r.name });
    journalEntries.push({ id: id(), transactionRef: ref, date: '2026-12-20', accountDebit: r.account, accountCredit: '1020', amount: r.accrued, by: { kind: 'code', check: 'payroll' } });
  }
  const statement = lohnausweisOf(store.employees[0], closes, firmWageTypes(ch.payroll!, store), ch.payroll!, '2026');
  const input: PayrollYearEndInput = {
    year: '2026', books: { journalEntries, transactions, mappings }, closes, employees: store.employees, data: ch.payroll!, store,
    issued: [{ id: 'la1', employee: 'e1', issuedAt: '2027-01-10T09:00:00.000Z', data: statement }],
    isDebitNormal: (a) => chart().isDebitNormal(a), wageAccount: '5000', deductionsAccount: '2270',
  };
  return { store, closes, input };
}

test('a year closed with payslips and payments: every check agrees, to the Rappen', () => {
  const { input, closes } = year();
  const p = payrollYearEnd(input);
  assert.deepEqual([p.clearing!.balance, p.clearing!.expected, p.clearing!.difference, p.clearing!.unpaid.length], [0, 0, 0, 0]);
  assert.ok(p.insurers.length >= 4);
  for (const i of p.insurers) assert.deepEqual([i.open, insurerState(i)], [0, 'ok'], i.id);
  const gross = closes.reduce((s, c) => s + c.gross, 0);
  assert.equal(p.wages!.booked, Math.round(gross * 100) / 100, '5000 holds the year\'s gross: every line of these payslips books on it');
  assert.deepEqual([p.wages!.difference, p.wages!.other, p.wages!.persons[0].difference, p.wages!.persons[0].months], [0, 0, 0, []]);
  const s = p.statements[0];
  assert.deepEqual([s.difference, s.unmapped, s.openMonths, s.issued?.value === s.today, statementState(s)], [0, [], [], true, 'ok']);
  assert.equal(s.today, Math.round(gross));
  assert.equal(p.withheld, undefined, 'no wage touched the collective account: nothing to explain');
  assert.deepEqual([...new Set(payrollStates(p))], ['ok']);
});

test('a person\'s change of one payslip\'s entry by CHF 10 shows exactly that on that person and that month', () => {
  const { input } = year();
  const wage = input.books.journalEntries.find((e) => e.transactionRef === 'LR-2026-07-e1' && e.accountDebit === '5000')!;
  (input.books.journalEntries as JournalEntry[]).splice(input.books.journalEntries.indexOf(wage), 1, { ...wage, amount: wage.amount + 10, origin: 'manual' });
  const p = payrollYearEnd(input);
  const person = p.wages!.persons.find((x) => x.employee === 'e1')!;
  assert.equal(person.difference, 10);
  assert.deepEqual(person.months, [{ month: '2026-07', id: '2026-07-e1', expected: wage.amount, booked: wage.amount + 10, difference: 10 }]);
  assert.equal(p.wages!.difference, 10);
  assert.equal(p.wages!.other, 0, 'the change is the payslip\'s ref: it is hers, not a wage booked otherwise');
  assert.equal(p.clearing!.difference, 10, 'its other side is the clearing account: 10 more than the payouts owe');
  assert.ok(payrollStates(p).includes('warn'));
});

test('a December payout not paid by 31.12. is what the clearing account holds: named, no difference', () => {
  const { input, closes } = year({ unpaid: ['2026-12'] });
  const dec = closes.find((c) => c.month === '2026-12')!;
  const c = payrollYearEnd(input).clearing!;
  assert.deepEqual(c.unpaid, [{ id: dec.id, employee: 'e1', name: dec.person.name, month: '2026-12', payout: dec.payout, open: dec.payout }]);
  assert.deepEqual([c.balance, c.expected, c.difference], [dec.payout, dec.payout, 0]);
});

test('a payout paid in January is still unpaid at 31.12.', () => {
  const { input, closes } = year();
  const dec = closes.find((c) => c.month === '2026-12')!;
  const tx = input.books.transactions.find((t) => t.ref === 'PAY-2026-12')! as BankTransaction;
  tx.date = '2027-01-05';
  const e = input.books.journalEntries.find((x) => x.transactionRef === 'PAY-2026-12')! as JournalEntry;
  e.date = '2027-01-05';
  const c = payrollYearEnd(input).clearing!;
  assert.deepEqual([c.unpaid.map((u) => u.month), c.balance, c.difference], [['2026-12'], dec.payout, 0]);
});

test('an insurer whose year is open without a final statement is a fact to book; with one booked it is settled', () => {
  const { input } = year({ unpaidInsurer: 'pk' });
  const pk = payrollYearEnd(input).insurers.find((i) => i.id === 'pk')!;
  assert.deepEqual([pk.open > 0, pk.settlement, insurerState(pk)], [true, [], 'open']);
  assert.deepEqual([pk.compare?.before, pk.compare?.books], [0, pk.accrued], 'the final statement\'s comparison: without an opening, the payslips\' accrual alone');
  (input.books.journalEntries as JournalEntry[]).push({ id: 'ls', transactionRef: 'LS-2026-pk', date: '2027-01-20', accountDebit: '5720', accountCredit: '2275', amount: 12, by: { kind: 'code', check: 'payroll' } });
  const settled = payrollYearEnd(input).insurers.find((i) => i.id === 'pk')!;
  assert.deepEqual([settled.open, settled.settlement.map((s) => s.ref), insurerState(settled)], [pk.open + 12, ['LS-2026-pk'], 'ok']);
  assert.deepEqual(settlementsOf(input.books.journalEntries, '2026').map((b) => b.transactionRef), ['LS-2026-pk'], 'the year-end step of the social insurances is booked by it');
  assert.deepEqual(settlementsOf(input.books.journalEntries, '2027'), []);
});

test('a statement not issued yet is open; one issued before a payslip changed names both figures', () => {
  const { input } = year();
  assert.equal(statementState(payrollYearEnd({ ...input, issued: [] }).statements[0]), 'open');
  const issued = [{ ...input.issued[0], data: { fields: { ...input.issued[0].data.fields, '8': input.issued[0].data.fields['8'] - 100 } } }];
  const s = payrollYearEnd({ ...input, issued }).statements[0];
  assert.deepEqual([s.issued!.value, s.today - s.issued!.value, statementState(s)], [s.today - 100, 100, 'warn']);
});

test('wages booked otherwise (level A) are named as such; a source of read payslips claims them by their refs', () => {
  const books = { journalEntries: [
    { id: 'a', transactionRef: 'B-1', date: '2026-03-25', accountDebit: '5000', accountCredit: '1020', amount: 4500 },
    { id: 'b', transactionRef: 'B-1', date: '2026-03-25', accountDebit: '5000', accountCredit: '2270', amount: 500 },
  ] as JournalEntry[] };
  assert.deepEqual([wageCheck(books, '5000', '2026', []).other, wageCheck(books, '5000', '2026', []).booked], [5000, 5000]);
  const read = wageCheck(books, '5000', '2026', [{ employee: 'Jana', name: 'Jana Muster', month: '2026-03', id: 'B-1', gross: 5000, expected: 5000, refs: ['B-1'], source: 'external' }]);
  assert.deepEqual([read.other, read.persons[0].difference], [0, 0]);
});

test('level A: the collective account at 31.12. explained by what the wages withheld and what the funds were paid', () => {
  const { input } = year();
  const transactions = [
    { ref: 'W-1', bank: 'Bank', date: '2026-03-25', amount: -4500, currency: 'CHF', direction: 'DBIT' as const, description: 'Lohn März', counterparty: 'Jana Muster' },
    { ref: 'AK-1', bank: 'Bank', date: '2026-04-10', amount: -400, currency: 'CHF', direction: 'DBIT' as const, description: 'Akonto', counterparty: 'Ausgleichskasse' },
  ];
  const journalEntries = [
    { id: 'a', transactionRef: 'W-1', date: '2026-03-25', accountDebit: '5000', accountCredit: '1020', amount: 4500 },
    { id: 'b', transactionRef: 'W-1', date: '2026-03-25', accountDebit: '5000', accountCredit: '2270', amount: 500 },
    { id: 'c', transactionRef: 'AK-1', date: '2026-04-10', accountDebit: '2270', accountCredit: '1020', amount: 300 },
    { id: 'd', transactionRef: 'AK-1', date: '2026-04-10', accountDebit: '5700', accountCredit: '1020', amount: 100 },
  ] as JournalEntry[];
  const w = payrollYearEnd({ ...input, closes: [], employees: [], issued: [], books: { journalEntries, transactions, mappings: [] } }).withheld!;
  assert.deepEqual([w.opening, w.withheld, w.paid, w.other, w.balance, w.uncleared], [0, 500, 300, 0, 200, []]);
});

test('level A: a contribution payment booked whole on the expense leaves the employees\' share on the account, and is named', () => {
  const { input } = year();
  const transactions = [
    { ref: 'W-1', bank: 'Bank', date: '2026-03-25', amount: -4500, currency: 'CHF', direction: 'DBIT' as const, description: 'Lohn März', counterparty: 'Jana Muster' },
    { ref: 'AK-1', bank: 'Bank', date: '2026-04-10', amount: -400, currency: 'CHF', direction: 'DBIT' as const, description: 'Akonto', counterparty: 'Ausgleichskasse' },
  ];
  const journalEntries = [
    { id: 'a', transactionRef: 'W-1', date: '2026-03-25', accountDebit: '5000', accountCredit: '1020', amount: 4500 },
    { id: 'b', transactionRef: 'W-1', date: '2026-03-25', accountDebit: '5000', accountCredit: '2270', amount: 500 },
    { id: 'c', transactionRef: 'AK-1', date: '2026-04-10', accountDebit: '5700', accountCredit: '1020', amount: 400 },
  ] as JournalEntry[];
  const w = payrollYearEnd({ ...input, closes: [], employees: [], issued: [], books: { journalEntries, transactions, mappings: [] }, withheldPayees: new Set(['AK-1']) }).withheld!;
  assert.deepEqual([w.withheld, w.paid, w.balance, w.uncleared], [500, 0, 500, [{ ref: 'AK-1', date: '2026-04-10', open: 500 }]]);
});

test('the opening\'s months: wages booked by hand before payroll ran here are the opening, not a difference; booked otherwise, the difference is named', async () => {
  const { owner, firm: firmOf } = await import('./support/payroll.js');
  const store = firmOf([owner({ opening: { '2026': { through: '2026-06', months: 6, fields: { '1': 60000 } } } })]);
  const closes = (closedThrough(store, '2026-13') as PayslipClose[]).filter((c) => c.month > '2026-06');
  const journalEntries: JournalEntry[] = closes.flatMap((c) => entriesOf({ booking: bookingOf(c, ch.payroll!, store) }, id));
  for (const m of ['01', '02', '03', '04', '05', '06']) journalEntries.push({ id: id(), transactionRef: `H-${m}`, date: `2026-${m}-25`, accountDebit: '5000', accountCredit: '1020', amount: 10000 });
  const input = { year: '2026', books: { journalEntries, transactions: [], mappings: [] }, closes, employees: store.employees, data: ch.payroll!, store, issued: [], isDebitNormal: (a: string) => chart().isDebitNormal(a), wageAccount: '5000' };
  const w = payrollYearEnd(input).wages!;
  assert.deepEqual([w.opening, w.other, w.difference], [{ through: '2026-06', expected: 60000, booked: 60000, difference: 0 }, 0, 0]);
  journalEntries.push({ id: id(), transactionRef: 'H-07', date: '2026-07-25', accountDebit: '5000', accountCredit: '1020', amount: 500 });
  journalEntries.push({ id: id(), transactionRef: 'H-06b', date: '2026-06-30', accountDebit: '5000', accountCredit: '1020', amount: 10 });
  const w2 = payrollYearEnd(input).wages!;
  assert.deepEqual([w2.opening!.difference, w2.other], [10, 500], 'a hand booking in the opening\'s months differs from it; one after them is booked otherwise');
});
