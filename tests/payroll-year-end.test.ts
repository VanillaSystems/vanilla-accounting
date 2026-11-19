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
import { ch, closedThrough, dated, firm, owner } from './support/payroll.js';

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
  for (const i of p.insurers) assert.deepEqual([i.open, insurerState(i)], [0, 'ok'], i.account);
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
  const pk = payrollYearEnd(input).insurers.find((i) => i.account === '2275')!;
  assert.deepEqual([pk.open > 0, pk.settlement, insurerState(pk)], [true, [], 'open']);
  assert.deepEqual([pk.compare?.before, pk.compare?.books], [0, pk.accrued], 'the final statement\'s comparison: without an opening, the payslips\' accrual alone');
  (input.books.journalEntries as JournalEntry[]).push({ id: 'ls', transactionRef: 'LS-2026-pk', date: '2027-01-20', accountDebit: '5720', accountCredit: '2275', amount: 12, by: { kind: 'code', check: 'payroll' } });
  const settled = payrollYearEnd(input).insurers.find((i) => i.account === '2275')!;
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

/** Books of the owner's closed months as code books them, each payout paid on its payday; `store` and `until` choose the year(s). */
function booked(store = firm(), until = '2026-13', events: PayslipClose[] = []) {
  const all = closedThrough(store, until, 'e1', events) as PayslipClose[];
  const closes = all.map((c) => ({ ...c, receiptId: `r-${c.id}` }));
  const journalEntries: JournalEntry[] = []; const transactions: BankTransaction[] = []; const mappings: Mapping[] = [];
  for (const c of closes) {
    const es = entriesOf({ booking: bookingOf(c, ch.payroll!, store) }, id, c.receiptId);
    c.entries = es.map((e) => e.id);
    journalEntries.push(...es);
    const ref = `PAY-${c.month}`;
    transactions.push({ ref, bank: 'Bank', date: c.payday, amount: -c.payout, currency: 'CHF', direction: 'DBIT', description: 'Lohn', counterparty: c.person.name });
    journalEntries.push({ id: id(), transactionRef: ref, date: c.payday, accountDebit: '1091', accountCredit: '1020', amount: c.payout, by: { kind: 'code', check: 'payroll' }, receipts: [c.receiptId] });
    mappings.push({ transactionRef: ref, receiptId: c.receiptId });
  }
  const input = (year = '2026'): PayrollYearEndInput => ({ year, books: { journalEntries, transactions, mappings }, closes, employees: store.employees, data: ch.payroll!, store, issued: [], isDebitNormal: (a) => chart().isDebitNormal(a), wageAccount: '5000', deductionsAccount: '2270' });
  return { store, closes, journalEntries, transactions, mappings, input };
}

test('a family allowance paid with the wage is in the statement\'s gross field and in her gross: no difference', () => {
  const store = firm();
  store.monthLines = Array.from({ length: 12 }, (_, i) => ({ id: `k${i}`, employee: 'e1', month: `2026-${String(i + 1).padStart(2, '0')}`, wageType: 'kinderzulage', amount: 215, enteredAt: '2026-01-02T00:00:00Z' }));
  const b = booked(store);
  const s = payrollYearEnd(b.input()).statements[0];
  const grossOfSlips = b.closes.reduce((a, c) => a + c.gross, 0);
  assert.deepEqual([s.gross, s.difference, statementState(s)], [Math.round((grossOfSlips + 12 * 215) * 100) / 100, 0, 'open'], 'the allowances are in field 1, so in the form\'s gross');
  assert.equal(payrollYearEnd(b.input()).wages!.persons[0].difference, 0, 'they are not booked on the wage account, nor expected there');
});

