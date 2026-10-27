/**
 * A payment provider's sales report booked onto its clearing account (#203). The provider's own
 * export for a period (a CSV: one row per order, or per line of an order) names each order's day,
 * delivery country, gross, tax and refunds; its fee export each charge's fee. Code reads both by the
 * columns the provider's file names (src/knowledge/provider.ts) and books:
 *
 *   each order      clearing / revenue   gross, the domestic sale code for a delivery into the VAT
 *                                        territory, the export code for one abroad
 *                   clearing / revenue   an export whose tax column shows a foreign VAT (EU OSS):
 *                   clearing / foreign   the net at the export code, the tax onto the company's
 *                                        account for foreign tax without a code (#206)
 *   each refund     revenue / clearing   its amount, the sale's code with the minus (an export with
 *                                        foreign VAT split as its sale: the tax share off the account)
 *   each fee        fees / clearing      the provider's fee, the company's fee code
 *
 * The payout itself is booked bank / clearing without VAT (src/booking/classify.ts), so the clearing
 * account comes back to what the provider holds unpaid (src/booking/providers.ts clearingCheck).
 *
 * The tax point: on the cash basis the day the provider collected the payment (`date`); on the
 * agreed basis the day of the order (`ordered`, else `date`): it dates the entry and says whether
 * the row lies in a filed period; whether a payout from the clearing account can have paid it (the
 * reach, what the books carry) goes by the day the provider collected it. Each order has a ref of its own
 * (SR-<provider>-<order>), so a report read twice, or two that overlap, book each order once; an
 * order the books carry with other figures is named, never booked again. Nothing is booked into a
 * filed period or before the books begin: such orders are counted, a correction is the person's
 * (golden rule 1); a refund of such an order dated in the open period is booked. From the company's
 * cut-over day (`provider.since`) on the provider's payouts settle the clearing account, and the
 * first of them pay sales collected up to its payout days before it: so the report books every row
 * from `since` less the payout days on that the books do not carry yet; earlier rows are counted. A
 * row before `since` waits when the clearing account carries it already (the old way, per order) or
 * a payout before `since` booked otherwise (as sales) is dated after it and so may have paid it. A domestic order is
 * booked at the rate its tax column shows (the normal one, a reduced one the firm's form takes); one
 * without tax, or at no rate the firm books, is a new case for the person, never a sale without
 * output tax (processes/suppliers/shopify.yaml sv-delivery-decides); a foreign tax on an export goes
 * onto the company's account for it (`provider.foreignTax`), the net is the export; without that
 * account the order waits (`foreignTax`), never booked gross at the export code (#206). Swiss VAT
 * shown on an export holds it (it is owed as shown). An order the
 * provider did not collect (its `gateway` none of the provider's `gateways`) is counted, never booked
 * onto the clearing account. A refund without its own day waits for the person: it is never dated on
 * the order's day. What the books carry already from elsewhere holds
 * what it may be (`ReportContext.legacy`): sales on the clearing account that name one order only (an
 * older booking per order, a person's own, less a reversal of it) with its amount in all book it, so
 * the order is known and never held again; with another amount, or naming several orders in one
 * entry, they hold the orders they name and every row up to their day; one that names none, and a payout of
 * the provider booked otherwise than from the clearing account (as sales), hold every order, refund
 * and fee up to their day; so nothing counts twice. Browser-safe apart from the engines' globals.
 */
import type { JournalEntry, Mapping, Receipt, SalesReportFacts } from '../types/index.js';
import type { Columns, FeeColumn, ProviderFacts, ReportKind, SalesColumn } from '../knowledge/provider.js';
import { FEE_NEEDS, SALES_NEEDS } from '../knowledge/provider.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { isIsoDate } from '../accounting/periods.js';

// ─── Reading the file ────────────────────────────────────────────────────────

