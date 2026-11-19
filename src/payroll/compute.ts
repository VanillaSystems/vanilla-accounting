/**
 * The Lohnabrechnung computed (docs/specs/payroll.md §5.5, §6.2, §19.2): one person, one month, from the
 * values that hold in it, the recurring Lohnarten, the Lohnarten added for the month, the corrections
 * carried from a closed month, and the contributions of the jurisdiction's data. Every line prints
 * base × rate = amount with its source; a line whose input is missing is not computed but named
 * («unvollständig») and left out of every figure. A draft is computed again on every read; closing keeps
 * it (src/payroll/close.ts). Code reads only the data's keys and flags: no insurance is named here.
 * Pure and browser-safe.
 */
import { entriesWithin, entryOn, type Dated, type DatedEntry } from '../core/dated.js';
import type { FederalFigure, PayrollData, PayrollYearData } from '../core/modules/schema.js';
import { firmWageTypes, type WageType } from './catalogue.js';
import { closedOf, type PayslipHistory } from './history.js';
import type {
  Employment, MissingLine, PayrollEmployee, PayrollInsurance, PayrollLanguage, PayrollStore, PayslipClose, PayslipLine, PersonInsurances, UsedEntry,
} from './model.js';
import { payslipId } from './model.js';
import { addMonths, daysIn, firstDay, lastDay, monthsBetween, nextMonth, round2, roundStep, sum } from './money.js';

/** A fact beside the payslip: said once, never a reminder, never a block (§6.2 step 3). */
export interface PayslipFact { key: string; vars?: Record<string, string | number> }

export interface PayslipDraft {
  id: string;
  employee: string;
  month: string;
  postingDate: string;
  payday: string;
  language: PayrollLanguage;
  lines: PayslipLine[];
  missing: MissingLine[];
  bases: Record<string, { month: number; year: number }>;
  gross: number;
  /** Σ of the employee's deductions. */
  deductions: number;
  net: number;
  payout: number;
  employer: number;
  facts: PayslipFact[];
  used: UsedEntry[];
  person: PayslipClose['person'];
  text?: string;
  /** The share of the month the person was employed (1: the whole month). */
  fraction: number;
}

export interface PayrollContext {
  data: PayrollData;
  years: Readonly<Record<string, PayrollYearData>> | undefined;
  store: PayrollStore;
  history: PayslipHistory;
}

/** The settings of the firm on a day, each with its default where the firm set none (§5.1). */
function settingsOn(store: PayrollStore, day: string, read: Reader) {
  const c = store.company;
  return {
    rounding: read('company/rounding', c.rounding, day) ?? 0.05,
    proration: read('company/proration', c.proration, day) ?? 'calendar-days',
    thirteenth: read('company/thirteenth', c.thirteenth, day) ?? 'twelfth',
    payday: read('company/payday', c.payday, day) ?? 25,
    postingDate: read('company/postingDate', c.postingDate, day) ?? 'month-end',
  };
}

type Reader = <T>(path: string, h: Dated<T> | undefined, day: string) => T | undefined;

/** The days of a part month counted as the firm prorates: calendar days, or 30 to every month. */
function spanDays(from: string, to: string, month: string, method: string): { days: number; of: number } {
  const total = daysIn(month);
  if (method !== 'thirty-days') return { days: Number(to.slice(8)) - Number(from.slice(8)) + 1, of: total };
  const d30 = (d: number) => Math.min(d, 30);
  const end = Number(to.slice(8)) === total ? 30 : d30(Number(to.slice(8)));
  return { days: Math.max(0, end - d30(Number(from.slice(8))) + 1), of: 30 };
}

/** The share of `month` the person is employed (0 when not at all). */
export function employedFraction(e: PayrollEmployee, month: string, method: string): number {
  return employedDays(e, firstDay(month), lastDay(month), month, method);
}

