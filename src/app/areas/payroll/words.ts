/**
 * The Löhne area's words that come from data: the Lohnart, group, insurance and rate labels of the
 * jurisdiction's payroll.yaml in the UI's language (never the dictionaries, docs/specs/payroll.md §12.2),
 * and the dictionary's sentences for the facts, the lines «unvollständig» and the warnings of a close.
 */
import { language, monthLocale, t, tWith } from '../../i18n/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { payroll } from '../../../engines/index.js';
import type { Labels, PayrollData } from '../../../core/modules/schema.js';
import type { PayslipFact } from '../../../payroll/compute.js';
import type { CloseWarning } from '../../../payroll/close.js';
import type { RateWarning } from '../../../payroll/settings.js';

/** The jurisdiction's payroll data; the area shows without it only that the books have none. */
export const data = (): PayrollData | undefined => { try { return payroll(); } catch { return undefined; } };

export const lang = (): keyof Labels => (['de', 'fr', 'it', 'en'].includes(language()) ? language() as keyof Labels : 'de');
export const labelOf = (l: Partial<Labels> | undefined, fallback = ''): string => l?.[lang()] ?? l?.de ?? fallback;

/** «September 2026». */
export const monthText = (month: string): string => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString(monthLocale(), { month: 'long', year: 'numeric' });
/** «Sep». */
export const monthShort = (month: string): string => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString(monthLocale(), { month: 'short' });

/**
 * A Lohnart's label in the UI's language: the firm's (a rename, a copy) where `types` has it, else the
 * catalogue's, else what the server wrote (in the person's language, on her payslip).
 */
export const wageTypeLabel = (key: string, fallback: string, types?: ReadonlyMap<string, { label: Partial<Labels> }>): string =>
  labelOf(types?.get(key)?.label ?? data()?.wageTypes.find((w) => w.key === key)?.label, fallback);

export const kindLabel = (kind: string): string => labelOf(data()?.insurances[kind]?.label, kind);
export const rateLabel = (kind: string, key: string): string => labelOf(data()?.insurances[kind]?.rates?.[key]?.label, key);

/** The insurance a contribution Lohnart belongs to. */
const kindOfWageType = (wageType: string): string | undefined => data()?.contributions.find((c) => c.wageType === wageType)?.insurance;

/** A fact beside a payslip, in a sentence. */
export function factText(f: PayslipFact): string {
  const v = f.vars ?? {};
  const vars: Record<string, string | number> = {};
  for (const [k, x] of Object.entries(v)) vars[k] = k === 'date' ? formatDate(String(x)) : k === 'month' ? monthText(String(x)) : k === 'amount' ? fmt(Number(x)) : k === 'kind' ? kindLabel(String(x)) : x;
  return tWith(`payroll.fact.${f.key}`, vars);
}

/** What the form and the line «unvollständig» call a Lohnart's input (a car's price, «Stunden»), from the data; undefined: the app's word. */
export const inputLabel = (wageType: string, input: 'quantity' | 'rate' | 'amount', inputs?: Partial<Record<'quantity' | 'rate' | 'amount', Labels>>): string | undefined => {
  const l = (inputs ?? data()?.wageTypes.find((w) => w.key === wageType)?.inputs)?.[input];
  return l ? labelOf(l) : undefined;
};

/** What a line «unvollständig» lacks: a rate of the insurance names that rate, an input its Lohnart's word for it (a car's price). */
export function missingText(code: string, wageType: string, inputs?: Partial<Record<'quantity' | 'rate' | 'amount', Labels>>): string {
  const input = code === 'quantity' ? 'quantity' : code === 'unitRate' ? 'rate' : code === 'amount' ? 'amount' : undefined;
  const said = input && inputLabel(wageType, input, inputs);
  if (said) return t('payroll.missing.input', { what: said });
  if (code.startsWith('rate:')) {
    const kind = kindOfWageType(wageType);
    return t('payroll.missing.rate', { rate: kind ? rateLabel(kind, code.slice(5)) : code.slice(5), insurance: kind ? kindLabel(kind) : '' });
  }
  if (code === 'insurance') { const kind = kindOfWageType(wageType); return t('payroll.missing.insurance', { insurance: kind ? kindLabel(kind) : '' }); }
  return tWith(`payroll.missing.${code}`, {});
}

export function warningText(w: CloseWarning): string {
  switch (w.key) {
    case 'missing': return t('payroll.warn.missing', { label: wageTypeLabel(w.wageType, w.label), what: missingText(w.missing, w.wageType) });
    case 'earlierOpen': return t('payroll.warn.earlierOpen', { month: monthText(w.month) });
    case 'accountMissing': return t('payroll.warn.accountMissing', { account: w.account });
    case 'withoutAccount': return t('payroll.warn.withoutAccount', { wageType: w.wageType });
    case 'handEntries': return t('payroll.warn.handEntries', { n: w.entries.length });
  }
}

export const rateWarningText = (kind: string, w: RateWarning): string =>
  t('payroll.settings.rateRange', { rate: rateLabel(kind, w.key), value: fmt(w.value), from: w.range[0], to: w.range[1] });

/** A rate as the payslip prints it: «5.30 %», up to four decimals where the data has them. */
export const pct = (r: number): string => `${r.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} %`;

/** The Inhaber/in, the status and the language of a person, in words. */
export const statusText = (s: 'active' | 'left' | 'future'): string => t(`payroll.status.${s}`);

/** An instant («2026-11-19T09:37:00Z») as the viewer's day and time: «19.11.2026», «10:37». */
export function localWhen(iso: string): { at: string; time: string } {
  const d = new Date(iso);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { at: formatDate(day), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
}
