/**
 * The payroll's documents (docs/specs/payroll.md §5.6, §6.7): the Lohnkonto per person and for the firm
 * (every Lohnart summed per month), the Lohnausweis fields per person from her closed payslips by each
 * Lohnart's field, the figures of the annual declarations (AHV and ALV wages, the insured wages per
 * insurance and code), and the month's Buchungsjournal. Everything is computed from closed payslips
 * only, so a document and the payslips it sums always agree. Pure, browser-safe.
 */
import { entriesWithin, entryOn } from '../core/dated.js';
import type { PayrollData, PayrollYearData } from '../core/modules/schema.js';
import type { JournalEntry } from '../types/index.js';
import type { WageType } from './catalogue.js';
import type { PayrollEmployee, PayslipClose } from './model.js';
import { round2, sum } from './money.js';
import { referenceAgeReached } from './compute.js';
import { inOpening, openingOf } from './opening.js';

const months = (year: string) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

export interface LohnkontoRow { wageType: string; label: string; group: string; months: number[]; total: number }
export interface Lohnkonto {
  year: string;
  rows: LohnkontoRow[];
  totals: Record<'gross' | 'net' | 'payout' | 'employer', { months: number[]; total: number }>;
  /**
   * The openings of the year (§22 decision 43): the months paid before payroll ran here, per person her last
   * month, and their bases summed. No Lohnart: those months have no payslip here, so the rows and totals hold none.
   */
  opening?: { people: Array<{ employee: string; through?: string }>; bases: Record<string, number> };
}

/** The person's closes of `year` the year's figures count: none of a month her opening holds. */
const countedCloses = (e: Pick<PayrollEmployee, 'id' | 'employment' | 'opening'>, closes: readonly PayslipClose[], year: string) =>
  closes.filter((c) => c.employee === e.id && c.month.startsWith(year) && !inOpening(e, c.month));

/**
 * Every Lohnart of the closed payslips summed per month, in the catalogue's order; corrections in the month
 * that carried them. With `employees`, a close of a month a person's opening holds counts no more, and the
 * openings stand beside the months.
 */
export function lohnkonto(closes: readonly PayslipClose[], types: ReadonlyMap<string, WageType>, year: string, lang: 'de' | 'fr' | 'it' | 'en' = 'de', employees?: readonly PayrollEmployee[]): Lohnkonto {
  const ms = months(year);
  const who = employees ? new Map(employees.map((e) => [e.id, e])) : undefined;
  const of = closes.filter((c) => c.month.startsWith(year) && !(who?.get(c.employee) && inOpening(who.get(c.employee)!, c.month)));
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
  const people = new Set(of.map((c) => c.employee));
  const openings = (employees ?? []).filter((e) => people.has(e.id) || closes.some((c) => c.employee === e.id)).flatMap((e) => { const o = openingOf(e, year); return o ? [{ employee: e.id, o }] : []; });
  const bases: Record<string, number> = {};
  for (const { o } of openings) for (const [k, v] of Object.entries(o.bases)) bases[k] = round2((bases[k] ?? 0) + v);
  return {
    year, rows, totals: { gross: total('gross'), net: total('net'), payout: total('payout'), employer: total('employer') },
    ...(openings.length ? { opening: { people: openings.map(({ employee, o }) => ({ employee, through: o.through })), bases } } : {}),
  };
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
  /** The opening the fields count (§22 decision 43): its last month and its own fields. */
  opening?: { through?: string; fields: Record<string, number> };
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
  // Each month once: the opening's fields for its months, the closes of the months after it.
  const mine = countedCloses(e, closes, year);
  const opening = openingOf(e, year);
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
  for (const [k, v] of Object.entries(opening?.fields ?? {})) fields[k] = round2((fields[k] ?? 0) + v);
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
  // The months an opening covers were paid before payroll ran here: open are only the months after it.
  const employedMonths = new Set(spans.flatMap((s) => months(year).filter((m) => m >= s.from.slice(0, 7) && m <= s.to.slice(0, 7) && !inOpening(e, m))));
  const closedMonths = new Set(mine.map((c) => c.month));
  return {
    employee: e.id, year,
    ...(spans.length ? { from: spans[0].from, to: spans.at(-1)!.to } : {}),
    fields, remarks: [...remarks.values()].filter((r) => r.amount !== 0),
    openMonths: [...employedMonths].filter((m) => !closedMonths.has(m)).sort(),
    ...(unmapped.length ? { unmapped } : {}),
    ...(opening ? { opening: { through: opening.through, fields: opening.fields } } : {}),
  };
}

