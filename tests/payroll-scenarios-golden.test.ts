/**
 * A golden regression of the payroll's contributions over 64 scenarios (the fourth review of fix/payroll-walk3-b,
 * 2026-11-19): ordinary employees (bonus months, negative months, unpaid leave, illness, hourly months of zero, entry
 * and exit, two employments, openings, the age rules) and payments after the exit (Nachzahlungen). Each scenario closes
 * its months in order and keeps every payslip's lines, facts, bases and totals in tests/golden/payroll-scenarios.json.
 * A change of any figure fails here; `UPDATE_SCENARIOS=1` writes the file again, to be reviewed line by line.
 *
 * The expected figures are those of the tree before the Nachzahlung rework (a0d52bba's parent) for the 44 scenarios
 * it computed right. The 20 that differ by design or by the review's fixes, worked by hand:
 * - Small wage, then the year goes over 2,500 (hourly small then big; monthly small wage 200; two employments small
 *   wage; opening legacy months:3): the month that catches up charges the whole year's base once, and the next month
 *   its own base under the ALV ceiling (the parent charged a negative ALV base after the catch-up; finding 3). The year's
 *   ALV base equals its AHV base.
 * - Small wage months now keep a capped ALV base of 0 (bases only: hourly small wage 25/h few hours; monthly small wage
 *   200 with exit; hourly small wage NZ cases; no employment at all; exit 2025 hourly).
 * - Reference age reached after the exit (bonus later the same year; NZ ref age in the exit month; NZ ref age after
 *   exit): the payment is for months before it, no pensioner: ALV owed, no pensioner fact (finding 6, decision 115).
 * - NZ partial closes Oct–Dec (15,000; 6,000 + 50,000): the ceiling over the 3 months held, 37,050, less the
 *   45,000 / 18,000 held: no room / 19,050; wagesNotInApp (finding 2).
 * - NZ second exit: the Nachzahlung of 2028 counts only 2027's months (May–Dec at 12,350 = 98,800 = 8/12 of
 *   148,200): no ALV, no NBU (the parent charged −5,000).
 * - NZ small wage year lifted (12 × 200 + 300): 2,700 over 2,500, 2026's 2,400 caught up. NZ small wage stays under
 *   (12 × 150 + 300 = 2,100), then +500: 2,600, the 1,800 and the 300 caught up.
 * - NZ out of order, NZ earlier open: a later Nachzahlung computed while an earlier one is open says so (earlierOpen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computePayslip } from '../src/payroll/compute.js';
import { historyOf } from '../src/payroll/history.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { ch, closeOf, dated, firm, owner } from './support/payroll.js';

const GOLDEN = join(APP_ROOT, 'tests/golden/payroll-scenarios.json');
/** One payslip as the golden keeps it: its lines, facts, missing lines, bases of the month and totals. */
const slim = (d: any) => d && ({
  month: d.month, lines: d.lines.map((l: any) => [l.wageType, l.base ?? null, l.rate ?? null, l.amount, l.side]),
  facts: d.facts.map((f: any) => (f.vars ? `${f.key} ${JSON.stringify(f.vars)}` : f.key)), missing: d.missing.map((m: any) => `${m.wageType} ${m.missing}`),
  bases: Object.fromEntries(Object.entries(d.bases).map(([k, v]: any) => [k, v.month])), gross: d.gross, net: d.net, payout: d.payout, employer: d.employer,
});
const out: Record<string, any> = {};
const monthly = (amount: number, more: Record<string, unknown> = {}) => ({ kind: 'monthly' as const, amount, pensum: 100, hoursPerWeek: 42, holidayDays: 25, ...more });
const hourly = (amount: number, more: Record<string, unknown> = {}) => ({ kind: 'hourly' as const, amount, hoursPerWeek: 20, ...more });
const staff = (more: any = {}) => owner({ id: 'p1', isOwner: false, birthDate: '1990-04-02', sex: 'f', name: [dated('2025-01-01', { first: 'Nora', last: 'P' })], insurances: [dated('2025-01-01', { uvg: { insurance: 'uvg', code: 'A1' }, ktg: { insurance: 'ktg', code: 'A' } })], ...more });
function years(extra: string[]) { const y26 = ch.payrollYears!['2026']; const out: any = { ...ch.payrollYears }; for (const y of extra) out[y] = { ...y26, year: Number(y), figures: Object.fromEntries(Object.entries(y26.figures).map(([k, f]: any) => [k, { ...(Array.isArray(f) ? f.at(-1) : f), validFrom: `${y}-01-01` }])) }; return out; }
const Y = years(['2027', '2028']);
const ms = (y: string, a = 1, b = 12) => Array.from({ length: b - a + 1 }, (_, i) => `${y}-${String(i + a).padStart(2, '0')}`);
const ml = (month: string, wageType: string, v: any) => ({ id: `${wageType}${month}`, employee: 'p1', month, wageType, enteredAt: `${month}-10T08:00:00Z`, ...(typeof v === 'number' ? { amount: v } : v) });

