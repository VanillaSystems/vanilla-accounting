/**
 * The one owner of payroll.json and the closed payslips (docs/specs/payroll.md §9.2, §9.3): load with
 * the schema ladder of src/workspace/schema.ts, save atomically; payslips.jsonl of a year is append-only,
 * one event per line, never rewritten. The layout:
 *
 *   payroll.json                                   Stammdaten, Sozialversicherungen, Lohnarten, Mitarbeitende
 *   transactional-data/<year>/payroll/payslips.jsonl  close, reopen and correction events
 *   transactional-data/<year>/receipts/            the payslip PDFs, receipts of the books like any other
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { yearPaths, yearsOf, type Workspace } from '../workspace/workspace.js';
import { PAYROLL_MIGRATIONS, PAYROLL_SCHEMA, climb, schemaOf } from '../workspace/schema.js';
import { writeAtomic } from '../invoices/store.js';
import type { PayrollStore, PayslipEvent } from './model.js';

export const emptyPayroll = (): PayrollStore => ({
  schema: PAYROLL_SCHEMA,
  company: { canton: [], payday: [], postingDate: [], rounding: [], proration: [], thirteenth: [] },
  insurances: [], wageTypes: [], employees: [], monthLines: [],
});

type Paths = Pick<Workspace, 'paths'>;

export const hasPayroll = (ws: Paths): boolean => existsSync(ws.paths.payroll);

/**
 * The full names of the people of payroll.json, each name it ever held: what src/llm/mask.ts masks before a model. Read again
 * only when the file changed; none without one, or when it cannot be read.
 */
let peopleCache: { path: string; mtime: number; names: string[] } | undefined;
export function payrollPeople(ws: Paths): string[] {
  const path = ws.paths.payroll;
  try {
    if (!existsSync(path)) return [];
    const mtime = statSync(path).mtimeMs;
    if (peopleCache?.path !== path || peopleCache.mtime !== mtime) {
      const names = loadPayroll(ws).employees.flatMap((e) => e.name.map((n) => `${n.value.first} ${n.value.last}`));
      peopleCache = { path, mtime, names: [...new Set(names)] };
    }
    return peopleCache.names;
  } catch { return []; }
}

export function loadPayroll(ws: Paths): PayrollStore {
  const path = ws.paths.payroll;
  if (!existsSync(path)) return emptyPayroll();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const current = climb<Record<string, unknown>>(raw, schemaOf(raw.schema, path), PAYROLL_SCHEMA, PAYROLL_MIGRATIONS, path, (d) => structuredClone(d));
  const empty = emptyPayroll();
  return { ...empty, ...current, company: { ...empty.company, ...(current.company as object) }, schema: PAYROLL_SCHEMA } as PayrollStore;
}

export function savePayroll(ws: Paths, store: PayrollStore): void {
  const { schema: _, ...rest } = store;
  writeAtomic(ws.paths.payroll, JSON.stringify({ schema: PAYROLL_SCHEMA, ...rest }, null, 2) + '\n');
}

/** Load, change, save; nothing is saved when `fn` throws. */
export function updatePayroll<T>(ws: Paths, fn: (store: PayrollStore) => T): T {
  const store = loadPayroll(ws);
  const result = fn(store);
  savePayroll(ws, store);
  return result;
}

const payslipsFile = (ws: Paths, year: string): string => join(yearPaths(ws.paths, year).payroll, 'payslips.jsonl');

/** Every payslip event of `year`, in the order written. */
export function payslipEvents(ws: Paths, year: string): PayslipEvent[] {
  const file = payslipsFile(ws, year);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l) as PayslipEvent; } catch { throw new Error(`${file}:${i + 1}: not a JSON line`); }
  });
}

/** Every payslip event of every year, oldest year first. */
export const allPayslipEvents = (ws: Paths): PayslipEvent[] => yearsOf(ws.paths).flatMap((y) => payslipEvents(ws, y));

/** Appends events to the year's file: the earlier lines stay byte for byte. */
export function appendPayslipEvents(ws: Paths, year: string, events: readonly PayslipEvent[]): void {
  if (!events.length) return;
  const file = payslipsFile(ws, year);
  mkdirSync(yearPaths(ws.paths, year).payroll, { recursive: true });
  appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
