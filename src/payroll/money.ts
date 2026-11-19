/** Amounts and months for payroll: cents for every sum, a line rounded to the firm's step. Pure. */

/** To two decimals, by cents, half away from zero. */
export function round2(x: number): number {
  const c = Math.round(Math.abs(x) * 100 + 1e-7);
  return (x < 0 ? -c : c) / 100;
}

/** To the firm's step (0.05 or 0.01), by cents, half away from zero. */
export function roundStep(x: number, step: number): number {
  const cents = Math.round(Math.abs(x) * 100 + 1e-7);
  const unit = Math.max(1, Math.round(step * 100));
  const r = Math.round(cents / unit) * unit;
  return (x < 0 ? -r : r) / 100;
}

export const sum = (xs: readonly number[]): number => round2(xs.reduce((a, b) => a + Math.round(b * 100), 0) / 100);

export const daysIn = (month: string): number => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
export const firstDay = (month: string): string => `${month}-01`;
export const lastDay = (month: string): string => `${month}-${String(daysIn(month)).padStart(2, '0')}`;
export const monthOf = (day: string): string => day.slice(0, 7);

export function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4)); const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** The months from `from` to `to`, both included. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

/** The day `n` months after `day` (a 29th, 30th or 31st the month lacks becomes its last day). */
export function addMonths(day: string, n: number): string {
  const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7)) - 1 + n; const d = Number(day.slice(8, 10));
  const year = y + Math.floor(m / 12); const month = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