/** Close `months` in the order given; record each draft. `drafts`: months only computed (not closed) at the end. */
function run(name: string, emp: any, months: string[], lines: any[] = [], drafts: string[] = [], tweak?: (store: any) => void) {
  const store = firm([emp]);
  for (const i of store.insurances) i.validFrom = '2025-01-01';
  store.monthLines = lines;
  tweak?.(store);
  const ev: any[] = [];
  const rec: any[] = [];
  for (const m of months) {
    const d = computePayslip({ data: ch.payroll!, years: Y, store, history: historyOf(ev) }, 'p1', m);
    rec.push(slim(d) ?? { month: m, none: true });
    if (d) ev.push(closeOf(d));
  }
  for (const m of drafts) rec.push({ draft: slim(computePayslip({ data: ch.payroll!, years: Y, store, history: historyOf(ev) }, 'p1', m)) ?? { month: m, none: true } });
  out[name] = rec;
}
const emp = (from: string, v: any, until?: string) => dated(from, v, undefined, until);

// ─── ordinary ───
run('normal 10000 owner-like', staff({ employment: [emp('2026-01-01', monthly(10000))] }), ms('2026'));
run('normal 15000 over ceiling', staff({ employment: [emp('2026-01-01', monthly(15000))] }), ms('2026'));
run('normal 15000 with 13th in 6,12', staff({ employment: [emp('2026-01-01', monthly(15000, { thirteenth: { months: [6, 12] } }))] }), ms('2026'));
run('13th + bonus 30000 in March, 9000', staff({ employment: [emp('2026-01-01', monthly(9000, { thirteenth: { months: [12] } }))] }), ms('2026'), [ml('2026-03', 'bonus', 30000)]);
run('two years in a row 13000', staff({ employment: [emp('2026-01-01', monthly(13000))] }), [...ms('2026'), ...ms('2027')]);
run('entry mid-year 04-16, 15000', staff({ employment: [emp('2026-04-16', monthly(15000))] }), ms('2026'));
run('exit 08-20 with 13th, 15000', staff({ employment: [emp('2026-01-01', monthly(15000, { thirteenth: { months: [12] } }), '2026-08-20')] }), ms('2026'));
run('exit 08-20, bonus in 10 same year', staff({ employment: [emp('2026-01-01', monthly(15000), '2026-08-20')] }), ms('2026'), [ml('2026-10', 'bonus', 20000), ml('2026-12', 'bonus', 5000)]);
run('exit 08-20, low wage, bonus in 10 same year', staff({ employment: [emp('2026-01-01', monthly(4000), '2026-08-20')] }), ms('2026'), [ml('2026-10', 'bonus', 2000)]);
run('unpaid leave July', staff({ employment: [emp('2026-01-01', monthly(15000))], absences: [{ id: 'a1', kind: 'unpaid', from: '2026-07-01', to: '2026-07-31' }] }), ms('2026'));
run('unpaid leave mid June-Aug', staff({ employment: [emp('2026-01-01', monthly(13000))], absences: [{ id: 'a1', kind: 'unpaid', from: '2026-06-10', to: '2026-08-20' }] }), ms('2026'));
run('illness with allowance', staff({ employment: [emp('2026-01-01', monthly(13000))], absences: [{ id: 'a1', kind: 'illness', from: '2026-05-04', to: '2026-06-12', dailyAllowance: 300, continuedPay: 80 }] }), ms('2026'));
const hrs = (h: number[]) => h.flatMap((q, i) => q ? [ml(`2026-${String(i + 1).padStart(2, '0')}`, 'stundenlohn', { quantity: q })] : []);
run('hourly 30/h steady', staff({ employment: [emp('2026-01-01', hourly(30))] }), ms('2026'), hrs([80, 80, 90, 60, 80, 80, 0, 80, 80, 80, 80, 80]));
run('hourly small wage 25/h few hours', staff({ employment: [emp('2026-01-01', hourly(25))] }), ms('2026'), hrs([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]));
run('hourly small then big (catch-up)', staff({ employment: [emp('2026-01-01', hourly(25))] }), ms('2026'), hrs([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 80, 80]));
run('hourly high 200/h over ceiling', staff({ employment: [emp('2026-01-01', hourly(200))] }), ms('2026'), hrs([80, 80, 90, 60, 80, 80, 0, 80, 80, 80, 80, 80]));
run('hourly entry 03-10 exit 10-15', staff({ employment: [emp('2026-03-10', hourly(40), '2026-10-15')] }), ms('2026'), hrs([0, 0, 50, 80, 80, 80, 80, 80, 80, 40, 0, 0]));
run('monthly small wage 200', staff({ employment: [emp('2026-01-01', monthly(200))] }), ms('2026'), [ml('2026-11', 'bonus', 500)]);
run('monthly small wage 200, exit 06-30, bonus 09', staff({ employment: [emp('2026-01-01', monthly(200), '2026-06-30')] }), ms('2026'), [ml('2026-09', 'bonus', 1500)]);
run('two employments Jan-Mar, Sep-Dec 15000', staff({ employment: [emp('2026-01-01', monthly(15000), '2026-03-31'), emp('2026-09-01', monthly(15000))] }), ms('2026'));
run('two employments + bonus in gap June', staff({ employment: [emp('2026-01-01', monthly(15000), '2026-03-31'), emp('2026-09-01', monthly(15000))] }), ms('2026'), [ml('2026-06', 'bonus', 30000)]);
run('two employments mid-month edges', staff({ employment: [emp('2026-01-01', monthly(14000), '2026-03-15'), emp('2026-08-20', monthly(16000, { thirteenth: { months: [12] } }))] }), ms('2026'), [ml('2026-05', 'bonus', 1000)]);
run('two employments small wage', staff({ employment: [emp('2026-01-01', monthly(300), '2026-03-31'), emp('2026-09-01', monthly(300))] }), ms('2026'), [ml('2026-06', 'bonus', 1200)]);
run('opening through 06, 15000', staff({ employment: [emp('2026-01-01', monthly(15000))], opening: { '2026': { through: '2026-06', bases: { ahv: 90000, alv: 74100, uvg: 74100, uvgz: 15900, ktg: 90000, thirteenth: 90000 } } } }), ms('2026', 7, 12));
run('opening through 06, entered 04-01, 20000', staff({ employment: [emp('2026-04-01', monthly(20000, { thirteenth: { months: [12] } }))], opening: { '2026': { through: '2026-06', bases: { ahv: 60000, alv: 37050, uvg: 37050, thirteenth: 60000 } } } }), ms('2026', 7, 12));
run('opening legacy months:3 small wage', staff({ employment: [emp('2026-01-01', monthly(200))], opening: { '2026': { months: 3, bases: { ahv: 600, alv: 600, uvg: 600 } } } }), ms('2026', 4, 12), [ml('2026-10', 'bonus', 900)]);
run('opening with closes of opening months too', staff({ employment: [emp('2026-01-01', monthly(15000))], opening: { '2026': { through: '2026-03', bases: { ahv: 45000, alv: 37050, uvg: 37050 } } } }), ms('2026'));
run('turning 18 in 2026 (born 2008)', staff({ birthDate: '2008-06-15', employment: [emp('2026-01-01', monthly(3000))] }), [...ms('2026'), ...ms('2027', 1, 3)]);
run('17 in 2026 (born 2009), liable 2027', staff({ birthDate: '2009-06-15', employment: [emp('2026-01-01', monthly(3000))] }), [...ms('2026'), ...ms('2027', 1, 3)]);
run('reference age m 1961-06-15', staff({ sex: 'm', birthDate: '1961-06-15', employment: [emp('2026-01-01', monthly(9000))] }), ms('2026'));
run('reference age f 1961-06-15', staff({ sex: 'f', birthDate: '1961-06-15', employment: [emp('2026-01-01', monthly(9000))] }), [...ms('2026'), ...ms('2027', 1, 2)]);
run('reference age f 1962-03-31 high wage', staff({ sex: 'f', birthDate: '1962-03-31', employment: [emp('2026-01-01', monthly(15000))] }), ms('2026'));
run('pensioner small 1500', staff({ sex: 'm', birthDate: '1958-02-01', employment: [emp('2026-01-01', monthly(1500))] }), ms('2026'));
run('pensioner hourly', staff({ sex: 'm', birthDate: '1958-02-01', employment: [emp('2026-01-01', hourly(40))] }), ms('2026'), hrs([10, 10, 10, 60, 60, 10, 10, 10, 10, 10, 10, 10]));
run('reference age reached, exit after, bonus later same year', staff({ sex: 'm', birthDate: '1961-03-15', employment: [emp('2026-01-01', monthly(9000), '2026-08-31')] }), ms('2026'), [ml('2026-11', 'bonus', 5000)]);
run('reference age reached after exit, bonus later same year', staff({ sex: 'm', birthDate: '1961-09-15', employment: [emp('2026-01-01', monthly(9000), '2026-06-30')] }), ms('2026'), [ml('2026-11', 'bonus', 5000)]);
run('months closed out of order', staff({ employment: [emp('2026-01-01', monthly(15000))] }), ['2026-01', '2026-03', '2026-02', '2026-05', '2026-04', ...ms('2026', 6, 12)]);
run('negative bonus (clawback) high wage', staff({ employment: [emp('2026-01-01', monthly(15000))] }), ms('2026'), [ml('2026-04', 'bonus', 20000), ml('2026-09', 'bonus', -30000)]);
run('30/360 proration? default; entry 02-15 exit 11-10', staff({ employment: [emp('2026-02-15', monthly(13500), '2026-11-10')] }), ms('2026'));
run('no employment at all, bonus', staff({ employment: [] }), ['2026-03'], [ml('2026-03', 'bonus', 2000)]);
run('employment starts later; bonus before entry', staff({ employment: [emp('2026-06-01', monthly(15000))] }), ms('2026'), [ml('2026-03', 'bonus', 2000)]);