/** The share of `month` within `from`..`to` the person is employed, unrounded. */
function employedDays(e: PayrollEmployee, from: string, to: string, month: string, method: string): number {
  return entriesWithin(e.employment, from, to).filter((s) => s.entry).reduce((acc, s) => {
    const { days, of } = spanDays(s.from, s.to, month, method);
    return acc + days / of;
  }, 0);
}

const isEmployed = (e: PayrollEmployee, month: string): boolean =>
  entriesWithin(e.employment, firstDay(month), lastDay(month)).some((s) => s.entry);

/** The payday of the month: a day (the month's last when it is shorter), or its last working day. */
export function paydayOf(month: string, payday: number | 'last-working-day'): string {
  const total = daysIn(month);
  if (payday !== 'last-working-day') return `${month}-${String(Math.min(payday, total)).padStart(2, '0')}`;
  for (let d = total; d > 0; d--) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return day;
  }
  return lastDay(month);
}

/** A federal figure on a day, from the year's file; undefined when the year's file or the key is missing. */
function federalOn(years: PayrollContext['years'], key: string, day: string): FederalFigure | undefined {
  const rows = years?.[day.slice(0, 4)]?.figures[key];
  if (!rows) return undefined;
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r.validFrom <= day).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return list.at(-1);
}

/** The day the person reaches the reference age, from the year's table; undefined without a birth date or the table. */
export function referenceAgeReached(e: PayrollEmployee, year: PayrollYearData | undefined): string | undefined {
  if (!year || !/^\d{4}-\d{2}-\d{2}$/.test(e.birthDate ?? '')) return undefined;
  if (!e.sex) return undefined;
  const rows = [...(year.referenceAge[e.sex] ?? [])].sort((a, b) => a.bornFrom - b.bornFrom);
  const born = Number(e.birthDate.slice(0, 4));
  const row = rows.filter((r) => r.bornFrom <= born).at(-1);
  if (!row) return undefined;
  return addMonths(e.birthDate, row.years * 12 + row.months);
}

const LANGS: readonly PayrollLanguage[] = ['de', 'fr', 'it', 'en'];

/**
 * The draft of `employee`'s payslip for `month`, or undefined when the person is not employed in it and
 * has nothing added to it. A month already closed is read from its close, never computed.
 */
