/**
 * What the Löhne area shows (docs/specs/payroll.md §12.1), computed from payroll.json, the payslip
 * events and the books: the year strip, the month's Lohnlauf (one row per person, «x von y
 * abgeschlossen»), one payslip with its booking preview and history. The social security number is
 * masked in every list. Pure, browser-safe.
 */
import type { PeriodLock } from '../books/store.js';
import { entryOn, valueOn } from '../core/dated.js';
import { bookingOf, type PayslipBooking } from './booking.js';
import { computePayslip, employedFraction, type PayrollContext, type PayslipDraft, type PayslipFact } from './compute.js';
import { closedOf, latestClosed } from './history.js';
import type { PayrollEmployee, PayslipClose, PayslipCorrection, PayslipEvent } from './model.js';
import { payslipId } from './model.js';
import { monthsBetween, round2, sum } from './money.js';
import { inOpening, openingOf } from './opening.js';

/** The number as lists show it: only its last two digits. */
export const maskedNumber = (n: string | undefined): string | undefined => (n ? `${n.slice(0, 3)}.****.****.${n.slice(-2)}` : undefined);

export const nameOf = (e: PayrollEmployee, day: string): string => {
  const n = valueOn(e.name, day) ?? e.name.at(-1)?.value;
  return n ? `${n.first} ${n.last}` : e.id;
};

export interface EmployeeRow {
  id: string; name: string; isOwner: boolean; entry?: string; exit?: string;
  kind?: 'monthly' | 'hourly'; amount?: number; pensum?: number; since?: string;
  status: 'active' | 'left' | 'future'; socialSecurityNumber?: string;
}

export function employeeRows(ctx: PayrollContext, today: string): EmployeeRow[] {
  return ctx.store.employees.map((e) => {
    const sorted = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const entry = sorted[0]?.validFrom;
    const exit = sorted.at(-1)?.validUntil;
    const now = entryOn(e.employment, today) ?? sorted.filter((x) => x.validFrom <= today).at(-1) ?? sorted[0];
    return {
      id: e.id, name: nameOf(e, today), isOwner: !!e.isOwner, ...(entry ? { entry } : {}), ...(exit ? { exit } : {}),
      ...(now ? { kind: now.value.kind, amount: now.value.amount, pensum: now.value.pensum ?? 100, since: now.validFrom } : {}),
      status: exit && exit < today ? 'left' : entry && entry > today ? 'future' : 'active',
      ...(e.socialSecurityNumber ? { socialSecurityNumber: maskedNumber(e.socialSecurityNumber) } : {}),
    };
  });
}

export type SlipStatus = 'closed' | 'draft';

export interface MonthRow {
  id: string; employee: string; name: string; status: SlipStatus;
  gross: number; deductions: number; net: number; payout: number; employer: number;
  missing: number; facts: PayslipFact[];
}

export interface MonthView {
  month: string; rows: MonthRow[]; closed: number; of: number;
  /** The persons whose opening holds this month: paid and booked before payroll ran here, no payslip (§22 decision 43). */
  opening: Array<{ employee: string; name: string; through: string }>;
  totals: { gross: number; deductions: number; net: number; payout: number; employer: number };
  text?: string;
}

/** A payslip as the views read it: the close where it stands, else the draft. */
export function slipOf(ctx: PayrollContext, employee: string, month: string): { status: SlipStatus; slip: PayslipDraft | PayslipClose } | undefined {
  const close = ctx.history.closed.get(payslipId(month, employee));
  if (close) return { status: 'closed', slip: close };
  const draft = computePayslip(ctx, employee, month);
  return draft ? { status: 'draft', slip: draft } : undefined;
}

export function monthView(ctx: PayrollContext, month: string): MonthView {
  const rows: MonthRow[] = [];
  const opening: MonthView['opening'] = [];
  for (const e of ctx.store.employees) {
    // A close made before the opening said so still shows: it stands until reopened.
    if (inOpening(e, month) && !ctx.history.closed.has(payslipId(month, e.id))) {
      opening.push({ employee: e.id, name: nameOf(e, `${month}-28`), through: openingOf(e, month.slice(0, 4))!.through! });
      continue;
    }
    const s = slipOf(ctx, e.id, month);
    if (!s) continue;
    const deductions = 'deductions' in s.slip ? s.slip.deductions : round2(s.slip.gross - s.slip.net);
    rows.push({
      id: s.slip.id, employee: e.id, name: s.slip.person.name, status: s.status,
      gross: s.slip.gross, deductions, net: s.slip.net, payout: s.slip.payout, employer: s.slip.employer,
      missing: 'missing' in s.slip ? s.slip.missing.length : s.slip.left.length,
      facts: 'facts' in s.slip ? s.slip.facts : [],
    });
  }
  const t = (k: 'gross' | 'deductions' | 'net' | 'payout' | 'employer') => sum(rows.map((r) => r[k]));
  return {
    month, rows, opening, closed: rows.filter((r) => r.status === 'closed').length, of: rows.length,
    totals: { gross: t('gross'), deductions: t('deductions'), net: t('net'), payout: t('payout'), employer: t('employer') },
    ...(ctx.store.monthTexts?.[month] ? { text: ctx.store.monthTexts[month] } : {}),
  };
}

