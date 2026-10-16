/**
 * Computes a VAT return from a jurisdiction's return data and the books: which entries feed which
 * box, the per-entry report the app shows, and the figures a filing declares, where the tax is
 * computed on each rate's total (eCH-0217 rules 7.5/7.6). Pure and browser-safe; the periods, the
 * period lock rule and money in rappen come from the core.
 */
import type { JournalEntry, QuarterKey, VatAdjustment } from '../types/index.js';
import type { BoxId, Formula, Jurisdiction, RateRow, ReturnData } from '../core/modules/schema.js';
import { filingLengthOf, methodOf, netRatesOf, type VatSetup } from '../workspace/vat-setup.js';
import { derivePeriod } from '../accounting/periods.js';
import { entriesForReturn, reportRange } from '../accounting/declarations.js';
import { fromRappen, roundCHF, toRappen } from '../accounting/rappen.js';
import { chfAmount } from '../accounting/ledger.js';
import { formulaRefs } from '../core/modules/check.js';
import { taxCodeEngine, type TaxCodeEngine, type TaxCodeInfo } from './tax-codes.js';

/** A rate row with the box it declares; a net-rate row carries the authority's activity code of the firm's rate when it is known. */
export interface RateRowAt extends RateRow {
  ziffer: BoxId;
  activityId?: string;
}

/** One journal entry's contribution to a box. */
export interface VatLine {
  date: string;
  ref: string;
  description: string;
  code: string;
  gross: number;
  base: number;
  tax: number;
}

export interface ReportBox {
  number: BoxId;
  label: string;
  amount: number;
}

export interface VatReport {
  ziffern: ReportBox[];
  rates: { row: RateRowAt; base: number; tax: number }[];
  toPay: number;
  credit: number;
}

/** A period's return as a filing declares it, keyed by box. */
export interface ReturnFigures {
  period: QuarterKey;
  ziffern: Record<BoxId, number>;
}

export interface ReturnEngine {
  codes: TaxCodeEngine;
  /** The return form as the module declares it: deductions, input tax, derived boxes. */
  form: ReturnData;
  rateRows: RateRowAt[];
  /** Whether a rate is one of the jurisdiction's own (current or superseded); a foreign 19 % is not. */
  isDomesticRate(rate: number): boolean;
  /** An entry's VAT amounts, signed as they count, or null when its code declares nothing. */
  vatLine(entry: JournalEntry): VatLine | null;
  /** The declaration adjustments a report counts (skipped where the report already holds their entries). */
  adjustmentsFor(adjustments: VatAdjustment[], entries: JournalEntry[], periodKey: string): VatAdjustment[];
  /** The entries and adjustments behind each source box of a report. */
  lines(entries: JournalEntry[], periodKey: string, adjustments: VatAdjustment[]): Record<BoxId, VatLine[]>;
  /** The return for any report key (quarter, half year, year), with the tax summed per entry. */
  report(entries: JournalEntry[], periodKey: string, adjustments: VatAdjustment[]): VatReport;
  /** Fills in the derived boxes of declared figures, the tax computed on each rate's total. */
  complete(period: QuarterKey, declared: Record<BoxId, number>): ReturnFigures & { payable: number };
  /** The return today's books declare for a quarter: what a filing would send. */
  figures(entries: JournalEntry[], period: QuarterKey, adjustments: VatAdjustment[]): ReturnFigures & { payable: number };
}

/** The tax on a rate row's declared amount, full precision: a supply is gross and holds its tax; an acquisition is net and a net-rate row gross, the rate on top of either. */
export const taxOfRow = (row: RateRow, amount: number) => (row.kind === 'supply' ? amount * row.rate / (100 + row.rate) : amount * row.rate / 100);

const rateLabel = (row: RateRow) => (row.kind === 'net-rate' ? `${row.name} ${row.rate}%` : `${row.kind === 'supply' ? 'Leistungen' : 'Bezugsteuer'} ${row.rate}%`);

