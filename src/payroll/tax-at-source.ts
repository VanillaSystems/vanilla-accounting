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
import { codeRuleOf } from './sources.js';
import type { PayrollInsurance, PayslipLine, TaxAtSource, UsedEntry } from './model.js';
import { round2, roundStep } from './money.js';

/** A tariff file as payroll reads it: the parsed file, the checksum of its bytes, when and where it was fetched. */
export interface LoadedTariff { region: string; year: string; file: TariffFile; sha256: string; fetchedAt: string; url?: string }

/** The tariff file of a region and year the workspace has, or undefined. */
export type TariffSource = (region: string, year: string) => LoadedTariff | undefined;

/** Where a tax line comes from: the file, the code and the rate-determining income it was looked up with. */
export interface TariffUse {
  region: string; code: string; income: number; created?: string; version?: string; units?: UnitsUse; abroad?: { days: number; total: number; wage: number };
  /** The annual model: `income` is the year's; the month's it was looked up with, and the months of the year it counts. */
  annual?: { monthly: number; months: number };
  /** The year's settlement: the earlier months it settles, what they owe at the year's rate, what they withheld. */
  yearEnd?: { months: number; owed: number; withheld: number };
}

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
  /** The working days she worked abroad this month (and the month's working days, absent: the data's), §22 decision 121. */
  abroad?: { abroad: number; total?: number };
  /** Her address on the month's last day is in the jurisdiction's own country: days abroad are taken off only where a treaty says so. */
  resident?: boolean;
  /**
   * The annual model (§22 decision 122): her closed months of the year before this one (not the opening's), each with
   * its lines as closed, its days employed scaled to `partMonth` and the region she was taxed in.
   */
  year?: ReadonlyArray<{ id: string; month: string; lines: readonly PayslipLine[]; days: number; region?: string; base: number }>;
  /** The month the year's tax is settled in: December, or the employment ends in it. */
  yearEnd?: boolean;
  /** The year has an opening (months paid before the app): their wages are not in `year`. */
  opening?: boolean;
  /** Not employed in the month (a payment after the exit). */
  afterExit?: boolean;
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
  /** What the payslip says beside the tax (days abroad of a resident, an aperiodic payment taxed whole). */
  facts: Array<{ key: string; vars?: Record<string, string | number> }>;
}

