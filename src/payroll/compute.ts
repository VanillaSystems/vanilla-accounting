/**
 * The Lohnabrechnung computed (docs/specs/payroll.md §5.5, §6.2, §19.2): one person, one month, from the
 * values that hold in it, the recurring Lohnarten, the Lohnarten added for the month, the corrections
 * carried from a closed month, and the contributions of the jurisdiction's data. Every line prints
 * base × rate = amount with its source; a line whose input is missing is not computed but named
 * («unvollständig») and left out of every figure. A draft is computed again on every read; closing keeps
 * it (src/payroll/close.ts). Code reads only the data's keys and flags: no insurance is named here.
 * Pure and browser-safe.
 */
import { entriesWithin, entryOn, nextDay, type Dated, type DatedEntry } from '../core/dated.js';
import type { FederalFigure, PayrollData, PayrollYearData } from '../core/modules/schema.js';
import { firmWageTypes, type WageType } from './catalogue.js';
import { closedOf, type PayslipHistory } from './history.js';
import type {
  Employment, HolidayBalance, MissingLine, PayrollEmployee, PayrollInsurance, PayrollLanguage, PayrollStore, PayslipClose, PayslipLine, PersonInsurances, UsedEntry,
} from './model.js';
import { payslipId } from './model.js';
import { inOpening, openingOf } from './opening.js';
import { taxAtSourceLines, type TariffSource } from './tax-at-source.js';
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
  /** The holiday balance in days at the month's end; absent where the holidays are paid with an hourly wage. */
  holidays?: HolidayBalance;
  /** The share of the month the person was employed (1: the whole month). */
  fraction: number;
}