export interface DeclarationRow {
  employee: string; name: string;
  /** The base of each base key and each capped base of the year (AHV wage, ALV wage to the ceiling, UVG wage, …). */
  bases: Record<string, number>;
  from?: string; to?: string;
  /** What of `bases` the opening holds (§22 decision 43): its last month and its bases (a capped one as the engine capped it). */
  opening?: { through?: string; bases: Record<string, number> };
  /**
   * The first pillar's liable wage (payroll.yaml `declarations.liable`) where it is less than the AHV wage: the
   * person is exempt in part or whole, by age (not yet liable), as a pensioner (the allowance), or by a small wage.
   */
  exempt?: { liable: number; amount: number; reason: 'age' | 'pensioner' | 'smallWage' };
}

/** The figures of the annual declarations per person: each base of the year as the closed payslips kept it. */
export function declarationRows(employees: readonly PayrollEmployee[], closes: readonly PayslipClose[], year: string, law?: { data: PayrollData; years?: Readonly<Record<string, PayrollYearData>> }): DeclarationRow[] {
  return employees.flatMap((e) => {
    const mine = countedCloses(e, closes, year);
    if (!mine.length) return [];
    const o = openingOf(e, year);
    const bases: Record<string, number> = {};
    for (const [k, v] of Object.entries(o?.bases ?? {})) bases[k] = round2((bases[k] ?? 0) + v);
    // A small wage's charged base (`ahv#smallWageLimit`) is the engine's bookkeeping, no declared base.
    for (const c of mine) for (const [k, v] of Object.entries(c.bases)) if (!k.includes('#')) bases[k] = round2((bases[k] ?? 0) + v.month);
    // A capped base (`alv|alvCeiling`) counts the opening of its base too, as the engine capped it (src/payroll/compute.ts cumulative).
    const ofOpening: Record<string, number> = { ...(o?.bases ?? {}) };
    for (const k of Object.keys(bases)) if (k.includes('|')) { const v = o?.bases[k.split('|')[0]] ?? 0; bases[k] = round2(bases[k] + v); if (v) ofOpening[k] = v; }
    const spans = entriesWithin(e.employment, `${year}-01-01`, `${year}-12-31`).filter((s) => s.entry);
    const exempt = law ? exemptOf(e, mine, bases, year, law, o?.bases) : undefined;
    return [{ employee: e.id, name: mine.at(-1)!.person.name, bases, ...(spans.length ? { from: spans[0].from, to: spans.at(-1)!.to } : {}), ...(o ? { opening: { through: o.through, bases: ofOpening } } : {}), ...(exempt ? { exempt } : {}) }];
  });
}

/** The part of the AHV wage the year's liable contribution did not charge, and why. */
function exemptOf(e: PayrollEmployee, mine: readonly PayslipClose[], bases: Record<string, number>, year: string, law: { data: PayrollData; years?: Readonly<Record<string, PayrollYearData>> }, opening: Record<string, number> | undefined): DeclarationRow['exempt'] {
  const rule = law.data.declarations?.liable;
  if (!rule) return undefined;
  const wage = bases[rule.base] ?? 0;
  const liable = round2((opening?.[rule.base] ?? 0) + sum(mine.flatMap((c) => c.lines.filter((l) => l.wageType === rule.contribution && !l.corrects).map((l) => l.base ?? 0))));
  const amount = round2(wage - liable);
  if (amount <= 0) return undefined;
  const c = law.data.contributions.find((x) => x.wageType === rule.contribution);
  const y = law.years?.[year];
  const age = c?.liable ? y?.figures[c.liable] : undefined;
  const from = age ? Number(e.birthDate.slice(0, 4)) + (Array.isArray(age) ? age[0] : age).value + 1 : undefined;
  const reached = referenceAgeReached(e, y);
  const reason = from !== undefined && Number(year) < from ? 'age' : reached && reached.slice(0, 4) <= year ? 'pensioner' : 'smallWage';
  return { liable, amount, reason };
}

// ─── the family allowances (FAK statement) ─────────────────────────────────────

export interface FamilyAllowanceRow {
  employee: string; name: string;
  /** Per child and Lohnart, the allowances paid by month. */
  children: Array<{ child: string; wageType: string; label: string; months: number[]; total: number }>;
  allowances: number;
  /** The contributions to the fund the payslips accrued for the person. */
  contributions: number;
}

export interface FamilyAllowanceStatement {
  year: string;
  /** The kind of insurance the allowances are booked against (the fund). */
  kind?: string;
  rows: FamilyAllowanceRow[];
  totals: { allowances: number; contributions: number; balance: number };
}

/**
 * The year's family allowances against the fund (§5.6 «FAK statement»): the allowances paid with the wage per
 * person and child, and the contributions accrued for the fund. Its balance (contributions less allowances) is
 * what the payslips put on the fund's liability account; the fund's statement nets the two.
 */