test('a Lohnart booked on another account since: what each payslip booked when it closed is the expected, no false difference', () => {
  const b = booked();
  b.store.wageTypes = [{ key: 'monatslohn', debit: '5001' }];
  const w = payrollYearEnd(b.input()).wages!;
  assert.deepEqual([w.difference, w.persons[0].months], [0, []]);
  // A person then changes one of its entries: known by what it was before her change.
  const e = b.journalEntries.find((x) => x.transactionRef === 'LR-2026-05-e1' && x.accountDebit === '5000')!;
  Object.assign(e, { amount: e.amount + 10, by: { kind: 'person', at: '2026-12-01T00:00:00Z', was: { amount: e.amount } }, origin: 'manual' });
  assert.deepEqual(payrollYearEnd(b.input()).wages!.persons[0].months.map((m) => [m.month, m.difference, m.cause]), [['2026-05', 10, undefined]]);
  // Without what it was: the cause is named, never a difference.
  e.by = { kind: 'person', at: '2026-12-01T00:00:00Z' };
  assert.deepEqual(payrollYearEnd(b.input()).wages!.persons[0].months.map((m) => [m.month, m.difference, m.cause]), [['2026-05', 0, 'accountsChanged']]);
});

test('a wage paid from a foreign-currency account: its payout in the books\' currency, no difference on the clearing account', () => {
  const b = booked();
  const e = b.journalEntries.find((x) => x.transactionRef === 'PAY-2026-11')!;
  const chf = e.amount;
  Object.assign(e, { amount: Math.round(chf / 0.8 * 100) / 100, exchangeCurrency: 'EUR', exchangeRate: 0.8, accountCredit: '1021', by: { kind: 'person', at: '2026-11-30T00:00:00Z' }, origin: 'manual' });
  Object.assign(b.transactions.find((x) => x.ref === 'PAY-2026-11')!, { amount: -e.amount, currency: 'EUR' });
  const c = payrollYearEnd(b.input()).clearing!;
  assert.deepEqual([c.unpaid, c.difference], [[], 0]);
});