export interface PayrollContext {
  data: PayrollData;
  years: Readonly<Record<string, PayrollYearData>> | undefined;
  store: PayrollStore;
  history: PayslipHistory;
  /** The tax at source's tariff files the workspace has (src/payroll/tariffs.ts); absent: none. */
  tariffs?: TariffSource;
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
    holidayBasis: read('company/holidayBasis', c.holidayBasis, day) ?? 'wage',
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

/** The shipped year nearest to `year` (the later of two as near), or undefined when none is shipped. */
function nearestYear(years: PayrollContext['years'], year: string): string | undefined {
  const all = Object.keys(years ?? {}).sort();
  return all.sort((a, b) => Math.abs(Number(a) - Number(year)) - Math.abs(Number(b) - Number(year)) || b.localeCompare(a))[0];
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
  // A month of the person's opening was paid and booked before payroll ran here: it has no payslip of the app.
  if (inOpening(e, month)) return undefined;
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

  // The law's rates and ceilings: of the payment's month, but a payment after the employment ended, in a later year,
  // takes those of the year it was earned in, its last year (WBB Rz 2038; while employed, the payment year's, Rz 2039).
  const earnedIn = referenceYear(e, month);
  // A year whose figures the app does not ship (yet): the nearest year it ships, said on the payslip, never no line.
  const figureYear = earnedIn === year || ctx.years?.[earnedIn] ? earnedIn : nearestYear(ctx.years, earnedIn);
  const figureDay = figureYear === year ? to : figureYear && figureYear > earnedIn ? `${figureYear}-01-01` : `${figureYear ?? earnedIn}-12-31`;
  const fig = (key: string) => {
    const f = federalOn(ctx.years, key, figureDay);
    if (f && figureYear && figureYear !== earnedIn) fact('figuresOfYear', { earned: earnedIn, year: figureYear });
    if (f) used.set(`federal/${key}|${f.validFrom}`, { path: `federal/${key}`, validFrom: f.validFrom, enteredAt: f.validFrom });
    return f;
  };
  const fact = (key: string, vars?: PayslipFact['vars']) => { if (!facts.some((f) => f.key === key && JSON.stringify(f.vars) === JSON.stringify(vars))) facts.push({ key, ...(vars ? { vars } : {}) }); };

  const employed = isEmployed(e, month);
  const monthLines = store.monthLines.filter((l) => l.employee === e.id && l.month === month && !l.removed);
  // A close of an opening month (made before the opening said so) counts no more: the opening holds that month.
  const earlier = closedOf(history, e.id).filter((c) => c.month < month && c.month.startsWith(year) && !inOpening(e, c.month));
  const opening = openingOf(e, year);
  const pendingCorrections = correctionsFor(ctx, e, month);
  if (!employed && !monthLines.length && !pendingCorrections.length) return undefined;

  const spans = entriesWithin(e.employment, from, to);
  const fraction = employedFraction(e, month, settings.proration);
  const firstEntry = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];
  const lastEntry = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1);
  if (firstEntry && firstEntry.validFrom >= from && firstEntry.validFrom <= to) facts.push({ key: 'entry', vars: { date: firstEntry.validFrom } });
  if (lastEntry?.validUntil && lastEntry.validUntil >= from && lastEntry.validUntil <= to) facts.push({ key: 'exit', vars: { date: lastEntry.validUntil } });
  const openBefore = monthsBetween(`${year}-01`, month).filter((m) => m < month && isEmployed(e, m) && !inOpening(e, m) && !history.closed.has(payslipId(m, e.id)));
  if (openBefore.length) facts.push({ key: 'earlierOpen', vars: { month: openBefore[0] } });
  // A payment after the exit (§6.6 «Nachzahlung»): a payslip of only the Lohnarten added for the month.
  const exit = exitBefore(e, month);
  if (exit) fact('afterExit', { date: exit });

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
      if (!line) { miss(w.key, lacking(w, v)); continue; }
      const amount = share === 1 ? line.amount : round(line.amount * share);
      add({ ...line, amount, ...(share === 1 ? {} : { days: { from: s.from, to: s.to } }) });
    }
  }

  // 2b. The family allowances the fund decided per child, for the days employed; a birth allowance once.
  for (const c of e.children ?? []) {
    for (const s of entriesWithin(c.allowance, from, to)) {
      if (!s.entry || !employed) continue;
      const w = types.get(s.entry.value.wageType);
      if (!w) continue;
      note(`employees/${e.id}/children/${c.id}/allowance`, s.entry);
      const v = s.entry.value;
      const once = !!w.once;
      if (once && (s.entry.validFrom < from || s.entry.validFrom > to)) continue;
      const share = once ? 1 : employedDays(e, s.from, s.to, month, settings.proration);
      if (share <= 0) continue;
      const amount = share === 1 ? round2(v.amount) : round(v.amount * share);
      add({ wageType: w.key, label: label(w), amount, side: 'employee', source: 'fak', text: c.name, child: c.id, ...(share === 1 ? {} : { base: v.amount, rate: round2(share * 100), days: { from: s.from, to: s.to } }) });
      const min = w.allowance?.minimum ? fig(w.allowance.minimum) : undefined;
      if (min && v.amount < min.value) fact('allowanceBelowMinimum', { name: c.name, amount: min.value });
      if (w.allowance?.untilAge !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(c.birthDate)) {
        const ends = lastDay(addMonths(c.birthDate, w.allowance.untilAge * 12).slice(0, 7));
        if (from > ends) fact('allowanceAge', { name: c.name, age: w.allowance.untilAge, date: ends });
      }
    }
    // A one-off allowance (at the birth or the adoption) apart from the monthly history: paid in its month.
    const birth = c.birth && c.birth.month === month && employed ? types.get(c.birth.wageType) : undefined;
    if (birth && c.birth) add({ wageType: birth.key, label: label(birth), amount: round2(c.birth.amount), side: 'employee', source: 'fak', text: c.name, child: c.id });
  }

  // 3. The Lohnarten added for the month.
  const hourlyRate = spans.map((x) => x.entry?.value).find((j) => j?.kind === 'hourly')?.amount;
  for (const l of monthLines) {
    const w = types.get(l.wageType);
    if (!w) continue;
    const line = valued(w, w.hours && l.rate === undefined && hourlyRate !== undefined ? { ...l, rate: hourlyRate } : l, label(w), w.hours ? 'employment' : 'entered');
    if (!line) { miss(w.key, lacking(w, l)); continue; }
    add({ ...line, ...(l.text ? { text: l.text } : {}) });
  }

  // 3b. An hourly wage: the public-holiday surcharge its contract names, and the holiday surcharge on its own line.
  const hourlyJob = spans.map((x) => x.entry?.value).filter((j): j is Employment => j?.kind === 'hourly').at(-1);
  const hoursWage = round2(sum(lines.filter((l) => types.get(l.wageType)?.hours && !l.corrects).map((l) => l.amount)));
  if (hourlyJob && hoursWage !== 0) {
    const publicType = [...types.values()].find((t) => t.computes === 'publicHoliday');
    let publicAmount = 0;
    if (publicType && hourlyJob.publicHolidaySurcharge) {
      publicAmount = round(hoursWage * hourlyJob.publicHolidaySurcharge / 100);
      add({ wageType: publicType.key, label: label(publicType), base: hoursWage, rate: hourlyJob.publicHolidaySurcharge, amount: publicAmount, side: 'employee', source: 'employment' });
    }
    const holidayType = [...types.values()].find((t) => t.computes === 'holiday');
    const rules = data.holidays;
    if (holidayType && rules && hourlyJob.holidayPay !== 'leave') {
      const weeks = holidayWeeks(hourlyJob, e, to, rules);
      const rate = round2(weeks / (rules.weeksPerYear - weeks) * 100);
      const base = round2(hoursWage + (settings.holidayBasis === 'wage-with-surcharge' ? publicAmount : 0));
      const minimum = hourlyJob.holidayDays === undefined ? data.documents.holidaysMinimum : undefined;
      add({ wageType: holidayType.key, label: label(holidayType), base, rate, amount: round(base * rate / 100), side: 'employee', source: minimum ? 'holidays-minimum' : 'employment', ...(minimum ? { text: (minimum[lang] ?? minimum.de).replace('{weeks}', String(weeks)) } : {}) });
    }
  }

  // 3c. Absences: the absent days' wage taken off, the insurer's daily allowance, the wage the employer continues beyond it.
  const kinds = data.absences ?? {};
  const byKind = new Map<string, { lost: number; continued: number; losses: PayslipLine[] }>();
  /** The share of each day an absence has taken off already. */
  const absentShare = new Map<string, number>();
  for (const a of [...(e.absences ?? [])].sort((x, y) => x.from.localeCompare(y.from))) {
    const k = Object.hasOwn(kinds, a.kind) ? kinds[a.kind] : undefined;
    if (!k || k.holiday || !employed) continue;
    const aFrom = a.from > from ? a.from : from;
    const aTo = a.to < to ? a.to : to;
    if (aFrom > aTo) continue;
    const kindText = k.label[lang] ?? k.label.de;
    const incapacity = (a.incapacity ?? 100) / 100;
    const continued = k.unpaid ? 0 : (a.continuedPay ?? 100) / 100;
    const acc = byKind.get(a.kind) ?? { lost: 0, continued: 0, losses: [] };
    byKind.set(a.kind, acc);
    const lossType = k.loss ? types.get(k.loss) : undefined;
    for (const s of spans) {
      if (!s.entry) continue;
      const f = s.from > aFrom ? s.from : aFrom;
      const t = s.to < aTo ? s.to : aTo;
      if (f > t) continue;
      // An hourly wage is paid by the hours entered: what an absence pays is entered too («Lohn bei Krankheit»).
      if (s.entry.value.kind !== 'monthly') { fact('absenceHourly', { kind: kindText }); continue; }
      const { days, of } = spanDays(f, t, month, settings.proration);
      // A day's wage is taken off once: an absence over another takes only what the earlier left of the day.
      let calendar = 0; let share = 0;
      for (let d = f; d <= t; d = nextDay(d)) {
        const eff = Math.max(0, Math.min(incapacity, 1 - (absentShare.get(d) ?? 0)));
        absentShare.set(d, (absentShare.get(d) ?? 0) + eff);
        calendar++; share += eff;
      }
      const factor = calendar ? share / calendar : 0;
      if (factor + 1e-9 < incapacity) fact('absenceOverlap', { kind: kindText });
      const base = round2(s.entry.value.amount * (s.entry.value.pensum ?? 100) / 100);
      const lost = round(base * days / of * factor);
      acc.lost = round2(acc.lost + lost);
      acc.continued = round2(acc.continued + lost * continued);
      if (lossType && lost) acc.losses.push({ wageType: lossType.key, label: label(lossType), base, rate: round2(days / of * factor * 100), amount: lost, side: 'employee', source: 'absence', text: kindText, days: { from: f, to: t } });
    }
    const allowanceType = k.allowance ? types.get(k.allowance) : undefined;
    if (allowanceType && a.dailyAllowance) {
      const af = a.allowanceFrom && a.allowanceFrom > aFrom ? a.allowanceFrom : aFrom;
      if (af <= aTo) {
        // The insurers pay per calendar day.
        const days = Number(aTo.slice(8)) - Number(af.slice(8)) + 1;
        const perDay = round2(a.dailyAllowance * incapacity);
        add({ wageType: allowanceType.key, label: label(allowanceType), quantity: days, rate: perDay, amount: round(perDay * days), side: 'employee', source: 'absence', text: kindText, days: { from: af, to: aTo } });
      }
    }
  }
  for (const [key, acc] of byKind) {
    const k = kinds[key];
    const kindText = k.label[lang] ?? k.label.de;
    const wageType = k.wage ? types.get(k.wage) : undefined;
    // What the insurer pays for the kind this month: computed above for it, or entered from its statement when no other
    // kind of the month shares that Lohnart (two kinds paid by the same fund each count only their own).
    const sharing = [...byKind.keys()].filter((x) => kinds[x].allowance === k.allowance).length;
    const allowance = k.allowance ? round2(sum(lines.filter((l) => l.wageType === k.allowance && !l.corrects && (l.source === 'absence' ? l.text === kindText : sharing === 1)).map((l) => l.amount))) : 0;
    const topUp = round(Math.max(0, acc.continued - allowance));
    // The wage runs on whole and no insurer pays: the two lines would cancel, so the payslip says it instead.
    if (acc.lost && acc.lost === topUp && !allowance) { fact('absencePaid', { kind: kindText }); continue; }
    for (const l of acc.losses) add(l);
    if (wageType && topUp) add({ wageType: wageType.key, label: label(wageType), ...(allowance ? {} : { base: acc.lost, rate: round2(acc.continued / acc.lost * 100) }), amount: topUp, side: 'employee', source: 'absence', text: kindText });
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
      // A tax correction names its canton: its own figures, else the corrected month's (a correction entered by hand),
      // so its booking, its commission and the settlement list agree on the canton.
      ...(() => {
        if (c.tariff) return { tariff: c.tariff };
        const was = of?.lines.find((l) => l.wageType === w.key && !l.corrects && l.tariff)?.tariff;
        if (was) return { tariff: { region: was.region, code: was.code, income: was.income } };
        // A month closed without its tax line: the person's canton then, else now.
        const tariffKind = data.contributions.some((x) => x.wageType === w.key && data.insurances[x.insurance]?.tariff);
        if (!tariffKind) return {};
        const region = (of ? entryOn(e.taxAtSource ?? [], lastDay(of.month))?.value.canton : undefined) ?? entryOn(e.taxAtSource ?? [], to)?.value.canton;
        return region?.trim() ? { tariff: { region: region.trim().toUpperCase(), code: '', income: 0 } } : {};
      })(),
    });
  }

  // 5. The 13th salary in its payout months, and with the last month of a person who leaves.
  const job = entryOn(e.employment, to)?.value ?? lastEntry?.value;
  const thirteenthType = [...types.values()].find((t) => t.computes === 'thirteenth');
  const leaves = !!lastEntry?.validUntil && lastEntry.validUntil >= from && lastEntry.validUntil <= to;
  const tb = data.bases.find((b) => b.thirteenth)?.key;
  // December always pays out what the year owes (model.ts Employment.thirteenth).
  if (employed && thirteenthType && tb && job?.thirteenth && (job.thirteenth.months.includes(Number(month.slice(5))) || month.endsWith('-12') || leaves)) {
    const paidIn = earlier.filter((c) => c.lines.some((l) => l.wageType === thirteenthType.key && !l.corrects)).map((c) => c.month).at(-1);
    const since = earlier.filter((c) => !paidIn || c.month > paidIn);
    const fromOpening = paidIn ? 0 : opening?.bases[tb] ?? 0;
    const base = round2(fromOpening + sum(since.map((c) => c.bases[tb]?.month ?? 0)) + (basesOf(lines, types)[tb] ?? 0));
    const rate = settings.thirteenth === 'percent' ? 8.33 : 100 / 12;
    add({ wageType: thirteenthType.key, label: label(thirteenthType), base, rate: round2(rate), amount: round(base * rate / 100), side: 'employee', source: settings.thirteenth === 'percent' ? 'thirteenth-percent' : 'thirteenth-twelfth' });
  }

  // 6. The contributions, in the data's order.
  const bases = basesOf(lines, types);
  const insurancesOn = read(`employees/${e.id}/insurances`, e.insurances, to) ?? {};
  const yearData = ctx.years?.[year];
  const reachDay = referenceAgeReached(e, yearData);
  const pensioner = !!reachDay && from > lastDay(reachDay.slice(0, 7));
  if (pensioner) facts.push({ key: 'pensioner', vars: { date: reachDay! } });
  if (!e.sex) facts.push({ key: 'sexMissing' });
  const computed = new Map<string, number>();
  const commissionLines: PayslipLine[] = [];
  const cumulated: Record<string, ReturnType<typeof cumulative>> = {};
  /** The capped base of each base and ceiling this month: kept on the close, so the next month caps against what was used. */
  const capped: Record<string, number> = {};
  for (const c of data.contributions) {
    const w = types.get(c.wageType);
    if (!w) continue;
    const kind = data.insurances[c.insurance];
    const side: 'employee' | 'employer' = w.side === 'employer' ? 'employer' : 'employee';
    if (kind?.computed === false || kind?.tariff) {
      const tax = read(`employees/${e.id}/taxAtSource`, e.taxAtSource, to);
      // A tax correction carried into a month she is no longer subject in still takes its commission.
      const carried = lines.some((l) => l.wageType === w.key && l.corrects);
      if (!tax?.subject && !(kind.tariff && carried)) continue;
      if (!kind.tariff) { miss(w.key, 'notComputed'); continue; }
      // The tax at source by the region's tariff file, and the commission on it (src/payroll/tax-at-source.ts).
      const commission = [...types.values()].find((x) => x.computes === 'commission');
      const out = taxAtSourceLines({
        data, types, wageType: w, label: label(w), person: tax ?? { subject: false }, month, lines,
        // The days employed in the firm's own proration, so the extrapolation takes back exactly what the proration cut (§22 decision 94).
        days: employedFraction(e, month, settings.proration) * (data.taxAtSource?.partMonth ?? 30), pensum: job?.pensum ?? (job?.kind === 'monthly' ? 100 : undefined),
        // A payment after the exit (a Nachzahlung) takes the rate with the exit month's income (FAQ KS 45, Frage 16).
        ...(!employed ? { exitIncome: exitIncomeOf(history, e.id, month, w.key, typeof c.base === 'string' ? c.base : '') } : {}),
        tariffs: ctx.tariffs, insurances: store.insurances,
        regionOf: (id) => history.closed.get(id)?.lines.find((l) => l.wageType === w.key && l.tariff && !l.corrects)?.tariff?.region,
        ...(commission ? { commission: { wageType: commission, label: label(commission) } } : {}),
      });
      // The commission prints after the employer's contributions, the tax in its place.
      for (const l of out.lines) (l.side === 'employer' ? commissionLines : lines).push(l);
      for (const m of out.missing) miss(m.wageType, m.code);
      for (const u of out.used) used.set(`${u.path}|${u.validFrom}|${u.enteredAt}`, u);
      continue;
    }
    const firm = insuranceOf(store, c.insurance, from, to);
    if (!firm) {
      if (kind?.required) miss(w.key, 'insurance');
      continue;
    }
    // An insurance the law does not require of everyone (a daily sickness allowance, a supplementary accident
    // cover) holds only for the persons the firm put in it: their own solution of the kind (§22 decision 46).
    if (kind && !kind.required && !kind.perPerson && !kind.requiredAbove && !insurancesOn[c.insurance]) {
      // Said once per kind, so a firm that adds the insurance sees whom it does not cover.
      if (!facts.some((f) => f.key === 'notInsured' && f.vars?.kind === c.insurance)) facts.push({ key: 'notInsured', vars: { kind: c.insurance } });
      continue;
    }
    // Liability by age, and past the reference age.
    if (c.liable) {
      const age = fig(c.liable);
      if (!age) { miss(w.key, 'federal'); continue; }
      const startYear = Number(e.birthDate?.slice(0, 4)) + age.value + 1;
      // A payment after the exit is judged in the year it was earned in, as its figures are.
      if (Number.isFinite(startYear) && Number(earnedIn) < startYear) { if (!facts.some((f) => f.key === 'notLiable')) facts.push({ key: 'notLiable', vars: { year: startYear } }); continue; }
    }
    if (pensioner && c.pensioner === 'ends') continue;
    if (c.minHours) {
      const min = fig(c.minHours);
      // An hourly wage without its weekly hours: the month's hours as an average week.
      const weekly = job?.hoursPerWeek ?? (job?.kind === 'hourly' ? round2(sum(lines.filter((l) => types.get(l.wageType)?.hours).map((l) => l.quantity ?? 0)) * 12 / 52) : undefined);
      if (min && weekly !== undefined && weekly < min.value) {
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
    if (c.smallWage && typeof c.base === 'string' && insurancesOn.smallWage !== 'liable') {
      const limit = fig(c.smallWage);
      if (!limit) { miss(w.key, 'federal'); continue; }
      const key = `${c.base}#${c.smallWage}`;
      const raw = (m: PayslipClose) => m.bases[c.base as string]?.month ?? 0;
      // What the earlier months charged: kept on each close; a close before this rule charged its whole base.
      const charged = (m: PayslipClose) => m.bases[key]?.month ?? raw(m);
      // A payment after the exit in a later year belongs to the year it was earned in (as its ceiling does, cumulative()).
      const ref = earnedIn;
      // Every earlier month that counts in that year: its own, and each payment after the exit before this one.
      const counted = ref === year ? earlier : closedOf(history, e.id).filter((x) => x.month < month && referenceYear(e, x.month) === ref && !inOpening(e, x.month));
      const refEarlier = ref === year ? earlier : counted.filter((x) => x.month.startsWith(ref));
      const openingBase = openingOf(e, ref)?.bases[c.base] ?? 0;
      const yearBase = round2(openingBase + sum(counted.map(raw)) + base);
      // A monthly wage promises its year; an hourly one is judged by its average month so far over the months employed.
      const promised = promisedYear(e, ref, settings.proration) ?? expectedYear(e, ref, refEarlier, yearBase, ref === year ? fraction : 0, settings.proration);
      if (yearBase <= limit.value && promised <= limit.value) {
        fact('smallWage', { amount: limit.value });
        capped[key] = 0;
        continue;
      }
      // Past the limit the whole year is liable: the months left out are caught up now.
      const catchUp = round2(Math.max(0, sum(earlier.map(raw)) - sum(earlier.map(charged))));
      if (catchUp) fact('smallWageCaught', { amount: limit.value, caught: catchUp });
      base = round2(base + catchUp);
      // Kept as the raw base it covers (before a pensioner's allowance), so the next month compares like with like.
      capped[key] = round2((bases[c.base] ?? 0) + catchUp);
    }
    if (c.ceiling) {
      const ceiling = fig(c.ceiling);
      if (!ceiling) { miss(w.key, 'federal'); continue; }
      const raw = typeof c.base === 'string' ? c.base : '';
      const key = `${raw}|${c.ceiling}`;
      const cum = cumulated[key] ??= cumulative(ctx, e, month, raw, key, settings.proration, ceiling.value);
      if (cum.unknown) fact('wagesNotInApp', { year: cum.unknown });
      const own = round2(Math.min(cum.base + base, cum.ceiling) - cum.capped);
      if (own < base && !facts.some((f) => f.key === 'ceiling')) facts.push({ key: 'ceiling', vars: { amount: ceiling.value } });
      capped[key] = own;
      base = own;
    }
    // The person's own figures (a pension certificate), or a rate.
    if ('person' in c.rate) {
      // A payment after the exit owes no pension contribution: the fund insured the employment, which has ended.
      if (!employed) continue;
      const cert = insurancesOn[c.insurance] as PersonInsurances['bvg'];
      if (kind?.requiredAbove) {
        const threshold = fig(kind.requiredAbove.figure);
        // The yearly wage the Anstellung promises; an hourly one by this month's wage, as the fund does it.
        const yearly = job?.kind === 'monthly'
          ? round2(job.amount * (job.pensum ?? 100) / 100 * (12 + (job.thirteenth ? 1 : 0)))
          : round2((bases[kind.requiredAbove.base] ?? 0) / Math.max(fraction, 1 / 31) * 12);
        if (threshold && yearly <= threshold.value && !cert) {
          if (!facts.some((f) => f.key === 'belowThreshold')) facts.push({ key: 'belowThreshold', vars: { amount: threshold.value, yearly } });
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

  lines.push(...commissionLines);
  // The holiday balance in days, where the holidays are taken (a monthly wage, or an hourly one paid as leave).
  const holidays = employed && data.holidays ? holidayBalanceOf(e, month, settings.proration, data) : undefined;
  if (holidays && leaves) fact('holidayBalance', { days: holidays.balance });

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
    bases: Object.fromEntries(Object.entries({ ...bases, ...capped }).map(([k, v]) => [k, { month: v, year: round2(sum(earlier.map((c) => c.bases[k]?.month ?? 0)) + (opening?.bases[k] ?? 0) + v) }])),
    ...totals, facts, used: [...used.values()].sort((a, b) => a.path.localeCompare(b.path)),
    person: {
      name: name ? `${name.first} ${name.last}` : e.id, language: lang,
      ...(address ? { address: { postcode: address.postcode, town: address.town, country: address.country, ...(address.street ? { street: address.street } : {}), ...(address.number ? { number: address.number } : {}) } } : {}),
      ...(bank?.iban ? { iban: bank.iban } : {}),
    },
    ...(text ? { text } : {}),
    ...(holidays ? { holidays } : {}),
    fraction: round2(fraction * 1e4) / 1e4,
  };
}

/**
 * The rate-determining income of the person's last closed month before `month` (her exit month, for a payment after
 * the exit): what its tax line was looked up with, else its taxable wage; undefined without one.
 */
function exitIncomeOf(history: PayslipHistory, employee: string, month: string, taxType: string, base: string): number | undefined {
  const last = closedOf(history, employee).filter((c) => c.month < month && c.lines.some((l) => !l.corrects)).at(-1);
  if (!last) return undefined;
  return last.lines.find((l) => l.wageType === taxType && !l.corrects && l.tariff)?.tariff?.income ?? last.bases[base]?.month;
}

/** Which input of a line is missing: its quantity (a car's price, the hours), its rate per unit, or its amount. */
const lacking = (w: WageType, v: { quantity?: number; rate?: number }): string =>
  w.input !== 'quantity' ? 'amount' : typeof v.quantity !== 'number' ? 'quantity' : 'unitRate';

/** The wage the Anstellungen of `year` promise for it (monthly × Pensum × the share of each month employed, and a 13th); undefined while one is hourly. */
function promisedYear(e: PayrollEmployee, year: string, proration: string): number | undefined {
  let total = 0;
  for (const m of monthsBetween(`${year}-01`, `${year}-12`)) {
    for (const s of entriesWithin(e.employment, firstDay(m), lastDay(m))) {
      if (!s.entry) continue;
      const job = s.entry.value;
      if (job.kind !== 'monthly') return undefined;
      const { days, of } = spanDays(s.from, s.to, m, proration);
      total += job.amount * (job.pensum ?? 100) / 100 * days / of * (job.thirteenth ? 13 / 12 : 1);
    }
  }
  return round2(total);
}

/**
 * The exit a payment of `month` comes after: the end of the latest Anstellung begun by the month's end, when the person
 * is not employed in the month and it ended before. Decided per month, so an Anstellung entered later for a later
 * month (a re-hire) leaves an earlier month's answer as it was.
 */
export function exitBefore(e: Pick<PayrollEmployee, 'employment'>, month: string): string | undefined {
  const from = firstDay(month); const to = lastDay(month);
  if (entriesWithin(e.employment, from, to).some((x) => x.entry)) return undefined;
  const last = e.employment.filter((x) => x.validFrom <= to).sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1);
  return last?.validUntil && last.validUntil < from ? last.validUntil : undefined;
}

/** The year a payment of `month` counts in: its own, or for a payment after an exit of an earlier year, the exit's (WBB Rz 2038). */
export function referenceYear(e: Pick<PayrollEmployee, 'employment'>, month: string): string {
  const year = month.slice(0, 4);
  const exit = exitBefore(e, month);
  return exit && exit.slice(0, 4) < year ? exit.slice(0, 4) : year;
}

/** An hourly year's wage: the year's base so far by the months employed so far, over the months the Anstellungen hold this year. */
function expectedYear(e: PayrollEmployee, year: string, earlier: readonly PayslipClose[], yearBase: number, fraction: number, proration: string): number {
  const months = monthsBetween(`${year}-01`, `${year}-12`);
  const soFar = (openingOf(e, year)?.months ?? 0) + earlier.reduce((a, c) => a + employedFraction(e, c.month, proration), 0) + fraction;
  const all = months.reduce((a, m) => a + employedFraction(e, m, proration), 0);
  return soFar > 0 ? round2(yearBase / soFar * all) : yearBase;
}

type HolidayRules = NonNullable<PayrollData['holidays']>;

/** The person's holiday weeks a year: her Anstellung's days, else the legal minimum for her age on `day`. */
export function holidayWeeks(job: Employment, e: Pick<PayrollEmployee, 'birthDate'>, day: string, rules: HolidayRules): number {
  if (job.holidayDays !== undefined) return job.holidayDays / rules.daysPerWeek;
  const age = ageOn(e.birthDate, day);
  const row = [...rules.minimum].filter((r) => r.untilAge === undefined || (age !== undefined && age < r.untilAge)).sort((a, b) => (a.untilAge ?? 999) - (b.untilAge ?? 999))[0];
  return row?.weeks ?? 4;
}

/** Whole years of age on `day`; undefined without a birth date. */
function ageOn(birthDate: string | undefined, day: string): number | undefined {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return undefined;
  const years = Number(day.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return day.slice(5) < birthDate.slice(5) ? years - 1 : years;
}

/** The working days Monday to Friday from `from` to `to`. */
function workingDays(from: string, to: string): number {
  let n = 0;
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/**
 * The holiday balance at the end of `month` (§5.4 «Feriensaldo»): the days earned in the year so far (the year's
 * holiday days by the share of each month employed), less the holiday absences taken (working days × the
 * share of the day). None where an hourly wage pays the holidays with every hour. Counts from January or the
 * entry; a balance carried from last year is not known to the app.
 */
export function holidayBalanceOf(e: PayrollEmployee, month: string, proration: string, data: PayrollData): HolidayBalance | undefined {
  const rules = data.holidays;
  if (!rules) return undefined;
  const year = month.slice(0, 4);
  let earned = 0;
  let any = false;
  for (const m of monthsBetween(`${year}-01`, month)) {
    const job = entryOn(e.employment, lastDay(m))?.value ?? entriesWithin(e.employment, firstDay(m), lastDay(m)).filter((x) => x.entry).at(-1)?.entry?.value;
    if (!job) continue;
    if (job.kind === 'hourly' && job.holidayPay !== 'leave') continue;
    any = true;
    earned += holidayWeeks(job, e, lastDay(m), rules) * rules.daysPerWeek / 12 * employedFraction(e, m, proration);
  }
  if (!any) return undefined;
  const kinds = data.absences ?? {};
  const end = lastDay(month);
  let taken = 0;
  for (const a of e.absences ?? []) {
    if (!(Object.hasOwn(kinds, a.kind) && kinds[a.kind].holiday)) continue;
    const f = a.from > `${year}-01-01` ? a.from : `${year}-01-01`;
    const t = a.to < end ? a.to : end;
    if (f <= t) taken += workingDays(f, t) * (a.incapacity ?? 100) / 100;
  }
  const r = (x: number) => Math.round(x * 100) / 100;
  return { earned: r(earned), taken: r(taken), balance: r(earned - taken) };
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
    // An employer line that deducts (the commission on the tax at source) lowers the employer's total.
    if (w.stage === 'employer') employer += signed;
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
function cumulative(ctx: PayrollContext, e: PayrollEmployee, month: string, base: string, key: string, proration: string, yearly: number): { base: number; capped: number; ceiling: number; unknown?: string } {
  const year = month.slice(0, 4);
  // A payment after the exit in a later year («Nachzahlung») counts against the ceiling of the employment's last year.
  const ref = referenceYear(e, month);
  // Every earlier month that counts in that year: its own months, and each payment after the exit before this one.
  const earlier = closedOf(ctx.history, e.id).filter((c) => ((ref !== year && c.month.startsWith(ref)) || (c.month < month && referenceYear(e, c.month) === ref)) && !inOpening(e, c.month));
  const opening = openingOf(e, ref);
  const share = (m: string) => employedFraction(e, m, proration);
  // A payment after the exit: the ceiling of the months she was employed in that year, whatever the app holds of them;
  // its room is that less the wages the app knows (none known: said, never a ceiling of zero).
  const months = ref !== year
    ? monthsBetween(`${ref}-01`, `${ref}-12`).reduce((a, m) => a + share(m), 0)
    : (opening?.months ?? 0) + earlier.reduce((a, c) => a + share(c.month), 0) + share(month);
  const unknown = ref !== year && !opening && !earlier.some((c) => c.month.startsWith(ref)) ? ref : undefined;
  const openingBase = opening?.bases[base] ?? 0;
  // A month whose close kept no capped base (none of this ceiling's contributions was owed then) used at most its share of the ceiling.
  const cappedOf = (c: PayslipClose) => c.bases[key]?.month ?? Math.min(c.bases[base]?.month ?? 0, yearly / 12 * share(c.month));
  return {
    base: round2(openingBase + sum(earlier.map((c) => c.bases[base]?.month ?? 0))),
    capped: round2(Math.min(openingBase, yearly / 12 * (opening?.months ?? 0)) + sum(earlier.map(cappedOf))),
    ceiling: round2(yearly / 12 * months),
    ...(unknown ? { unknown } : {}),
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
