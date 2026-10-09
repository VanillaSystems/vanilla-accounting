/**
 * Periods, DERIVED from their name, never enumerated: a hardcoded list silently refuses (or worse,
 * silently replaces) every later quarter. One token names one date range, in the app's URL
 * (/<lang>/<period>/<tab>) and on the CLI:
 *
 * - fixed:    2026, 2026-H1, 2026-Q3, 2026-09 (a month), all
 * - custom:   2026-10-01..2026-10-09 (ISO dates: they sort and cannot be misread)
 * - relative: today, yesterday, last-7d, …, qtd, ytd. They resolve against `today` each time they
 *             are parsed, so a bookmarked "quarter to date" stays current.
 *
 * Bookkeeping is by day: no hour presets. Weeks start on Monday (Swiss). "Last N days" ends today.
 */
import type { QuarterKey } from '../types/index.js';

/** A calendar day, YYYY-MM-DD. */
export type IsoDate = string;

export const RELATIVE_PRESETS = [
  'today', 'yesterday',
  'last-7d', 'last-30d', 'last-90d', 'last-365d',
  'last-week', 'last-month', 'last-quarter', 'last-12m', 'last-year',
  'wtd', 'mtd', 'qtd', 'ytd',
] as const;
export type RelativePreset = typeof RELATIVE_PRESETS[number];

export type PeriodKind = 'all' | 'year' | 'half' | 'quarter' | 'month' | 'range' | RelativePreset;

export interface Period {
  /** As in the URL; for a relative preset the preset's name, not its dates. */
  token: string;
  kind: PeriodKind;
  from: IsoDate;
  to: IsoDate;
}

export const ALL: Period = { token: 'all', kind: 'all', from: '0000-01-01', to: '9999-12-31' };

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): IsoDate => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const parts = (date: IsoDate) => date.split('-').map(Number) as [number, number, number];
export const addDays = (date: IsoDate, n: number): IsoDate => { const [y, m, d] = parts(date); return iso(y, m, d + n); };
const lastOfMonth = (y: number, m: number) => iso(y, m + 1, 0);
const quarterOf = (m: number) => Math.ceil(m / 3);

/** A real calendar day (2026-02-29 is not). */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parts(s);
  return iso(y, m, d) === s;
}

/**
 * VAT reporting periods only: YYYY-Qn, YYYY-Hn and YYYY. The CLI and the VAT engine use this; the
 * app uses parsePeriod.
 */
export function derivePeriod(key: string): { from: string; to: string } | null {
  let m = key.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    const y = +m[1], q = +m[2];
    return { from: iso(y, (q - 1) * 3 + 1, 1), to: lastOfMonth(y, q * 3) };
  }
  m = key.match(/^(\d{4})-H([12])$/);
  if (m) return +m[2] === 1 ? { from: `${m[1]}-01-01`, to: `${m[1]}-06-30` } : { from: `${m[1]}-07-01`, to: `${m[1]}-12-31` };
  m = key.match(/^(\d{4})$/);
  if (m) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
  return null;
}

/** Each relative preset's range on `today`. */
const RESOLVE: Record<RelativePreset, (today: IsoDate) => [IsoDate, IsoDate]> = {
  'today': (t) => [t, t],
  'yesterday': (t) => [addDays(t, -1), addDays(t, -1)],
  'last-7d': (t) => [addDays(t, -6), t],
  'last-30d': (t) => [addDays(t, -29), t],
  'last-90d': (t) => [addDays(t, -89), t],
  'last-365d': (t) => [addDays(t, -364), t],
  'last-week': (t) => { const mon = weekStart(t); return [addDays(mon, -7), addDays(mon, -1)]; },
  'last-month': (t) => { const [y, m] = parts(t); return [iso(y, m - 1, 1), lastOfMonth(y, m - 1)]; },
  'last-quarter': (t) => { const [y, m] = parts(t); const s = (quarterOf(m) - 1) * 3 + 1; return [iso(y, s - 3, 1), lastOfMonth(y, s - 1)]; },
  'last-12m': (t) => { const [y, m] = parts(t); return [iso(y, m - 12, 1), lastOfMonth(y, m - 1)]; },
  'last-year': (t) => { const y = parts(t)[0] - 1; return [`${y}-01-01`, `${y}-12-31`]; },
  'wtd': (t) => [weekStart(t), t],
  'mtd': (t) => [t.slice(0, 8) + '01', t],
  'qtd': (t) => { const [y, m] = parts(t); return [iso(y, (quarterOf(m) - 1) * 3 + 1, 1), t]; },
  'ytd': (t) => [t.slice(0, 5) + '01-01', t],
};