export function computePayslip(ctx: PayrollContext, employeeId: string, month: string): PayslipDraft | undefined {
  const { data, store, history } = ctx;
  const e = store.employees.find((x) => x.id === employeeId);
  if (!e) return undefined;
  const from = firstDay(month);
  const to = lastDay(month);
  const year = month.slice(0, 4);
  const used = new Map<string, UsedEntry>();
  const read: Reader = (path, h, day) => {
    const hit = entryOn(h, day);
    if (hit) used.set(`${path}|${hit.validFrom}|${hit.enteredAt}`, { path, validFrom: hit.validFrom, enteredAt: hit.enteredAt });
    return hit?.value;
  };
  const note = <T>(path: string, entry: DatedEntry<T> | undefined) => {
    if (entry) used.set(`${path}|${entry.validFrom}|${entry.enteredAt}`, { path, validFrom: entry.validFrom, enteredAt: entry.enteredAt });
  };
  const settings = settingsOn(store, to, read);
  const lang: PayrollLanguage = LANGS.includes(e.language) ? e.language : 'de';
  const types = firmWageTypes(data, store);
  const label = (w: WageType) => w.label[lang] ?? w.label.de;
  const round = (x: number) => roundStep(x, settings.rounding);
  const lines: PayslipLine[] = [];
  const missing: MissingLine[] = [];
  const facts: PayslipFact[] = [];
  const add = (l: PayslipLine) => { if (l.amount !== 0 || l.corrects) lines.push(l); };
  const miss = (wageType: string, code: string, days?: { from: string; to: string }) => {
    const w = types.get(wageType);
    missing.push({ wageType, label: w ? label(w) : wageType, missing: code, ...(days ? { days } : {}) });
  };

  const employed = isEmployed(e, month);
  const monthLines = store.monthLines.filter((l) => l.employee === e.id && l.month === month && !l.removed);
  const earlier = closedOf(history, e.id).filter((c) => c.month < month && c.month.startsWith(year));
  const pendingCorrections = correctionsFor(ctx, e, month);
  if (!employed && !monthLines.length && !pendingCorrections.length) return undefined;

  const spans = entriesWithin(e.employment, from, to);
  const fraction = employedFraction(e, month, settings.proration);
  const firstEntry = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];
  const lastEntry = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1);
  if (firstEntry && firstEntry.validFrom >= from && firstEntry.validFrom <= to) facts.push({ key: 'entry', vars: { date: firstEntry.validFrom } });
  if (lastEntry?.validUntil && lastEntry.validUntil >= from && lastEntry.validUntil <= to) facts.push({ key: 'exit', vars: { date: lastEntry.validUntil } });
  const openBefore = monthsBetween(`${year}-01`, month).filter((m) => m < month && isEmployed(e, m) && !history.closed.has(payslipId(m, e.id)));
  if (openBefore.length) facts.push({ key: 'earlierOpen', vars: { month: openBefore[0] } });

  // 1. The wage of the Anstellung, split where it changes inside the month.
  for (const s of spans) {
    if (!s.entry) continue;
    note(`employees/${e.id}/employment`, s.entry);
    const job: Employment = s.entry.value;
    const { days, of } = spanDays(s.from, s.to, month, settings.proration);
    const whole = days === of;
    const split = spans.filter((x) => x.entry).length > 1 || !whole;
    const daysOf = split ? { days: { from: s.from, to: s.to } } : {};
    if (job.kind === 'monthly') {
      const w = [...types.values()].find((t) => t.computes === 'monthly');
      if (!w) continue;
      const base = round2(job.amount * (job.pensum ?? 100) / 100);
      const amount = whole ? base : round(base * days / of);
      add({ wageType: w.key, label: label(w), base, ...(whole ? {} : { rate: round2(days / of * 100), quantity: days }), amount, side: 'employee', source: 'employment', ...daysOf });
    } else {
      const hourly = monthLines.filter((l) => types.get(l.wageType)?.hours);
      if (!hourly.length) {
        const w = [...types.values()].find((t) => t.hours);
        if (w) miss(w.key, 'hours', split ? { from: s.from, to: s.to } : undefined);
      }
    }
  }

  // 2. The recurring Lohnarten, each for the days it holds.
  for (const r of e.recurring) {
    const w = types.get(r.wageType);
    if (!w) continue;
    for (const s of entriesWithin(r.value, from, to)) {
      if (!s.entry || !employed) continue;
      note(`employees/${e.id}/recurring/${r.wageType}`, s.entry);
      // Its days within the employment: a person who starts on the 16th gets half a month's flat expenses.
      const share = employedDays(e, s.from, s.to, month, settings.proration);
      if (share <= 0) continue;
      const v = s.entry.value;
      const line = valued(w, v, label(w), 'recurring');
      if (!line) { miss(w.key, w.input === 'quantity' ? 'quantity' : 'amount'); continue; }
      const amount = share === 1 ? line.amount : round(line.amount * share);
      add({ ...line, amount, ...(share === 1 ? {} : { days: { from: s.from, to: s.to } }) });
    }
  }

  // 3. The Lohnarten added for the month.
  const hourlyRate = spans.map((x) => x.entry?.value).find((j) => j?.kind === 'hourly')?.amount;
  for (const l of monthLines) {
    const w = types.get(l.wageType);
    if (!w) continue;
    const line = valued(w, w.hours && l.rate === undefined && hourlyRate !== undefined ? { ...l, rate: hourlyRate } : l, label(w), w.hours ? 'employment' : 'entered');
    if (!line) { miss(w.key, w.input === 'quantity' ? 'quantity' : 'amount'); continue; }
    add({ ...line, ...(l.text ? { text: l.text } : {}) });
  }

  // 4. The corrections carried from a closed month.
  for (const c of pendingCorrections) {
    const w = types.get(c.wageType);
    if (!w) continue;
    const of = history.closed.get(c.of);
    add({
      wageType: w.key, label: label(w), amount: c.amount, side: c.side, source: 'correction', corrects: c.of, correction: c.id,
      ...(c.base !== undefined ? { base: c.base } : {}), ...(c.rateDiff !== undefined ? { rate: c.rateDiff } : {}),
      ...(c.text ? { text: c.text } : {}), ...(of ? { days: { from: firstDay(of.month), to: lastDay(of.month) } } : {}),
    });
  }

  // 5. The 13th salary in its payout months, and with the last month of a person who leaves.
  const job = entryOn(e.employment, to)?.value ?? lastEntry?.value;
  const thirteenthType = [...types.values()].find((t) => t.computes === 'thirteenth');
  const leaves = !!lastEntry?.validUntil && lastEntry.validUntil >= from && lastEntry.validUntil <= to;
  const tb = data.bases.find((b) => b.thirteenth)?.key;
  // December always pays out what the year owes (model.ts Employment.thirteenth).
  if (thirteenthType && tb && job?.thirteenth && (job.thirteenth.months.includes(Number(month.slice(5))) || month.endsWith('-12') || leaves)) {
    const paidIn = earlier.filter((c) => c.lines.some((l) => l.wageType === thirteenthType.key && !l.corrects)).map((c) => c.month).at(-1);
    const since = earlier.filter((c) => !paidIn || c.month > paidIn);
    const opening = paidIn ? 0 : e.opening?.[year]?.bases?.[tb] ?? 0;
    const base = round2(opening + sum(since.map((c) => c.bases[tb]?.month ?? 0)) + (basesOf(lines, types)[tb] ?? 0));
    const rate = settings.thirteenth === 'percent' ? 8.33 : 100 / 12;
    add({ wageType: thirteenthType.key, label: label(thirteenthType), base, rate: round2(rate), amount: round(base * rate / 100), side: 'employee', source: settings.thirteenth === 'percent' ? 'thirteenth-percent' : 'thirteenth-twelfth' });
  }

  // 6. The contributions, in the data's order.
  const bases = basesOf(lines, types);
  const insurancesOn = read(`employees/${e.id}/insurances`, e.insurances, to) ?? {};
  const fig = (key: string) => {
    const f = federalOn(ctx.years, key, to);
    if (f) used.set(`federal/${key}|${f.validFrom}`, { path: `federal/${key}`, validFrom: f.validFrom, enteredAt: f.validFrom });
    return f;
  };
  const yearData = ctx.years?.[year];
  const reachDay = referenceAgeReached(e, yearData);
  const pensioner = !!reachDay && from > lastDay(reachDay.slice(0, 7));
  if (pensioner) facts.push({ key: 'pensioner', vars: { date: reachDay! } });
  if (!e.sex) facts.push({ key: 'sexMissing' });
  const computed = new Map<string, number>();
  const cumulated: Record<string, { base: number; capped: number; ceiling: number }> = {};
  /** The capped base of each base and ceiling this month: kept on the close, so the next month caps against what was used. */
  const capped: Record<string, number> = {};
  for (const c of data.contributions) {
    const w = types.get(c.wageType);
    if (!w) continue;
    const kind = data.insurances[c.insurance];
    const side: 'employee' | 'employer' = w.side === 'employer' ? 'employer' : 'employee';
    if (kind?.computed === false) {
      const tax = read(`employees/${e.id}/taxAtSource`, e.taxAtSource, to);
      if (tax?.subject) miss(w.key, 'notComputed');
      continue;
    }
    const firm = insuranceOf(store, c.insurance, from, to);
    if (!firm) {
      if (kind?.required) miss(w.key, 'insurance');
      continue;
    }
    // Liability by age, and past the reference age.
    if (c.liable) {
      const age = fig(c.liable);
      if (!age) { miss(w.key, 'federal'); continue; }
      const startYear = Number(e.birthDate?.slice(0, 4)) + age.value + 1;
      if (Number.isFinite(startYear) && Number(year) < startYear) { if (!facts.some((f) => f.key === 'notLiable')) facts.push({ key: 'notLiable', vars: { year: startYear } }); continue; }
    }
    if (pensioner && c.pensioner === 'ends') continue;
    if (c.minHours) {
      const min = fig(c.minHours);
      if (min && job?.hoursPerWeek !== undefined && job.hoursPerWeek < min.value) {
        if (!facts.some((f) => f.key === 'belowHours')) facts.push({ key: 'belowHours', vars: { hours: min.value } });
        continue;
      }
    }
    // The base.
    let base = typeof c.base === 'string' ? bases[c.base] ?? 0 : round2(sum(c.base.lines.map((k) => computed.get(k) ?? 0)));
    if (pensioner && typeof c.pensioner === 'object' && insurancesOn.pensioner !== 'waiver') {
      const allowance = fig(c.pensioner.allowance);
      if (!allowance) { miss(w.key, 'federal'); continue; }
      base = Math.max(0, round2(base - allowance.value * fraction));
    }
    if (c.ceiling) {
      const ceiling = fig(c.ceiling);
      if (!ceiling) { miss(w.key, 'federal'); continue; }
      const raw = typeof c.base === 'string' ? c.base : '';
      const key = `${raw}|${c.ceiling}`;
      const cum = cumulated[key] ??= cumulative(ctx, e, month, raw, key, settings.proration, ceiling.value);
      const own = round2(Math.min(cum.base + base, cum.ceiling) - cum.capped);
      if (own < base && !facts.some((f) => f.key === 'ceiling')) facts.push({ key: 'ceiling', vars: { amount: ceiling.value } });
      capped[key] = own;
      base = own;
    }
    // The person's own figures (a pension certificate), or a rate.
    if ('person' in c.rate) {
      const cert = insurancesOn[c.insurance] as PersonInsurances['bvg'];
      if (kind?.requiredAbove) {
        const threshold = fig(kind.requiredAbove.figure);
        // The yearly wage the Anstellung promises; an hourly one by this month's wage, as the fund does it.
        const yearly = job?.kind === 'monthly'
          ? round2(job.amount * (job.pensum ?? 100) / 100 * (12 + (job.thirteenth ? 1 : 0)))
          : round2((bases[kind.requiredAbove.base] ?? 0) / Math.max(fraction, 1 / 31) * 12);
        if (threshold && yearly <= threshold.value && !cert) {
          if (!facts.some((f) => f.key === 'belowThreshold')) facts.push({ key: 'belowThreshold', vars: { amount: threshold.value } });
          continue;
        }
      }
      if (!cert) { miss(w.key, 'certificate'); continue; }
      if ('percent' in cert) {
        const pct = cert.percent[c.rate.person];
        add({ wageType: w.key, label: label(w), base, rate: pct, amount: round(base * pct / 100), side, source: `insurance:${firm.id}` });
      } else {
        const monthly = cert[c.rate.person];
        if (typeof monthly !== 'number') { miss(w.key, 'certificate'); continue; }
        const amount = fraction === 1 ? monthly : round(monthly * fraction);
        add({ wageType: w.key, label: label(w), ...(fraction === 1 ? {} : { base: monthly, rate: round2(fraction * 100) }), amount, side, source: `insurance:${firm.id}` });
      }
      computed.set(w.key, lines.at(-1)?.wageType === w.key ? lines.at(-1)!.amount : 0);
      continue;
    }
    let rate: number | undefined;
    let source: string;
    if ('federal' in c.rate) {
      const f = fig(c.rate.federal);
      if (!f) { miss(w.key, 'federal'); continue; }
      rate = f.value;
      source = `federal:${c.rate.federal}`;
    } else {
      const solution = solutionOf(firm, insurancesOn, c.insurance);
      if (!solution) { miss(w.key, 'solution'); continue; }
      const rates = read(`insurances/${firm.id}/solutions/${solution.code}/rates`, solution.rates, to);
      rate = rates?.[c.rate.insurance];
      if (rate === undefined) { miss(w.key, `rate:${c.rate.insurance}`); continue; }
      if (c.share) {
        const employerShare = rates?.[c.share.employer];
        if (employerShare === undefined) { miss(w.key, `rate:${c.share.employer}`); continue; }
        rate = round2((side === 'employer' ? employerShare : 100 - employerShare) * rate / 100 * 1e4) / 1e4;
      }
      source = `insurance:${firm.id}`;
    }
    const amount = round(base * rate / 100);
    computed.set(w.key, amount);
    if (amount !== 0 || base !== 0) add({ wageType: w.key, label: label(w), base, rate, amount, side, source });
  }

  const totals = totalsOf(lines, types);
  const bank = read(`employees/${e.id}/bank`, e.bank, paydayOf(month, settings.payday));
  if (!bank?.iban && totals.payout > 0) facts.push({ key: 'noIban' });
  const name = read(`employees/${e.id}/name`, e.name, to) ?? e.name.at(-1)?.value;
  const address = read(`employees/${e.id}/address`, e.address, paydayOf(month, settings.payday));
  const payday = paydayOf(month, settings.payday);
  const text = store.monthTexts?.[month];
  return {
    id: payslipId(month, e.id), employee: e.id, month,
    postingDate: settings.postingDate === 'payday' ? payday : to, payday, language: lang,
    lines, missing,
    bases: Object.fromEntries(Object.entries({ ...bases, ...capped }).map(([k, v]) => [k, { month: v, year: round2(sum(earlier.map((c) => c.bases[k]?.month ?? 0)) + (e.opening?.[year]?.bases?.[k] ?? 0) + v) }])),
    ...totals, facts, used: [...used.values()].sort((a, b) => a.path.localeCompare(b.path)),
    person: {
      name: name ? `${name.first} ${name.last}` : e.id, language: lang,
      ...(address ? { address: { postcode: address.postcode, town: address.town, country: address.country, ...(address.street ? { street: address.street } : {}), ...(address.number ? { number: address.number } : {}) } } : {}),
      ...(bank?.iban ? { iban: bank.iban } : {}),
    },
    ...(text ? { text } : {}),
    fraction: round2(fraction * 1e4) / 1e4,
  };
}

