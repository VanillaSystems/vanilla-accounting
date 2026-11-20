/**
 * A payslip wish of the AI sidebar (docs/specs/payroll.md §22 decisions 130–134): «mach d Lohnabrechnig
 * für Marco», «Lohnabrechnung Oktober für Nina», «schliess den November ab». The model names the person
 * only in the words she used and a month; code finds the person, the month and the payslip, and says its
 * state as counts. No name, wage or number of payroll.json goes back to the model; closing is the
 * person's click on the card (the same API as Löhne), never the model's.
 */
import type { PayrollContext } from './compute.js';
import { employedFraction } from './compute.js';
import { payslipId, type PayrollEmployee } from './model.js';
import { monthsBetween } from './money.js';
import { inOpening } from './opening.js';
import { slipOf } from './views.js';

/** What the model writes: the person as the person named her, a month (YYYY-MM), whether she wants it closed. */
export interface PayslipWish { person?: string; month?: string; close?: boolean }

/** The payslip (or, without `employee`, the month's Lohnlauf) the wish is about, as code found it. */
export interface WishTarget { month: string; employee?: string; close: boolean }

/** Why a wish names no payslip: no payroll, no such person, several, or no payslip of hers that month (or none left to make). */
export type WishRefusal = 'none' | 'person' | 'ambiguous' | 'month';

export class PayslipWishError extends Error {
  constructor(readonly why: WishRefusal, readonly said?: string) {
    super(WISH_WORDS[why](said ?? ''));
  }
}

/** The German words of a refusal, for the model and the logs: the person's own words, never a name of payroll.json. */
const WISH_WORDS: Record<WishRefusal, (said: string) => string> = {
  none: () => 'Die Firma führt keine Löhne in der App: es gibt keine Lohnabrechnung.',
  person: (said) => `Unter den Mitarbeitenden in Löhne ist niemand «${said}».`,
  ambiguous: (said) => `«${said}» passt auf mehrere Mitarbeitende: die Person wählt in Löhne, wen sie meint.`,
  month: () => 'Für diesen Monat gibt es keine Lohnabrechnung dieser Person (nicht angestellt, oder in der Eröffnung).',
};

const folded = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The people the words name: by id, by first name, by last name, or by first and last name, in any of her dated names. */
export function peopleNamed(employees: readonly PayrollEmployee[], said: string): PayrollEmployee[] {
  const w = folded(said);
  if (!w) return [];
  const byId = employees.filter((e) => folded(e.id) === w);
  if (byId.length) return byId;
  return employees.filter((e) => e.name.some(({ value: n }) => [n.first, n.last, `${n.first} ${n.last}`, `${n.last} ${n.first}`].some((x) => folded(x) === w)));
}

/** A month with a payslip of hers: employed in it and not in her opening (a close made before the opening said so still counts). */
const hasPayslip = (ctx: PayrollContext, e: PayrollEmployee, month: string): boolean =>
  ctx.history.closed.has(payslipId(month, e.id)) || (!inOpening(e, month) && employedFraction(e, month, 'calendar-days') > 0 && !!slipOf(ctx, e.id, month));

const shift = (month: string, by: number): string => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

/** How far back and ahead a month is looked for when the wish names none. */
const BACK = 24;
const AHEAD = 12;

/**
 * Her payslip to make when the wish names no month: the first not closed up to this month (an older one
 * left open comes first), else the next one ahead; undefined when none is left.
 */
export function nextPayslipMonth(ctx: PayrollContext, e: PayrollEmployee, today: string): string | undefined {
  const now = today.slice(0, 7);
  const months = monthsBetween(shift(now, -BACK), shift(now, AHEAD)).filter((m) => hasPayslip(ctx, e, m));
  return months.find((m) => m <= now && !ctx.history.closed.has(payslipId(m, e.id))) ?? months.find((m) => m > now && !ctx.history.closed.has(payslipId(m, e.id)));
}

/** The first month with a payslip not closed, of anyone, up to this month; else this month. */
function monthOfLohnlauf(ctx: PayrollContext, today: string): string {
  const now = today.slice(0, 7);
  return monthsBetween(shift(now, -BACK), now).find((m) => ctx.store.employees.some((e) => hasPayslip(ctx, e, m) && !ctx.history.closed.has(payslipId(m, e.id)))) ?? now;
}

/** The payslip or month the wish names, found by code; throws PayslipWishError when it names none. */
export function resolveWish(ctx: PayrollContext, wish: PayslipWish, today: string): WishTarget {
  if (!ctx.store.employees.length) throw new PayslipWishError('none');
  const close = wish.close === true;
  if (!wish.person) return { month: wish.month ?? monthOfLohnlauf(ctx, today), close };
  const named = peopleNamed(ctx.store.employees, wish.person);
  if (!named.length) throw new PayslipWishError('person', wish.person);
  if (named.length > 1) throw new PayslipWishError('ambiguous', wish.person);
  const e = named[0];
  const month = wish.month ?? nextPayslipMonth(ctx, e, today);
  if (!month || !hasPayslip(ctx, e, month)) throw new PayslipWishError('month', wish.person);
  return { month, employee: e.id, close };
}

/** What the model hears of a target now: its state and counts, never a figure of it. */
export type WishState =
  | { kind: 'payslip'; status: 'draft' | 'closed' | 'gone'; incomplete: number; facts: number }
  | { kind: 'month'; closed: number; of: number };

export function wishState(ctx: PayrollContext, target: Pick<WishTarget, 'month' | 'employee'>): WishState {
  if (!target.employee) {
    const people = ctx.store.employees.filter((e) => hasPayslip(ctx, e, target.month));
    return { kind: 'month', closed: people.filter((e) => ctx.history.closed.has(payslipId(target.month, e.id))).length, of: people.length };
  }
  const s = slipOf(ctx, target.employee, target.month);
  if (!s) return { kind: 'payslip', status: 'gone', incomplete: 0, facts: 0 };
  const incomplete = 'missing' in s.slip ? s.slip.missing.length : s.slip.left.length;
  return { kind: 'payslip', status: s.status, incomplete, facts: 'facts' in s.slip ? s.slip.facts.length : 0 };
}