/** The engine for a firm set up as `setup`: its form (the effective one, or the net tax rate method's), its codes, its rate rows (the firm's approved net rates among them). */
export function returnEngine(j: Jurisdiction, setup?: VatSetup): ReturnEngine {
  const method = setup ? methodOf(setup) : 'effective';
  const netRate = method === 'net-rate';
  if (netRate && !j.vatReturnNetRate) throw new Error(`the jurisdiction ${j.manifest.id} has no return for the net tax rate method (return-net-rate.yaml)`);
  // A firm that is not registered knows no code at all: its form takes none, every entry is gross.
  const r: ReturnData = netRate ? j.vatReturnNetRate! : method === 'none' ? { ...j.vatReturn, codes: [] } : j.vatReturn;
  const rates = setup ? netRatesOf(setup) : [];
  const codes = taxCodeEngine(j.taxCodes, r, rates);
  // The firm's filing period decides which entries a return declares (a correction is declared in the period it corrects).
  const length = setup ? filingLengthOf(setup, j.periods.vat.length) : j.periods.vat.length;
  const rateRows: RateRowAt[] = r.rateOrder.flatMap((z): RateRowAt[] => {
    if (j.rates.rows[z]) return [{ ziffer: z, ...j.rates.rows[z] }];
    const own = netRate ? j.vatReturnNetRate!.netRateRows[z] : undefined;
    const approved = own && rates[own.netRate - 1];
    return own && approved
      ? [{ ziffer: z, rate: approved.rate, kind: 'net-rate', code: own.code, name: approved.label ? `${own.name} (${approved.label})` : own.name, ...(approved.activityId ? { activityId: approved.activityId } : {}) }]
      : [];
  });
  const deductionBoxes = Object.keys(r.deductions);
  const inputTaxBoxes = Object.entries(r.inputTax);
  const derivedOrder = topoOrder(r.derived);

  function vatLine(entry: JournalEntry): VatLine | null {
    const info = entry.vatCode ? codes.parse(entry.vatCode) : null;
    if (!info) return null;
    const gross = toRappen(chfAmount(entry));
    const sign = info.isNegative ? -1 : 1;
    return {
      date: entry.date,
      ref: entry.transactionRef,
      description: entry.description ?? '',
      code: info.code,
      gross: fromRappen(gross * sign),
      base: fromRappen(baseOf(gross, info) * sign),
      tax: fromRappen(taxOf(gross, info) * sign),
    };
  }

  function adjustmentsFor(adjustments: VatAdjustment[], entries: JournalEntry[], periodKey: string): VatAdjustment[] {
    const { from, to } = reportRange(periodKey);
    const declared = new Set(entriesForReturn(entries, periodKey, length).map((e) => e.id));
    return adjustments.filter((a) => {
      const p = derivePeriod(a.period);
      if (!p) throw new Error(`vatAdjustments ${a.id}: unknown period "${a.period}"`);
      if (p.from < from || p.to > to) return false;
      const inside = a.entryIds.filter((id) => declared.has(id)).length;
      if (inside === 0) return true;
      if (inside === a.entryIds.length) return false;
      throw new Error(`vatAdjustments ${a.id}: the report ${periodKey} contains only some of its entries`);
    });
  }

  function entryLines(entries: JournalEntry[], periodKey: string, out: Record<BoxId, VatLine[]> = {}) {
    for (const entry of entriesForReturn(entries, periodKey, length)) {
      const line = vatLine(entry);
      if (!line) continue;
      for (const z of codes.sourceBoxes(codes.parse(line.code)!)) (out[z] ??= []).push(line);
    }
    return out;
  }

  function lines(entries: JournalEntry[], periodKey: string, adjustments: VatAdjustment[]) {
    const out: Record<BoxId, VatLine[]> = {};
    for (const a of adjustmentsFor(adjustments, entries, periodKey)) {
      (out[a.ziffer] ??= []).push({ date: derivePeriod(a.period)!.to, ref: `adjustment:${a.id}`, description: a.reason, code: 'Nachdeklaration', gross: 0, base: 0, tax: a.amount });
    }
    return entryLines(entries, periodKey, out);
  }

  function report(entries: JournalEntry[], periodKey: string, adjustments: VatAdjustment[]): VatReport {
    const ls = entryLines(entries, periodKey);
    const adjusted: Record<BoxId, number> = {};
    for (const a of adjustmentsFor(adjustments, entries, periodKey)) adjusted[a.ziffer] = (adjusted[a.ziffer] ?? 0) + toRappen(a.amount);
    const sum = (z: BoxId, field: 'gross' | 'base' | 'tax') =>
      (ls[z] ?? []).reduce((s, l) => s + toRappen(l[field]), 0) + (field === 'base' ? 0 : adjusted[z] ?? 0);

    const rates = rateRows.map((row) => ({ row, base: sum(row.ziffer, 'base'), tax: sum(row.ziffer, 'tax') }));
    const value: Record<BoxId, number> = {
      [r.turnoverBox]: (ls[r.turnoverBox] ?? []).reduce((s, l) => s + toRappen(l.gross), 0),
      ...Object.fromEntries(deductionBoxes.map((z) => [z, sum(z, 'gross')])),
      ...Object.fromEntries(rates.map((x) => [x.row.ziffer, x.row.kind === 'acquisition' ? x.tax : x.base])),
      ...Object.fromEntries(inputTaxBoxes.map(([z]) => [z, sum(z, 'tax')])),
    };
    const owed = rates.reduce((s, x) => s + x.tax, 0);
    for (const z of derivedOrder) value[z] = evaluate(r.derived[z].formula, value, owed);

    const label = (z: BoxId) =>
      z === r.turnoverBox ? r.turnoverLabel
        : r.deductions[z]?.label ?? r.inputTax[z]?.label ?? r.derived[z]?.label ?? rateLabel(rateRows.find((row) => row.ziffer === z)!);
    const ziffern = Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((z) => ({ number: z, label: label(z), amount: fromRappen(value[z]) }));
    return {
      ziffern,
      rates: rates.map((x) => ({ row: x.row, base: fromRappen(x.base), tax: fromRappen(x.tax) })),
      toPay: fromRappen(value[r.payable]),
      credit: fromRappen(value[r.credit]),
    };
  }

  function complete(period: QuarterKey, declared: Record<BoxId, number>) {
    const z = (n: BoxId) => declared[n] ?? 0;
    const owed = rateRows.reduce((s, row) => s + taxOfRow(row, z(row.ziffer)), 0);
    const value: Record<BoxId, number> = { ...declared };
    for (const n of derivedOrder) value[n] = evaluate(r.derived[n].formula, value, owed);
    const signedInput = inputTaxBoxes.reduce((s, [n, b]) => s + b.sign * z(n), 0);
    // eCH-0217 rounds the amount to pay once; the credit is that rounded amount negated.
    const payable = roundCHF(owed - signedInput);
    const rounded = Object.fromEntries(derivedOrder.map((n) => [n, roundCHF(value[n])]));
    rounded[r.payable] = Math.max(0, payable);
    rounded[r.credit] = Math.max(0, roundCHF(-payable));
    return { period, payable, ziffern: { ...declared, ...rounded } };
  }

  function figures(entries: JournalEntry[], period: QuarterKey, adjustments: VatAdjustment[]) {
    const rep = report(entries, period, adjustments);
    const ls = lines(entries, period, adjustments);
    const z = (n: BoxId) => rep.ziffern.find((x) => x.number === n)?.amount ?? 0;
    const declared: Record<BoxId, number> = { [r.turnoverBox]: z(r.turnoverBox) };
    for (const n of [...deductionBoxes, ...inputTaxBoxes.map(([n]) => n)]) declared[n] = z(n);
    for (const row of rateRows) {
      const field = row.kind === 'supply' ? 'gross' : 'base';
      declared[row.ziffer] = roundCHF((ls[row.ziffer] ?? []).reduce((s, l) => s + l[field], 0));
    }
    return complete(period, declared);
  }

  // The jurisdiction's statutory rates, whatever form the firm files: a receipt's 8.1 % is domestic for a net-rate firm too.
  const domestic = new Set(Object.values(j.rates.rows).map((row) => row.rate));
  return { codes, form: r, rateRows, isDomesticRate: (rate) => domestic.has(rate), vatLine, adjustmentsFor, lines, report, complete, figures };
}

