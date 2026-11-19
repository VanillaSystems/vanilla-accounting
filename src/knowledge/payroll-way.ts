/**
 * A business's `payroll:` section (docs/specs/payroll.md §22 decision 59): the firm books a payment to this fund
 * or insurer that the payslips' accruals do not cover yet (an Akonto paid ahead) against the insurance's liability,
 * by code, without asking «für Monate ab dem Lohnstart / davor» again: kept once with «Immer so».
 *
 *   # knowledge/<role>/<id>.yaml (the company's file of the fund)
 *   payroll:
 *     payments: liability
 *     source: hand 2026-11-19
 *
 * Only the liability way can be kept: «für Monate davor» pays months before payroll ran here, which end, so kept for
 * good it would expense later advance payments a second time; it stays a choice per payment. One company's choice,
 * so the app layer never says it. A person undoes it by removing the section (the app's «Rückgängig» does the same). Pure.
 */

export const PAYROLL_WAYS = ['liability'] as const;
export type PayrollWay = (typeof PAYROLL_WAYS)[number];

export interface PayrollSection { payments: PayrollWay; source?: string }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The section as written, or what is wrong with it, in the words of the file. */
export function parsePayrollSection(raw: unknown): { section: PayrollSection } | { problem: string } {
  if (!isMap(raw)) return { problem: 'payroll must be a map: payroll: { payments: liability }' };
  const extra = Object.keys(raw).find((k) => k !== 'payments' && k !== 'source');
  if (extra) return { problem: `payroll.${extra} is not known — use payments and source` };
  if (raw.payments === 'contributions') return { problem: 'payroll.payments: contributions cannot be kept — «für Monate davor» is chosen per payment; remove the payroll section or write liability' };
  if (!(PAYROLL_WAYS as readonly unknown[]).includes(raw.payments)) return { problem: `payroll.payments must be ${PAYROLL_WAYS.join(' or ')}` };
  if (raw.source !== undefined && (typeof raw.source !== 'string' || !raw.source.trim())) return { problem: 'payroll.source must be a text' };
  return { section: { payments: raw.payments as PayrollWay, ...(typeof raw.source === 'string' ? { source: raw.source.trim() } : {}) } };
}
