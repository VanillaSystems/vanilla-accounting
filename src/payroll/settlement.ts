/**
 * The tax at source's settlement list (Abrechnungsliste, docs/specs/payroll.md §3f, phase B2): per region
 * and month, every closed payslip that withheld the tax, with its taxable wage, the tariff code, the
 * rate-determining income and rate, the tax and the commission; and what is owed to the region, the tax
 * less the commission. It is read from the closed payslips only, so it is exactly what they booked on
 * the liability account: the tax credited, the commission debited. A correction carried into a month is
 * listed in that month, with the month it corrects. Pure, browser-safe.
 */
import type { PayrollData } from '../core/modules/schema.js';
import type { WageType } from './catalogue.js';
import type { PayrollStore, PayslipClose } from './model.js';
import { regionSolutionOf } from './tax-at-source.js';
import { firstDay, lastDay, round2, sum } from './money.js';

export interface SettlementRow {
  payslip: string; employee: string; name: string;
  /** The taxable wage of the month (0 for a row that only carries a correction). */
  wage: number;
  code?: string; income?: number; rate?: number;
  tax: number; commission: number;
  /** The months whose tax a correction line of this payslip corrects. */
  corrects: string[];
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
  const regionOfClose = new Map<string, string>();
  for (const c of closes) for (const l of c.lines) if (keys.tax.has(l.wageType) && l.tariff) regionOfClose.set(c.id, l.tariff.region);
  const lists = new Map<string, Settlement>();
  for (const c of [...closes].filter((x) => x.month.startsWith(year)).sort((a, b) => a.month.localeCompare(b.month) || a.person.name.localeCompare(b.person.name))) {
    const byRegion = new Map<string, SettlementRow>();
    for (const l of c.lines) {
      if (!keys.tax.has(l.wageType) && !keys.commission.has(l.wageType)) continue;
      const region = l.tariff?.region ?? (l.corrects ? regionOfClose.get(l.corrects) : undefined) ?? regionOfClose.get(c.id);
      if (!region) continue;
      const row = byRegion.get(region) ?? { payslip: c.id, employee: c.employee, name: c.person.name, wage: 0, tax: 0, commission: 0, corrects: [] };
      if (keys.commission.has(l.wageType)) row.commission = round2(row.commission + l.amount);
      else {
        row.tax = round2(row.tax + l.amount);
        if (l.corrects) { if (!row.corrects.includes(l.corrects.slice(0, 7))) row.corrects.push(l.corrects.slice(0, 7)); }
        else { row.wage = l.base ?? 0; row.code = l.tariff?.code; row.income = l.tariff?.income; row.rate = l.rate; }
      }
      byRegion.set(region, row);
    }
    for (const [region, row] of byRegion) {
      const k = `${c.month}|${region}`;
      const s = lists.get(k) ?? { region, month: c.month, rows: [], totals: { wage: 0, tax: 0, commission: 0, payable: 0 }, files: [] };
      s.rows.push(row);
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
      ...s, totals: { wage: sum(s.rows.map((r) => r.wage)), tax, commission, payable: round2(tax - commission) },
      ...(firm ? { insurer: { id: firm.id, name: firm.name, ...(firm.customerNumber ? { customerNumber: firm.customerNumber } : {}) } } : {}),
    };
  }).sort((a, b) => a.month.localeCompare(b.month) || a.region.localeCompare(b.region));
}
