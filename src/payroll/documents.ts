/**
 * The payroll's documents (docs/specs/payroll.md §5.6, §6.7): the Lohnkonto per person and for the firm
 * (every Lohnart summed per month), the Lohnausweis fields per person from her closed payslips by each
 * Lohnart's field, the figures of the annual declarations (AHV and ALV wages, the insured wages per
 * insurance and code), and the month's Buchungsjournal. Everything is computed from closed payslips
 * only, so a document and the payslips it sums always agree. Pure, browser-safe.
 */
import { entriesWithin } from '../core/dated.js';
import type { PayrollData } from '../core/modules/schema.js';
import type { JournalEntry } from '../types/index.js';
import type { WageType } from './catalogue.js';
import type { PayrollEmployee, PayslipClose } from './model.js';
import { round2 } from './money.js';

const months = (year: string) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

export interface LohnkontoRow { wageType: string; label: string; group: string; months: number[]; total: number }
export interface Lohnkonto {
  year: string;
  rows: LohnkontoRow[];
  totals: Record<'gross' | 'net' | 'payout' | 'employer', { months: number[]; total: number }>;
}

/** Every Lohnart of the closed payslips summed per month, in the catalogue's order; corrections in the month that carried them. */
export function lohnkonto(closes: readonly PayslipClose[], types: ReadonlyMap<string, WageType>, year: string, lang: 'de' | 'fr' | 'it' | 'en' = 'de'): Lohnkonto {
  const ms = months(year);
  const of = closes.filter((c) => c.month.startsWith(year));
  const order = [...types.keys()];
  const byType = new Map<string, number[]>();
  for (const c of of) {
    const i = ms.indexOf(c.month);
    for (const l of c.lines) {
      const row = byType.get(l.wageType) ?? Array(12).fill(0);
      row[i] = round2(row[i] + l.amount);
      byType.set(l.wageType, row);
    }
  }
  const rows = [...byType.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([k, m]) => {
    const w = types.get(k);
    return { wageType: k, label: w ? (w.label[lang] ?? w.label.de) : k, group: w?.group ?? '', months: m, total: round2(m.reduce((s, x) => s + x, 0)) };
  });
  const total = (k: 'gross' | 'net' | 'payout' | 'employer') => {
    const m = ms.map((month) => round2(of.filter((c) => c.month === month).reduce((s, c) => s + c[k], 0)));
    return { months: m, total: round2(m.reduce((s, x) => s + x, 0)) };
  };
  return { year, rows, totals: { gross: total('gross'), net: total('net'), payout: total('payout'), employer: total('employer') } };
}

export interface LohnausweisData {
  employee: string;
  year: string;
  /** The days of the year the person was employed (Buchstabe E). */
  from?: string;
  to?: string;
  fields: Record<string, number>;
  /** What field 15 says, as amounts by Lohnart (the employee's contributions the form has no field for). */
  remarks: Array<{ label: string; amount: number }>;
  /** Payslips of the year that are not closed yet: the statement is not final while one is open. */
  openMonths: string[];
  /** Lohnarten of the gross that name no field: field 8 is short of the gross by their lines. */
  unmapped?: string[];
}

/**
 * The Lohnausweis of `e` for `year`: each closed line summed into its Lohnart's field (a deduction field
 * takes the amount withheld, every other the line signed by its Lohnart), the opening of a firm that
 * started mid-year added, the sums of the module's form computed.
 */
