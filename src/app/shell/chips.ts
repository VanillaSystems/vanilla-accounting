/**
 * A list's filter as chips (#211): each chip is one condition, a field and a value. Chips of
 * different fields all hold (AND); chips of the same field are alternatives (OR: «FedEx oder
 * Amazon»), except a field that takes one value (a bound, yes/no), whose new chip replaces the old.
 * Pure and generic: an area names its fields, this module combines them; the URL carries the chips
 * as `?f=<field>_<value>` (docs/urls.md, parsed only by route.ts).
 */

import type { Key } from '../i18n/types.js';

export interface Chip { field: string; value: string }

/** Field ids are lower-case letters: the first `_` of a token ends the field, the rest is the value. */
const FIELD = /^[a-z]+$/;

export function parseChip(token: string): Chip | undefined {
  const i = token.indexOf('_');
  if (i < 1) return undefined;
  const field = token.slice(0, i);
  const value = token.slice(i + 1);
  return FIELD.test(field) && value ? { field, value } : undefined;
}

export const chipToken = (c: Chip): string => `${c.field}_${c.value}`;

export interface Option { value: string; label: string }

/** The words fields are named in: the dictionary (t in the app, wordsIn(lang).t in Node) and a month's name. Field modules stay free of the browser's i18n. */
export interface FieldWords {
  say: (key: Key, vars?: Record<string, string | number>) => string;
  monthName: (iso: string) => string;
}

/**
 * One field a list can be filtered by. `pick` offers values from the rows; `number` and `date`
 * take a typed value; `text` is the list's search box (it stays the search, ?q=, and is no chip).
 */
export interface Field<T> {
  id: string;
  label: () => string;
  input: 'pick' | 'number' | 'date' | 'text';
  /** Several values of this field: any of them (OR). Otherwise a new value replaces the old. */
  multi: boolean;
  /** The values the rows hold, for `pick`: what the menu offers. */
  options?: (rows: readonly T[]) => Option[];
  /** The value as the chip shows it. */
  valueLabel: (value: string) => string;
  /** Whether a row passes one value; undefined for a value the field does not know (a stale link). */
  test: (value: string) => ((row: T) => boolean) | undefined;
}

/** The chips a list knows, in field order of `fields`, each once; a chip of an unknown field or value is dropped. */
export function knownChips<T>(chips: readonly Chip[], fields: readonly Field<T>[]): Chip[] {
  const out: Chip[] = [];
  for (const f of fields) {
    const mine = chips.filter((c) => c.field === f.id && f.test(c.value));
    for (const c of f.multi ? mine : mine.slice(-1)) if (!out.some((o) => o.field === c.field && o.value === c.value)) out.push(c);
  }
  return out;
}

/** The chips with `c` added: beside the others of its field when the field takes several, else in their place. */
export function addChip<T>(chips: readonly Chip[], c: Chip, fields: readonly Field<T>[]): Chip[] {
  const f = fields.find((x) => x.id === c.field);
  if (!f) return [...chips];
  const rest = chips.filter((x) => !(x.field === c.field && (!f.multi || x.value === c.value)));
  return [...rest, c];
}

export const removeChip = (chips: readonly Chip[], c: Chip): Chip[] => chips.filter((x) => !(x.field === c.field && x.value === c.value));

/** One predicate per field the chips name: any of its values (OR). */
function predicates<T>(chips: readonly Chip[], fields: readonly Field<T>[]): Array<{ field: string; pass: (row: T) => boolean }> {
  return fields.flatMap((f) => {
    const tests = chips.filter((c) => c.field === f.id).flatMap((c) => f.test(c.value) ?? []);
    return tests.length ? [{ field: f.id, pass: (row: T) => tests.some((t) => t(row)) }] : [];
  });
}

/** Whether a row passes every field's chips (AND across fields); every row passes no chips. */
export function chipTest<T>(chips: readonly Chip[], fields: readonly Field<T>[]): (row: T) => boolean {
  const ps = predicates(chips, fields);
  return (r) => ps.every((p) => p.pass(r));
}

