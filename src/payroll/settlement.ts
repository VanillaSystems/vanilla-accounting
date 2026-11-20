/**
 * The tax at source's settlement list (Abrechnungsliste, docs/specs/payroll.md §3f, phase B2): per region
 * and month, every closed payslip that withheld the tax, with its taxable wage, the tariff code, the
 * rate-determining income and rate, the tax and the commission; and what is owed to the region, the tax
 * less the commission. It is read from the closed payslips only, so it is exactly what they booked on
 * the liability account: the tax credited, the commission debited. A correction carried into a month is
 * its own row in that month's list, declared with the month it corrects (§22 decision 111). Pure, browser-safe.
 */
import type { PayrollData } from '../core/modules/schema.js';
import type { WageType } from './catalogue.js';
import type { PayrollStore, PayslipClose, PayslipLine } from './model.js';
import { regionSolutionOf } from './tax-at-source.js';
import { firstDay, lastDay, round2, sum } from './money.js';

export interface SettlementRow {
  payslip: string; employee: string; name: string;
  /**
   * The month a correction row corrects (YYYY-MM): a correction carried into this month is its own row, declared
   * with the month it corrects (§22 decision 111). Absent: the month's own tax.
   */
  corrects?: string;
  /** The annual model's settlement of the year (§22 decision 122): the year's earlier months at the year's rate, less what they withheld. */
  yearEnd?: boolean;
  /** The taxable wage: of the month, or of the corrected month as computed when the correction was made (absent: not known). */
  wage?: number;
  code?: string; income?: number; rate?: number;
  tax: number; commission: number;
}

export interface Settlement {
  region: string; month: string;
  rows: SettlementRow[];
  totals: { wage: number; tax: number; commission: number; payable: number };
  /** The firm's insurer of the region (its name, its customer number), where it entered one. */
  insurer?: { id: string; name: string; customerNumber?: string };
  /** The tariff files the month's payslips computed with (their dates). */
  files: string[];
}

/** The keys of the tax's and the commission's Lohnarten. */
function keysOf(data: PayrollData, types: ReadonlyMap<string, WageType>): { tax: Set<string>; commission: Set<string> } {
  const tariffKinds = new Set(Object.entries(data.insurances).filter(([, k]) => k.tariff).map(([k]) => k));
  const tax = new Set(data.contributions.filter((c) => tariffKinds.has(c.insurance)).map((c) => c.wageType));
  for (const w of types.values()) if (w.origin === 'copy' && tax.has(w.key)) tax.add(w.key);
  const commission = new Set([...types.values()].filter((w) => w.computes === 'commission').map((w) => w.key));
  return { tax, commission };
}