test('two years: what an insurer\'s account carried into the year is open with it; a December payout paid in January is open at 31.12.', () => {
  const store = firm();
  const b = booked(store, '2027-13', closedThrough(store, '2026-13') as PayslipClose[]);
  // Each month's contributions paid on the 5th of the next month: December's in January.
  const fifth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y + 1}-01-05` : `${y}-${String(mm + 1).padStart(2, '0')}-05`; };
  for (const c of b.closes) {
    for (const e of b.journalEntries.filter((x) => x.transactionRef === `LR-${c.month}-e1` && x.accountCredit === '2275')) {
      b.journalEntries.push({ id: id(), transactionRef: `PK-${c.month}-${e.id}`, date: fifth(c.month), accountDebit: '2275', accountCredit: '1020', amount: e.amount, by: { kind: 'code', check: 'payroll' } });
    }
  }
  const dec = b.closes.find((c) => c.month === '2026-12')!;
  const decPk = b.journalEntries.filter((x) => x.transactionRef === 'LR-2026-12-e1' && x.accountCredit === '2275').reduce((s, x) => s + x.amount, 0);
  const pk26 = payrollYearEnd(b.input('2026')).insurers.find((i) => i.account === '2275')!;
  const pk27 = payrollYearEnd(b.input('2027')).insurers.find((i) => i.account === '2275')!;
  assert.deepEqual([pk26.carried, pk26.open], [0, decPk], 'December\'s contributions are open at 31.12.2026');
  assert.deepEqual([pk27.carried, pk27.open], [decPk, decPk], 'carried into 2027, paid in January, and December 2027\'s open at its end');
  Object.assign(b.journalEntries.find((x) => x.transactionRef === 'PAY-2026-12')!, { date: '2027-01-05' });
  b.transactions.find((x) => x.ref === 'PAY-2026-12')!.date = '2027-01-05';
  assert.deepEqual(payrollYearEnd(b.input('2026')).clearing!.unpaid.map((u) => u.id), [dec.id]);
  const c27 = payrollYearEnd(b.input('2027')).clearing!;
  assert.deepEqual([c27.unpaid, c27.difference], [[], 0], 'the year not opened yet: what 2026 left on 1091 is carried by its entries');
});

test('two persons: a difference on one is hers alone; two insurances on one account are one fact', () => {
  const store = firm([owner(), owner({ id: 'e2', isOwner: false, name: [dated('2026-01-01', { first: 'Nora', last: 'Muster' })] })]);
  store.insurances.push({ id: 'uvgz', kind: 'uvgz', name: 'Zusatz Beispiel', account: '2273', solutions: [{ code: 'Z', rates: [] }], validFrom: '2026-01-01' });
  const both = [...closedThrough(store, '2026-13', 'e1'), ...closedThrough(store, '2026-13', 'e2')] as PayslipClose[];
  const journalEntries = both.flatMap((c) => entriesOf({ booking: bookingOf(c, ch.payroll!, store) }, id));
  const wage = journalEntries.find((e) => e.transactionRef === 'LR-2026-03-e2' && e.accountDebit === '5000')!;
  wage.amount += 25;
  const p = payrollYearEnd({ year: '2026', books: { journalEntries, transactions: [], mappings: [] }, closes: both, employees: store.employees, data: ch.payroll!, store, issued: [], isDebitNormal: (a) => chart().isDebitNormal(a), wageAccount: '5000' });
  assert.deepEqual(p.wages!.persons.map((x) => [x.employee, x.difference]).sort(), [['e1', 0], ['e2', 25]]);
  const accident = p.insurers.filter((i) => i.account === '2273');
  assert.equal(accident.length, 1, 'one fact for the account, not its balance twice');
  assert.deepEqual(accident[0].insurances.map((x) => x.id).sort(), ['uvg', 'uvgz']);
  assert.equal(p.statements.length, 2);
});

test('a person\'s change of a payslip\'s entry, as the app records it (no account changed since): exactly her change on that month', () => {
  const b = booked();
  const e = b.journalEntries.find((x) => x.transactionRef === 'LR-2026-08-e1' && x.accountDebit === '5000')!;
  Object.assign(e, { amount: e.amount - 10, by: { kind: 'person', at: '2026-12-01T00:00:00Z' }, origin: 'manual' });
  const p = payrollYearEnd(b.input()).wages!.persons[0];
  assert.deepEqual([p.difference, p.months.map((m) => [m.month, m.difference])], [-10, [['2026-08', -10]]]);
});

test('the statement check counts the payslips the Lohnausweis counts: a month reopened and closed again once, a month of the opening never', async () => {
  const { historyOf } = await import('../src/payroll/history.js');
  const { computePayslip } = await import('../src/payroll/compute.js');
  const { closeOf, ctxOf, owner: own } = await import('./support/payroll.js');
  const store = firm([own({ opening: { '2026': { through: '2026-03', months: 3, fields: { '1': 30000 } } } })]);
  const events = closedThrough(store, '2026-13') as PayslipClose[];
  // A close of an opening month (written before the opening was): the Lohnausweis leaves it out, so must the check.
  const stray = { ...events.find((c) => c.month === '2026-04')!, id: '2026-02-e1', month: '2026-02', postingDate: '2026-02-28' };
  // November reopened, a bonus added, closed again: only the second close stands.
  const nov = events.find((c) => c.month === '2026-11')!;
  store.monthLines = [{ id: 'b', employee: 'e1', month: '2026-11', wageType: 'bonus', amount: 1000, enteredAt: '2026-11-20T00:00:00Z' }];
  const again = closeOf(computePayslip(ctxOf(store, [...events, stray, { event: 'reopen', id: nov.id, at: '2026-11-21T00:00:00Z', by: 'person' }]), 'e1', '2026-11')!);
  const closes = [...historyOf([...events, stray, { event: 'reopen', id: nov.id, at: '2026-11-21T00:00:00Z', by: 'person' }, again]).closed.values()];
  const s = payrollYearEnd({ year: '2026', books: { journalEntries: [], transactions: [], mappings: [] }, closes, employees: store.employees, data: ch.payroll!, store, issued: [], isDebitNormal: (a) => chart().isDebitNormal(a) }).statements[0];
  assert.deepEqual([s.difference, s.unmapped], [0, []]);
  assert.equal(s.today, Math.round(s.gross), 'the form and the check sum the same payslips');
  assert.ok(closes.some((c) => c.month === '2026-02') && s.gross < closes.filter((c) => c.month >= '2026-04').reduce((a, c) => a + c.gross, 0) + 30000 + 1, 'the opening month\'s stray close is in neither');
});
