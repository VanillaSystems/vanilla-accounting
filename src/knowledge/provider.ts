/**
 * A payment provider's section of its business file (#203): `provider:`. A shop platform or a card
 * terminal collects the sales and pays them out less its fees; the payout settles what it holds.
 *
 *   # processes/suppliers/<id>.yaml (the app layer: true for every company)
 *   provider:
 *     reports:
 *       sales: { order: Name, date: Paid at, shipTo: Shipping Country, gross: Total, tax: Taxes, outstanding: Outstanding Balance, refunded: Refunded Amount, currency: Currency, gateway: Payment Method }
 *       fees: { date: Transaction Date, fee: Fee, currency: Currency, order: Order, type: Type, amount: Amount }
 *     gateways: [ Shopify Payments ]
 *     processors: [ stripe ]
 *     payoutDays: 7
 *   # knowledge/suppliers/<id>.yaml (the company: its chart)
 *   provider:
 *     clearing: "1093"
 *     since: 2026-10-01
 *     revenue: "3200"
 *     fees: { account: "6580", vat: I0 }
 *     foreignTax: "2201"
 *     account: "1020"
 *
 * `reports` name the columns of the provider's own exports, each a header or a list of headers
 * (the first one found counts): `sales`, one row per order (or per line of an order: rows of one
 * order add up), and `fees`, the provider's payments export: one row per transaction (a charge, a
 * refund, …) with the provider's fee. With its `order` column the payments export says which orders
 * the provider collected (a row names them) and, with `type` and `amount`, on which day and how much
 * each refund went back (a `type` that reads «refund»): the sales report dates its refunds from there
 * (src/booking/sales-report.ts PaymentFacts); its rows whose `type` reads «charge» are the order's
 * charges, each on its day. `outstanding` in the sales report: the part of an order's total not
 * charged yet (an order edited after checkout): the sale is the total less it, its tax in the same
 * share (#231). `test` in either report: a column that flags a test
 * (true, yes, 1, test): such a row is no sale, no refund, no fee. `gateways`: the values of
 * the sales report's `gateway` column whose orders the provider collected and pays out (the others,
 * paid by PayPal, by bank transfer, on delivery, with a gift card or through a test gateway, come
 * with their own payment and are never booked onto the clearing account); with `gateways` the column
 * is needed. `processors`: the payment processors whose name the bank writes as the payer of the
 * provider's payouts (its reference then names the provider). `payoutDays`: how many days after a sale it pays it out at most, for the clearing
 * check; a company's file may say its own. `clearing`, `revenue` and `fees` are accounts of one
 * company's chart, so only its own file names them. `since`: the company's cut-over day, from which
 * on the provider's payouts are booked from the clearing account and its reports book the sales and
 * fees; whatever is dated before it stays as it was booked, and the app never books it again.
 * `foreignTax`: the account a foreign VAT an export order shows (IOSS, for example) goes onto, a pass-through
 * the firm pays abroad from; the net is the export. Without it such an order waits (#206).
 * `account`: the bank account (ledger account) the provider pays into, where the report's check for
 * a payout it does not recognise looks; absent: every account. Pure.
 */

import { isIsoDate } from '../accounting/periods.js';

export const SALES_COLUMNS = ['order', 'date', 'ordered', 'shipTo', 'gross', 'tax', 'outstanding', 'refunded', 'refundedAt', 'currency', 'gateway', 'test'] as const;
export type SalesColumn = (typeof SALES_COLUMNS)[number];
/** Without these a file is no sales report. */
export const SALES_NEEDS: readonly SalesColumn[] = ['order', 'date', 'gross'];
export const FEE_COLUMNS = ['date', 'fee', 'currency', 'order', 'type', 'amount', 'test'] as const;
export type FeeColumn = (typeof FEE_COLUMNS)[number];
export const FEE_NEEDS: readonly FeeColumn[] = ['date', 'fee'];

/** A column as the file names it: the headers it may have, the first found counts. */
export type Headers = readonly string[];
export type ReportKind = 'sales' | 'fees';
export type Columns<C extends string> = Partial<Record<C, Headers>>;