/** The rows every field's chips let through (AND across fields). */
export function applyChips<T>(rows: readonly T[], chips: readonly Chip[], fields: readonly Field<T>[]): T[] {
  return chips.length ? rows.filter(chipTest(chips, fields)) : [...rows];
}

/**
 * Why chips show nothing: the fields whose chips alone match no row (`alone`), and per field how
 * many rows the list would show without that field's chips (`without`), so the empty list can
 * offer to remove the ones that exclude everything.
 */
export interface Excluding { alone: string[]; without: Array<{ field: string; n: number }> }

export function excluding<T>(rows: readonly T[], chips: readonly Chip[], fields: readonly Field<T>[]): Excluding {
  const ps = predicates(chips, fields);
  return {
    alone: ps.filter((p) => !rows.some(p.pass)).map((p) => p.field),
    without: ps.map((p) => ({ field: p.field, n: rows.filter((r) => ps.every((q) => q === p || q.pass(r))).length })),
  };
}

/** Values of a `pick` field matching typed text, for the search box's suggestions: `[field, option]`, at most `max`. */
export function suggestions<T>(text: string, rows: readonly T[], fields: readonly Field<T>[], chips: readonly Chip[], max = 8): Array<{ field: Field<T>; option: Option }> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Array<{ field: Field<T>; option: Option }> = [];
  for (const f of fields) {
    if (f.input !== 'pick') continue;
    for (const o of f.options?.(rows) ?? []) {
      if (chips.some((c) => c.field === f.id && c.value === o.value)) continue;
      const hay = `${f.label()} ${o.label}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push({ field: f, option: o });
    }
  }
  return out.slice(0, max);
}

/** Plain-number parsing of a typed amount: «1'200.50», «1200,5»; undefined when it is none. */
export function parseAmount(s: string): number | undefined {
  const n = Number(s.replace(/['’\s]/g, '').replace(',', '.'));
  return s.trim() && Number.isFinite(n) ? n : undefined;
}

/** The shared fields of amounts and dates: over, under, exactly; a month, from, to. `amount` and `date` read a row. */
export function rangeFields<T>(amount: (row: T) => number | undefined, date: (row: T) => string | undefined, words: {
  over: () => string; under: () => string; exact: () => string; month: () => string; from: () => string; to: () => string;
  money: (n: number) => string; day: (iso: string) => string; monthName: (iso: string) => string;
}): Array<Field<T>> {
  const num = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : undefined);
  const iso = (v: string) => (/^\d{4}-\d\d-\d\d$/.test(v) ? v : undefined);
  const abs = (row: T) => { const a = amount(row); return a == null ? undefined : Math.abs(a); };
  const amountField = (id: string, label: () => string, cmp: (a: number, n: number) => boolean): Field<T> => ({
    id, label, input: 'number', multi: false,
    valueLabel: (v) => words.money(Number(v)),
    test: (v) => { const n = num(v); return n === undefined ? undefined : (row) => { const a = abs(row); return a !== undefined && cmp(a, n); }; },
  });
  return [
    amountField('over', words.over, (a, n) => a > n),
    amountField('under', words.under, (a, n) => a < n),
    amountField('amount', words.exact, (a, n) => Math.abs(a - n) < 0.005),
    {
      id: 'month', label: words.month, input: 'pick', multi: true,
      options: (rows) => [...new Set(rows.flatMap((r) => date(r)?.slice(0, 7) ?? []))].sort().reverse().map((m) => ({ value: m, label: words.monthName(`${m}-01`) })),
      valueLabel: (v) => words.monthName(`${v}-01`),
      test: (v) => (/^\d{4}-\d\d$/.test(v) ? (row) => date(row)?.slice(0, 7) === v : undefined),
    },
    { id: 'from', label: words.from, input: 'date', multi: false, valueLabel: words.day, test: (v) => (iso(v) ? (row) => { const d = date(row); return !!d && d >= v; } : undefined) },
    { id: 'to', label: words.to, input: 'date', multi: false, valueLabel: words.day, test: (v) => (iso(v) ? (row) => { const d = date(row); return !!d && d <= v; } : undefined) },
  ];
}

/** A number as a chip's value in the URL: no trailing zeros, a dot for decimals. */
export const amountToken = (n: number): string => String(Math.round(n * 100) / 100);
