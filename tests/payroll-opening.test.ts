/**
 * A person's opening of a year (src/payroll/opening.ts, docs/specs/payroll.md §22 decision 43): January to its
 * last month were paid and booked by hand before payroll ran here. Those months have no draft, are no «noch
 * offen», are never closed here (a data boundary, not a warning), and count once in the Lohnausweis, the
 * declarations and the Lohnkonto. The opening is set by the person form through the settings API, checked.
 * Invented people only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, type ApiServer } from './support/api-server.js';
import { ch, closeOf, closedThrough, ctxOf, dated, firm, owner } from './support/payroll.js';
import { computePayslip } from '../src/payroll/compute.js';
import { inOpening, openingOf } from '../src/payroll/opening.js';
import { PayrollRefusal, planClose } from '../src/payroll/close.js';
import { monthView, payslipView, yearStrip } from '../src/payroll/views.js';
import { declarationRows, lohnausweisOf, lohnkonto } from '../src/payroll/documents.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import { historyOf } from '../src/payroll/history.js';
import { createEmployee, employeeDetail, setOpening } from '../src/payroll/settings.js';
import { appendPayslipEvents, loadPayroll, savePayroll } from '../src/payroll/store.js';
import type { PayrollEmployee, PayslipEvent } from '../src/payroll/model.js';

const data = ch.payroll!;
const refused = (code: PayrollRefusal['code']) => (e: unknown) => e instanceof PayrollRefusal && e.code === code;
/** The demo's shape: the owner paid January to September by hand, the opening written with `months` only (before `through` existed). */
const withOpening = (o: NonNullable<PayrollEmployee['opening']>[string] = { months: 9, bases: { ahv: 90000, alv: 90000, bvg: 90000, thirteenth: 90000 }, fields: { 1: 90000, 9: 5715, '10.1': 2700 } }) =>
  owner({ opening: { 2026: o } });

test('the opening\'s months are explicit: `through`, or `months` counted from January', () => {
  assert.equal(openingOf(withOpening(), '2026')?.through, '2026-09');
  assert.equal(openingOf(withOpening({ through: '2026-06' }), '2026')?.through, '2026-06');
  assert.equal(openingOf(withOpening({ through: '2026-06' }), '2026')?.months, 6, 'its months counted when only `through` is given');
  const mid = owner({ employment: [dated('2026-07-01', { kind: 'monthly' as const, amount: 6000 })], opening: { 2026: { months: 6 } } });
  assert.equal(openingOf(mid, '2026')?.through, '2026-06', 'January to June, paid before her employment was recorded here in July');
  assert.equal(openingOf(owner({ opening: { 2026: { months: 8.5 } } }), '2026')?.through, '2026-09', 'a part month counts whole');
  assert.equal(inOpening(withOpening(), '2026-09'), true);
  assert.equal(inOpening(withOpening(), '2026-10'), false);
  assert.equal(openingOf(owner(), '2026'), undefined);
});

test('an opening month has no draft, the strip says «Eröffnung», and October is the first draft without «Januar ist noch offen»', () => {
  const store = firm([withOpening()]);
  const ctx = ctxOf(store);
  assert.equal(computePayslip(ctx, 'e1', '2026-03'), undefined);
  const oct = computePayslip(ctx, 'e1', '2026-10')!;
  assert.ok(oct, 'October is a draft');
  assert.ok(!oct.facts.some((f) => f.key === 'earlierOpen'), 'no earlier month is open: January to September are the opening');
  const strip = yearStrip(ctx, '2026', '2026-11-19');
  assert.deepEqual(strip.map((m) => m.state), ['opening', 'opening', 'opening', 'opening', 'opening', 'opening', 'opening', 'opening', 'opening', 'open', 'open', 'future']);
  const sep = monthView(ctx, '2026-09');
  assert.deepEqual([sep.rows.length, sep.opening.map((o) => [o.employee, o.through])], [0, [['e1', '2026-09']]]);
  assert.equal(payslipView(ctx, 'e1', '2026-10', { isClosed: () => false })!.months.filter((m) => m.status === 'opening').length, 9);
});

test('closing an opening month is refused with its reason: the wage is booked already', () => {
  const ctx = ctxOf(firm([withOpening()]));
  assert.throws(() => planClose(ctx, 'e1', '2026-07', new Set()), refused('opening'));
  assert.doesNotThrow(() => planClose(ctx, 'e1', '2026-10', new Set()));
});

test('the ceilings and the 13th start from the opening: October caps as the tenth month of the year', () => {
  const store = firm([owner({ employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 14000, thirteenth: { months: [12] } })], opening: { 2026: { through: '2026-09', bases: { alv: 9 * 14000, ahv: 9 * 14000, thirteenth: 9 * 14000 } } } })]);
  const oct = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  assert.equal(oct.bases.ahv.year, 10 * 14000, 'the year\'s base holds the opening once');
  const events = closedThrough(store, '2026-12');
  const dec = computePayslip(ctxOf(store, events), 'e1', '2026-12')!;
  const thirteenth = dec.lines.find((l) => l.wageType === [...firmWageTypes(data, store).values()].find((w) => w.computes === 'thirteenth')!.key)!;
  assert.equal(thirteenth.base, 12 * 14000, 'the 13th counts the opening\'s nine months and October to December once each');
});