/** A line from an amount, quantity × rate, or base × rate %; undefined when its input is missing. */
function valued(w: WageType, v: { amount?: number; quantity?: number; rate?: number; base?: number }, label: string, source: string): PayslipLine | undefined {
  const side = w.side === 'employer' ? 'employer' : 'employee';
  if (typeof v.amount === 'number') return { wageType: w.key, label, amount: round2(v.amount), side, source };
  if (typeof v.quantity === 'number' && typeof v.rate === 'number') return { wageType: w.key, label, quantity: v.quantity, rate: v.rate, amount: round2(v.quantity * v.rate), side, source };
  if (typeof v.base === 'number' && typeof v.rate === 'number') return { wageType: w.key, label, base: v.base, rate: v.rate, amount: round2(v.base * v.rate / 100), side, source };
  return undefined;
}

/** The sum of the lines per base, signed. */
export function basesOf(lines: readonly PayslipLine[], types: ReadonlyMap<string, WageType>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    const w = types.get(l.wageType);
    if (!w || w.side === 'employer') continue;
    for (const b of w.bases) out[b] = round2((out[b] ?? 0) + (w.sign === '-' ? -l.amount : l.amount));
  }
  return out;
}

/** The payslip's totals from its lines and their Lohnarten's stages and flags. */
export function totalsOf(lines: readonly PayslipLine[], types: ReadonlyMap<string, WageType>): { gross: number; deductions: number; net: number; payout: number; employer: number } {
  let gross = 0; let deductions = 0; let after = 0; let noCash = 0; let employer = 0;
  for (const l of lines) {
    const w = types.get(l.wageType);
    if (!w) continue;
    const signed = w.sign === '-' ? -l.amount : l.amount;
    if (w.stage === 'employer') employer += l.amount;
    else if (w.stage === 'gross') { gross += signed; if (w.cash === false) noCash += signed; }
    else if (w.stage === 'deduction') deductions -= signed;
    else after += signed;
  }
  const net = round2(gross - deductions);
  return { gross: round2(gross), deductions: round2(deductions), net, payout: round2(net + after - noCash), employer: round2(employer) };
}

