/**
 * Where the app is: one Route per page and object, and the only parser and formatter of the
 * paths and query parameters that name them (docs/urls.md). Links carry no language (rule 3);
 * the period is parsed here by src/accounting/periods.ts and leaves as a Period, never a token.
 */
import { localToday, parsePeriod, type IsoDate, type Period } from '../../accounting/periods.js';

export const REPORTS = ['income', 'balance', 'trial'] as const;
export type Report = typeof REPORTS[number];

export const COMPANY_SECTIONS = ['profile', 'vat', 'banks', 'invoice-layout', 'mail', 'accounts', 'periods', 'opening', 'display'] as const;
export type CompanySection = typeof COMPANY_SECTIONS[number];

export const RECEIPT_FILTERS = ['zugeordnet', 'offen', 'ohneDatum'] as const;
export type ReceiptFilter = typeof RECEIPT_FILTERS[number];

export const INVOICE_STATUSES = ['open', 'overdue', 'draft', 'paid'] as const;
export type InvoiceStatus = typeof INVOICE_STATUSES[number];

export type Route =
  | { area: 'receipts'; id?: string }
  /** A payment without its statement is /payments/<ref>: the bank area finds the statement. */
  | { area: 'bank'; statement?: string; payment?: string }
  | { area: 'journal'; id?: string }
  | { area: 'vat'; ziffer?: string }
  | { area: 'codes'; code?: string }
  | { area: 'reports'; report: Report; account?: string }
  | { area: 'close'; step?: string }
  /** An unknown section stays in the route, so the area can say it does not exist (urls.md rule 5). */
  | { area: 'company'; section: CompanySection | (string & {}) }
  | { area: 'invoices'; view: 'list' | 'customers' | 'sent'; id?: string };

export type AreaId = Route['area'];
export type RouteOf<A extends AreaId> = Extract<Route, { area: A }>;

/** Each area's own page, where the dock and G + letter go. */
export const AREA_HOME: { [A in AreaId]: RouteOf<A> } = {
  receipts: { area: 'receipts' },
  invoices: { area: 'invoices', view: 'list' },
  bank: { area: 'bank' },
  journal: { area: 'journal' },
  vat: { area: 'vat' },
  codes: { area: 'codes' },
  reports: { area: 'reports', report: 'income' },
  close: { area: 'close' },
  company: { area: 'company', section: 'profile' },
};

export interface Query {
  /** Absent: the open period. */
  period?: Period;
  q?: string;
  filter?: ReceiptFilter;
  status?: InvoiceStatus;
  vat?: string;
  /** /invoices/new?customer=<id>: the customer of the draft to write. */
  customer?: string;
}

export interface Location { route: Route; query: Query }

/** A URL that names a location in another spelling (an old link, a trailing slash): replace it. */
export interface Redirect { redirect: Location }

export function parseLocation(path: string, search: string, today: IsoDate = localToday()): Location | Redirect {
  const segs = path.split('/').filter(Boolean).map(decode);
  const params = new URLSearchParams(search);
  const legacy = legacyLocation(segs, params, today);
  if (legacy) return { redirect: legacy };
  const loc: Location = { route: routeOf(segs), query: queryOf(params, today) };
  const qs = search.replace(/^\?/, '');
  return formatLocation(loc) === (qs ? `${path}?${qs}` : path) ? loc : { redirect: loc };
}

