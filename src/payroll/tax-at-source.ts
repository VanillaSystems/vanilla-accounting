/**
 * The tax at source of one payslip (docs/specs/payroll.md §3f, §5.4, phase B2), by the monthly model:
 * the region's tariff file gives the rate of the person's tariff code for the month's rate-determining
 * income, and the tax is that rate on the month's taxable wage. The rate-determining income is the
 * periodic part of the wage, extrapolated to a whole month when the person enters or leaves in it and to
 * the whole of her employments when she has others (their Pensum, else 100 %, or their income when the
 * firm knows it), plus the aperiodic part as it is. The commission the region leaves the employer is a
 * line of its own on the tax of the month (its corrections included), rounded as the tax is. A missing input is a line
 * «unvollständig», never a guess. Code reads the data's keys and the file; no region is named here.
 * Pure and browser-safe.
 */
import type { PayrollData, TaxAtSourceData } from '../core/modules/schema.js';
import { valueOn } from '../core/dated.js';
import { bracketOf, provisionOf, type TariffFile } from '../providers/tax-at-source/tariff-file.js';
import type { WageType } from './catalogue.js';
import type { PayrollInsurance, PayslipLine, TaxAtSource, UsedEntry } from './model.js';
import { round2, roundStep } from './money.js';

/** A tariff file as payroll reads it: the parsed file, the checksum of its bytes, when and where it was fetched. */
export interface LoadedTariff { region: string; year: string; file: TariffFile; sha256: string; fetchedAt: string; url?: string }

/** The tariff file of a region and year the workspace has, or undefined. */
export type TariffSource = (region: string, year: string) => LoadedTariff | undefined;

/** Where a tax line comes from: the file, the code and the rate-determining income it was looked up with. */
export interface TariffUse { region: string; code: string; income: number; created?: string; version?: string }

export interface TaxAtSourceInput {
  data: PayrollData;
  types: ReadonlyMap<string, WageType>;
  /** The Lohnart of the tax (the contribution's), in the person's language. */
  wageType: WageType; label: string;
  person: TaxAtSource;
  month: string;
  /** The payslip's lines so far: the wage, the allowances, the corrections carried into it. */
  lines: readonly PayslipLine[];
  /** The days of the month the person is employed, as the firm prorates them, scaled to `partMonth` (30) for a whole month. */
  days: number;
  /**
   * A month after her exit (a Nachzahlung): the rate-determining income of her exit month, added to what is paid now
   * (FAQ KS 45, Frage 16, monthly model: the periodic income of the exit month where the month's other income is not known).
   */
  exitIncome?: number;
  /** Her Pensum in %, when the Anstellung states one (an hourly wage may not). */
  pensum?: number;
  tariffs?: TariffSource;
  insurances: readonly PayrollInsurance[];
  /** The region of a closed payslip's tax, for a correction carried from it. */
  regionOf(payslip: string): string | undefined;
  commission?: { wageType: WageType; label: string };
}

export interface TaxAtSourceResult {
  lines: PayslipLine[];
  missing: Array<{ wageType: string; code: string }>;
  used: UsedEntry[];
}

/** The tariff code the file names: a letter, the children and the church tax (A0N); two characters take the church flag. */
export function tariffCode(code: string | undefined, church: boolean | undefined): string | undefined {
  const c = (code ?? '').trim().toUpperCase();
  if (/^[A-Z][0-9A-Z][NY]$/.test(c)) return c;
  if (/^[A-Z][0-9]$/.test(c)) return `${c}${church ? 'Y' : 'N'}`;
  return undefined;
}

/** The firm's insurance of a tariff kind with a solution for `region` that holds in the month, and that solution. */
export function regionSolutionOf(insurances: readonly PayrollInsurance[], data: Pick<PayrollData, 'insurances'>, region: string, from: string, to: string) {
  for (const i of insurances) {
    if (!data.insurances[i.kind]?.tariff || i.validFrom > to || (i.validUntil && i.validUntil < from)) continue;
    const s = i.solutions.find((x) => x.code.toUpperCase() === region);
    if (s) return { insurance: i, solution: s };
  }
  return undefined;
}

const rules = (data: PayrollData): TaxAtSourceData | undefined => data.taxAtSource;

