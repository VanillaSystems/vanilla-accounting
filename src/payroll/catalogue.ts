/**
 * The Lohnarten as a firm uses them (docs/specs/payroll.md §5.3): the jurisdiction's catalogue with the
 * firm's layer over it (payroll.json `wageTypes`): a rename, other accounts or another Lohnausweis field,
 * a copy that keeps every flag, or a Lohnart of its own. Code reads only the flags. Pure, browser-safe.
 */
import type { Labels, PayrollAccountRef, PayrollData, WageTypeDef } from '../core/modules/schema.js';
import type { PayrollInsurance, PayrollStore, WageTypeLayer } from './model.js';

/** A Lohnart as the firm uses it: where it came from, and its stage on the payslip. */
export interface WageType extends WageTypeDef {
  stage: 'gross' | 'deduction' | 'after' | 'employer';
  origin: 'catalogue' | 'override' | 'copy' | 'own';
}

export class CatalogueError extends Error {}

/** Every Lohnart the firm has, by key: the catalogue's in its order, then the firm's copies and its own. */
export function wageTypesOf(data: PayrollData, layer: readonly WageTypeLayer[]): Map<string, WageType> {
  const stageOf = (group: string) => {
    const g = data.groups.find((x) => x.key === group);
    if (!g) throw new CatalogueError(`group "${group}" does not exist`);
    return g.stage;
  };
  const out = new Map<string, WageType>();
  for (const w of data.wageTypes) out.set(w.key, { ...w, stage: stageOf(w.group), origin: 'catalogue' });
  for (const l of layer) {
    if ('own' in l) {
      out.set(l.key, { ...l.own, key: l.key, stage: stageOf(l.own.group), origin: 'own' });
    } else if ('copyOf' in l) {
      const from = out.get(l.copyOf);
      if (!from) throw new CatalogueError(`the copy "${l.key}" names "${l.copyOf}", which does not exist`);
      out.set(l.key, { ...from, key: l.key, label: l.label, ...accounts(l), origin: 'copy' });
    } else {
      const base = out.get(l.key);
      if (!base) continue;
      out.set(l.key, { ...base, label: { ...base.label, ...(l.label ?? {}) } as Labels, ...accounts(l), origin: base.origin === 'catalogue' ? 'override' : base.origin });
    }
  }
  return out;
}

const accounts = (l: { debit?: string; credit?: string; lohnausweis?: string }) => ({
  ...(l.debit ? { debit: l.debit } : {}), ...(l.credit ? { credit: l.credit } : {}), ...(l.lohnausweis ? { lohnausweis: l.lohnausweis } : {}),
});

/** The firm's wage types: the catalogue with its layer. */
export const firmWageTypes = (data: PayrollData, store: Pick<PayrollStore, 'wageTypes'>): Map<string, WageType> => wageTypesOf(data, store.wageTypes);

/** The account a Lohnart books on: a number, or the liability account of the firm's insurance of that kind (else the kind's). */
export function resolveAccount(ref: PayrollAccountRef | undefined, data: PayrollData, insurance: PayrollInsurance | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === 'string') return ref;
  return insurance?.kind === ref.insurance && insurance.account ? insurance.account : data.insurances[ref.insurance]?.account;
}