export interface YearMonth { month: string; state: 'closed' | 'open' | 'partial' | 'future' | 'none' | 'opening'; closed: number; of: number; gross: number }

/**
 * The year strip: twelve months, each closed, partly closed, open, to come, without anyone employed, or the
 * opening's (every person employed in it paid it before payroll ran here). A person's opening month counts in
 * no other state: it is not open, and never «noch offen».
 */
export function yearStrip(ctx: PayrollContext, year: string, today: string): YearMonth[] {
  return monthsBetween(`${year}-01`, `${year}-12`).map((month) => {
    // A person whose employment is recorded only from after her opening still has the opening's months.
    const all = ctx.store.employees.filter((e) => employedFraction(e, month, 'calendar-days') > 0 || inOpening(e, month));
    const employed = all.filter((e) => !inOpening(e, month) || ctx.history.closed.has(payslipId(month, e.id)));
    const closed = employed.filter((e) => ctx.history.closed.has(payslipId(month, e.id)));
    const gross = sum(closed.map((e) => ctx.history.closed.get(payslipId(month, e.id))!.gross));
    const state = !all.length ? 'none' : !employed.length ? 'opening' : closed.length === employed.length ? 'closed' : closed.length ? 'partial' : `${month}-01` > today ? 'future' : 'open';
    return { month, state, closed: closed.length, of: employed.length, gross };
  });
}

export interface PayslipView {
  id: string; employee: string; month: string; status: SlipStatus;
  slip: PayslipDraft | PayslipClose;
  booking: PayslipBooking;
  history: PayslipEvent[];
  /** Corrections entered on this payslip, with the payslip that carries each (once one has). */
  corrections: Array<PayslipCorrection & { carriedBy?: string }>;
  /** «Wieder öffnen»: offered for the person's latest closed month in an open period; else why not. */
  reopen: { offered: true } | { offered: false; why: 'notClosed' | 'notLatest' | 'closedPeriod' };
  /** The person's months of the year, for the Zeitachse; the opening's months as `opening`. */
  months: Array<{ month: string; status: SlipStatus | 'opening' }>;
}

export function payslipView(ctx: PayrollContext, employee: string, month: string, lock: Pick<PeriodLock, 'isClosed'>): PayslipView | undefined {
  const s = slipOf(ctx, employee, month);
  if (!s) return undefined;
  const id = payslipId(month, employee);
  const booking = bookingOf(s.slip, ctx.data, ctx.store);
  const latest = latestClosed(ctx.history, employee);
  const reopen: PayslipView['reopen'] = s.status !== 'closed' ? { offered: false, why: 'notClosed' }
    : latest?.id !== id ? { offered: false, why: 'notLatest' }
    : lock.isClosed(s.slip.postingDate) ? { offered: false, why: 'closedPeriod' } : { offered: true };
  const year = month.slice(0, 4);
  const e = ctx.store.employees.find((x) => x.id === employee);
  const months = monthsBetween(`${year}-01`, `${year}-12`).flatMap((m): Array<{ month: string; status: SlipStatus | 'opening' }> => {
    if (ctx.history.closed.has(payslipId(m, employee))) return [{ month: m, status: 'closed' }];
    if (e && inOpening(e, m)) return [{ month: m, status: 'opening' }];
    return e && employedFraction(e, m, 'calendar-days') > 0 ? [{ month: m, status: 'draft' }] : [];
  });
  return {
    id, employee, month, status: s.status, slip: s.slip, booking,
    history: ctx.history.events.get(id) ?? [],
    corrections: ctx.history.corrections.filter((c) => c.of === id).map((c) => ({ ...c, ...(ctx.history.carriedBy.has(c.id) ? { carriedBy: ctx.history.carriedBy.get(c.id) } : {}) })),
    reopen, months,
  };
}

/** The person's closed payslips of the year (the Lohnkonto's rows). */
export const yearOf = (ctx: PayrollContext, employee: string, year: string): PayslipClose[] => closedOf(ctx.history, employee).filter((c) => c.month.startsWith(year));


/**
 * The people whose December payslip of `year` is not closed yet (a draft): a final statement booked before
 * compares a total with a year the books do not hold whole, so it is said first (§22 decision 58).
 */
export const decemberOpen = (ctx: PayrollContext, year: string): string[] =>
  monthView(ctx, `${year}-12`).rows.filter((r) => r.status !== 'closed').map((r) => r.name);