/** The rows of a CSV file: its separator found on the header line (comma, semicolon or tab), quotes as RFC 4180 writes them. */
export function csvRows(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const nl = body.search(/\r?\n/);
  const head = nl < 0 ? body : body.slice(0, nl);
  const sep = [',', ';', '\t'].map((c) => ({ c, n: head.split(c).length })).sort((a, b) => b.n - a.n)[0].c;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const norm = (h: string) => h.trim().toLowerCase();

/** Where each column the file names stands in its header, or the needed columns it lacks. */
function placeColumns<C extends string>(header: readonly string[], columns: Columns<C>, needs: readonly C[]): { at: Partial<Record<C, number>> } | { missing: C[] } {
  const heads = header.map(norm);
  const at: Partial<Record<C, number>> = {};
  for (const [k, names] of Object.entries(columns) as Array<[C, readonly string[]]>) {
    const i = names.map((n) => heads.indexOf(norm(n))).find((x) => x >= 0);
    if (i !== undefined) at[k] = i;
  }
  const missing = needs.filter((n) => at[n] === undefined);
  return missing.length ? { missing } : { at };
}

/** A provider whose report columns the file has: which one, and which kind. */
export interface ReportMatch { provider: string; kind: ReportKind }

/** What the header of a CSV says it is, by the providers' files: a sales or fee report of exactly one of them, else nothing (a bank's CSV, an unknown export). */
export function recognizeReport(text: string, providers: ReadonlyArray<{ id: string; provider: Pick<ProviderFacts, 'reports'> }>): ReportMatch | undefined {
  const header = csvRows(text.slice(0, 8192))[0];
  if (!header) return undefined;
  const hits = providers.flatMap((p) => ([['sales', p.provider.reports.sales, SALES_NEEDS], ['fees', p.provider.reports.fees, FEE_NEEDS]] as const)
    .flatMap(([kind, columns, needs]) => (columns && 'at' in placeColumns(header, columns as Columns<string>, needs) ? [{ provider: p.id, kind }] : [])));
  return hits.length === 1 ? hits[0] : undefined;
}

/** An amount as an export writes it: 1234.50, 1'234.50, 1.234,50, EUR 12.00, -3.20; undefined for an empty cell or no number. */
export function amountOf(cell: string | undefined): number | undefined {
  const s = (cell ?? '').replace(/[^\d.,'’\-−]/g, '').replace('−', '-');
  if (!/\d/.test(s)) return undefined;
  const n = Number(s.replace(/[.,](\d{1,2})$/, 'D$1').replace(/[,'’.]/g, '').replace('D', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** A day as an export writes it: 2026-07-03, 2026-07-03 14:22:10 +0200, 2026-07-03T14:22:10Z, 03.07.2026; undefined for anything else. */
export function dayOf(cell: string | undefined): string | undefined {
  const s = (cell ?? '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s)?.[1];
  if (iso) return isIsoDate(iso) ? iso : undefined;
  const ch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (ch) { const d = `${ch[3]}-${ch[2].padStart(2, '0')}-${ch[1].padStart(2, '0')}`; return isIsoDate(d) ? d : undefined; }
  return undefined;
}

/** One order of a sales report, as code read it; amounts as the report writes them, refunds positive. */
export interface SaleRow { order: string; date: string; ordered?: string; shipTo?: string; gross: number; tax?: number; refunded: number; refundedAt?: string; currency?: string; gateway?: string }
/** One fee of a fee report, summed per order (or per day where the report names no order). */
export interface FeeRow { order?: string; date: string; fee: number; currency?: string }

/** A report read: its rows, and the rows code could not read (their line numbers, 1 = the header). */
export type ReadReport =
  | { kind: 'sales'; rows: SaleRow[]; unread: number[] }
  | { kind: 'fees'; rows: FeeRow[]; unread: number[] };

/**
 * The rows of a report of `kind` by the provider's columns. Rows of one order (a shop's export
 * writes one per line of the order, the order's figures on its first) make one: each field from the
 * first of its rows that has it. A row without an order, a day or a gross where it needs one is unread.
 */
export function readReport(text: string, kind: ReportKind, facts: Pick<ProviderFacts, 'reports' | 'gateways'>): ReadReport | { missing: string[] } {
  const [header, ...lines] = csvRows(text);
  const cell = (row: string[], i: number | undefined) => (i === undefined ? undefined : row[i]?.trim() || undefined);
  if (kind === 'sales') {
    // With gateways the report must say how each order was paid: else no order could be told from one paid elsewhere.
    const placed = placeColumns<SalesColumn>(header ?? [], facts.reports.sales ?? {}, facts.gateways?.length ? [...SALES_NEEDS, 'gateway'] : SALES_NEEDS);
    if ('missing' in placed) return { missing: placed.missing };
    const { at } = placed;
    const byOrder = new Map<string, { row: Partial<SaleRow>; lines: number[] }>();
    const unread: number[] = [];
    lines.forEach((row, k) => {
      const order = cell(row, at.order)?.replace(/^#/, '');
      if (!order) { unread.push(k + 2); return; }
      const o = byOrder.get(order) ?? byOrder.set(order, { row: { order }, lines: [] }).get(order)!;
      o.lines.push(k + 2);
      const r = o.row;
      r.date ??= dayOf(cell(row, at.date));
      r.ordered ??= dayOf(cell(row, at.ordered));
      r.shipTo ??= cell(row, at.shipTo)?.toUpperCase();
      r.gross ??= amountOf(cell(row, at.gross));
      r.tax ??= amountOf(cell(row, at.tax));
      r.refunded ??= amountOf(cell(row, at.refunded));
      r.refundedAt ??= dayOf(cell(row, at.refundedAt));
      r.currency ??= cell(row, at.currency)?.toUpperCase();
      r.gateway ??= cell(row, at.gateway);
    });
    const rows: SaleRow[] = [];
    for (const { row: r, lines: at2 } of byOrder.values()) {
      if (!r.date || r.gross === undefined) { unread.push(at2[0]); continue; }
      rows.push({ order: r.order!, date: r.date, gross: r.gross, refunded: Math.abs(r.refunded ?? 0), ...(r.ordered && { ordered: r.ordered }), ...(r.shipTo && { shipTo: r.shipTo }), ...(r.tax !== undefined && { tax: r.tax }), ...(r.refundedAt && { refundedAt: r.refundedAt }), ...(r.currency && { currency: r.currency }), ...(r.gateway && { gateway: r.gateway }) });
    }
    return { kind, rows, unread: unread.sort((a, b) => a - b) };
  }
  const placed = placeColumns<FeeColumn>(header ?? [], facts.reports.fees ?? {}, FEE_NEEDS);
  if ('missing' in placed) return { missing: placed.missing };
  const { at } = placed;
  const sums = new Map<string, FeeRow>();
  const unread: number[] = [];
  lines.forEach((row, k) => {
    const date = dayOf(cell(row, at.date));
    const fee = amountOf(cell(row, at.fee));
    if (!date || fee === undefined) { unread.push(k + 2); return; }
    if (fee === 0) return;
    const order = cell(row, at.order)?.replace(/^#/, '');
    const currency = cell(row, at.currency)?.toUpperCase();
    const key = `${order ?? date}|${currency ?? ''}`;
    const had = sums.get(key);
    // A fee as a provider writes it may carry a minus (money it keeps): what counts is how much.
    if (had) { had.fee = fromRappen(toRappen(had.fee) + toRappen(Math.abs(fee))); if (date > had.date) had.date = date; } else sums.set(key, { date, fee: Math.abs(fee), ...(order && { order }), ...(currency && { currency }) });
  });
  return { kind, rows: [...sums.values()], unread };
}

/** What the receipt of a report keeps of it: whose, which kind, the days it covers and how many orders or fees. */
export function reportFacts(provider: string, read: ReadReport): SalesReportFacts {
  const days = read.rows.map((r) => r.date).sort();
  return { provider, kind: read.kind, from: days[0] ?? '', to: days.at(-1) ?? '', rows: read.rows.length };
}

// ─── Booking it ──────────────────────────────────────────────────────────────

/** The ref of an order's sale, its refund, a fee: one each, so booking converges. */
export const saleRef = (provider: string, order: string): string => `SR-${provider}-${order}`;
export const refundRef = (provider: string, order: string): string => `SR-${provider}-${order}-refund`;
export const feeRef = (provider: string, key: string): string => `SF-${provider}-${key}`;
/** Whether a ref is one a sales or fee report booked. */
export const isReportRef = (ref: string): boolean => /^S[RF]-/.test(ref);

/** The rule a link of the report names (Mapping.rule). */
export const REPORT_LINK_RULE = 'sales-report';

/** A domestic sale code and the rate a tax column shows for it. */
export interface SaleCode { code: string; rate: number }

/** What the booking needs beside the books: the provider's accounts, the firm's codes and basis, the rates, the lock. */
export interface ReportContext {
  provider: { id: string; name: string };
  clearing: string;
  revenue: string;
  fees?: { account: string; vat?: string };
  /** The company's account for a foreign VAT an export order shows (ProviderFacts.foreignTax); absent: such an order waits. */
  foreignTax?: string;
  /** The report's receipt: every entry names it. */
  receipt: string;
  /** The books' currency; another one converts at `rate`, the official daily sell rate of the entry's day (ADR 0001). */
  base: string;
  rate: (currency: string, date: string) => number | undefined;
  /**
   * The domestic sale code at the normal rate, that rate, the codes of the other rates the firm's
   * form takes (a reduced rate), the export code, the minus; absent: the firm books no codes.
   */
  codes?: { domestic: string; rate: number; reduced?: readonly SaleCode[]; abroad?: string; negative: string };
  territory: readonly string[];
  /** The gateway column's values whose orders the provider collected (ProviderFacts.gateways); absent: every order. */
  gateways?: readonly string[];
  /** The company's cut-over day (ProviderFacts.since): from it on the provider's payouts settle the clearing account. */
  since: string;
  /**
   * The first day a row is booked: `since` less the provider's payout days, since a sale collected
   * that late may be paid out after the cut-over day, from the clearing account. Rows dated before it
   * are counted (`beforeSince`), never booked.
   */
  from: string;
  /**
   * What the books carry already from elsewhere. `entries`: entries on the clearing account no report
   * booked, of the report's kind (a sale onto it for a sales report, a fee off it for a fee report, and
   * their reversals): the entries naming one row only with its net amount book it (known); a row
   * another one names (by its ref, its text, or its day and amount) waits; one dated on or after
   * `since` that books no row of its own holds every row up to its day. `through`: the last day of a payout of the provider
   * on or after `since` booked otherwise than from the clearing account (it may hold every sale,
   * refund and fee up to its day): those wait too. `paidBefore`: the days of the provider's payouts
   * from `from` to before `since` not booked bank / clearing account (the old way, as sales, or not
   * booked yet): a row dated before `since` and before one of them may have been paid by it, so it
   * waits.
   */
  legacy?: { entries: readonly JournalEntry[]; through?: string; paidBefore?: readonly string[] };
  /** The agreed basis: the order's day is the tax point. */
  agreed: boolean;
  isClosed: (date: string) => boolean;
  beforeBooks: (date: string) => boolean;
  newId: () => string;
  /** The booking texts, in the books' language. */
  texts: ReportTexts;
}

export interface ReportTexts {
  sale(order: string, country: string | undefined): string;
  refund(order: string): string;
  /** The line of an export's foreign tax (its sale's or its refund's). */
  foreignTax(order: string, country: string | undefined): string;
  fee(key: string): string;
  reason(kind: 'domestic' | 'abroad' | 'foreignTax' | 'none' | 'refund' | 'fee', country: string | undefined): string;
}

/**
 * Why an order (or a fee) is not booked by code: its tax column disagrees with its delivery (`noTax`,
 * `rate`, Swiss VAT on an export `abroadTax`), a foreign VAT on an export without the company's
 * account for it (`foreignTax`), no country, its figures in the books differ, no rate of
 * its day, a refund without a day of its own (`refundDate`), or the clearing account carries a sale
 * from elsewhere that may be it (`legacy`).
 */
export interface ReportHold { order: string; why: 'noTax' | 'rate' | 'abroadTax' | 'foreignTax' | 'country' | 'changed' | 'noRate' | 'refundDate' | 'legacy' }

/** What a report booked and left: counts, the orders held with why, and the rows dated in a filed period or before the books. */
export interface ReportOutcome {
  orders: number;
  refunds: number;
  fees: number;
  /** Already in the books with the same figures. */
  known: number;
  /** The refs of those: the report names them too (src/intake/sales-report-import.ts). */
  knownRefs: string[];
  filed: number;
  before: number;
  /** Rows collected before `ReportContext.from` (the cut-over day less the payout days): booked the way they were, never by the report. */
  beforeSince: number;
  /** Those rows' orders (or fee keys), in the report's order: the drop row names them. */
  beforeSinceRows: string[];
  /** Orders the provider did not collect (their gateway none of its gateways), and those gateways as the report writes them. */
  other: number;
  ways: string[];
  held: ReportHold[];
  entries: JournalEntry[];
  links: Mapping[];
}

const TAX_SLACK = 0.02;

/** Whether an order's own tax shows `rate` on its gross, within two percent of the tax or 0.05. */
function showsRate(gross: number, tax: number, rate: number): boolean {
  const want = (gross * rate) / (100 + rate);
  return Math.abs(tax - want) <= Math.max(0.05, want * TAX_SLACK);
}

/** A gateway as a report may write it: «Shopify Payments», «shopify_payments». */
const gatewayKey = (g: string): string => g.trim().toLowerCase().replace(/[_\s]+/g, ' ');

/**
 * Whether the provider collected an order (and pays it out): every way it was paid is one of its
 * `gateways`; without gateways every order. Paid by PayPal, by bank transfer, on delivery, with a
 * gift card, through a test gateway, or partly so: not money the provider pays out.
 */
export function collectedBy(o: Pick<SaleRow, 'gateway'>, gateways: readonly string[] | undefined): boolean {
  if (!gateways?.length) return true;
  const collects = new Set(gateways.map(gatewayKey));
  const ways = (o.gateway ?? '').split(/\s*[+,]\s*/).map(gatewayKey).filter(Boolean);
  return ways.length > 0 && ways.every((w) => collects.has(w));
}

/**
 * The entries of `read` for the books `books`, by `ctx`. Pure: the caller pushes the entries and
 * links inside the write door. Each entry has origin 'classify' and names the check `payoutReport` (a check older builds keep).
 */
export function bookReport(books: { journalEntries: readonly JournalEntry[] }, read: ReadReport, ctx: ReportContext): ReportOutcome {
  const out: ReportOutcome = { orders: 0, refunds: 0, fees: 0, known: 0, knownRefs: [], filed: 0, before: 0, beforeSince: 0, beforeSinceRows: [], other: 0, ways: [], held: [], entries: [], links: [] };
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) if (isReportRef(e.transactionRef)) (byRef.get(e.transactionRef) ?? byRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  // The tax point decides whether a row lies in a filed period or before the books; the day the provider collected it whether a
  // payout from the clearing account can have paid it (`from`). On the cash basis they are one day; on the agreed basis an order
  // placed before `from` and collected after it is booked, on its own day.
  const dated = (taxPoint: string, collected = taxPoint): 'filed' | 'before' | 'beforeSince' | undefined => (ctx.beforeBooks(taxPoint) ? 'before' : ctx.isClosed(taxPoint) ? 'filed' : collected < ctx.from ? 'beforeSince' : undefined);
  const count = (where: 'filed' | 'before' | 'beforeSince', key: string) => { out[where]++; if (where === 'beforeSince') out.beforeSinceRows.push(key); };
  /** A row the books carry from elsewhere: an entry that names it books it already (known), any other match holds it. */
  const carried = (verdict: Legacy, key: string): boolean => {
    if (verdict === 'booked') out.known++;
    else if (verdict === 'held') out.held.push({ order: key, why: 'legacy' });
    return !!verdict;
  };
  const make = (ref: string, date: string, currency: string | undefined, line: Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'description'> & { vatCode?: string }, reason: string): JournalEntry | 'noRate' => {
    const foreign = currency && currency !== ctx.base ? currency : undefined;
    const rate = foreign ? ctx.rate(foreign, date) : undefined;
    if (foreign && rate === undefined) return 'noRate';
    const { vatCode, ...sides } = line;
    return {
      id: ctx.newId(), transactionRef: ref, date, ...sides, ...(vatCode ? { vatCode } : {}),
      ...(foreign ? { exchangeCurrency: foreign, exchangeRate: rate } : {}),
      origin: 'classify', receipts: [ctx.receipt], reason, by: { kind: 'code', check: 'payoutReport' },
    };
  };
  /** The entries the books carry under `ref`: the same lines (their amounts, one each) are known, other ones changed. */
  const known = (ref: string, amounts: readonly number[]): 'same' | 'changed' | undefined => {
    const had = byRef.get(ref);
    if (!had) return undefined;
    const key = (xs: readonly number[]) => xs.map(toRappen).sort((a, b) => a - b).join(',');
    return key(had.map((e) => e.amount)) === key(amounts) ? 'same' : 'changed';
  };
  const same = (ref: string) => { out.known++; out.knownRefs.push(ref); };
  const push = (ref: string, e: JournalEntry) => {
    out.entries.push(e);
    if (!out.links.some((m) => m.transactionRef === ref)) out.links.push({ transactionRef: ref, receiptId: ctx.receipt, by: 'rule', rule: REPORT_LINK_RULE });
    (byRef.get(ref) ?? byRef.set(ref, []).get(ref)!).push(e);
  };

  if (read.kind === 'fees') {
    const feeLegacy = legacyRows(read.rows.map((f) => ({ key: f.order ?? f.date, day: f.date, amount: f.fee })), ctx.legacy, ctx.since, (e) => e.accountDebit === ctx.clearing);
    for (const f of read.rows) {
      if (!ctx.fees) break;
      const key = f.order ?? f.date;
      // One order's fees in two currencies are two fees, each with its own ref.
      const ref = feeRef(ctx.provider.id, f.currency && f.currency !== ctx.base ? `${key}-${f.currency}` : key);
      const k = known(ref, [f.fee]);
      if (k === 'same') { same(ref); continue; }
      if (k === 'changed') { out.held.push({ order: key, why: 'changed' }); continue; }
      const where = dated(f.date);
      if (where) { count(where, key); continue; }
      if (carried(feeLegacy({ key, day: f.date, amount: f.fee }), key)) continue;
      const e = make(ref, f.date, f.currency, { accountDebit: ctx.fees.account, accountCredit: ctx.clearing, amount: f.fee, vatCode: ctx.fees.vat, description: ctx.texts.fee(key) }, ctx.texts.reason('fee', undefined));
      if (e === 'noRate') { out.held.push({ order: key, why: 'noRate' }); continue; }
      push(ref, e);
      out.fees++;
    }
    return out;
  }

  const taxDay = (o: SaleRow) => (ctx.agreed ? o.ordered ?? o.date : o.date);
  const rates: SaleCode[] = ctx.codes ? [{ code: ctx.codes.domestic, rate: ctx.codes.rate }, ...(ctx.codes.reduced ?? [])] : [];
  /** The foreign VAT an export shows (its tax column above zero at no Swiss rate): it is no revenue of the export (#206); else 0. */
  const foreignTaxOf = (o: SaleRow): number => (ctx.codes && o.shipTo && !ctx.territory.includes(o.shipTo) && o.tax !== undefined && o.tax > 0 && !rates.some((r) => showsRate(o.gross, o.tax!, r.rate)) ? o.tax : 0);
  /** What an order puts on the revenue account: its gross less a foreign VAT. */
  const netOf = (o: SaleRow): number => fromRappen(toRappen(o.gross) - toRappen(foreignTaxOf(o)));
  // What the books carry is matched by the day the provider collected the order: the day a payout pays it from; its revenue, as a sale onto the clearing account from elsewhere books it.
  const orderLegacy = legacyRows(read.rows.filter((o) => collectedBy(o, ctx.gateways)).map((o) => ({ key: o.order, day: o.date, amount: netOf(o) })), ctx.legacy, ctx.since, (e) => e.accountCredit === ctx.clearing);
  for (const o of read.rows) {
    // Its refund goes with it: an order the provider did not collect is refunded otherwise too.
    if (!collectedBy(o, ctx.gateways)) {
      out.other++;
      const said = o.gateway ?? '–';
      if (!out.ways.includes(said)) out.ways.push(said);
      continue;
    }
    const day = taxDay(o);
    const domestic = !!o.shipTo && ctx.territory.includes(o.shipTo);
    let code: string | undefined;
    let kind: 'domestic' | 'abroad' | 'none' = 'none';
    if (ctx.codes) {
      if (!o.shipTo) { out.held.push({ order: o.order, why: 'country' }); continue; }
      if (domestic) {
        if (o.tax !== undefined && o.tax <= 0) { out.held.push({ order: o.order, why: 'noTax' }); continue; }
        const at = o.tax === undefined ? rates[0] : rates.find((r) => showsRate(o.gross, o.tax!, r.rate));
        if (!at) { out.held.push({ order: o.order, why: 'rate' }); continue; }
        code = at.code;
        kind = 'domestic';
      } else {
        // Swiss VAT shown on an export is owed as shown (Art. 27 MWSTG): the person decides, never V0 over it.
        if (o.tax !== undefined && o.tax > 0 && rates.some((r) => showsRate(o.gross, o.tax!, r.rate))) { out.held.push({ order: o.order, why: 'abroadTax' }); continue; }
        // A foreign VAT (EU OSS) is owed abroad, no export turnover: without the company's account for it the order waits, never gross at V0.
        if (foreignTaxOf(o) > 0) {
          if (toRappen(o.tax!) >= toRappen(o.gross)) { out.held.push({ order: o.order, why: 'rate' }); continue; }
          if (!ctx.foreignTax) { out.held.push({ order: o.order, why: 'foreignTax' }); continue; }
        }
        code = ctx.codes.abroad;
        kind = 'abroad';
      }
    }
    const tax = foreignTaxOf(o);
    const net = netOf(o);
    const sale = saleRef(ctx.provider.id, o.order);
    const k = known(sale, tax ? [net, tax] : [o.gross]);
    if (k === 'changed') { out.held.push({ order: o.order, why: 'changed' }); continue; }
    if (k === 'same') same(sale);
    else {
      const where = dated(day, o.date);
      // A sale of a filed period is the person's to correct; its refund paid in the open period is still booked below.
      if (where) count(where, o.order);
      else {
        if (carried(orderLegacy({ key: o.order, day: o.date, amount: net }), o.order)) continue;
        const e = make(sale, day, o.currency, { accountDebit: ctx.clearing, accountCredit: ctx.revenue, amount: net, vatCode: code, description: ctx.texts.sale(o.order, o.shipTo) }, ctx.texts.reason(kind, o.shipTo));
        if (e === 'noRate') { out.held.push({ order: o.order, why: 'noRate' }); continue; }
        push(sale, e);
        if (tax) push(sale, make(sale, day, o.currency, { accountDebit: ctx.clearing, accountCredit: ctx.foreignTax!, amount: tax, description: ctx.texts.foreignTax(o.order, o.shipTo) }, ctx.texts.reason('foreignTax', o.shipTo)) as JournalEntry);
        out.orders++;
      }
    }
    if (o.refunded > 0) {
      const ref = refundRef(ctx.provider.id, o.order);
      // An export's refund gives back its foreign VAT in the sale's share, to the cent; the rest is the export's.
      const backTax = tax ? Math.min(toRappen(o.refunded), Math.round((toRappen(o.refunded) * toRappen(tax)) / toRappen(o.gross))) : 0;
      const backNet = fromRappen(toRappen(o.refunded) - backTax);
      const kr = known(ref, [backNet, ...(backTax ? [fromRappen(backTax)] : [])].filter((x) => x !== 0));
      if (kr === 'same') { same(ref); continue; }
      if (kr === 'changed') { out.held.push({ order: o.order, why: 'changed' }); continue; }
      // A refund is the day the money went back: without that day, or one before the sale, it waits, never on the order's day.
      const when = o.refundedAt;
      if (!when || when < day) { out.held.push({ order: o.order, why: 'refundDate' }); continue; }
      const where = dated(when);
      if (where) { count(where, o.order); continue; }
      // Held whenever its order is carried, also by an entry that books the order's sale: that entry books no refund.
      if (orderLegacy({ key: o.order, day: when, amount: o.refunded })) { out.held.push({ order: o.order, why: 'legacy' }); continue; }
      const e = make(ref, when, o.currency, { accountDebit: ctx.revenue, accountCredit: ctx.clearing, amount: backNet, vatCode: code ? `${ctx.codes!.negative}${code}` : undefined, description: ctx.texts.refund(o.order) }, ctx.texts.reason('refund', o.shipTo));
      if (e === 'noRate') { out.held.push({ order: o.order, why: 'noRate' }); continue; }
      if (backNet !== 0) push(ref, e);
      if (backTax) push(ref, make(ref, when, o.currency, { accountDebit: ctx.foreignTax!, accountCredit: ctx.clearing, amount: fromRappen(backTax), description: ctx.texts.foreignTax(o.order, o.shipTo) }, ctx.texts.reason('foreignTax', o.shipTo)) as JournalEntry);
      out.refunds++;
    }
  }
  return out;
}

/** Whether a ref ends in an order's name, as `SHOPIFY-1001` or `#1001` names order 1001. */
function namesOrder(ref: string, order: string): boolean {
  if (!ref.endsWith(order)) return false;
  const before = ref.charAt(ref.length - order.length - 1);
  return !before || !/[0-9A-Za-z]/.test(before);
}

/** Whether a booking text names an order, as «Shopify #1001» or «Bestellung 1001» names order 1001. */
function textNames(text: string | undefined, order: string): boolean {
  if (!text) return false;
  const at = text.indexOf(order);
  if (at < 0) return false;
  const edge = /[\p{L}\d]/u;
  return !edge.test(text.charAt(at - 1)) && !edge.test(text.charAt(at + order.length));
}

/** A row of a report as the legacy check sees it: its order (or fee key), its day (the day the provider collected it), its amount. */
interface LegacyRow { key: string; day: string; amount: number }

/** What the books carry of a row from elsewhere: `booked`, an entry that names it with its amount books it; `held`, it may be in an entry or a payout; none. */
type Legacy = 'booked' | 'held' | undefined;

/**
 * Which rows of a report the books may carry already from elsewhere (ReportContext.legacy). The
 * entries that name exactly one row's order (their ref ends in it, or their text names it) book that
 * row when their net amount is the row's (a person's own booking of that order, an older one per
 * order, less a reversal of it: `reversal` says which entries take back): the row is known, never
 * held again on the next taking. Every other entry holds: the rows it names (one with another net,
 * one naming several orders at once, whose sum books none of them alone), else the row of its day
 * and amount; and one on or after `since` that books no row of its own holds every row up to its
 * day, as a payout booked otherwise does up to `through`. One before `since` holds only the rows it
 * names or matches: the old way booked each sale onto the clearing account and paid it from there,
 * so another sale of those days is not on it yet. A row dated before `since` waits when a payout
 * before `since` not booked from the clearing account is dated after it (`paidBefore`): a payout
 * pays what was collected before its day.
 */
function legacyRows(rows: readonly LegacyRow[], legacy: ReportContext['legacy'], since: string, reversal: (e: JournalEntry) => boolean): (row: LegacyRow) => Legacy {
  if (!legacy) return () => undefined;
  const booked = new Set<string>();
  const named = new Set<string>();
  let through = legacy.through ?? '';
  const signed = (e: JournalEntry) => (reversal(e) ? -toRappen(e.amount) : toRappen(e.amount));
  const naming = legacy.entries.map((e) => ({ e, keys: [...new Set(rows.filter((x) => namesOrder(e.transactionRef, x.key) || textNames(e.description, x.key)).map((x) => x.key))] }));
  const own = new Map<string, JournalEntry[]>();
  for (const { e, keys } of naming) if (keys.length === 1) (own.get(keys[0]) ?? own.set(keys[0], []).get(keys[0])!).push(e);
  for (const [key, es] of own) {
    const row = rows.find((x) => x.key === key)!;
    if (es.reduce((s, e) => s + signed(e), 0) === toRappen(row.amount)) booked.add(key);
  }
  for (const { e, keys } of naming) {
    if (keys.length === 1 && booked.has(keys[0])) continue;
    for (const k of keys) named.add(k);
    const r = keys.length ? undefined : rows.find((x) => !named.has(x.key) && !booked.has(x.key) && x.day === e.date && toRappen(x.amount) === signed(e));
    if (r) named.add(r.key);
    else if (e.date >= since && e.date > through) through = e.date;
  }
  const paid = legacy.paidBefore ?? [];
  return (row) => (booked.has(row.key) ? 'booked' : named.has(row.key) || row.day <= through || (row.day < since && paid.some((d) => d > row.day)) ? 'held' : undefined);
}

// ─── Export proof: order documents to their sale ─────────────────────────────

/**
 * Order documents linked to the sale a sales report booked for their order (#203 4): an order page
 * or a shipping document whose facts name the order (Receipt.order.number) proves where the goods
 * went, so it goes with the sale, never with the payout. The order is the rest of a sale's ref after
 * its provider's `SR-<id>-` (an order name may hold a dash); a sale is the entry onto the provider's
 * clearing account, a refund the one off it. A sale of a filed period gets no new link.
 */
export function linkOrdersToSales(
  books: { receipts: readonly Receipt[]; mappings: Mapping[]; journalEntries: readonly JournalEntry[] },
  isOpen: (date: string) => boolean,
  providers: ReadonlyArray<{ id: string; provider: Pick<ProviderFacts, 'clearing'> }>,
): Array<{ receipt: string; sale: string }> {
  const sales = new Map<string, string[]>();
  for (const p of providers) {
    const prefix = `SR-${p.id}-`;
    for (const e of books.journalEntries) {
      if (!p.provider.clearing || !e.transactionRef.startsWith(prefix) || e.accountDebit !== p.provider.clearing || !isOpen(e.date)) continue;
      const order = e.transactionRef.slice(prefix.length);
      const refs = sales.get(order) ?? sales.set(order, []).get(order)!;
      if (!refs.includes(e.transactionRef)) refs.push(e.transactionRef);
    }
  }
  const made: Array<{ receipt: string; sale: string }> = [];
  for (const r of books.receipts) {
    const number = r.order?.number.replace(/^#/, '');
    if (!number || r.kind === 'duplicate') continue;
    const refs = sales.get(number);
    if (refs?.length !== 1 || books.mappings.some((m) => m.receiptId === r.id)) continue;
    books.mappings.push({ transactionRef: refs[0], receiptId: r.id, by: 'rule', rule: REPORT_LINK_RULE });
    made.push({ receipt: r.id, sale: refs[0] });
  }
  return made;
}