/** The Monday of `date`'s week. */
function weekStart(date: IsoDate): IsoDate {
  const [y, m, d] = parts(date);
  return addDays(date, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
}

const isPreset = (s: string): s is RelativePreset => (RELATIVE_PRESETS as readonly string[]).includes(s);

/** The period a URL token names, its relative presets resolved on `today`; null for anything else. */
export function parsePeriod(token: string, today: IsoDate): Period | null {
  if (token === 'all') return ALL;
  if (isPreset(token)) {
    const [from, to] = RESOLVE[token](today);
    return { token, kind: token, from, to };
  }
  const vat = derivePeriod(token);
  if (vat) return { token, kind: token.includes('-Q') ? 'quarter' : token.includes('-H') ? 'half' : 'year', ...vat };
  const month = token.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (month) return { token, kind: 'month', from: `${token}-01`, to: lastOfMonth(+month[1], +month[2]) };
  const range = token.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range && isIsoDate(range[1]) && isIsoDate(range[2]) && range[1] <= range[2]) {
    return { token, kind: 'range', from: range[1], to: range[2] };
  }
  return null;
}

/**
 * The token for a range picked on a calendar: the year, half, quarter or month it covers exactly,
 * else `from..to`. So picking 1 July to 30 September gives 2026-Q3, whose VAT return exists.
 */
export function rangeToken(from: IsoDate, to: IsoDate): string {
  const [y, m, d] = parts(from);
  const [ty, tm] = parts(to);
  if (d === 1 && ty === y && to === lastOfMonth(y, tm)) {
    if (m === 1 && tm === 12) return String(y);
    if ((m === 1 && tm === 6) || (m === 7 && tm === 12)) return `${y}-H${m === 1 ? 1 : 2}`;
    if (m % 3 === 1 && tm === m + 2) return `${y}-Q${quarterOf(m)}`;
    if (tm === m) return `${y}-${pad(m)}`;
  }
  return `${from}..${to}`;
}

/** The ESTV reporting period (year, half or quarter) a period covers exactly, else null. */
export function vatPeriodOf(p: Period): string | null {
  if (p.kind === 'all') return null;
  const token = rangeToken(p.from, p.to);
  return /^\d{4}(-[QH]\d)?$/.test(token) ? token : null;
}

/** A date typed the Swiss way, "9.10.2026" or "09.10.2026"; null when it is no real day. */
export function parseSwissDate(text: string): IsoDate | null {
  const m = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isIsoDate(day) ? day : null;
}

/** Undated items show in every period. */
export const inPeriod = (p: Period, date: IsoDate | undefined): boolean => !date || (date >= p.from && date <= p.to);

/**
 * The period a link to an item dated `date` opens in: the current one when it holds the date,
 * else the date's quarter. Undated items open in 'all'.
 */
export function periodContaining(date: IsoDate | undefined, current?: Period): string {
  if (!date) return 'all';
  if (current && inPeriod(current, date)) return current.token;
  return `${date.slice(0, 4)}-Q${quarterOf(Number(date.slice(5, 7)))}`;
}

/** The VAT quarter a date falls in, e.g. 2026-08-20 → 2026-Q3. */
export const vatQuarterOf = (date: IsoDate): QuarterKey => `${date.slice(0, 4)}-Q${quarterOf(Number(date.slice(5, 7)))}` as QuarterKey;

/** Today in the local time zone, YYYY-MM-DD. */
export function localToday(now = new Date()): IsoDate {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