export interface ProviderFacts {
  reports: { sales?: Columns<SalesColumn>; fees?: Columns<FeeColumn> };
  /** The values of the sales report's `gateway` column that pay into the clearing account; absent: every order does. */
  gateways?: string[];
  /**
   * The payment processors that pay the provider's payouts under their own name (Shopify's: Stripe):
   * a credit from an unknown payer is the provider's payout by its reference only when the bank names
   * no payer or one of these (src/booking/providers.ts providerOfMoneyIn).
   */
  processors?: string[];
  /** At most this many days between a sale and the payout that pays it (the clearing check). */
  payoutDays?: number;
  /** The bank account (its ledger account) the provider pays into; absent: any. The unseen-payout check looks only there. */
  account?: string;
  /** The company's clearing account: what the provider collected and has not paid out yet. */
  clearing?: string;
  /** The company's cut-over day (YYYY-MM-DD): payouts, sales, refunds and fees from it on go over the clearing account; before it nothing changes. */
  since?: string;
  /** The company's revenue account for the provider's sales; absent: the firm's own for what it sells. */
  revenue?: string;
  /** The company's account and VAT code for the provider's fees. */
  fees?: { account: string; vat: string };
  /** The company's account for a foreign VAT on an export (IOSS, for example): the tax goes onto it without a code, the net is the export. */
  foreignTax?: string;
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const COMPANY_KEYS = ['clearing', 'since', 'revenue', 'fees', 'foreignTax', 'account'] as const;
const APP_KEYS = ['reports', 'payoutDays', 'gateways', 'processors'] as const;

function columnsOf<C extends string>(raw: unknown, names: readonly C[], needs: readonly C[], what: string): { columns: Columns<C> } | { problem: string } {
  if (!isMap(raw)) return { problem: `provider.reports.${what} must be a map of columns: { ${needs.map((n) => `${n}: <header>`).join(', ')} }` };
  const out: Columns<C> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(names as readonly string[]).includes(k)) return { problem: `provider.reports.${what}.${k} is no column — use ${names.join(', ')}` };
    const headers = (Array.isArray(v) ? v : [v]).map(text);
    if (!headers.length || headers.some((h) => !h)) return { problem: `provider.reports.${what}.${k} must name a header, or a list of headers` };
    out[k as C] = headers as string[];
  }
  const missing = needs.filter((n) => !out[n]);
  if (missing.length) return { problem: `provider.reports.${what} needs the columns ${missing.join(', ')}` };
  return { columns: out };
}