test('the Lohnausweis counts each month once: the opening\'s fields and the closes after it; a close of an opening month made before counts no more', () => {
  const store = firm([owner()]);
  const ctx0 = ctxOf(store);
  // July was closed here before the opening said so (the walk's double booking): it stands in the history.
  const july = closeOf(computePayslip(ctx0, 'e1', '2026-07')!);
  store.employees[0] = { ...withOpening(), id: 'e1' };
  let events: PayslipEvent[] = [july];
  for (const m of ['2026-10', '2026-11', '2026-12']) events = [...events, closeOf(computePayslip(ctxOf(store, events), 'e1', m)!)];
  const closes = [...historyOf(events).closed.values()];
  const types = firmWageTypes(data, store);
  const l = lohnausweisOf(store.employees[0], closes, types, data, '2026');
  assert.equal(l.fields['1'], 90000 + 3 * 10000, 'nine months of the opening and three closes; July once, by the opening');
  assert.deepEqual(l.openMonths, [], 'every month after the opening is closed');
  assert.equal(l.opening?.through, '2026-09');
  const d = declarationRows(store.employees, closes, '2026')[0];
  assert.equal(d.bases.ahv, 120000);
  assert.equal(d.opening?.bases.ahv, 90000);
  const k = lohnkonto(closes, types, '2026', 'de', store.employees);
  assert.equal(k.totals.gross.months[6], 0, 'July\'s close is not in the Lohnkonto: the opening holds that month');
  assert.deepEqual(k.opening?.people, [{ employee: 'e1', through: '2026-09' }]);
  assert.equal(k.opening?.bases.ahv, 90000);
});

test('the Lohnausweis is open only for the months after the opening', () => {
  const store = firm([withOpening()]);
  const events = [closeOf(computePayslip(ctxOf(store), 'e1', '2026-10')!)];
  const l = lohnausweisOf(store.employees[0], [...historyOf(events).closed.values()], firmWageTypes(data, store), data, '2026');
  assert.deepEqual(l.openMonths, ['2026-11', '2026-12']);
});

