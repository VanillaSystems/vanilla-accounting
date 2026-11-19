/**
 * A person's opening of a year (docs/specs/payroll.md §6.6, §22 decision 43): the months paid before payroll
 * ran here (January to `through`, booked by hand), with their bases and Lohnausweis fields. Those months
 * are the opening's: no draft, no «noch offen», never closed here; the year's figures start from the
 * opening's totals and add the closes of the months after it. An opening written before `through`
 * existed names only `months`: January and the months after it, that many (a part month counts whole).
 * Pure, browser-safe.
 */
import { entriesWithin } from '../core/dated.js';
import type { PayrollEmployee } from './model.js';
import { daysIn, firstDay, lastDay, monthsBetween } from './money.js';

export interface Opening {
  /** The opening's last month (YYYY-MM): January to it are paid and booked before payroll ran here. */
  through: string;
  /** The months it counts for the ceilings (part months by their days). */
  months: number;
  bases: Record<string, number>;
  fields: Record<string, number>;
}

/** The share of `month` the person is employed, by calendar days. */
function shareOf(e: Pick<PayrollEmployee, 'employment'>, month: string): number {
  return entriesWithin(e.employment, firstDay(month), lastDay(month)).filter((s) => s.entry)
    .reduce((acc, s) => acc + (Number(s.to.slice(8)) - Number(s.from.slice(8)) + 1) / daysIn(month), 0);
}

/** The month `months` months after December of the year before: January to it (a part month counts as a month). */
function throughOf(year: string, months: number): string | undefined {
  if (!(months > 0)) return undefined;
  return `${year}-${String(Math.min(12, Math.ceil(months - 1e-6))).padStart(2, '0')}`;
}

/** The person's opening of `year`, its months explicit; undefined without one, or with one that covers no month. */
export function openingOf(e: Pick<PayrollEmployee, 'employment' | 'opening'>, year: string): Opening | undefined {
  const o = e.opening?.[year];
  if (!o) return undefined;
  const through = o.through && o.through.startsWith(`${year}-`) ? o.through : throughOf(year, o.months ?? 0);
  if (!through) return undefined;
  // Without `months`: the months of the opening the person was employed in, by their days; none recorded (she was paid
  // before her employment here was entered): each month whole.
  const share = monthsBetween(`${year}-01`, through).reduce((a, m) => a + shareOf(e, m), 0);
  const months = o.months ?? (share > 0 ? share : Number(through.slice(5)));
  return { through, months: Math.round(months * 1e4) / 1e4, bases: { ...(o.bases ?? {}) }, fields: { ...(o.fields ?? {}) } };
}

/** Whether `month` is one of the person's opening months: paid and booked before payroll ran here. */
export function inOpening(e: Pick<PayrollEmployee, 'employment' | 'opening'>, month: string): boolean {
  const o = openingOf(e, month.slice(0, 4));
  return !!o && month <= o.through;
}