/** The firm's insurance of `kind` in the month: the first that holds on any of its days. */
export function insuranceOf(store: Pick<PayrollStore, 'insurances'>, kind: string, from: string, to: string): PayrollInsurance | undefined {
  return store.insurances.find((i) => i.kind === kind && i.validFrom <= to && (!i.validUntil || i.validUntil >= from));
}

/** The solution the person is in: her code for the kind, else the insurance's only (or first) solution. */
function solutionOf(firm: PayrollInsurance, person: PersonInsurances, kind: string) {
  const own = person[kind] as { code?: string } | undefined;
  if (own?.code) return firm.solutions.find((s) => s.code === own.code);
  return firm.solutions[0];
}

/**
 * The cumulated base and ceiling of the year up to the month before (§3b: payroll annualises month by
 * month): the base of the closed months, the capped base their lines used, and the ceiling to date with
 * this month's share.
 */
function cumulative(ctx: PayrollContext, e: PayrollEmployee, month: string, base: string, key: string, proration: string, yearly: number): { base: number; capped: number; ceiling: number } {
  const year = month.slice(0, 4);
  const earlier = closedOf(ctx.history, e.id).filter((c) => c.month < month && c.month.startsWith(year));
  const opening = e.opening?.[year];
  const share = (m: string) => employedFraction(e, m, proration);
  const months = (opening?.months ?? 0) + earlier.reduce((a, c) => a + share(c.month), 0) + share(month);
  const openingBase = opening?.bases?.[base] ?? 0;
  // A month whose close kept no capped base (none of this ceiling's contributions was owed then) used at most its share of the ceiling.
  const cappedOf = (c: PayslipClose) => c.bases[key]?.month ?? Math.min(c.bases[base]?.month ?? 0, yearly / 12 * share(c.month));
  return {
    base: round2(openingBase + sum(earlier.map((c) => c.bases[base]?.month ?? 0))),
    capped: round2(Math.min(openingBase, yearly / 12 * (opening?.months ?? 0)) + sum(earlier.map(cappedOf))),
    ceiling: round2(yearly / 12 * months),
  };
}

/**
 * The corrections a draft of `month` carries: those against a closed payslip of the person, not carried
 * by a standing close, whose next open month of the person is this one (§6.5 step 1).
 */
function correctionsFor(ctx: PayrollContext, e: PayrollEmployee, month: string) {
  return ctx.history.corrections.filter((c) => {
    if (ctx.history.carriedBy.has(c.id)) return false;
    const of = ctx.history.closed.get(c.of);
    // A correction entered before the payslip's standing close belonged to a close that was reopened since: it is void.
    if (!of || of.employee !== e.id || of.month >= month || c.at < of.closedAt) return false;
    for (let m = nextMonth(of.month); m <= month; m = nextMonth(m)) {
      if (ctx.history.closed.has(payslipId(m, e.id))) continue;
      return m === month;
    }
    return false;
  });
}
