/**
 * Values that change over time («gilt ab», docs/specs/domain-model.md §5): one value and the days it
 * holds, never overwritten. A change is a new entry; the value on a day is the entry with the latest
 * `validFrom` on or before it, two of the same `validFrom` decided by the later `enteredAt`. Pure and
 * browser-safe: payroll reads every setting of a payslip through it, and the law's yearly figures too.
 */

/** One value and the days it holds. Days are YYYY-MM-DD, both ends inclusive. */
export interface DatedEntry<T> {
  validFrom: string;
  /** Absent: until the next entry begins, or open-ended. Set for an end with nothing after it (an exit, an allowance that stops). */
  validUntil?: string;
  value: T;
  /** When it was entered (ISO time). Decides between two entries of the same validFrom. */
  enteredAt: string;
  /** The document the value was read from: a pension certificate, a policy, a decision of the fund. */
  source?: { receiptId?: string; note?: string };
}

/** Sorted by validFrom, then enteredAt. An entry is addressed by (validFrom, enteredAt). */
export type Dated<T> = readonly DatedEntry<T>[];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day as the histories write it: YYYY-MM-DD and a real date. */
export function isDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

const order = (a: DatedEntry<unknown>, b: DatedEntry<unknown>): number =>
  a.validFrom.localeCompare(b.validFrom) || a.enteredAt.localeCompare(b.enteredAt);

/** The entry that holds on `day`, or undefined: none began by then, or the one that did ended before it. */
export function entryOn<T>(h: Dated<T> | undefined, day: string): DatedEntry<T> | undefined {
  let hit: DatedEntry<T> | undefined;
  for (const e of h ?? []) {
    if (e.validFrom > day) continue;
    if (!hit || order(e, hit) > 0) hit = e;
  }
  return hit && (!hit.validUntil || hit.validUntil >= day) ? hit : undefined;
}

/** The value on `day`: a missing value is a fact the reader names, never a guess. */
export const valueOn = <T>(h: Dated<T> | undefined, day: string): T | undefined => entryOn(h, day)?.value;

/** The value today. */
export const current = <T>(h: Dated<T> | undefined, today: string): T | undefined => valueOn(h, today);

/** The entries that begin after `today`: a planned raise, a new certificate from January. */
export const planned = <T>(h: Dated<T> | undefined, today: string): DatedEntry<T>[] => [...(h ?? [])].filter((e) => e.validFrom > today).sort(order);

/** The next day after `day`. */
export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** One stretch of days inside a period with the entry that holds on each of them; `entry` absent where none holds. */
export interface Span<T> { from: string; to: string; entry?: DatedEntry<T> }

/**
 * The days `from`..`to` cut where the value changes, each stretch with the entry that holds on it
 * (a month whose wage changes on the 16th: two stretches). A stretch without a value says so.
 */
export function entriesWithin<T>(h: Dated<T> | undefined, from: string, to: string): Span<T>[] {
  const cuts = new Set<string>([from]);
  for (const e of h ?? []) {
    if (e.validFrom > from && e.validFrom <= to) cuts.add(e.validFrom);
    if (e.validUntil && e.validUntil >= from && e.validUntil < to) cuts.add(nextDay(e.validUntil));
  }
  const starts = [...cuts].sort();
  const spans: Span<T>[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? previousDay(starts[i + 1]) : to;
    const entry = entryOn(h, start);
    const last = spans[spans.length - 1];
    if (last && last.entry === entry) last.to = end;
    else spans.push({ from: start, to: end, ...(entry ? { entry } : {}) });
  });
  return spans;
}

function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export class DatedEntryError extends Error {}

/**
 * The only writer: `h` with `entry` added, sorted. It refuses only a malformed day or an end before the
 * start; an overlap is no error, the latest `validFrom` decides.
 */
export function addEntry<T>(h: Dated<T> | undefined, entry: DatedEntry<T>): DatedEntry<T>[] {
  if (!isDay(entry.validFrom)) throw new DatedEntryError(`validFrom must be a day YYYY-MM-DD (found ${String(entry.validFrom)})`);
  if (entry.validUntil !== undefined && !isDay(entry.validUntil)) throw new DatedEntryError(`validUntil must be a day YYYY-MM-DD (found ${String(entry.validUntil)})`);
  if (entry.validUntil !== undefined && entry.validUntil < entry.validFrom) throw new DatedEntryError(`validUntil ${entry.validUntil} lies before validFrom ${entry.validFrom}`);
  if (typeof entry.enteredAt !== 'string' || Number.isNaN(Date.parse(entry.enteredAt))) throw new DatedEntryError(`enteredAt must be a time (found ${String(entry.enteredAt)})`);
  return [...(h ?? []), entry].sort(order);
}

/** How an entry is named where something used it: a payslip's `used` (payroll) and the withdraw check. */
export interface EntryKey { validFrom: string; enteredAt: string }

/**
 * `h` without the entry `key`, refused when `usedBy` names it: an entry a document or run used stays;
 * a planned one nobody read can go.
 */
export function withdrawEntry<T>(h: Dated<T>, key: EntryKey, usedBy: (key: EntryKey) => boolean): DatedEntry<T>[] {
  const i = h.findIndex((e) => e.validFrom === key.validFrom && e.enteredAt === key.enteredAt);
  if (i < 0) throw new DatedEntryError(`no entry from ${key.validFrom} entered ${key.enteredAt}`);
  if (usedBy(key)) throw new DatedEntryError(`the entry from ${key.validFrom} was used and stays; a new entry corrects it`);
  return h.filter((_, j) => j !== i);
}

// ─── a value of before the histories, and the one writer of a form's change ─────────

/**
 * The day a value written before histories holds from: «from the start», before any document a
 * workspace can hold (an opening Rechnung of an earlier year included). The UI says «seit Beginn».
 */
export const SINCE_START = '1900-01-01';
/** When such a value was «entered»: before any entry a person adds, so hers wins on the same day. */
export const START_ENTERED = '1900-01-01T00:00:00.000Z';

export const fromStart = <T>(value: T): DatedEntry<T>[] => [{ validFrom: SINCE_START, enteredAt: START_ENTERED, value }];

/** A list of dated entries, as a file writes one (every item with `validFrom` and `value`). */
export function isHistory(v: unknown): v is DatedEntry<unknown>[] {
  return Array.isArray(v) && v.every((e) => !!e && typeof e === 'object' && 'validFrom' in e && 'value' in e);
}

/**
 * A field as a file holds it, as a history: a history stays; a plain value (a file of before the
 * histories, or one written by hand) is one entry valid from the start; absent is none. `read` checks
 * or shapes each value.
 */
export function historyOf<T>(v: unknown, read: (x: unknown) => T = (x) => x as T): DatedEntry<T>[] {
  if (v === undefined || v === null) return [];
  if (isHistory(v)) return v.map((e) => ({ ...e, value: read(e.value) }));
  return fromStart(read(v));
}

/**
 * `h` with `value` from `validFrom`: the one writer of invoicing's histories (core/dated addEntry).
 * Nothing is added when the value on that day is already the same: a form saved unchanged leaves no entry.
 */
export function withEntry<T>(h: Dated<T> | undefined, value: T, validFrom: string, enteredAt: string, source?: DatedEntry<T>['source']): DatedEntry<T>[] {
  // None and null are alike: a value ended (null) on a day none held adds nothing.
  if (same(valueOn(h, validFrom) ?? null, value ?? null)) return [...(h ?? [])];
  return addEntry(h, { validFrom, enteredAt, value, ...(source ? { source } : {}) });
}

/** Two values alike as JSON writes them (keys in any order). */
export function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