/** The tax in an entry's amount, in rappen; the amount is gross unless the code says net or tax; a net-rate code's tax is the rate on the gross. */
function taxOf(amount: number, info: TaxCodeInfo): number {
  if (info.rate === 0) return 0;
  if (info.flatOnGross) return Math.round(amount * info.rate / 100);
  if (info.amountIs === 'tax') return amount;
  if (info.amountIs === 'net') return Math.round(amount * info.rate / 100);
  return amount - Math.round(amount * 100 / (100 + info.rate));
}

/** The taxable base in an entry's amount, in rappen: net, or the gross itself under a net-rate code. */
function baseOf(amount: number, info: TaxCodeInfo): number {
  if (info.rate === 0 || info.flatOnGross) return amount;
  if (info.amountIs === 'tax') return Math.round(amount * 100 / info.rate);
  if (info.amountIs === 'net') return amount;
  return Math.round(amount * 100 / (100 + info.rate));
}

function evaluate(f: Formula | BoxId, value: Record<BoxId, number>, owedTax: number): number {
  if (typeof f === 'string') return value[f] ?? 0;
  if ('sum' in f) return f.sum.reduce((s, z) => s + (value[z] ?? 0), 0);
  if ('minus' in f) return (value[f.minus[0]] ?? 0) - (value[f.minus[1]] ?? 0);
  if ('positive' in f) return Math.max(0, evaluate(f.positive, value, owedTax));
  if ('signed' in f) return Object.entries(f.signed).reduce((s, [z, sign]) => s + sign * (value[z] ?? 0), 0);
  return owedTax;
}

/** The derived boxes in an order where each comes after the boxes it reads (check.ts refuses cycles). */
function topoOrder(derived: Jurisdiction['vatReturn']['derived']): BoxId[] {
  const order: BoxId[] = []; const seen = new Set<BoxId>();
  const visit = (z: BoxId) => {
    if (seen.has(z) || !(z in derived)) return;
    seen.add(z);
    formulaRefs(derived[z].formula).forEach(visit);
    order.push(z);
  };
  Object.keys(derived).forEach(visit);
  return order;
}