export function formatLocation({ route, query }: Location): string {
  const path = `/${segmentsOf(route).filter((s): s is string => !!s).map(encodeURIComponent).join('/')}`;
  const qs = new URLSearchParams();
  if (query.period) qs.set('period', query.period.token.replace('..', '_'));
  if (query.filter) qs.set('filter', query.filter);
  if (query.status) qs.set('status', query.status);
  if (query.vat) qs.set('vat', query.vat);
  if (query.customer) qs.set('customer', query.customer);
  if (query.q) qs.set('q', query.q);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export const isRedirect = (p: Location | Redirect): p is Redirect => 'redirect' in p;

function segmentsOf(r: Route): Array<string | undefined> {
  switch (r.area) {
    case 'receipts': return ['receipts', r.id];
    case 'bank': return r.statement ? ['bank', r.statement, r.payment] : r.payment ? ['payments', r.payment] : ['bank'];
    case 'journal': return ['journal', r.id];
    case 'vat': return ['vat', r.ziffer];
    case 'codes': return ['vat', 'codes', r.code];
    case 'reports': return ['reports', r.report, r.account];
    case 'close': return ['close', r.step];
    case 'company': return ['company', r.section];
    case 'invoices': return ['invoices', r.view === 'list' ? undefined : r.view, r.id];
  }
}

function routeOf([a, b, c]: string[]): Route {
  switch (a) {
    case 'receipts': return defined({ area: 'receipts', id: b });
    case 'bank': return defined({ area: 'bank', statement: b, payment: b && c });
    case 'payments': return defined({ area: 'bank', payment: b });
    case 'journal': return defined({ area: 'journal', id: b });
    case 'vat': return b === 'codes' ? defined({ area: 'codes', code: c }) : defined({ area: 'vat', ziffer: b });
    case 'reports': return isOneOf(REPORTS, b) ? defined({ area: 'reports', report: b, account: c }) : { area: 'reports', report: 'income' };
    case 'close': return defined({ area: 'close', step: b });
    case 'company': return { area: 'company', section: b ?? 'profile' };
    case 'invoices': return b === 'customers' || b === 'sent' ? defined({ area: 'invoices', view: b, id: c }) : defined({ area: 'invoices', view: 'list', id: b });
    default: return { area: 'receipts' };
  }
}

function queryOf(params: URLSearchParams, today: IsoDate): Query {
  const get = (k: string) => params.get(k) || undefined;
  const filter = LEGACY_FILTER[get('filter') ?? ''] ?? get('filter');
  const status = get('status');
  return defined({
    period: periodOf(get('period'), today),
    q: get('q'),
    filter: isOneOf(RECEIPT_FILTERS, filter) ? filter : undefined,
    status: isOneOf(INVOICE_STATUSES, status) ? status : undefined,
    vat: get('vat'),
    customer: get('customer'),
  });
}

/** urls.md writes a custom range 2026-07-01_2026-09-30; periods.ts and older links use '..'. */
function periodOf(token: string | undefined, today: IsoDate): Period | undefined {
  return token ? parsePeriod(token.replace('_', '..'), today) ?? undefined : undefined;
}

const LEGACY_FILTER: Record<string, ReceiptFilter> = { linked: 'zugeordnet', unlinked: 'offen' };

/** The tabs of /<lang>/<period>/<tab>?receipt=&tx=&je=&account=&ziffer=&view=&code= links. */
const LEGACY_TABS: Record<string, (p: (k: string) => string | undefined) => Route> = {
  'receipts': (p) => defined({ area: 'receipts', id: p('receipt') }),
  'transactions': (p) => defined({ area: 'bank', payment: p('tx') }),
  'bank-statements': () => ({ area: 'bank' }),
  'bank-reconciliation': () => ({ area: 'bank' }),
  'journal-entries': (p) => defined({ area: 'journal', id: p('je') }),
  'trial-balance': (p) => defined({ area: 'reports', report: 'trial', account: p('account') }),
  'account-ledger': (p) => defined({ area: 'reports', report: 'trial', account: p('account') }),
  'balance-sheet': (p) => defined({ area: 'reports', report: 'balance', account: p('account') }),
  'income-statement': (p) => defined({ area: 'reports', report: 'income', account: p('account') }),
  'vat-report': (p) => p('view') === 'codes' ? defined({ area: 'codes', code: p('code') }) : defined({ area: 'vat', ziffer: p('ziffer') }),
  'year-close': () => ({ area: 'close' }),
};

/** An old link's new location, or null when the URL is not one. */
function legacyLocation(segs: string[], params: URLSearchParams, today: IsoDate): Location | null {
  let rest = segs;
  if (/^[a-z]{2}$/.test(rest[0] ?? '')) rest = rest.slice(1);
  const period = rest[0] !== undefined && periodOf(rest[0], today) ? periodOf(rest[0], today) : undefined;
  if (period) rest = rest.slice(1);
  const tab = rest[0] ?? 'receipts';
  const oldSelection = tab === 'receipts' && (params.has('receipt') || params.has('tx'));
  if (rest === segs && (tab === 'receipts' ? !oldSelection : !(tab in LEGACY_TABS))) return null;
  const route = (LEGACY_TABS[tab] ?? LEGACY_TABS.receipts)((k) => params.get(k) || undefined);
  return { route, query: defined({ ...queryOf(params, today), period }) };
}

/** The section a company route names, or undefined when there is none of that name. */
export const companySection = (s: string): CompanySection | undefined => (isOneOf(COMPANY_SECTIONS, s) ? s : undefined);

function isOneOf<T extends string>(values: readonly T[], v: string | undefined): v is T {
  return (values as readonly (string | undefined)[]).includes(v);
}

/** The object without its undefined keys, so a parsed route equals one written by hand. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