/** The `provider:` section of a merged business file, or what is wrong with it. */
export function parseProvider(raw: unknown): { provider: ProviderFacts } | { problem: string } {
  if (!isMap(raw)) return { problem: 'provider must be a map: { reports, payoutDays } in the app\'s file, { clearing, since, revenue, fees } in the company\'s' };
  for (const k of Object.keys(raw)) if (![...APP_KEYS, ...COMPANY_KEYS].includes(k as never)) return { problem: `provider.${k} is unknown — use ${[...APP_KEYS, ...COMPANY_KEYS].join(', ')}` };
  const out: ProviderFacts = { reports: {} };
  if (raw.reports !== undefined) {
    if (!isMap(raw.reports)) return { problem: 'provider.reports must be a map: { sales: {…}, fees: {…} }' };
    for (const k of Object.keys(raw.reports)) if (k !== 'sales' && k !== 'fees') return { problem: `provider.reports.${k} is unknown — use sales, fees` };
    if (raw.reports.sales !== undefined) {
      const c = columnsOf(raw.reports.sales, SALES_COLUMNS, SALES_NEEDS, 'sales');
      if ('problem' in c) return c;
      out.reports.sales = c.columns;
    }
    if (raw.reports.fees !== undefined) {
      const c = columnsOf(raw.reports.fees, FEE_COLUMNS, FEE_NEEDS, 'fees');
      if ('problem' in c) return c;
      out.reports.fees = c.columns;
    }
  }
  if (raw.gateways !== undefined) {
    const list = (Array.isArray(raw.gateways) ? raw.gateways : [raw.gateways]).map(text);
    if (!list.length || list.some((g) => !g)) return { problem: 'provider.gateways must name the payment methods the provider pays out, a list of the gateway column\'s values' };
    if (!out.reports.sales?.gateway) return { problem: 'provider.gateways needs the column reports.sales.gateway, where the sales report names how each order was paid' };
    out.gateways = list as string[];
  }
  if (raw.processors !== undefined) {
    const list = (Array.isArray(raw.processors) ? raw.processors : [raw.processors]).map(text);
    if (!list.length || list.some((x) => !x)) return { problem: 'provider.processors must name the payment processors that pay the provider\'s payouts under their own name, a list of words of the bank\'s payer name' };
    out.processors = list as string[];
  }
  if (raw.payoutDays !== undefined) {
    if (typeof raw.payoutDays !== 'number' || !Number.isInteger(raw.payoutDays) || raw.payoutDays < 1 || raw.payoutDays > 90) return { problem: 'provider.payoutDays must be a whole number of days, 1 to 90' };
    out.payoutDays = raw.payoutDays;
  }
  for (const k of ['clearing', 'revenue', 'foreignTax', 'account'] as const) {
    if (raw[k] === undefined) continue;
    const a = text(raw[k]);
    if (!a) return { problem: `provider.${k} must be an account number of the chart` };
    out[k] = a;
  }
  if (raw.since !== undefined) {
    // YAML reads an unquoted 2026-10-01 as a date.
    const day = raw.since instanceof Date && !Number.isNaN(raw.since.getTime()) ? raw.since.toISOString().slice(0, 10) : text(raw.since);
    if (!day || !isIsoDate(day)) return { problem: 'provider.since must be a day, YYYY-MM-DD: from it on the payouts go over the clearing account' };
    out.since = day;
  }
  if (raw.fees !== undefined) {
    const account = isMap(raw.fees) ? text(raw.fees.account) : undefined;
    const vat = isMap(raw.fees) ? text(raw.fees.vat) : undefined;
    if (!account || !vat || Object.keys(raw.fees as object).some((k) => k !== 'account' && k !== 'vat')) return { problem: 'provider.fees must be { account: <account number>, vat: <VAT code> } (I0 when no bill shows the provider\'s Swiss VAT)' };
    out.fees = { account, vat };
  }
  return { provider: out };
}

/**
 * The provider sections of the app's file (`vendor`) and the company's (`binding`) as one: the
 * reports are the app's (a company's file may add a report the app's does not name), the gateways
 * of both, the payout days the company's where it says them (its provider may pay slower), the
 * accounts the company's only. `hasVendor`: the business has an app file at all; without one the
 * company's file is the whole business and may say everything.
 */
export function mergeProvider(vendor: unknown, binding: unknown, hasVendor: boolean): { raw: unknown } | { problem: string; layer: 'vendor' | 'binding' } | undefined {
  if (vendor === undefined && binding === undefined) return undefined;
  if (isMap(vendor)) {
    const own = COMPANY_KEYS.find((k) => vendor[k] !== undefined);
    if (own) return { problem: `provider.${own} is one company's chart — move it to <binding>`, layer: 'vendor' };
  }
  if (!hasVendor || vendor === undefined) return { raw: binding };
  if (binding === undefined) return { raw: vendor };
  if (!isMap(vendor) || !isMap(binding)) return { problem: 'provider must be a map', layer: isMap(vendor) ? 'binding' : 'vendor' };
  const vr = isMap(vendor.reports) ? vendor.reports : {};
  const br = isMap(binding.reports) ? binding.reports : {};
  const twice = Object.keys(br).find((k) => vr[k] !== undefined);
  if (twice) return { problem: `provider.reports.${twice} is said in the app's file already — delete it here`, layer: 'binding' };
  const reports = { ...vr, ...br };
  const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const gateways = [...new Set([...list(vendor.gateways), ...list(binding.gateways)])];
  const processors = [...new Set([...list(vendor.processors), ...list(binding.processors)])];
  return { raw: { ...vendor, ...binding, ...(Object.keys(reports).length ? { reports } : {}), ...(gateways.length ? { gateways } : {}), ...(processors.length ? { processors } : {}) } };
}
