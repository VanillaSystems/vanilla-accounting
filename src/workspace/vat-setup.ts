/**
 * The company's VAT setup: one typed value the whole app reads. Parsed once at the manifest
 * boundary (src/workspace/manifest.ts), carried on Company.vat, handed to the engines with the
 * jurisdiction (src/engines/index.ts setJurisdiction), so the return, the tax codes, the filing
 * length and the booking paths never check a setup field of their own.
 *
 * Three kinds of firm: not registered (purchases and sales gross, no codes, no return); registered
 * on the effective method (input tax per receipt, form 0550); registered on the net tax rate
 * method (one or two approved rates on the gross turnover, no input tax, form 0553). The method
 * holds for whole years: the Firma page refuses a change in a year that has entries.
 */
import type { FilingLength } from '../accounting/periods.js';

export const VAT_METHODS = ['effective', 'net-rate'] as const;
export type VatMethod = (typeof VAT_METHODS)[number];

export const VAT_PERIODS = ['quarterly', 'half-yearly'] as const;
export type VatPeriod = (typeof VAT_PERIODS)[number];

/**
 * One net tax rate the tax authority approved for the firm: the percent of the gross turnover it
 * owes. `activityId` is the authority's five-character code of the activity, which the electronic
 * return names each rate by; without it the return's XML cannot be written (the review task says so).
 */
export interface NetRate {
  rate: number;
  /** What the rate is for, in the owner's words («Schreinerei»). */
  label?: string;
  activityId?: string;
}

export type NetRates = readonly [NetRate] | readonly [NetRate, NetRate];

export type VatSetup =
  | { registered: false }
  | { registered: true; method: 'effective'; reporting: 'received'; period: VatPeriod }
  | { registered: true; method: 'net-rate'; reporting: 'received'; period: VatPeriod; rates: NetRates };

export type RegisteredVat = Extract<VatSetup, { registered: true }>;

/** The setup every workspace had before the other kinds existed: what a manifest without `registered` and `period` means. */
export const EFFECTIVE_QUARTERLY: VatSetup = { registered: true, method: 'effective', reporting: 'received', period: 'quarterly' };

export const NOT_REGISTERED: VatSetup = { registered: false };

/** `rates` as the one or two approved rates a setup carries; null for none or more than two. */
export function asNetRates(rates: readonly NetRate[]): NetRates | null {
  return rates.length === 1 || rates.length === 2 ? (rates as NetRates) : null;
}

/** The method the books run on; `none` for a firm that charges no VAT. */
export const methodOf = (setup: VatSetup): VatMethod | 'none' => (setup.registered ? setup.method : 'none');

/** The firm's approved net rates, none on any other setup. */
export const netRatesOf = (setup: VatSetup): readonly NetRate[] => (setup.registered && setup.method === 'net-rate' ? setup.rates : []);

/** How long one return is: the setup's period; a firm without returns keeps the jurisdiction's length as its bookkeeping period. */
export function filingLengthOf(setup: VatSetup, fallback: FilingLength): FilingLength {
  if (!setup.registered) return fallback;
  return setup.period === 'half-yearly' ? 'half' : 'quarter';
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `company.vat` of the manifest, checked. Defaults keep every older manifest valid: `registered`
 * is true and `period` quarterly when absent. `fail` throws with the manifest's path in front.
 */
export function parseVatSetup(raw: unknown, fail: (msg: string) => never): VatSetup {
  const vat = raw === undefined ? {} : isMap(raw) ? raw : fail('company.vat must be a mapping');
  const registered = vat.registered ?? true;
  if (typeof registered !== 'boolean') return fail('company.vat.registered must be true or false');
  if (!registered) {
    const extra = Object.keys(vat).filter((k) => k !== 'registered');
    if (extra.length) fail(`company.vat with registered: false takes no other key (found ${extra.join(', ')})`);
    return NOT_REGISTERED;
  }
  const method = vat.method;
  if (!VAT_METHODS.includes(method as VatMethod)) fail(`company.vat.method must be one of ${VAT_METHODS.join(', ')}`);
  if (vat.reporting !== 'received') fail('company.vat.reporting must be received: the books are kept on a cash basis, the only basis the engine supports');
  const period = vat.period ?? 'quarterly';
  if (!VAT_PERIODS.includes(period as VatPeriod)) fail(`company.vat.period must be one of ${VAT_PERIODS.join(', ')}`);
  if (method === 'effective') {
    if (vat.rates !== undefined) fail('company.vat.rates belongs to the net tax rate method only');
    return { registered: true, method: 'effective', reporting: 'received', period: period as VatPeriod };
  }
  return { registered: true, method: 'net-rate', reporting: 'received', period: period as VatPeriod, rates: parseNetRates(vat.rates, fail) };
}

export function parseNetRates(raw: unknown, fail: (msg: string) => never): NetRates {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return fail('company.vat.rates must list one or two approved net tax rates, as [{ rate: 4.5 }]');
  const rates = raw.map((r, i): NetRate => {
    const where = `company.vat.rates[${i}]`;
    const o = isMap(r) ? r : typeof r === 'number' ? { rate: r } : fail(`${where} must be { rate, label?, activityId? }`);
    const rate = Number(o.rate);
    if (!(rate > 0 && rate < 100) || !Number.isFinite(rate)) fail(`${where}.rate must be a percent above 0 and below 100`);
    const label = o.label === undefined ? undefined : String(o.label).trim();
    const activityId = o.activityId === undefined ? undefined : String(o.activityId).trim();
    if (activityId !== undefined && !/^[A-Z0-9]{5}$/.test(activityId)) fail(`${where}.activityId must be the tax authority's five-character activity code`);
    return { rate, ...(label ? { label } : {}), ...(activityId ? { activityId } : {}) };
  });
  if (rates.length === 2 && rates[0].rate === rates[1].rate && rates[0].activityId === rates[1].activityId) fail('company.vat.rates names the same rate twice');
  return asNetRates(rates)!;
}

/** The setup as the manifest writes it: every key explicit, so a reader sees the kind of firm at once. */
export function vatSetupYaml(setup: VatSetup): Record<string, unknown> {
  if (!setup.registered) return { registered: false };
  const base = { registered: true, method: setup.method, reporting: setup.reporting, period: setup.period };
  return setup.method === 'net-rate' ? { ...base, rates: setup.rates.map((r) => ({ ...r })) } : base;
}

/**
 * Whether two setups differ in a way the method rule covers: registration, method, period or a
 * rate's percent. A label or an activity code may change at any time.
 */
export function changesMethod(a: VatSetup, b: VatSetup): boolean {
  const key = (s: VatSetup) => JSON.stringify(s.registered ? [s.method, s.period, netRatesOf(s).map((r) => r.rate)] : ['none']);
  return key(a) !== key(b);
}