test('setting an opening: checked by the jurisdiction\'s bases and fields, refused over a month closed here, removed with null', () => {
  const store = firm([owner()]);
  const history = historyOf(closedThrough(store, '2026-08'));
  assert.throws(() => setOpening(store, data, history, 'e1', '2026', { through: '2026-09' }), refused('used'), 'July and August are closed and booked here');
  assert.throws(() => setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2027-01' }), refused('badInput'));
  assert.throws(() => setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-09', bases: { nope: 1 } }), refused('badInput'));
  assert.throws(() => setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-09', bases: { ahv: -1 } }), refused('badInput'));
  assert.throws(() => setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-09', fields: { 8: 100 } }), refused('badInput'), 'a sum of the form is computed, never entered');
  setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-09', bases: { ahv: 90000 }, fields: { 1: 90000 } });
  assert.deepEqual(store.employees[0].opening, { 2026: { through: '2026-09', bases: { ahv: 90000 }, fields: { 1: 90000 } } });
  const detail = employeeDetail(ctxOf(store), 'e1', '2026', '2026-11-19', (n) => n);
  assert.equal(detail.defaultFrom, '2026-10-01', '«gilt ab» after the opening');
  assert.equal(detail.months.filter((m) => m.status === 'opening').length, 9);
  setOpening(store, data, historyOf([]), 'e1', '2026', null);
  assert.equal(store.employees[0].opening, undefined);
});

test('«Person hinzufügen» takes the opening at once', () => {
  const store = firm([]);
  const e = createEmployee(store, data, { first: 'Nora', last: 'Muster', birthDate: '1990-02-02', validFrom: '2026-01-01', employment: { kind: 'monthly', amount: 5000 }, opening: { through: '2026-05', bases: { ahv: 25000 }, fields: { 1: 25000 } } }, 'p1', '2026-06-01T00:00:00.000Z');
  assert.deepEqual(e.opening, { 2026: { through: '2026-05', bases: { ahv: 25000 }, fields: { 1: 25000 } } });
});

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  savePayroll(api.ws, firm([withOpening({ through: '2026-09', bases: { ahv: 90000 } })]));
  appendPayslipEvents(api.ws, '2026', []);
});
after(() => api?.stop());

test('routes: an opening month refuses its close and its lines with the reason; the opening is set through the settings API', async () => {
  const close = await api.send('POST', '/api/payroll/payslips/2026-08-e1/close', { confirm: true });
  assert.equal(close.status, 409);
  assert.equal((close.json.params as { why: string }).why, 'opening');
  const slip = await api.send('GET', '/api/payroll/payslips/2026-08-e1');
  assert.equal((slip.json.params as { why: string }).why, 'opening');
  const line = await api.send('POST', '/api/payroll/month-lines', { employee: 'e1', month: '2026-08', wageType: 'bonus', amount: 100 });
  assert.equal((line.json.params as { why: string }).why, 'opening');
  const bad = await api.send('PUT', '/api/payroll/employees/e1/opening/2026', { value: { through: '2026-13' } });
  assert.deepEqual([bad.status, (bad.json.params as { field?: string }).field], [400, 'openingThrough']);
  const set = await api.send('PUT', '/api/payroll/employees/e1/opening/2026', { value: { through: '2026-06', bases: { ahv: 60000 } } });
  assert.equal(set.json.saved, true);
  assert.equal(loadPayroll(api.ws).employees[0].opening?.['2026']?.through, '2026-06');
  const strip = await api.send('GET', '/api/payroll?year=2026');
  assert.deepEqual((strip.json.months as Array<{ state: string }>).slice(5, 7).map((m) => m.state), ['opening', 'open']);
});

test('routes: a final statement for the whole year against October alone is said first, with its figures; «Trotzdem buchen» books it', async () => {
  // The opening is through June here (the test above); July closes as the first month of payroll here.
  const closed = await api.send('POST', '/api/payroll/payslips/2026-07-e1/close', { confirm: true });
  assert.equal(closed.json.closed, true);
  const first = await api.send('POST', '/api/payroll/insurances/ak/settle', { year: '2026', total: 20000, date: '2026-12-31' });
  assert.equal(first.json.booked, null);
  assert.equal(first.json.warning, true);
  const compare = first.json.compare as { accrued: number; before: number; difference: number; large: boolean; openingThrough: string };
  assert.deepEqual([compare.before, compare.large, compare.openingThrough], [0, true, '2026-06']);
  const booked = await api.send('POST', '/api/payroll/insurances/ak/settle', { year: '2026', total: 20000, date: '2026-12-31', confirm: true });
  assert.equal(typeof booked.json.booked, 'string');
  assert.equal(booked.json.amount, compare.difference);
});

test('review: an opening without `through` or `months` (by hand) still counts its figures and holds no month', () => {
  const e = owner({ opening: { 2026: { bases: { ahv: 90000 }, fields: { 1: 90000 } } } });
  const o = openingOf(e, '2026')!;
  assert.deepEqual([o.through, o.months, o.bases.ahv, o.fields['1']], [undefined, 0, 90000, 90000]);
  assert.equal(inOpening(e, '2026-01'), false);
  const store = firm([e]);
  assert.equal(computePayslip(ctxOf(store), 'e1', '2026-10')!.bases.ahv.year, 100000, 'the opening\'s base counts once');
});

test('review: the strip shows the opening\'s months also when the employment is recorded only from after it', () => {
  const late = firm([owner({ employment: [dated('2026-10-01', { kind: 'monthly' as const, amount: 6000 })], opening: { 2026: { through: '2026-09', bases: { ahv: 54000 } } } })]);
  assert.deepEqual(yearStrip(ctxOf(late), '2026', '2026-11-19').map((m) => m.state).slice(0, 10), [...Array(9).fill('opening'), 'open']);
  assert.equal(monthView(ctxOf(late), '2026-05').opening.length, 1);
});

test('review: setting an opening checks its months against `through`; the refusal names the months', () => {
  const store = firm([owner()]);
  assert.throws(() => setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-09', months: 0 }), refused('badInput'), 'no months with a last month');
  assert.throws(() => setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-03', months: 9 }), refused('badInput'), 'more months than January to March');
  setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-09', months: 8.5 });
  setOpening(store, data, historyOf([]), 'e1', '2026', { through: '2026-06' });
  assert.equal(store.employees[0].opening?.['2026']?.months, undefined, 'an edit without months drops the stored ones: they follow `through`');
  assert.throws(() => planClose(ctxOf(store), 'e1', '2026-05', new Set()), (e: unknown) => e instanceof PayrollRefusal && /Mai 2026 .*Januar bis Juni 2026/.test(e.message));
});

test('review: «Person hinzufügen» takes the opening\'s year from today, not from the entry day', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/app/areas/payroll/Employees.tsx', 'utf8');
  assert.ok(src.includes('openingFields(localToday().slice(0, 4))'));
  assert.ok(!/openingFields\(\(f\.validFrom/.test(src));
});

test('review: a KTG the person is not in leaves her a fact, so the change is visible', () => {
  const store = firm([owner({ insurances: [dated('2026-01-01', { bvg: { insurance: 'pk', employee: 300, employer: 300 }, uvg: { insurance: 'uvg', code: 'A1' } })] })]);
  const d = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  assert.ok(!d.lines.some((l) => l.wageType.startsWith('ktg')));
  assert.deepEqual(d.facts.filter((f) => f.key === 'notInsured').map((f) => f.vars?.kind), ['ktg']);
});

test('review: the declarations CSV says what of each base the opening holds', async () => {
  const r = await fetch(`http://127.0.0.1:${api.port}/payroll/documents/2026/declarations.csv`);
  const text = await r.text();
  assert.ok(text.split('\n')[0].includes('davon Eröffnung'));
  assert.ok(text.split('\n')[0].includes('openingThrough'));
});
