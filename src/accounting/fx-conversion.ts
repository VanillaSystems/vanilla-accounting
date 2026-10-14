/**
 * How a foreign-currency entry became CHF, and whether its rate is the one the books must use:
 * the ESTV daily sell rate valid on the payment date (ADR 0001). Pure, so the CLI, the API and
 * the UI read the rate table the same way.
 */
import type { JournalEntry } from '../types/index.js';
import { chfAmount } from './ledger.js';
import { baseCurrency } from '../engines/index.js';

/** reference/estv-daily-rates-<year>.json as `npm run fetch-rates` writes it. */
export interface EstvRateTable {
  fetchedAt?: string;
  /** Keyed by the date a rate is valid for: CHF per unit of each currency, and `src` naming the ESTV publication. */
  rates: Record<string, Record<string, number | string>>;
}

/** One ESTV daily sell rate, and the day it is valid for. */
export interface EstvRate {
  currency: string;
  rate: number;
  validOn: string;
  /** The publication it comes from, as the table names it ("datum 2026-08-13"). */
  source?: string;
}

export interface EstvRates {
  /** The rate valid on `date`: that day's, else the most recent earlier one (the ESTV rule for weekends and holidays). */
  on(currency: string, date: string): EstvRate | undefined;
  /** The rate of 31.12. for the year-end revaluation (Kursdifferenz), once the table reaches that day. */
  yearEnd(currency: string, year: string): EstvRate | undefined;
  readonly fetchedAt?: string;
}

export function estvRates(table: EstvRateTable): EstvRates {
  const dates = Object.keys(table.rates).sort();
  const last = dates.at(-1) ?? '';
  const on = (currency: string, date: string): EstvRate | undefined => {
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] > date) continue;
      const day = table.rates[dates[i]];
      const rate = day[currency];
      if (typeof rate === 'number') return { currency, rate, validOn: dates[i], source: typeof day.src === 'string' ? day.src : undefined };
    }
    return undefined;
  };
  return {
    on,
    yearEnd(currency, year) {
      const end = `${year}-12-31`;
      const reached = last >= end || (table.fetchedAt ?? '').slice(0, 10) > end;
      return reached ? on(currency, end) : undefined;
    },
    fetchedAt: table.fetchedAt,
  };
}

/** Stored rates are rounded to 6 places (npm run restamp-fx). */
export const sameRate = (a: number | undefined, b: number): boolean =>
  a !== undefined && Math.round(a * 1e6) === Math.round(b * 1e6);

/** The day the money moved: the bank transaction's date (a split ref `ref~…` its base's), else the entry's own date. */
export function paymentDateOf(entry: JournalEntry, txDates: ReadonlyMap<string, string>): string {
  return txDates.get(entry.transactionRef) ?? txDates.get(entry.transactionRef.split('~')[0]) ?? entry.date;
}

/** Whether the stored rate is the ESTV sell rate of the payment date. */
export type RateCheck =
  | { kind: 'estv'; estv: EstvRate }
  /** A stale or flat legacy rate, or none: `npm run restamp-fx` sets the ESTV one. */
  | { kind: 'differs'; estv: EstvRate }
  /** The table has no rate for this currency on or before the payment date. */
  | { kind: 'unknown' };

export interface Conversion {
  currency: string;
  amount: number;
  rate: number | undefined;
  /** What the books count: `chfAmount`, roundCHF(amount × rate). */
  chf: number;
  paymentDate: string;
  check: RateCheck;
}

/** Undefined for a CHF entry. */
export function conversionOf(entry: JournalEntry, paymentDate: string, rates: EstvRates): Conversion | undefined {
  const currency = entry.exchangeCurrency;
  if (!currency || currency === baseCurrency()) return undefined;
  const estv = rates.on(currency, paymentDate);
  const check: RateCheck = !estv ? { kind: 'unknown' } : sameRate(entry.exchangeRate, estv.rate) ? { kind: 'estv', estv } : { kind: 'differs', estv };
  return { currency, amount: entry.amount, rate: entry.exchangeRate, chf: chfAmount(entry), paymentDate, check };
}

/** One rate the books used: a currency, the day its ESTV rate is valid for, the stored rate, and its entries. */
export interface RateUse {
  currency: string;
  /** The ESTV validity date, or the payment date when the table has no rate. */
  date: string;
  rate: number | undefined;
  check: RateCheck;
  entries: Array<{ entry: JournalEntry; conversion: Conversion }>;
}

/** The rates behind `entries`, per currency in date order; CHF entries are left out. */
export function ratesUsed(entries: JournalEntry[], paymentDate: (e: JournalEntry) => string, rates: EstvRates): Map<string, RateUse[]> {
  const uses = new Map<string, RateUse>();
  for (const entry of entries) {
    const conversion = conversionOf(entry, paymentDate(entry), rates);
    if (!conversion) continue;
    const { check } = conversion;
    const date = check.kind === 'unknown' ? conversion.paymentDate : check.estv.validOn;
    const key = `${conversion.currency}|${date}|${conversion.rate}`;
    const use = uses.get(key) ?? { currency: conversion.currency, date, rate: conversion.rate, check, entries: [] };
    use.entries.push({ entry, conversion });
    uses.set(key, use);
  }
  const byCurrency = new Map<string, RateUse[]>();
  for (const use of [...uses.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.date.localeCompare(b.date))) {
    byCurrency.set(use.currency, [...(byCurrency.get(use.currency) ?? []), use]);
  }
  return byCurrency;
}