export function lohnausweisOf(e: PayrollEmployee, closes: readonly PayslipClose[], types: ReadonlyMap<string, WageType>, data: PayrollData, year: string, lang: 'de' | 'fr' | 'it' | 'en' = 'de'): LohnausweisData {
  const form = data.lohnausweis;
  const fields: Record<string, number> = {};
  const remarks = new Map<string, { label: string; amount: number }>();
  const deduction = new Set((form?.fields ?? []).filter((f) => f.deduction).map((f) => f.key));
  const remark = new Set((form?.fields ?? []).filter((f) => f.remark).map((f) => f.key));
  const mine = closes.filter((c) => c.employee === e.id && c.month.startsWith(year));
  for (const c of mine) {
    for (const l of c.lines) {
      const w = types.get(l.wageType);
      const field = w?.lohnausweis;
      if (!w || !field || w.side === 'employer') continue;
      const amount = deduction.has(field) ? l.amount : w.sign === '-' ? -l.amount : l.amount;
      if (remark.has(field)) {
        const r = remarks.get(w.key) ?? { label: w.label[lang] ?? w.label.de, amount: 0 };
        r.amount = round2(r.amount + amount);
        remarks.set(w.key, r);
        continue;
      }
      fields[field] = round2((fields[field] ?? 0) + amount);
    }
  }
  for (const [k, v] of Object.entries(e.opening?.[year]?.fields ?? {})) fields[k] = round2((fields[k] ?? 0) + v);
  // The form takes whole francs, and its sums must add up on paper: each field rounded first, the sums from the rounded ones.
  for (const k of Object.keys(fields)) fields[k] = Math.round(fields[k]);
  for (const r of remarks.values()) r.amount = Math.round(r.amount);
  for (const f of form?.fields ?? []) {
    if (!f.sum) continue;
    const plus = f.sum.plus.reduce((s, k) => s + (fields[k] ?? 0), 0);
    const minus = (f.sum.minus ?? []).reduce((s, k) => s + (fields[k] ?? 0), 0);
    fields[f.key] = round2(plus - minus);
  }
  // A gross line whose Lohnart names no field (a firm's own) would leave field 8 short of the gross: named, never hidden.
  const unmapped = [...new Set(mine.flatMap((c) => c.lines.filter((l) => { const w = types.get(l.wageType); return !!w && w.stage === 'gross' && !w.lohnausweis; }).map((l) => l.wageType)))];
  const spans = entriesWithin(e.employment, `${year}-01-01`, `${year}-12-31`).filter((s) => s.entry);
  // The months an opening covers were paid elsewhere: open are only the months from payroll's first here on.
  const first = e.opening?.[year] ? mine[0]?.month : undefined;
  const employedMonths = new Set(spans.flatMap((s) => months(year).filter((m) => m >= s.from.slice(0, 7) && m <= s.to.slice(0, 7) && (!e.opening?.[year] || (!!first && m >= first)))));
  const closedMonths = new Set(mine.map((c) => c.month));
  return {
    employee: e.id, year,
    ...(spans.length ? { from: spans[0].from, to: spans.at(-1)!.to } : {}),
    fields, remarks: [...remarks.values()].filter((r) => r.amount !== 0),
    openMonths: [...employedMonths].filter((m) => !closedMonths.has(m)).sort(),
    ...(unmapped.length ? { unmapped } : {}),
  };
}

export interface DeclarationRow {
  employee: string; name: string;
  /** The base of each base key and each capped base of the year (AHV wage, ALV wage to the ceiling, UVG wage, …). */
  bases: Record<string, number>;
  from?: string; to?: string;
}

/** The figures of the annual declarations per person: each base of the year as the closed payslips kept it. */
export function declarationRows(employees: readonly PayrollEmployee[], closes: readonly PayslipClose[], year: string): DeclarationRow[] {
  return employees.flatMap((e) => {
    const mine = closes.filter((c) => c.employee === e.id && c.month.startsWith(year));
    if (!mine.length) return [];
    const bases: Record<string, number> = {};
    for (const [k, v] of Object.entries(e.opening?.[year]?.bases ?? {})) bases[k] = round2((bases[k] ?? 0) + v);
    for (const c of mine) for (const [k, v] of Object.entries(c.bases)) bases[k] = round2((bases[k] ?? 0) + v.month);
    // A capped base (`alv|alvCeiling`) counts the opening of its base too, as the engine capped it (src/payroll/compute.ts cumulative).
    for (const k of Object.keys(bases)) if (k.includes('|')) bases[k] = round2(bases[k] + (e.opening?.[year]?.bases?.[k.split('|')[0]] ?? 0));
    const spans = entriesWithin(e.employment, `${year}-01-01`, `${year}-12-31`).filter((s) => s.entry);
    return [{ employee: e.id, name: mine.at(-1)!.person.name, bases, ...(spans.length ? { from: spans[0].from, to: spans.at(-1)!.to } : {}) }];
  });
}

/** The month's Lohnbuchungen as a fiduciary who keeps the ledger elsewhere takes them. */
export const journalOf = (entries: readonly JournalEntry[], month: string): JournalEntry[] =>
  entries.filter((e) => e.transactionRef.startsWith(`LR-${month}-`)).sort((a, b) => a.transactionRef.localeCompare(b.transactionRef));

/** A CSV with semicolons (what spreadsheets in the region open), every cell quoted where it needs it. */
export function csv(rows: ReadonlyArray<ReadonlyArray<string | number | undefined>>): string {
  const cell = (v: string | number | undefined) => {
    // A text that starts like a formula is kept a text: a spreadsheet would run it.
    const s = v === undefined ? '' : typeof v === 'number' ? v.toFixed(2) : /^[=+\-@]/.test(v) ? `'${v}` : v;
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(';')).join('\n') + '\n';
}