/** Every settlement of the year's closed payslips, by month, then region. */
export function settlementsOf(closes: readonly PayslipClose[], year: string, data: PayrollData, types: ReadonlyMap<string, WageType>, store: Pick<PayrollStore, 'insurances'>): Settlement[] {
  const keys = keysOf(data, types);
  // Each closed payslip's own tax line: its region, and what a correction of it without its own figures declares.
  const ownOf = new Map<string, PayslipLine>();
  const monthOf = new Map(closes.map((c) => [c.id, c.month]));
  for (const c of closes) for (const l of c.lines) if (keys.tax.has(l.wageType) && l.tariff && !l.corrects && !l.tariff.yearEnd) ownOf.set(c.id, l);
  const lists = new Map<string, Settlement>();
  for (const c of [...closes].filter((x) => x.month.startsWith(year)).sort((a, b) => a.month.localeCompare(b.month) || a.person.name.localeCompare(b.person.name))) {
    // The rows of this payslip per region: the month's own tax, and one per month a carried correction corrects.
    const rows = new Map<string, Map<string, SettlementRow>>();
    const commission = new Map<string, { amount: number; rate?: number }>();
    for (const l of c.lines) {
      if (!keys.tax.has(l.wageType) && !keys.commission.has(l.wageType)) continue;
      const region = l.tariff?.region ?? (l.corrects ? ownOf.get(l.corrects)?.tariff?.region : undefined) ?? ownOf.get(c.id)?.tariff?.region;
      if (!region) continue;
      if (keys.commission.has(l.wageType)) {
        const had = commission.get(region);
        commission.set(region, { amount: round2((had?.amount ?? 0) + l.amount), ...(l.rate !== undefined ? { rate: l.rate } : had?.rate !== undefined ? { rate: had.rate } : {}) });
        continue;
      }
      const corrected = l.corrects ? monthOf.get(l.corrects) ?? l.corrects.slice(0, 7) : l.tariff?.yearEnd ? 'yearEnd' : '';
      const byMonth = rows.get(region) ?? new Map<string, SettlementRow>();
      const row = byMonth.get(corrected) ?? { payslip: c.id, employee: c.employee, name: c.person.name, ...(l.corrects ? { corrects: corrected } : {}), ...(l.tariff?.yearEnd ? { yearEnd: true } : {}), tax: 0, commission: 0 };
      row.tax = round2(row.tax + l.amount);
      if (l.tariff?.yearEnd) Object.assign(row, { wage: l.base ?? 0, code: l.tariff.code, income: l.tariff.income, rate: l.rate });
      else if (!l.corrects) Object.assign(row, { wage: l.base ?? 0, code: l.tariff?.code, income: l.tariff?.income, rate: l.rate });
      else if (l.tariff?.wage !== undefined) Object.assign(row, { wage: l.tariff.wage, code: l.tariff.code, income: l.tariff.income, rate: l.tariff.rate });
      else if (row.code === undefined) {
        // A correction entered by hand: the corrected month's code as it declared it; its wage and rate are not known.
        const was = l.corrects ? ownOf.get(l.corrects)?.tariff?.code : undefined;
        if (was) row.code = was;
      }
      byMonth.set(corrected, row);
      rows.set(region, byMonth);
    }
    for (const region of commission.keys()) if (!rows.has(region)) rows.set(region, new Map([['', { payslip: c.id, employee: c.employee, name: c.person.name, tax: 0, commission: 0 }]]));
    for (const [region, byMonth] of rows) {
      const list = [...byMonth.values()].sort((a, b) => (a.corrects ?? '').localeCompare(b.corrects ?? ''));
      shareCommission(list, commission.get(region));
      // A row that nets to nothing (a correction taken back in the same month) is not declared; nor a list left empty.
      // A month's own row at 0 % (a code the canton lists without tax, §22 decision 120) is declared with its wage.
      const kept = list.filter((r) => r.tax !== 0 || r.commission !== 0 || (!r.corrects && !r.yearEnd && !!r.wage && r.code !== undefined));
      if (!kept.length) continue;
      const k = `${c.month}|${region}`;
      const s = lists.get(k) ?? { region, month: c.month, rows: [], totals: { wage: 0, tax: 0, commission: 0, payable: 0 }, files: [] };
      s.rows.push(...kept);
      const own = c.lines.find((l) => keys.tax.has(l.wageType) && l.tariff?.region === region && !l.corrects)?.tariff?.created;
      if (own && !s.files.includes(own)) s.files.push(own);
      lists.set(k, s);
    }
  }
  return [...lists.values()].map((s) => {
    const tax = sum(s.rows.map((r) => r.tax));
    const commission = sum(s.rows.map((r) => r.commission));
    const firm = regionSolutionOf(store.insurances, data, s.region, firstDay(s.month), lastDay(s.month))?.insurance;
    return {
      // The wage total is the month's own: a correction's wage is the corrected month's, declared there already.
      ...s, totals: { wage: sum(s.rows.filter((r) => !r.corrects && !r.yearEnd).map((r) => r.wage ?? 0)), tax, commission, payable: round2(tax - commission) },
      ...(firm ? { insurer: { id: firm.id, name: firm.name, ...(firm.customerNumber ? { customerNumber: firm.customerNumber } : {}) } } : {}),
    };
  }).sort((a, b) => a.month.localeCompare(b.month) || a.region.localeCompare(b.region));
}

/**
 * The payslip's commission of a region over its rows: each row's tax at the commission's rate, and what the rounding
 * leaves on the month's own row (else the largest), so the rows add up to the line the payslip booked on the account.
 */
function shareCommission(rows: SettlementRow[], commission: { amount: number; rate?: number } | undefined): void {
  if (!commission || !rows.length) return;
  const taxed = sum(rows.map((r) => r.tax));
  for (const r of rows) r.commission = commission.rate !== undefined ? round2(r.tax * commission.rate / 100) : taxed ? round2(commission.amount * r.tax / taxed) : 0;
  const rest = round2(commission.amount - sum(rows.map((r) => r.commission)));
  if (rest === 0) return;
  const target = rows.find((r) => !r.corrects && !r.yearEnd) ?? [...rows].sort((a, b) => Math.abs(b.tax) - Math.abs(a.tax))[0];
  target.commission = round2(target.commission + rest);
}
