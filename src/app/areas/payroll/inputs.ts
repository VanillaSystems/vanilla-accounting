/**
 * A Lohnart's inputs as both forms show them, the month's «Lohnart hinzufügen» and a person's «Wiederkehrende
 * Lohnart» (§22 decision 49): the same words from the data (a car's «Kaufpreis», «Satz % pro Monat»), the
 * same unit (a rate in percent is typed 0.9 and kept 0.009), the same prefilled value, and a refusal that
 * names the field by the word the form shows.
 */
import type { WageTypeDef } from '../../../core/modules/schema.js';
import { ratePercent, rateShown, rateStored } from '../../../payroll/catalogue.js';
import { t } from '../../i18n/index.js';
import { fmt } from '../../lib/utils.js';
import { numberOf, numText, type FieldDef, type Form } from './Dated.js';
import { inputLabel, pct } from './words.js';

type W = Pick<WageTypeDef, 'key' | 'input' | 'inputs' | 'units' | 'defaults' | 'hours'> | undefined;

const byQuantity = (w: W) => w?.input === 'quantity';

/** The fields of a Lohnart's value: quantity and rate, or an amount; `amountHint` under the amount. */
export function inputFields(w: W, opts: { amountHint?: string } = {}): FieldDef[] {
  if (!w || !byQuantity(w)) return [{ k: 'amount', label: (w && inputLabel(w.key, 'amount', w.inputs)) ?? t('payroll.field.amount'), type: 'number', ...(opts.amountHint ? { hint: opts.amountHint } : {}) }];
  return [
    { k: 'quantity', label: inputLabel(w.key, 'quantity', w.inputs) ?? t('payroll.field.quantity'), type: 'number' },
    { k: 'rate', label: inputLabel(w.key, 'rate', w.inputs) ?? t('payroll.field.unitRate'), type: 'number', ...(w.hours ? { hint: t('payroll.field.rateFromEmployment') } : {}) },
  ];
}

/** What a new form of the Lohnart starts with: its data's defaults, in the unit the form shows. */
export const inputDefaults = (w: W): Form => ({
  ...(w?.defaults?.quantity !== undefined ? { quantity: numText(w.defaults.quantity) } : {}),
  ...(w?.defaults?.rate !== undefined ? { rate: numText(w.defaults.rate) } : {}),
});

/** A form switched to another Lohnart: its inputs start again, with that Lohnart's defaults. */
export const switchedTo = (f: Form, next: Form, w: W): Form =>
  (next.wageType === f.wageType ? next : { ...next, quantity: '', rate: '', amount: '', ...inputDefaults(w) });

/** The value as the payslip computes with it: the rate in percent typed 0.9 is kept 0.009. */
export function inputValue(w: W, f: Form): { quantity?: number; rate?: number } | { amount?: number } {
  if (!byQuantity(w)) return { amount: numberOf(f.amount) };
  const rate = numberOf(f.rate);
  return { quantity: numberOf(f.quantity), rate: rate === undefined || Number.isNaN(rate) ? rate : rateStored(w, rate) };
}

/** A stored value in the form's unit. */
export const inputForm = (w: W, v: { amount?: number; quantity?: number; rate?: number } | undefined): Form => ({
  amount: numText(v?.amount), quantity: numText(v?.quantity), rate: numText(v?.rate === undefined ? undefined : rateShown(w, v.rate)),
});

/** «60'000.00 × 0.90 %» for a rate in percent, «8 × 45.00» otherwise; «…» for what is missing. */
export function calcText(w: W, quantity: number | undefined, rate: number | undefined): string {
  const q = quantity === undefined ? '…' : fmt(quantity).replace(/\.00$/, '');
  const r = rate === undefined ? '…' : ratePercent(w) ? pct(rateShown(w, rate)) : fmt(rate);
  return `${q} × ${r}`;
}

/** A refusal's field (the server's `quantity`, `unitRate`, `amount`) by the word this Lohnart's form shows it with. */
export const fieldWord = (w: W) => (field: string): string | undefined => {
  const k = field === 'unitRate' ? 'rate' : field;
  return inputFields(w).find((d) => d.k === k)?.label;
};