/** The tariff code the file names: a letter, the children and the church tax (A0N); two characters take the church flag. */
export function tariffCode(code: string | undefined, church: boolean | undefined): string | undefined {
  const c = (code ?? '').trim().toUpperCase();
  if (/^[A-Z][0-9A-Z][NY]$/.test(c)) return c;
  if (/^[A-Z][0-9A-Z]$/.test(c)) return `${c}${church ? 'Y' : 'N'}`;
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
  const out: TaxAtSourceResult = { lines: [], missing: [], used: [], facts: [] };
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
    if (model === 'annual' && input.afterExit) return miss(`annualAfterExit:${region}`);
    const code = tariffCode(person.code, person.church);
    if (!code) return miss('taxCode');
    // A code the payslip does not compute (the simplified procedure, an insurer's replacement income), or reports at 0 % (§22 decision 120).
    const rule = codeRuleOf(data, code);
    if (rule?.refuse) return miss(`taxCodeRefused:${code}`);
    const loaded = input.tariffs?.(region, year);
    if (!loaded) return miss(`tariff:${region}:${year}`);
    out.used.push({ path: `tariffs/${region}/${year}`, validFrom: loaded.file.created, enteredAt: loaded.sha256.slice(0, 12) });

    // The month's taxable wage: its periodic part, of which what the firm prorated to the days employed (a line with
    // its days: the monthly wage, a recurring Lohnart), and its aperiodic part (a carried correction is aperiodic).
    const qst = baseKey(data, input.wageType.key);
    const { prorated, periodic, aperiodic } = splitOf(t, types, lines, qst);
    const base = round2(prorated + periodic + aperiodic);
    if (base <= 0) return undefined;

    // A wage not paid monthly: its average rate per unit worked, times the units of a month (§22 decision 119).
    const units = person.notMonthly ? unitIncome(t, types, lines, qst) : undefined;
    if (units === 'mixed') return miss('notMonthlyMixed');
    let income: number;
    // The annual model: the year's rate-determining income, looked up as a month's (the files' brackets are monthly).
    const months = model === 'annual' ? (input.year ?? []).filter((m) => m.region === region) : [];
    let annual: ReturnType<typeof annualIncome> | undefined;
    if (model === 'annual') {
      annual = annualIncome(t, types, qst, months, { lines, days: input.days }, person, input.pensum, loaded.file.median);
      if (annual === 'mixed') return miss('notMonthlyMixed');
      income = annual.monthly;
    } else if (units) income = units.income;
    else {
      // The rate-determining income (KS 45 Ziff. 6): what the firm prorated in a part month back to a whole month;
      // what is paid as worked (hours, a month's line) counts as paid (§22 decision 94); other employments to their whole.
      income = periodic + (input.days > 0 && input.days < t.partMonth ? prorated * t.partMonth / input.days : prorated);
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
    }

    // Days worked abroad (KS 45 Ziff. 3.2.2, 6.7): the tax on the Swiss days' share of the periodic wage, at the rate of
    // the whole wage. An aperiodic payment was earned over another period, whose share the app does not know: taxed whole.
    let taxable = base;
    let abroad: TariffUse['abroad'];
    if (input.abroad && input.abroad.abroad > 0 && t.abroad) {
      const total = input.abroad.total ?? t.abroad.workdays;
      const swiss = Math.max(0, total - input.abroad.abroad);
      taxable = round2((prorated + periodic) * swiss / total + aperiodic);
      abroad = { days: input.abroad.abroad, total, wage: base };
      if (round2(aperiodic) !== 0) out.facts.push({ key: 'abroadAperiodic', vars: { amount: round2(aperiodic) } });
      if (input.resident) out.facts.push({ key: 'abroadResident' });
      if (taxable <= 0) return undefined;
    }

    let file = code;
    let bracket = bracketOf(loaded.file, file, income, to);
    // A region whose tariffs are only with or only without the church tax lists one of them (format, Ziff. 4.2.4).
    if (!bracket && /^[A-Z][0-9][NY]$/.test(code)) {
      file = `${code.slice(0, 2)}${code[2] === 'Y' ? 'N' : 'Y'}`;
      if (!loaded.file.tariffs.has(file)) file = code; else bracket = bracketOf(loaded.file, file, income, to);
    }
    if (!bracket) return miss(`taxCodeUnknown:${code}`);
    let amount = roundStep(taxable * bracket.rate / 100, t.rounding);
    if (amount < bracket.minimum) amount = bracket.minimum;
    const used = annual && annual !== 'mixed' ? annual : undefined;
    const tariff: TariffUse = {
      region, code: file, income: used ? used.annual : income, created: loaded.file.created, version: loaded.sha256.slice(0, 12),
      ...(units && !used ? { units: units.used } : {}), ...(used?.units ? { units: used.units } : {}), ...(abroad ? { abroad } : {}),
      ...(used ? { annual: { monthly: used.monthly, months: months.length + 1 } } : {}),
    };
    if (amount !== 0 || rule?.report) out.lines.push({ wageType: input.wageType.key, label: input.label, base: taxable, rate: bracket.rate, amount, side: 'employee', source: `tariff:${region}:${year}`, tariff });

    // The year's tax settled in December or the exit month (KS 45 Ziff. 7.2, 7.3.1): every month of the year in the
    // region at the rate of the year's income, less what was withheld; the difference is a line of this month.
    if (!used || !input.yearEnd) return undefined;
    if (input.opening) return miss(`annualOpening:${region}`);
    const ids = new Set(months.map((m) => m.id));
    let due = 0; let earlier = 0;
    for (const m of months) {
      const own = m.lines.find((l) => isTax(l) && !l.corrects && !l.tariff?.yearEnd && l.tariff);
      const c = own?.tariff?.code ?? file;
      const r = bracketOf(loaded.file, c, used.monthly, to)?.rate ?? bracket.rate;
      due += m.base * r / 100;
      earlier += m.base;
    }
    // Withheld: every tax line of those months (their own, a settlement, a correction they carried for a month of the
    // year), and the corrections this month carries for one of them.
    const ofYear = (l: PayslipLine) => isTax(l) && (l.tariff?.region ?? (l.corrects ? input.regionOf(l.corrects) : region)) === region && (!l.corrects || ids.has(l.corrects));
    const withheld = round2(months.reduce((s, m) => s + m.lines.filter(ofYear).reduce((x, l) => x + l.amount, 0), 0) + lines.filter((l) => l.corrects && ofYear(l)).reduce((x, l) => x + l.amount, 0));
    const owed = roundStep(due, t.rounding);
    const settle = round2(owed - withheld);
    out.facts.push({ key: 'annualSettled', vars: { year, months: months.length + 1, owed: round2(owed + amount), withheld: round2(withheld + amount) } });
    if (settle === 0 || !months.length) return undefined;
    out.lines.push({
      wageType: input.wageType.key, label: input.label, base: round2(earlier), rate: bracket.rate, amount: settle, side: 'employee', source: `tariff:${region}:${year}`,
      tariff: { ...tariff, units: undefined, abroad: undefined, yearEnd: { months: months.length, owed, withheld } },
    });
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
    // Rounded as the tax is (the data's step `rounding`): money of the same settlement (§22 decision 112).
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

/** A month's lines that count for the tax's base, by kind: prorated to the days employed, other periodic, aperiodic. */
function splitOf(t: TaxAtSourceData, types: ReadonlyMap<string, WageType>, lines: readonly PayslipLine[], base: string) {
  let prorated = 0; let periodic = 0; let aperiodic = 0;
  for (const l of lines) {
    const w = types.get(l.wageType);
    if (!w || w.side === 'employer' || !w.bases.includes(base)) continue;
    const signed = w.sign === '-' ? -l.amount : l.amount;
    if (l.corrects || t.aperiodic.includes(w.lohnausweis ?? '')) aperiodic += signed;
    else if (l.days) prorated += signed;
    else periodic += signed;
  }
  return { prorated, periodic, aperiodic };
}

/**
 * The annual model's rate-determining income (KS 45 Ziff. 7.3; §22 decision 122): the year's periodic wage so far over
 * its days employed (30 a month) times 360, her other employments to their whole, plus the year's aperiodic payments;
 * a wage not paid monthly by its average rate × 12 months' units. `monthly` is the twelfth the files' monthly brackets
 * are read with.
 */
function annualIncome(
  t: TaxAtSourceData, types: ReadonlyMap<string, WageType>, qst: string,
  months: ReadonlyArray<{ lines: readonly PayslipLine[]; days: number }>, now: { lines: readonly PayslipLine[]; days: number },
  person: TaxAtSource, pensum: number | undefined, median: number | undefined,
): { annual: number; monthly: number; units?: UnitsUse } | 'mixed' {
  const all = [...months, now];
  if (person.notMonthly) {
    const year = all.flatMap((m) => m.lines);
    const u = unitIncome(t, types, year, qst);
    if (u === 'mixed') return 'mixed';
    if (u) {
      const perYear = round2(u.used.paid / u.used.quantity * u.used.per * 12 + (u.income - u.used.paid / u.used.quantity * u.used.per));
      return { annual: perYear, monthly: round2(perYear / 12), units: { ...u.used, per: round2(u.used.per * 12) } };
    }
  }
  let periodic = 0; let aperiodic = 0; let days = 0;
  for (const m of all) {
    const s = splitOf(t, types, m.lines, qst);
    periodic += s.prorated + s.periodic;
    aperiodic += s.aperiodic;
    days += m.days;
  }
  const year = t.partMonth * 12;
  let income = days > 0 ? periodic / days * year : 0;
  const other = person.otherEmployment;
  if (other !== undefined) {
    if (typeof other === 'object' && typeof other.income === 'number') income += other.income * 12;
    else if (pensum && pensum > 0) {
      const whole = other === 'unknown' ? 100 : pensum + (typeof other === 'object' ? other.pensum ?? 0 : 0);
      if (other === 'unknown' ? pensum < 100 : true) income = income * whole / pensum;
    } else if (median !== undefined) income = Math.max(income, median * 12);
  }
  const annual = round2(income + aperiodic);
  return { annual, monthly: round2(annual / 12) };
}

/** How a wage not paid monthly was extrapolated: what was paid on the units worked, how many, and to how many a month. */
export interface UnitsUse { key: string; paid: number; quantity: number; per: number }

/**
 * The rate-determining income of a wage not paid monthly (data `notMonthly`): what the unit's Lohnarten paid, over the
 * units worked, times the units of a month, and the lines of the `asPaid` groups as they are. Undefined when the month
 * has no line of a unit (the ordinary rule holds); `mixed` when it has lines of two units (hours and days).
 */
export function unitIncome(t: TaxAtSourceData, types: ReadonlyMap<string, WageType>, lines: readonly PayslipLine[], base: string): { income: number; used: UnitsUse } | 'mixed' | undefined {
  const rules = t.notMonthly;
  if (!rules) return undefined;
  const counted = (l: PayslipLine) => {
    const w = types.get(l.wageType);
    return w && w.side !== 'employer' && w.bases.includes(base) && !l.corrects ? w : undefined;
  };
  const signed = (l: PayslipLine, w: WageType) => (w.sign === '-' ? -l.amount : l.amount);
  const hit = rules.units.filter((u) => lines.some((l) => counted(l) && u.counts.includes(l.wageType) && (l.quantity ?? 0) !== 0));
  if (hit.length > 1) return 'mixed';
  const unit = hit[0];
  if (!unit) return undefined;
  let paid = 0; let quantity = 0; let asPaid = 0;
  for (const l of lines) {
    const w = counted(l);
    if (!w) continue;
    if (unit.counts.includes(l.wageType)) { paid += signed(l, w); quantity += l.quantity ?? 0; }
    else if (unit.with?.includes(l.wageType)) paid += signed(l, w);
    else if (rules.asPaid.includes(w.group)) asPaid += signed(l, w);
  }
  if (quantity <= 0) return undefined;
  return { income: round2(paid / quantity * unit.per + asPaid), used: { key: unit.key, paid: round2(paid), quantity: round2(quantity), per: unit.per } };
}

/** The base the tax's contribution row takes (the taxable wage). */
function baseKey(data: PayrollData, wageType: string): string {
  const c = data.contributions.find((x) => x.wageType === wageType);
  return typeof c?.base === 'string' ? c.base : '';
}