// ─── Nachzahlung ───
run('NZ: 2026 whole 12300, bonus 2027-02 and 03', staff({ employment: [emp('2026-01-01', monthly(12300), '2026-12-31')] }), [...ms('2026'), '2027-02', '2027-03'], [ml('2027-02', 'bonus', 500), ml('2027-03', 'bonus', 500)]);
run('NZ: out of order', staff({ employment: [emp('2026-01-01', monthly(12300), '2026-12-31')] }), [...ms('2026'), '2027-03', '2027-02'], [ml('2027-02', 'bonus', 500), ml('2027-03', 'bonus', 500)]);
run('NZ: exit 06-30 6000, bonus 2027-02 80000', staff({ employment: [emp('2026-01-01', monthly(6000), '2026-06-30')] }), [...ms('2026', 1, 6), '2027-02'], [ml('2027-02', 'bonus', 80000)]);
run('NZ: exit 06-15 15000, nothing held, 90000', staff({ employment: [emp('2025-01-01', monthly(15000), '2025-06-15')] }), ['2026-03'], [ml('2026-03', 'bonus', 90000)]);
run('NZ: partial closes Oct-Dec only, 15000', staff({ employment: [emp('2026-01-01', monthly(15000), '2026-12-31')] }), [...ms('2026', 10, 12), '2027-02'], [ml('2027-02', 'bonus', 2000)]);
run('NZ: partial closes Oct-Dec only, 6000, bonus 50000', staff({ employment: [emp('2026-01-01', monthly(6000), '2026-12-31')] }), [...ms('2026', 10, 12), '2027-02'], [ml('2027-02', 'bonus', 50000)]);
run('NZ: opening through 06 + closes 7-12, exit 12-31', staff({ employment: [emp('2026-01-01', monthly(6000), '2026-12-31')], opening: { '2026': { through: '2026-06', bases: { ahv: 36000, alv: 36000, uvg: 36000 } } } }), [...ms('2026', 7, 12), '2027-02'], [ml('2027-02', 'bonus', 90000)]);
run('NZ: second exit', staff({ employment: [emp('2026-01-01', monthly(6000), '2026-12-31'), emp('2027-05-01', monthly(12350), '2027-12-31')] }), [...ms('2026'), '2027-03', ...ms('2027', 5, 12), '2028-02'], [ml('2027-03', 'bonus', 5000), ml('2028-02', 'bonus', 2000)]);
run('NZ: rehire next year after NZ in Jan', staff({ employment: [emp('2026-01-01', monthly(13000), '2026-12-31'), emp('2027-03-01', monthly(13000))] }), [...ms('2026'), '2027-01', ...ms('2027', 3, 12)], [ml('2027-01', 'bonus', 20000)]);
run('NZ: small wage year lifted', staff({ employment: [emp('2026-01-01', monthly(200), '2026-12-31')] }), [...ms('2026'), '2027-02', '2027-04'], [ml('2027-02', 'bonus', 300), ml('2027-04', 'bonus', 100)]);
run('NZ: small wage stays under', staff({ employment: [emp('2026-01-01', monthly(150), '2026-12-31')] }), [...ms('2026'), '2027-02', '2027-04'], [ml('2027-02', 'bonus', 300), ml('2027-04', 'bonus', 500)]);
run('NZ: hourly small wage year, then NZ', staff({ employment: [emp('2026-01-01', hourly(25), '2026-12-31')] }), [...ms('2026'), '2027-02'], [...hrs([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]), ml('2027-02', 'bonus', 300)]);
run('NZ: hourly small wage exit 06, NZ 1000', staff({ employment: [emp('2026-01-01', hourly(25), '2026-06-30')] }), [...ms('2026', 1, 6), '2027-02'], [...hrs([5, 5, 5, 5, 5, 5]), ml('2027-02', 'bonus', 1000)]);
run('NZ: pensioner before exit', staff({ sex: 'm', birthDate: '1960-01-10', employment: [emp('2026-01-01', monthly(6000), '2026-06-30')] }), [...ms('2026', 1, 6), '2027-02'], [ml('2027-02', 'bonus', 2000)]);
run('NZ: ref age reached in the exit month', staff({ sex: 'm', birthDate: '1961-06-10', employment: [emp('2026-01-01', monthly(6000), '2026-06-30')] }), [...ms('2026', 1, 6), '2027-02'], [ml('2027-02', 'bonus', 2000)]);
run('NZ: ref age after exit', staff({ sex: 'm', birthDate: '1961-08-10', employment: [emp('2026-01-01', monthly(6000), '2026-06-30')] }), [...ms('2026', 1, 6), '2027-02'], [ml('2027-02', 'bonus', 2000)]);
run('NZ: 17 in earned year', staff({ birthDate: '2009-06-15', employment: [emp('2026-01-01', monthly(3000), '2026-12-31')] }), [...ms('2026'), '2027-02'], [ml('2027-02', 'bonus', 2000)]);
run('NZ: negative (clawback) after exit', staff({ employment: [emp('2026-01-01', monthly(15000), '2026-12-31')] }), [...ms('2026'), '2027-02'], [ml('2027-02', 'bonus', -5000)]);
run('NZ: negative, low wage', staff({ employment: [emp('2026-01-01', monthly(5000), '2026-12-31')] }), [...ms('2026'), '2027-02'], [ml('2027-02', 'bonus', -2000)]);
run('NZ: exit 2025, year not held, two NZ', staff({ employment: [emp('2025-01-01', monthly(15000), '2025-12-31')] }), ['2026-02', '2026-05'], [ml('2026-02', 'bonus', 100000), ml('2026-05', 'bonus', 100000)]);
run('NZ: exit 2025 mid, hourly, not held', staff({ employment: [emp('2025-03-01', hourly(40), '2025-09-30')] }), ['2026-02'], [ml('2026-02', 'bonus', 2000)]);
run('NZ: earlier NZ open, later draft', staff({ employment: [emp('2026-01-01', monthly(12300), '2026-12-31')] }), ms('2026'), [ml('2027-02', 'bonus', 500), ml('2027-03', 'bonus', 500)], ['2027-03', '2027-02']);
run('NZ same year as exit, then later year', staff({ employment: [emp('2026-01-01', monthly(15000), '2026-06-30')] }), [...ms('2026', 1, 6), '2026-10', '2027-02'], [ml('2026-10', 'bonus', 50000), ml('2027-02', 'bonus', 50000)]);


const expected = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown> : {};
if (process.env.UPDATE_SCENARIOS) writeFileSync(GOLDEN, `{\n${Object.entries(out).map(([k, v]) => `${JSON.stringify(k)}: [\n${(v as unknown[]).map((x) => JSON.stringify(x)).join(',\n')}\n]`).join(',\n')}\n}\n`);

test('64 scenarios: every scenario is in the golden file', () => {
  assert.equal(Object.keys(out).length, 64);
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(out).sort());
});
for (const [name, months] of Object.entries(out)) {
  test(`scenario: ${name}`, () => assert.deepEqual(months, expected[name]));
}