/** The tax at source and its commission for one payslip. */
export function taxAtSourceLines(input: TaxAtSourceInput): TaxAtSourceResult {
  const { data, types, person, month, lines } = input;
  const out: TaxAtSourceResult = { lines: [], missing: [], used: [] };
  const t = rules(data);
  const year = month.slice(0, 4);
  const to = `${month}-${String(new Date(Date.UTC(Number(year), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
  const from = `${month}-01`;
  const miss = (code: string, wageType = input.wageType.key) => out.missing.push({ wageType, code });
  const isTax = (l: PayslipLine) => l.wageType === input.wageType.key;
  const region = person.canton?.trim().toUpperCase();

  const tax = (() => {
    // No longer subject (she left the tax at source, or left): no tax of this month, only the commission on a carried correction.
    if (!person.subject) return undefined;
    if (!t) return miss('notComputed');
    if (!region) return miss('taxRegion');
    const model = t.regions[region]?.model;
    if (!model) return miss(`taxRegionUnknown:${region}`);
    if (model !== 'monthly') return miss(`annualModel:${region}`);
    const code = tariffCode(person.code, person.church);
    if (!code) return miss('taxCode');
    const loaded = input.tariffs?.(region, year);
    if (!loaded) return miss(`tariff:${region}:${year}`);
    out.used.push({ path: `tariffs/${region}/${year}`, validFrom: loaded.file.created, enteredAt: loaded.sha256.slice(0, 12) });

    // The month's taxable wage: its periodic part, of which what the firm prorated to the days employed (a line with
    // its days: the monthly wage, a recurring Lohnart), and its aperiodic part (a carried correction is aperiodic).
    let prorated = 0; let periodic = 0; let aperiodic = 0;
    for (const l of lines) {
      const w = types.get(l.wageType);
      if (!w || w.side === 'employer' || !w.bases.includes(baseKey(data, input.wageType.key))) continue;
      const signed = w.sign === '-' ? -l.amount : l.amount;
      if (l.corrects || t.aperiodic.includes(w.lohnausweis ?? '')) aperiodic += signed;
      else if (l.days) prorated += signed;
      else periodic += signed;
    }
    const base = round2(prorated + periodic + aperiodic);
    if (base <= 0) return undefined;

    // The rate-determining income (KS 45 Ziff. 6): what the firm prorated in a part month back to a whole month;
    // what is paid as worked (hours, a month's line) counts as paid (§22 decision 94); other employments to their whole.
    let income = periodic + (input.days > 0 && input.days < t.partMonth ? prorated * t.partMonth / input.days : prorated);
    const median = loaded.file.median;
    const other = person.otherEmployment;
    if (other !== undefined) {
      const own = input.pensum;
      if (typeof other === 'object' && typeof other.income === 'number') income += other.income;
      else if (own && own > 0) {
        const whole = other === 'unknown' ? 100 : own + (typeof other === 'object' ? other.pensum ?? 0 : 0);
        if (other === 'unknown' ? own < 100 : true) income = income * whole / own;
      } else if (median !== undefined) {
        // Her own Pensum cannot be told (an hourly wage): the canton's median stands for a whole employment.
        income = Math.max(income, median);
      }
    }
    if (input.exitIncome !== undefined) income += input.exitIncome;
    income = round2(income + aperiodic);

    let file = code;
    let bracket = bracketOf(loaded.file, file, income, to);
    // A region whose tariffs are only with or only without the church tax lists one of them (format, Ziff. 4.2.4).
    if (!bracket && /^[A-Z][0-9][NY]$/.test(code)) {
      file = `${code.slice(0, 2)}${code[2] === 'Y' ? 'N' : 'Y'}`;
      if (!loaded.file.tariffs.has(file)) file = code; else bracket = bracketOf(loaded.file, file, income, to);
    }
    if (!bracket) return miss(`taxCodeUnknown:${code}`);
    let amount = roundStep(base * bracket.rate / 100, t.rounding);
    if (amount < bracket.minimum) amount = bracket.minimum;
    if (amount === 0) return undefined;
    const tariff: TariffUse = { region, code: file, income, created: loaded.file.created, version: loaded.sha256.slice(0, 12) };
    out.lines.push({ wageType: input.wageType.key, label: input.label, base, rate: bracket.rate, amount, side: 'employee', source: `tariff:${region}:${year}`, tariff });
    return undefined;
  });
  tax();

  // The commission: on every tax line of the month, the carried corrections included, per region.
  const c = input.commission;
  if (!c || !t) return out;
  const byRegion = new Map<string, number>();
  for (const l of [...lines.filter(isTax), ...out.lines]) {
    const r = l.tariff?.region ?? (l.corrects ? input.regionOf(l.corrects) : undefined) ?? region;
    if (!r) continue;
    byRegion.set(r, round2((byRegion.get(r) ?? 0) + l.amount));
  }
  for (const [r, taxed] of byRegion) {
    if (taxed === 0) continue;
    const own = regionSolutionOf(input.insurances, data, r, from, to);
    const firm = own ? valueOn(own.solution.rates, to)?.provision : undefined;
    const loaded = firm === undefined ? input.tariffs?.(r, year) : undefined;
    const rate = firm ?? (loaded ? provisionOf(loaded.file, t.provision.electronic, to) : undefined);
    if (rate === undefined) { miss(`tariff:${r}:${year}`, c.wageType.key); continue; }
    // Rounded as the tax is (5 Rappen, data `rounding`): money of the same settlement (§22 decision 121).
    const amount = roundStep(taxed * rate / 100, t.rounding);
    if (amount === 0) continue;
    // The region always on the line, whatever the rate's source: the settlement list reads it.
    out.lines.push({
      wageType: c.wageType.key, label: c.label, base: taxed, rate, amount, side: 'employer',
      source: own && firm !== undefined ? `insurance:${own.insurance.id}` : `tariff:${r}:${year}`,
      tariff: { region: r, code: loaded ? t.provision.electronic : '', income: taxed, ...(loaded ? { created: loaded.file.created, version: loaded.sha256.slice(0, 12) } : {}) },
    });
  }
  return out;
}

/** The base the tax's contribution row takes (the taxable wage). */
function baseKey(data: PayrollData, wageType: string): string {
  const c = data.contributions.find((x) => x.wageType === wageType);
  return typeof c?.base === 'string' ? c.base : '';
}