export function familyAllowanceStatement(employees: readonly PayrollEmployee[], closes: readonly PayslipClose[], types: ReadonlyMap<string, WageType>, data: PayrollData, year: string, lang: 'de' | 'fr' | 'it' | 'en' = 'de'): FamilyAllowanceStatement {
  const ms = months(year);
  const isAllowance = (w: WageType | undefined) => !!w && (!!w.allowance || !!w.once) && typeof w.debit === 'object';
  const kind = [...types.values()].find(isAllowance)?.debit as { insurance: string } | undefined;
  const contributionTypes = new Set(data.contributions.filter((c) => c.insurance === kind?.insurance).map((c) => c.wageType));
  const rows = employees.flatMap((e): FamilyAllowanceRow[] => {
    const mine = countedCloses(e, closes, year);
    const byChild = new Map<string, FamilyAllowanceRow['children'][number]>();
    let contributions = 0;
    for (const c of mine) {
      const i = ms.indexOf(c.month);
      for (const l of c.lines) {
        const w = types.get(l.wageType);
        if (contributionTypes.has(l.wageType)) { contributions = round2(contributions + l.amount); continue; }
        if (!isAllowance(w)) continue;
        const key = `${l.text ?? ''}|${l.wageType}`;
        const row = byChild.get(key) ?? { child: l.text ?? '', wageType: l.wageType, label: w!.label[lang] ?? w!.label.de, months: Array(12).fill(0), total: 0 };
        row.months[i] = round2(row.months[i] + l.amount);
        row.total = round2(row.total + l.amount);
        byChild.set(key, row);
      }
    }
    if (!byChild.size && !contributions) return [];
    const children = [...byChild.values()];
    return [{ employee: e.id, name: mine.at(-1)?.person.name ?? e.id, children, allowances: sum(children.map((c) => c.total)), contributions }];
  });
  const allowances = sum(rows.map((r) => r.allowances));
  const contributions = sum(rows.map((r) => r.contributions));
  return { year, ...(kind ? { kind: kind.insurance } : {}), rows, totals: { allowances, contributions, balance: round2(contributions - allowances) } };
}

// ─── the pension fund's expected wages ─────────────────────────────────────────

export interface PensionWageRow {
  employee: string; name: string;
  /** The day the wage is taken on: 1 January, or the entry. */
  on: string;
  kind: 'monthly' | 'hourly';
  /** The month's wage (an hourly one from her first closed payslip of the year), × 12, and a 13th where the Anstellung has one. */
  monthly?: number;
  yearly?: number;
  /** Below the federal entry threshold: the fund insures no wage unless its plan says otherwise. */
  belowThreshold?: number;
  insured: boolean;
}

/**
 * The expected wages a pension fund asks for its year (§5.6 «BVG expected wages»): per person employed in
 * `year`, the wage of January (or of her entry month) × 12, with the 13th where the Anstellung pays one. An hourly
 * wage has none until a payslip of the year is closed: then that month's pension base × 12.
 */
export function pensionWages(employees: readonly PayrollEmployee[], closes: readonly PayslipClose[], data: PayrollData, years: Readonly<Record<string, PayrollYearData>> | undefined, year: string): PensionWageRow[] {
  const kind = Object.entries(data.insurances).find(([, k]) => k.perPerson && k.requiredAbove);
  const threshold = kind ? years?.[year]?.figures[kind[1].requiredAbove!.figure] : undefined;
  const limit = threshold ? (Array.isArray(threshold) ? threshold[0] : threshold).value : undefined;
  return employees.flatMap((e): PensionWageRow[] => {
    const spans = entriesWithin(e.employment, `${year}-01-01`, `${year}-12-31`).filter((s) => s.entry);
    if (!spans.length) return [];
    const on = spans[0].from;
    const job = entryOn(e.employment, on)!.value;
    const insured = !!kind && !!(entryOn(e.insurances, on)?.value as Record<string, unknown> | undefined)?.[kind[0]];
    let monthly: number | undefined;
    if (job.kind === 'monthly') monthly = round2(job.amount * (job.pensum ?? 100) / 100);
    else {
      const first = countedCloses(e, closes, year)[0];
      const base = kind ? first?.bases[kind[1].requiredAbove!.base]?.month : undefined;
      if (base !== undefined) monthly = base;
    }
    const yearly = monthly === undefined ? undefined : round2(monthly * (12 + (job.kind === 'monthly' && job.thirteenth ? 1 : 0)));
    const name = entryOn(e.name, on)?.value ?? e.name.at(-1)?.value;
    return [{
      employee: e.id, name: name ? `${name.first} ${name.last}` : e.id, on, kind: job.kind,
      ...(monthly !== undefined ? { monthly } : {}), ...(yearly !== undefined ? { yearly } : {}),
      ...(limit !== undefined && yearly !== undefined && yearly <= limit ? { belowThreshold: limit } : {}), insured,
    }];
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
