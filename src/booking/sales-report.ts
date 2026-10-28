/**
 * A payment provider's sales report booked onto its clearing account (#203). The provider's own
 * export for a period (a CSV: one row per order, or per line of an order) names each order's day,
 * delivery country, gross, tax and refunds; its fee export each charge's fee. Code reads both by the
 * columns the provider's file names (src/knowledge/provider.ts) and books:
 *
 *   each order      clearing / revenue   gross, the domestic sale code for a delivery into the VAT
 *                                        territory, the export code for one abroad
 *                   clearing / revenue   an export whose tax column shows a foreign VAT (IOSS, for example):
 *                   clearing / foreign   the net at the export code, the tax onto the company's
 *                                        account for foreign tax without a code (#206)
 *   each refund     revenue / clearing   its amount, the sale's code with the minus (an export with
 *                                        foreign VAT split as its sale: the tax share off the account)
 *   each fee        fees / clearing      the provider's fee, the company's fee code, each charge's on its
 *                                        day (#242: the first under the order's ref, later ones -charge-<day>)
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
 * onto the clearing account, nor is one its test column flags. A refund is dated by the day the money
 * went back: the sales report's own refund day where its file names that column, else the refund rows
 * of the provider's payments exports in the books (#214), each day its own entry, split as its sale. A
 * refund without its day is never dated on the order's day: it waits, and an order not booked yet waits
 * with it, so a refunded order is never booked as a sale alone; refunds dated beyond the refunded amount
 * (or the gross) hold it too. An order not booked yet of a day strictly inside the days a payments
 * export's charges cover (neither its first nor its last: an export may be cut mid-day, or hold one
 * payout of several of a day) that no row of it names was never collected (a test-mode order): it
 * waits. A sale booked already is never taken back by code: such an order is named (`unpaid`) and the
 * person is asked. Each drop of either report takes the sales reports again
 * (src/intake/sales-report-import.ts), so a held order is booked once its refund has a day. What the
 * books carry already from elsewhere holds
 * what it may be (`ReportContext.legacy`): sales on the clearing account that name one order only (an
 * older booking per order, a person's own, less a reversal of it) with its amount in all book it, so
 * the order is known and never held again; with another amount, or naming several orders in one
 * entry, they hold only the orders they name (#242); one that names none and corrects no filed period, and a
 * payout of the provider booked otherwise than from the clearing account (as sales), hold every order, refund
 * and fee up to their day; so nothing counts twice.
 *
 * An order edited after checkout (#231) was charged its total less its outstanding balance: that is its
 * gross, its tax in the same share (a foreign VAT too); a balance below zero (charged a cent beyond the
 * total, #239) makes it more. With the payments exports' charges of an order in, they must add up to that
 * gross within a cent (booked at the charges, the reason says so), else the order waits (`charges`), never
 * booked with the difference; an order of a filed period charged there is counted as filed first. On
 * the cash basis each day charged is a part of its own on its day (the first keeps the sale's ref, the
 * later ones SR-<provider>-<order>-charge-<day>), so a balance charged in a later period is booked then. A sale the app booked in
 * one before its charges were known, in the open period, whose charges fall on other days is split onto them once they are in
 * (#242: `replaced`, all parts or none), so the order of the drops never moves a sale into another period; a person's, a filed
 * one, one a person linked a receipt to, or one a part of which cannot be booked stays as booked. Without charges a
 * balance charged later (the report's gross grown beyond the parts the books carry, its day after them)
 * is booked as a part of its own on the report's day. A refund paid in a filed period that the books
 * never carried, of a sale they carry, is never booked by code: it is named (`filedRefunds`) and booked
 * on the person's click (ReportContext.correct) in the open period with `corrects` (golden rule 1); so is
 * one whose sale an entry from elsewhere books alone with its amount. One whose sale sits in an old entry
 * naming it beside other orders or with another amount (a payout entry, which may net the refund) is
 * named for the person to book by hand (`byHand`, #239), never booked on a click. One an entry of the books carries
 * already, wherever it is (#242: on revenue or fees, paid from the bank directly, netted into its sale), is named with
 * where it is booked (`booked`), never offered. A filed order whose refunds are all filed too is counted as filed, never
 * held for refunds beyond what it says (#242).
 * Browser-safe apart from the engines' globals.
 */
import type { JournalEntry, Mapping, Receipt, SalesReportFacts } from '../types/index.js';
import type { Columns, FeeColumn, ProviderFacts, ReportKind, SalesColumn } from '../knowledge/provider.js';
import { FEE_NEEDS, SALES_NEEDS } from '../knowledge/provider.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { addDays, isIsoDate } from '../accounting/periods.js';

/**
 * The VAT code of an export's foreign tax line: none, the foreign VAT stays out of the return (owner
 * decision 2026-10-27, #206). The one place to give the line a code, should that change (its refund
 * takes the code's minus).
 */
const FOREIGN_TAX_CODE: string | undefined = undefined;

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

/** Whether a test column flags its row: true, yes, ja, oui, sì, 1, test, x. */
const flagged = (cell: string | undefined): boolean => /^(true|yes|ja|oui|si|sì|1|test|x)$/i.test((cell ?? '').trim());

/**
 * One order of a sales report, as code read it; amounts as the report writes them, refunds positive; `test`: its test column flags it.
 * `gross` is what was charged: the total less an `outstanding` balance (an order edited after checkout, #231; below zero, charged
 * beyond the total, #239), `tax` in the same share.
 */
export interface SaleRow { order: string; date: string; ordered?: string; shipTo?: string; gross: number; tax?: number; outstanding?: number; refunded: number; refundedAt?: string; currency?: string; gateway?: string; test?: boolean }
/** One fee of a fee report, summed per order and day (per day where the report names no order, #242). */
export interface FeeRow { order?: string; date: string; fee: number; currency?: string }
/** One refund of a payments export: its order, the day the money went back, how much (positive), its currency. */
export interface RefundRow { order: string; date: string; amount: number; currency?: string }
/** One charge of a payments export (#231): its order, the day the provider charged the customer, how much (positive), its currency. */
export type ChargeRow = RefundRow;
/**
 * What one payments export says beside its fees (#214), when it names each row's order: the first and
 * last day of its charges (`from` to `to`, its rows that name an order and are no refund of any kind;
 * none in an export of refunds only), the orders a row names (the provider has a transaction for them:
 * a test-mode order has none), and each refund row (its `type` is exactly «refund», not «refund_failure»
 * or the like) with its day and amount; with an amount column each charge row (its `type` exactly
 * «charge») too (#231).
 */
export interface PaymentRows { from?: string; to?: string; orders: string[]; refunds: RefundRow[]; charges?: ChargeRow[] }

/** A report read: its rows, and the rows code could not read (their line numbers, 1 = the header). */
export type ReadReport =
  | { kind: 'sales'; rows: SaleRow[]; unread: number[] }
  | { kind: 'fees'; rows: FeeRow[]; unread: number[]; payments?: PaymentRows };

/**
 * The provider's payments exports as one (#214): whether a day lies strictly inside the days one's
 * charges cover (`inside`: not its first or last day, which an export cut mid-day or holding one payout
 * of several may cover only partly), the orders they name, and each order's refunds. Exports that
 * overlap name the same rows: a refund counts as often as the export that names it most often does, so
 * overlapping exports never refund an order twice.
 */
export interface PaymentFacts { inside(day: string): boolean; orders: ReadonlySet<string>; refunds: ReadonlyMap<string, readonly RefundRow[]>; charges: ReadonlyMap<string, readonly ChargeRow[]> }

/** Rows of several exports per order, each counted as often as the export that names it most often does: overlapping exports name a row once. */
function perOrder(lists: ReadonlyArray<readonly RefundRow[]>): Map<string, RefundRow[]> {
  const most = new Map<string, { row: RefundRow; n: number }>();
  for (const list of lists) {
    const seen = new Map<string, number>();
    for (const r of list) {
      const key = `${r.order}|${r.date}|${toRappen(r.amount)}|${r.currency ?? ''}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if ((most.get(key)?.n ?? 0) < n) most.set(key, { row: r, n });
    }
  }
  const out = new Map<string, RefundRow[]>();
  for (const { row, n } of most.values()) for (let i = 0; i < n; i++) (out.get(row.order) ?? out.set(row.order, []).get(row.order)!).push(row);
  return out;
}

/** The payments exports `of` as one; none when none names its rows' orders. */
export function paymentFacts(of: ReadonlyArray<PaymentRows | undefined>): PaymentFacts | undefined {
  const all = of.filter((p): p is PaymentRows => !!p);
  if (!all.length) return undefined;
  return {
    inside: (day) => all.some((p) => !!p.from && !!p.to && p.from < day && day < p.to), orders: new Set(all.flatMap((p) => p.orders)),
    refunds: perOrder(all.map((p) => p.refunds)), charges: perOrder(all.map((p) => p.charges ?? [])),
  };
}

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
      r.outstanding ??= amountOf(cell(row, at.outstanding));
      r.refunded ??= amountOf(cell(row, at.refunded));
      r.refundedAt ??= dayOf(cell(row, at.refundedAt));
      r.currency ??= cell(row, at.currency)?.toUpperCase();
      r.gateway ??= cell(row, at.gateway);
      if (flagged(cell(row, at.test))) r.test = true;
    });
    const rows: SaleRow[] = [];
    for (const { row: r, lines: at2 } of byOrder.values()) {
      if (!r.date || r.gross === undefined) { unread.push(at2[0]); continue; }
      // An order edited after checkout: only the total less its outstanding balance was charged, its tax in the same share (#231).
      // A balance below zero is what was charged beyond the total (a cent of a currency's rounding, #239): the gross is more.
      const open = r.outstanding !== undefined && toRappen(r.outstanding) !== 0 ? r.outstanding : 0;
      const gross = open ? fromRappen(toRappen(r.gross) - toRappen(open)) : r.gross;
      const tax = open && r.tax !== undefined && toRappen(r.gross) > 0 ? fromRappen(Math.round((toRappen(r.tax) * toRappen(gross)) / toRappen(r.gross))) : r.tax;
      rows.push({ order: r.order!, date: r.date, gross, refunded: Math.abs(r.refunded ?? 0), ...(r.ordered && { ordered: r.ordered }), ...(r.shipTo && { shipTo: r.shipTo }), ...(tax !== undefined && { tax }), ...(open && { outstanding: open }), ...(r.refundedAt && { refundedAt: r.refundedAt }), ...(r.currency && { currency: r.currency }), ...(r.gateway && { gateway: r.gateway }), ...(r.test && { test: true }) });
    }
    return { kind, rows, unread: unread.sort((a, b) => a - b) };
  }
  const placed = placeColumns<FeeColumn>(header ?? [], facts.reports.fees ?? {}, FEE_NEEDS);
  if ('missing' in placed) return { missing: placed.missing };
  const { at } = placed;
  const sums = new Map<string, FeeRow>();
  const unread: number[] = [];
  // With the order column the export says which orders the provider has a transaction for, and on which day each refund went back.
  const days: string[] = [];
  const orders = new Set<string>();
  const refunds: RefundRow[] = [];
  const charges: ChargeRow[] = [];
  lines.forEach((row, k) => {
    // A test transaction is none: no fee, no payment, no refund.
    if (flagged(cell(row, at.test))) return;
    const date = dayOf(cell(row, at.date));
    const order = cell(row, at.order)?.replace(/^#/, '');
    const currency = cell(row, at.currency)?.toUpperCase();
    let refund = false;
    let unreadCharge = false;
    if (date && at.order !== undefined && order) {
      orders.add(order);
      const type = norm(cell(row, at.type) ?? '');
      // The charges' days say which days the export covers: no refund of any kind (a refund_failure, say) widens them.
      if (!type.includes('refund')) days.push(date);
      if (type === 'refund') {
        const amount = amountOf(cell(row, at.amount));
        // A refund whose amount code cannot read is unread: its order's refund then has no day, and its sale waits.
        if (amount === undefined) { unread.push(k + 2); return; }
        if (amount !== 0) refunds.push({ order, date, amount: Math.abs(amount), ...(currency && { currency }) });
        refund = true;
      }
      // A charge on its own day (#231): an order's charges add up to what its sale books.
      if (type === 'charge' && at.amount !== undefined) {
        const amount = amountOf(cell(row, at.amount));
        // Unread, the order's charges fall short of its sale: it waits, never booked with the difference.
        if (amount === undefined) { unread.push(k + 2); unreadCharge = true; } else if (amount !== 0) charges.push({ order, date, amount: Math.abs(amount), ...(currency && { currency }) });
      }
    }
    const fee = amountOf(cell(row, at.fee));
    if (!date || fee === undefined) { if (!refund && !unreadCharge) unread.push(k + 2); return; }
    if (fee === 0) return;
    // Each charge's fee on its own day (#242): an order charged on two days has a fee on each.
    const key = `${order ?? ''}|${date}|${currency ?? ''}`;
    const had = sums.get(key);
    // A fee as a provider writes it may carry a minus (money it keeps): what counts is how much.
    if (had) had.fee = fromRappen(toRappen(had.fee) + toRappen(Math.abs(fee))); else sums.set(key, { date, fee: Math.abs(fee), ...(order && { order }), ...(currency && { currency }) });
  });
  days.sort();
  return { kind, rows: [...sums.values()], unread, ...(at.order !== undefined && orders.size ? { payments: { ...(days.length ? { from: days[0], to: days.at(-1)! } : {}), orders: [...orders], refunds, ...(charges.length ? { charges } : {}) } } : {}) };
}

/** What the receipt of a report keeps of it: whose, which kind, the days it covers (a payments export's refunds' too) and how many orders or fees. */
export function reportFacts(provider: string, read: ReadReport): SalesReportFacts {
  const days = [...read.rows.map((r) => r.date), ...(read.kind === 'fees' ? read.payments?.refunds.map((r) => r.date) ?? [] : [])].sort();
  return { provider, kind: read.kind, from: days[0] ?? '', to: days.at(-1) ?? '', rows: read.rows.length };
}

// ─── Booking it ──────────────────────────────────────────────────────────────

/** The ref of an order's sale, its refund, a fee: one each, so booking converges. */
export const saleRef = (provider: string, order: string): string => `SR-${provider}-${order}`;
export const refundRef = (provider: string, order: string): string => `SR-${provider}-${order}-refund`;
/** The ref of a later part of an order's sale, charged on `date` (#231): the first part keeps the sale's own ref. */
export const salePartRef = (sale: string, date: string): string => `${sale}-charge-${date}`;
/** The ref of the correction of an order's refund paid on `date` in a filed period (#231): always with its day. */
export const refundCorrectionRef = (provider: string, order: string, date: string): string => `${refundRef(provider, order)}-${date}`;
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
   * waits. `named`: sales booked elsewhere than on the clearing account no report booked (a payout
   * booked as sales, its text naming orders): they hold no row; they only name a refund of a filed
   * period whose sale sits in one of them to the person (FiledRefund.byHand, #239).
   */
  legacy?: { entries: readonly JournalEntry[]; through?: string; paidBefore?: readonly string[]; named?: readonly JournalEntry[] };
  /**
   * The provider's payments exports in the books (#214): a refund is dated by its refund rows; an order
   * not booked yet of a day strictly inside one's charges that no row names was never collected (a
   * test-mode order) and waits. Absent: a refund needs the sales report's own day (`refundedAt`), and
   * every order the gateway names counts as collected.
   */
  payments?: PaymentFacts;
  /** The company's money accounts (its banks and cash): a refund paid from one directly is booked (#242). */
  moneyAccounts?: readonly string[];
  /** The agreed basis: the order's day is the tax point. */
  agreed: boolean;
  /**
   * The person's click on a refund paid in a filed period the books never carried (#231): that refund
   * (its order and its day) is booked on `on`, a day of the open period, with `corrects` (golden rule 1),
   * as the person's (`at`), its text `text`; every other row as without it.
   */
  correct?: { order: string; date: string; on: string; corrects: string; at: string; text: string };
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
  /** What a sale's reason adds when it is booked at its charges, a cent beside what the sales report says was charged (#239). */
  cent?(charged: number, gross: number): string;
  reason(kind: 'domestic' | 'abroad' | 'foreignTax' | 'none' | 'refund' | 'fee', country: string | undefined): string;
}

/**
 * Why an order (or a fee) is not booked by code: its tax column disagrees with its delivery (`noTax`,
 * `rate`, Swiss VAT on an export `abroadTax`), a foreign VAT on an export without the company's
 * account for it (`foreignTax`), no country, its figures in the books differ, no rate of
 * its day, a refund without a day of its own (`refundDate`: its sale waits with it), refunds dated beyond
 * the refunded amount or the gross (`refundMismatch`), no transaction in a payments export whose charges
 * cover its day on both sides (`noPayment`: a test-mode order, not booked yet), the clearing account
 * carries a sale from elsewhere that may be it (`legacy`), or the payments exports' charges of the order
 * do not add up to what was charged by the sales report, its total less its outstanding balance (`charges`, #231).
 */
export interface ReportHold { order: string; why: 'noTax' | 'rate' | 'abroadTax' | 'foreignTax' | 'country' | 'changed' | 'noRate' | 'refundDate' | 'refundMismatch' | 'noPayment' | 'legacy' | 'charges' }

/**
 * A refund paid in a filed period whose sale the books carry and which they never carried (#231): offered
 * as a correction in the open period. `byHand` (#239): its sale sits in an entry no report booked that
 * names it beside other orders, or with another amount (an old payout entry): that entry may net the
 * refund already, so code offers no booking; the person checks it and books the correction by hand.
 * `booked` (#242): an entry of the books carries the refund already (ReportOutcome bookedRefund): named with
 * where, never offered.
 */
export interface FiledRefund { order: string; date: string; amount: number; currency?: string; byHand?: true; booked?: RefundBooked }

/** Where the books carry a refund of a filed period already (#242): the entry, its day and its ref; nothing is offered for it. */
export interface RefundBooked { entry: string; date: string; ref: string }

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
  /** Orders the report's test column flags: no sale, never booked. */
  test: number;
  held: ReportHold[];
  /**
   * Orders whose sale the books carry already though a payments export whose charges cover their day on
   * both sides names no transaction of them (#214): the sale stays as booked, the person is asked.
   */
  unpaid: string[];
  /**
   * The refs of the report's own refunds (the app's, of the open period) that no refund day the sales
   * report or the payments exports give now matches: a payments export they were dated from is gone.
   * Only the person's «Rückgängig» of that export takes them back (src/intake/sales-report-import.ts).
   */
  stale: string[];
  /** Refunds paid in a filed period the books never carried, of sales they carry: the person may book each as a correction (ReportContext.correct). */
  filedRefunds: FiledRefund[];
  /** The refs of the corrections booked on the person's click (ReportContext.correct). */
  corrected: string[];
  /**
   * The ids of the app's own one-sum sales of the open period that `entries` split per charge day (#242): the caller takes
   * them out as it pushes the entries, so the sale is never in the books twice nor lost. Never a person's, a filed or a linked one.
   */
  replaced: string[];
  entries: JournalEntry[];
  links: Mapping[];
}

const TAX_SLACK = 0.02;
/** How far, in hundredths, an order's charges may lie from what its sales report says was charged: a cent of rounding, booked at the charges (#239). */
const CHARGE_SLACK = 1;

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
export function bookReport(books: { journalEntries: readonly JournalEntry[]; mappings?: readonly Mapping[] }, read: ReadReport, ctx: ReportContext): ReportOutcome {
  const out: ReportOutcome = { orders: 0, refunds: 0, fees: 0, known: 0, knownRefs: [], filed: 0, before: 0, beforeSince: 0, beforeSinceRows: [], other: 0, ways: [], test: 0, held: [], unpaid: [], stale: [], filedRefunds: [], corrected: [], replaced: [], entries: [], links: [] };
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
    else if (verdict) out.held.push({ order: key, why: 'legacy' });
    return !!verdict;
  };
  /** An entry of the report on `date`, converted at the rate of `rateDay` (the day the money moved: a correction is dated later). */
  const make = (ref: string, date: string, currency: string | undefined, line: Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'description'> & { vatCode?: string }, reason: string, rateDay = date): JournalEntry | 'noRate' => {
    const foreign = currency && currency !== ctx.base ? currency : undefined;
    const rate = foreign ? ctx.rate(foreign, rateDay) : undefined;
    if (foreign && rate === undefined) return 'noRate';
    const { vatCode, ...sides } = line;
    return {
      id: ctx.newId(), transactionRef: ref, date, ...sides, ...(vatCode ? { vatCode } : {}),
      ...(foreign ? { exchangeCurrency: foreign, exchangeRate: rate } : {}),
      origin: 'classify', receipts: [ctx.receipt], reason, by: { kind: 'code', check: 'payoutReport' },
    };
  };
  /**
   * The entries the books carry under `ref` against the lines a row books: one line is known when any
   * entry has its amount (as the app's line beside a person's Storno and rebooking of it leaves it);
   * two lines (an export split by its foreign tax) only when the entries are exactly those lines, so a
   * line edited or missing is changed, never booked again beside it.
   */
  const known = (ref: string, amounts: readonly number[]): 'same' | 'changed' | undefined => {
    const had = byRef.get(ref);
    if (!had) return undefined;
    if (amounts.length === 1) return had.some((e) => toRappen(e.amount) === toRappen(amounts[0])) ? 'same' : 'changed';
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
    if (!ctx.fees) return out;
    const fees = ctx.fees;
    // One order's fees in two currencies are two fees, each with its own ref; each day it was charged a part of its own (#242).
    const groups = new Map<string, FeeRow[]>();
    for (const f of read.rows) {
      const key = f.order ?? f.date;
      const id = f.currency && f.currency !== ctx.base ? `${key}-${f.currency}` : key;
      (groups.get(id) ?? groups.set(id, []).get(id)!).push(f);
    }
    const sumOf = (fs: readonly FeeRow[]) => fromRappen(fs.reduce((sum, f) => sum + toRappen(f.fee), 0));
    // What the books carry from elsewhere is matched per order, its fees summed on its last day: a person's entry books them in one.
    const legacyRow = (fs: readonly FeeRow[]): LegacyRow => ({ key: fs[0].order ?? fs[0].date, day: fs.map((f) => f.date).sort().at(-1)!, amount: sumOf(fs) });
    const feeLegacy = legacyRows([...groups.values()].map(legacyRow), ctx.legacy, ctx.since, (e) => e.accountDebit === ctx.clearing);
    for (const [id, fs] of groups) {
      const key = fs[0].order ?? fs[0].date;
      const ref = feeRef(ctx.provider.id, id);
      const parts = [...fs].sort((a, b) => a.date.localeCompare(b.date)).map((f, i) => ({ ref: i ? salePartRef(ref, f.date) : ref, f }));
      const carriedRefs = [...byRef.keys()].filter((r) => (r === ref || r.startsWith(`${ref}-charge-`)) && byRef.get(r)!.length);
      const states = parts.map((p) => known(p.ref, [p.f.fee]));
      const allSame = states.every((k) => k === 'same') && carriedRefs.every((r) => parts.some((p) => p.ref === r));
      // Booked in one on the last day before each charge's fee had its own (#242): it stays as booked.
      if (!allSame && parts.length > 1 && carriedRefs.length === 1 && carriedRefs[0] === ref && known(ref, [sumOf(fs)]) === 'same') { same(ref); continue; }
      if (!allSame && (states.some((k) => k === 'changed') || carriedRefs.some((r) => !parts.some((p) => p.ref === r)))) { out.held.push({ order: key, why: 'changed' }); continue; }
      let verdict: Legacy | 'none' | undefined;
      for (const [i, { ref: pref, f }] of parts.entries()) {
        if (states[i] === 'same') { same(pref); continue; }
        const where = dated(f.date);
        if (where) { count(where, key); continue; }
        verdict ??= feeLegacy(legacyRow(fs)) ?? 'none';
        if (verdict !== 'none') { carried(verdict, key); break; }
        const e = make(pref, f.date, f.currency, { accountDebit: fees.account, accountCredit: ctx.clearing, amount: f.fee, vatCode: fees.vat, description: ctx.texts.fee(key) }, ctx.texts.reason('fee', undefined));
        if (e === 'noRate') { out.held.push({ order: key, why: 'noRate' }); break; }
        push(pref, e);
        out.fees++;
      }
    }
    return out;
  }

  const taxDay = (o: SaleRow) => (ctx.agreed ? o.ordered ?? o.date : o.date);
  const rates: SaleCode[] = ctx.codes ? [{ code: ctx.codes.domestic, rate: ctx.codes.rate }, ...(ctx.codes.reduced ?? [])] : [];
  /** The foreign VAT an export shows (its tax column above zero at no Swiss rate): it is no revenue of the export (#206); else 0. */
  const foreignTaxOf = (o: SaleRow): number => (ctx.codes && o.shipTo && !ctx.territory.includes(o.shipTo) && o.tax !== undefined && o.tax > 0 && !rates.some((r) => showsRate(o.gross, o.tax!, r.rate)) ? o.tax : 0);
  /** What an order puts on the revenue account: its gross less a foreign VAT. */
  const netOf = (o: SaleRow): number => fromRappen(toRappen(o.gross) - toRappen(foreignTaxOf(o)));
  /**
   * An export the books carry under its sale ref the way before #206: one line, its gross at the export
   * code, foreign tax and all. It stays as booked (the app never books an entry again, filed or not):
   * the sale is known, and its refund is booked the same way, gross at the export code's minus.
   */
  const bookedWhole = (ref: string, o: SaleRow): boolean => {
    const had = byRef.get(ref);
    return had?.length === 1 && toRappen(had[0].amount) === toRappen(o.gross) && had[0].vatCode === ctx.codes?.abroad;
  };
  // What the books carry is matched by the day the provider collected the order: the day a payout pays it from; its revenue, as a sale onto the clearing account from elsewhere books it.
  // An export with a foreign tax also by its gross on that day: an entry from elsewhere booked it so before #206.
  /** Whether a sale booked elsewhere than on the clearing account names an order in its text (ReportContext.legacy.named). */
  const namedElsewhere = (order: string): boolean => !!ctx.legacy?.named?.some((e) => textNames(e.description, order));
  const reportOrders = new Set(read.rows.map((o) => o.order));
  const saleCodes = ctx.codes ? [ctx.codes.domestic, ...(ctx.codes.reduced ?? []).map((r) => r.code), ...(ctx.codes.abroad ? [ctx.codes.abroad] : [])] : [];
  /** Whether a code is a sale code's minus: a refund of a sale. */
  const refundCode = (c: string | undefined): boolean => !!c && !!ctx.codes && c.startsWith(ctx.codes.negative) && saleCodes.includes(c.slice(ctx.codes.negative.length));
  const near = (a: number, b: number) => Math.abs(toRappen(a) - toRappen(b)) <= 1;
  /**
   * Where the books carry a refund of a filed period already (#242), so the person is never offered a click that counts it twice
   * (the report's own refund of it, or its correction, is known by its ref): an entry naming the order (its ref or text, and no
   * other order of the report) with the refund's amount (± a cent) that takes revenue back (a sale code's minus, onto revenue or
   * fees, or paid from a money account directly), or a sale of it booked at its gross less the refund (netted); an entry naming no
   * order with that amount at a sale code's minus or onto revenue, of the refund's days (a week either side) or a correction dated
   * after it. The report's own entries never count. One naming the order first, else the first; each entry is the refund of one
   * refund only (`claimed`), so two refunds of one amount never point at one entry.
   */
  const claimed = new Set<string>();
  const bookedRefund = (o: SaleRow, sale: string, when: string, amount: number): JournalEntry | undefined => {
    const parts = new Set(saleRefsOf(sale));
    const money = new Set(ctx.moneyAccounts ?? []);
    const takesBack = (e: JournalEntry) => refundCode(e.vatCode) || e.accountDebit === ctx.revenue || (!!ctx.fees && e.accountDebit === ctx.fees.account) || (money.has(e.accountCredit) && e.accountDebit !== ctx.clearing);
    const lo = addDays(when, -7);
    const hi = addDays(when, 7);
    const open = books.journalEntries.flatMap((e) => {
      if (claimed.has(e.id) || parts.has(e.transactionRef) || isReportRef(e.transactionRef)) return [];
      const names = [...reportOrders].filter((x) => namesOrder(e.transactionRef, x) || textNames(e.description, x));
      return names.length > 1 || (names.length === 1 && names[0] !== o.order) ? [] : [{ e, named: names.length === 1 }];
    });
    const hit = open.find(({ e, named }) => named && ((near(e.amount, amount) && takesBack(e)) || (e.accountCredit === ctx.revenue && !refundCode(e.vatCode) && (near(e.amount, o.gross - amount) || near(e.amount, netOf(o) - amount)))))
      ?? open.find(({ e, named }) => !named && near(e.amount, amount) && (refundCode(e.vatCode) || e.accountDebit === ctx.revenue) && ((e.date >= lo && e.date <= hi) || (!!e.corrects && e.date >= when)));
    if (hit) claimed.add(hit.e.id);
    return hit?.e;
  };
  const orderLegacy = legacyRows(read.rows.filter((o) => collectedBy(o, ctx.gateways)).map((o) => ({ key: o.order, day: o.date, amount: netOf(o), ...(foreignTaxOf(o) ? { gross: o.gross } : {}) })), ctx.legacy, ctx.since, (e) => e.accountCredit === ctx.clearing);
  /**
   * The refunds of an order, each on the day the money went back: the sales report's own day
   * (`refundedAt`) for the whole refunded amount, else the payments exports' refund rows, summed per
   * day. `undated`: some of it has no day (the rows fall short of the refunded amount, or name another
   * currency), or a day before the sale's: that part waits, and an order not booked yet waits with it.
   * `exceeds`: the refund rows give back more than the refunded amount (a refund the order export says
   * is none among them), or the refunded amount is more than the gross: nothing of it is booked.
   */
  const refundsOf = (o: SaleRow, day: string): { events: Array<{ date: string; amount: number }>; undated: boolean; exceeds: boolean } => {
    if (toRappen(o.refunded) > toRappen(o.gross)) return { events: [], undated: false, exceeds: true };
    if (o.refundedAt) return o.refunded > 0 ? (o.refundedAt < day ? { events: [], undated: true, exceeds: false } : { events: [{ date: o.refundedAt, amount: o.refunded }], undated: false, exceeds: false }) : { events: [], undated: false, exceeds: false };
    const sums = new Map<string, number>();
    let undated = false;
    let all = 0;
    for (const r of ctx.payments?.refunds.get(o.order) ?? []) {
      if (!r.currency || !o.currency || r.currency === o.currency) all += toRappen(r.amount);
      if ((r.currency && o.currency && r.currency !== o.currency) || r.date < day) { undated = true; continue; }
      sums.set(r.date, (sums.get(r.date) ?? 0) + toRappen(r.amount));
    }
    if (all > toRappen(o.refunded)) return { events: [], undated: false, exceeds: true };
    const events = [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([date, rp]) => ({ date, amount: fromRappen(rp) }));
    if (events.reduce((sum, e) => sum + toRappen(e.amount), 0) < toRappen(o.refunded)) undated = true;
    return { events, undated, exceeds: false };
  };
  /**
   * The ref of an order's refund on `date`: the plain refund ref for its first one (as the sales report's
   * own day books it, so the two meet), each later one with its day; a ref the books carry keeps its day.
   */
  const refundRefOn = (order: string, date: string, first: boolean): string => {
    const plain = refundRef(ctx.provider.id, order);
    const had = byRef.get(plain);
    if (had?.length) return had.every((e) => e.date === date) ? plain : `${plain}-${date}`;
    return first && !byRef.has(`${plain}-${date}`) ? plain : `${plain}-${date}`;
  };
  /** The refs of the report's own refunds of an order: each entry under them the app's, of the open period. */
  const ownRefunds = (order: string): string[] => {
    const plain = refundRef(ctx.provider.id, order);
    return [...byRef.keys()].filter((r) => (r === plain || r.startsWith(`${plain}-`)) && byRef.get(r)!.every((e) => e.origin === 'classify' && e.by?.kind === 'code' && e.by.check === 'payoutReport' && !e.corrects && !ctx.isClosed(e.date)));
  };
  /**
   * An order's charges in the payments exports (#231), per day, and what they add up to (`total`): none
   * when they name none of it, or charges in another currency than the order's (they cannot be
   * compared); `differ` when they lie more than a cent from what the sales report says was charged (its
   * total less its outstanding balance). Within a cent (`off`, #239) the sale is booked at the charges.
   */
  const chargesOf = (o: SaleRow): { days: Array<{ date: string; amount: number }>; total: number; off: boolean } | 'differ' | undefined => {
    const rows = ctx.payments?.charges.get(o.order);
    if (!rows?.length || rows.some((r) => r.currency && o.currency && r.currency !== o.currency)) return undefined;
    const days = new Map<string, number>();
    for (const r of rows) days.set(r.date, (days.get(r.date) ?? 0) + toRappen(r.amount));
    const sum = [...days.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(sum - toRappen(o.gross)) > CHARGE_SLACK) return 'differ';
    return { days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, rp]) => ({ date, amount: fromRappen(rp) })), total: fromRappen(sum), off: sum !== toRappen(o.gross) };
  };
  /** The refs under which the books carry parts of an order's sale: its own ref and its later parts'. */
  const saleRefsOf = (sale: string): string[] => [...byRef.keys()].filter((r) => (r === sale || r.startsWith(`${sale}-charge-`)) && byRef.get(r)!.length);
  /**
   * The parts of an order's sale the books carry, each the report's own entries only (sale first, then by
   * day), with its day and what it put on the clearing account; undefined when one of them is no longer
   * the report's alone (a person's Storno beside it, a correction).
   */
  const ownParts = (sale: string): Array<{ ref: string; date: string; collected: string; gross: number }> | undefined => {
    const parts = saleRefsOf(sale).map((ref) => ({ ref, es: byRef.get(ref)! }));
    if (parts.some(({ es }) => es.some((e) => e.origin !== 'classify' || e.by?.kind !== 'code' || e.by.check !== 'payoutReport' || e.corrects))) return undefined;
    return parts.map(({ ref, es }) => ({ ref, date: es[0].date, collected: es[0].date, gross: fromRappen(es.reduce((sum, e) => sum + (e.accountDebit === ctx.clearing ? toRappen(e.amount) : 0), 0)) }))
      .sort((a, b) => (a.ref === sale ? -1 : b.ref === sale ? 1 : a.date.localeCompare(b.date)));
  };
  /**
   * The parts an order's sale is booked in (#231). On the cash basis with its charges in the payments
   * exports: one part per day charged, each on its day (the money came in then); they must add up to
   * what was charged within a cent (booked at the charges), else the order waits (`charges`), never booked
   * with the difference. Otherwise one part on the order's tax point (at the charges where they are in);
   * where the books carry parts of it already (the report's own) for less than was charged now, all dated
   * before the day the report gives (the last charge), the rest is a part of its own on that day: an
   * outstanding balance charged later is booked when it is charged.
   */
  const partsOf = (o: SaleRow, day: string, sale: string, charged: ReturnType<typeof chargesOf>): Array<{ ref: string; date: string; collected: string; gross: number }> | 'charges' => {
    if (toRappen(o.gross) <= 0) return 'charges';
    if (charged === 'differ') return 'charges';
    if (charged && !ctx.agreed) return charged.days.map((c, i) => ({ ref: i ? salePartRef(sale, c.date) : sale, date: c.date, collected: c.date, gross: c.amount }));
    const whole = [{ ref: sale, date: day, collected: o.date, gross: charged ? charged.total : o.gross }];
    const had = ownParts(sale);
    if (!had?.length) return whole;
    const rest = toRappen(o.gross) - had.reduce((sum, x) => sum + toRappen(x.gross), 0);
    if (rest === 0) return had;
    if (rest < 0 || had.some((x) => x.date >= o.date)) return whole;
    return [...had, { ref: salePartRef(sale, o.date), date: o.date, collected: o.date, gross: fromRappen(rest) }];
  };
  for (const o of read.rows) {
    // Its refund goes with it: an order the provider did not collect is refunded otherwise too.
    if (!collectedBy(o, ctx.gateways)) {
      out.other++;
      const said = o.gateway ?? '–';
      if (!out.ways.includes(said)) out.ways.push(said);
      continue;
    }
    if (o.test) { out.test++; continue; }
    // An order of the provider's gateway that no transaction names, of a day a payments export's charges cover on
    // both sides: the gateway collected nothing (a test-mode order). Not booked yet, it waits; a sale booked already
    // stays as booked (code never takes one back because a row is missing) and the person is asked.
    if (unpaidRow(o, ctx.payments, ctx.gateways)) {
      if (!byRef.has(saleRef(ctx.provider.id, o.order))) { out.held.push({ order: o.order, why: 'noPayment' }); continue; }
      out.unpaid.push(o.order);
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
        // A foreign VAT (IOSS, say) is owed abroad, no export turnover: without the company's account for it the order waits, never gross at V0.
        if (foreignTaxOf(o) > 0 && !bookedWhole(saleRef(ctx.provider.id, o.order), o)) {
          if (toRappen(o.tax!) >= toRappen(o.gross)) { out.held.push({ order: o.order, why: 'rate' }); continue; }
          if (!ctx.foreignTax) { out.held.push({ order: o.order, why: 'foreignTax' }); continue; }
        }
        code = ctx.codes.abroad;
        kind = 'abroad';
      }
    }
    const sale = saleRef(ctx.provider.id, o.order);
    const tax = bookedWhole(sale, o) ? 0 : foreignTaxOf(o);
    const charged = chargesOf(o);
    let parts = partsOf(o, day, sale, charged);
    if (parts === 'charges') {
      // An order of a filed period (or before the books), charged there too, is counted as such, never held for its charges (#239):
      // a correction is the person's (golden rule 1); its refund paid in the open period is still booked below.
      const shut = (d: string, collected = d) => { const w = dated(d, collected); return w === 'filed' || w === 'before'; };
      const chargeDays = ctx.agreed ? [] : (ctx.payments?.charges.get(o.order) ?? []).map((c) => c.date);
      if (!shut(day, o.date) || !chargeDays.every((d) => shut(d))) { out.held.push({ order: o.order, why: 'charges' }); continue; }
      parts = [{ ref: sale, date: day, collected: o.date, gross: o.gross }];
    }
    // Booked at its charges a cent beside what the sales report says was charged: the reason says so (#239).
    const reasonOf = (k: Parameters<ReportTexts['reason']>[0]) => {
      const said = ctx.texts.reason(k, o.shipTo);
      return charged && charged !== 'differ' && charged.off && ctx.texts.cent ? `${said}; ${ctx.texts.cent(charged.total, o.gross)}` : said;
    };
    // Each part's foreign tax in its share of the gross, rounded on the running sum so the parts add up to the tax to the cent.
    const upTo = (rp: number) => (tax ? Math.round((rp * toRappen(tax)) / toRappen(o.gross)) : 0);
    let ran = 0;
    const lines = parts.map((p) => {
      const before = upTo(ran);
      ran += toRappen(p.gross);
      const t = fromRappen(upTo(ran) - before);
      return { ...p, tax: t, net: fromRappen(toRappen(p.gross) - toRappen(t)) };
    });
    /** One sale's lines as entries: its revenue at the code, an export's foreign tax beside it; 'noRate' without the day's rate. */
    const entriesOf = (p: (typeof lines)[number]): JournalEntry[] | 'noRate' => {
      const e = make(p.ref, p.date, o.currency, { accountDebit: ctx.clearing, accountCredit: ctx.revenue, amount: p.net, vatCode: code, description: ctx.texts.sale(o.order, o.shipTo) }, reasonOf(kind));
      if (e === 'noRate') return e;
      return p.tax ? [e, make(p.ref, p.date, o.currency, { accountDebit: ctx.clearing, accountCredit: ctx.foreignTax!, amount: p.tax, vatCode: FOREIGN_TAX_CODE, description: ctx.texts.foreignTax(o.order, o.shipTo) }, reasonOf('foreignTax')) as JournalEntry] : [e];
    };
    /**
     * The parts that take the place of the app's one-sum sale `ref` (#242), or none: only when its every entry is the report's own
     * (ownParts), of the open period, no person or the AI linked a receipt to it, a charge falls on another day than it, and each part
     * is booked as the payments export first books it (open, carried nowhere else, its refunds dated, its rate there). The parts
     * keep the receipts the sale named.
     */
    const resplit = (ref: string, parts: typeof lines): JournalEntry[] | undefined => {
      const had = byRef.get(ref)!;
      if (!ownParts(ref) || had.some((e) => ctx.isClosed(e.date)) || books.mappings?.some((m) => m.transactionRef === ref && (m.by === 'human' || m.by === 'llm'))) return undefined;
      if (parts.every((p) => p.date === had[0].date)) return undefined;
      if (refunds.exceeds || refunds.undated || parts.some((p) => dated(p.date, p.collected) || orderLegacy({ key: o.order, day: p.collected, amount: p.net }))) return undefined;
      const receipts = [...new Set([...had.flatMap((e) => e.receipts ?? []), ctx.receipt])].sort();
      const made: JournalEntry[] = [];
      for (const p of parts) {
        const es = entriesOf(p);
        if (es === 'noRate') return undefined;
        made.push(...es.map((e) => ({ ...e, receipts })));
      }
      return made;
    };
    const states = lines.map((p) => known(p.ref, p.tax ? [p.net, p.tax] : [p.gross]));
    const carriedRefs = saleRefsOf(sale);
    const allSame = states.every((k) => k === 'same') && carriedRefs.every((r) => lines.some((p) => p.ref === r));
    const refunds = refundsOf(o, lines[0].date);
    const byCharges = !!charged && charged !== 'differ' && !ctx.agreed;
    // Charged on one day other than the day it is booked on: known by its figures, split onto that day where it can be (#242).
    const moved = allSame && byCharges && carriedRefs.length === 1 && carriedRefs[0] === sale && byRef.get(sale)!.some((e) => e.date !== lines[0].date);
    // Booked in one before its charges were known (in parts, or a cent beside them).
    const whole = moved || (!allSame && carriedRefs.length === 1 && carriedRefs[0] === sale && known(sale, tax ? [fromRappen(toRappen(o.gross) - toRappen(tax)), tax] : [o.gross]) === 'same');
    // The app's own sale of the open period, booked in one on the order's day, whose charges the payments export puts on
    // other days (#242): split per charge day, as the payments export first books it, so the drop order never moves a sale
    // into another period. All parts or none: a part that cannot be booked leaves the sale as it was booked.
    const split = whole && byCharges ? resplit(sale, lines) : undefined;
    if (split) {
      out.replaced.push(...byRef.get(sale)!.map((e) => e.id));
      byRef.delete(sale);
      for (const e of split) push(e.transactionRef, e);
    }
    // Else it stays as booked.
    const inOne = whole && !split;
    // A part with other figures, or one the books carry that the order has no more: changed, never booked beside it.
    if (!allSame && !whole && (states.some((k) => k === 'changed') || carriedRefs.some((r) => !lines.some((p) => p.ref === r)))) { out.held.push({ order: o.order, why: 'changed' }); continue; }
    const saleKnown = allSame || whole;
    if (saleKnown) { if (!split) for (const r of inOne ? [sale] : lines.map((p) => p.ref)) same(r); }
    else {
      let stop = false;
      let booked = false;
      for (const [i, p] of lines.entries()) {
        if (states[i] === 'same') { same(p.ref); continue; }
        const where = dated(p.date, p.collected);
        // A sale of a filed period is the person's to correct; its refund paid in the open period is still booked below.
        if (where) { count(where, o.order); continue; }
        if (carried(orderLegacy({ key: o.order, day: p.collected, amount: p.net }), o.order)) { stop = true; break; }
        // A refund without its day holds its sale with it: a refunded order is never booked as a sale alone (#214).
        if (refunds.exceeds) { out.held.push({ order: o.order, why: 'refundMismatch' }); stop = true; break; }
        if (refunds.undated) { out.held.push({ order: o.order, why: 'refundDate' }); stop = true; break; }
        const es = entriesOf(p);
        if (es === 'noRate') { out.held.push({ order: o.order, why: 'noRate' }); stop = true; break; }
        for (const e of es) push(p.ref, e);
        booked = true;
      }
      if (booked) out.orders++;
      if (stop) continue;
    }
    if (refunds.exceeds) {
      // A filed order whose refunds all lie in a filed period too (or before the books) is counted as such, never held (#242):
      // nothing of it can be booked, a correction is the person's (golden rule 1).
      const refundDays = o.refundedAt ? [o.refundedAt] : (ctx.payments?.refunds.get(o.order) ?? []).map((r) => r.date);
      const shut = (d: string, collected = d) => { const w = dated(d, collected); return w === 'filed' || w === 'before' ? w : undefined; };
      const was = shut(lines[0].date, lines[0].collected);
      if (was && lines.every((p) => shut(p.date, p.collected)) && refundDays.every((d) => shut(d))) count(was, o.order);
      else out.held.push({ order: o.order, why: 'refundMismatch' });
      continue;
    }
    // The refunds booked on their days; the first one that cannot be stops the rest, and the order is held once, with why.
    const refs = refunds.events.map(({ date: when }, i) => refundRefOn(o.order, when, i === 0));
    out.stale.push(...ownRefunds(o.order).filter((r) => !refs.includes(r)));
    let why: ReportHold['why'] | undefined;
    for (const [i, { date: when, amount }] of refunds.events.entries()) {
      const ref = refs[i];
      // An export's refund gives back its foreign VAT in the sale's share, to the cent; the rest is the export's.
      // A refund of a filed sale the books do not carry takes its share off the account too, which then never held that
      // tax: the account comes out uneven by it until the person books the sale's tax (a correction is hers).
      const backTax = tax ? Math.min(toRappen(amount), Math.round((toRappen(amount) * toRappen(tax)) / toRappen(o.gross))) : 0;
      const backNet = fromRappen(toRappen(amount) - backTax);
      const kr = known(ref, [backNet, ...(backTax ? [fromRappen(backTax)] : [])].filter((x) => x !== 0));
      if (kr === 'same') { same(ref); continue; }
      if (kr === 'changed') { why = 'changed'; break; }
      const where = dated(when);
      // A refund paid in a filed period the books never carried, of a sale they carry (#231): offered to the person as a
      // correction in the open period, declared in that period's correction return (golden rule 1); booked on her click.
      // A sale an entry from elsewhere books alone with its amount (the old way per order) is carried as well (#239).
      // A sale named only in an entry beside other orders or with another amount (an old payout entry) may have its refund
      // netted in it: named to the person, booked by her hand, never offered. A sale nothing names is only counted.
      const legacySale = where === 'filed' && !kr && !saleKnown ? orderLegacy({ key: o.order, day: o.date, amount: netOf(o) }) : undefined;
      // Booked already anywhere in the books (#242): nothing is offered, the person is told where it is.
      const listed = where === 'filed' && !kr && (saleKnown || legacySale === 'booked' || legacySale === 'named' || namedElsewhere(o.order));
      const already = listed ? bookedRefund(o, sale, when, amount) : undefined;
      if (already) {
        out.filedRefunds.push({ order: o.order, date: when, amount, ...(o.currency ? { currency: o.currency } : {}), booked: { entry: already.id, date: already.date, ref: already.transactionRef } });
        continue;
      }
      if (where === 'filed' && !kr && !saleKnown && legacySale !== 'booked' && (legacySale === 'named' || namedElsewhere(o.order))) {
        out.filedRefunds.push({ order: o.order, date: when, amount, ...(o.currency ? { currency: o.currency } : {}), byHand: true });
        continue;
      }
      if (where === 'filed' && !kr && (saleKnown || legacySale === 'booked')) {
        const c = ctx.correct;
        if (c?.order !== o.order || c.date !== when) { out.filedRefunds.push({ order: o.order, date: when, amount, ...(o.currency ? { currency: o.currency } : {}) }); continue; }
        const cref = refundCorrectionRef(ctx.provider.id, o.order, when);
        const hers = (e: JournalEntry, description: string): JournalEntry => ({ ...e, description, corrects: c.corrects, origin: 'manual', by: { kind: 'person', at: c.at } });
        const e = make(cref, c.on, o.currency, { accountDebit: ctx.revenue, accountCredit: ctx.clearing, amount: backNet, vatCode: code ? `${ctx.codes!.negative}${code}` : undefined, description: c.text }, ctx.texts.reason('refund', o.shipTo), when);
        if (e === 'noRate') { why = 'noRate'; break; }
        if (backNet !== 0) push(cref, hers(e, c.text));
        if (backTax) push(cref, hers(make(cref, c.on, o.currency, { accountDebit: ctx.foreignTax!, accountCredit: ctx.clearing, amount: fromRappen(backTax), vatCode: FOREIGN_TAX_CODE && `${ctx.codes!.negative}${FOREIGN_TAX_CODE}`, description: '' }, ctx.texts.reason('foreignTax', o.shipTo), when) as JournalEntry, ctx.texts.foreignTax(o.order, o.shipTo)));
        out.corrected.push(cref);
        continue;
      }
      if (where) { count(where, o.order); continue; }
      // Held whenever its order is carried, also by an entry that books the order's sale: that entry books no refund.
      if (orderLegacy({ key: o.order, day: when, amount })) { why = 'legacy'; break; }
      const e = make(ref, when, o.currency, { accountDebit: ctx.revenue, accountCredit: ctx.clearing, amount: backNet, vatCode: code ? `${ctx.codes!.negative}${code}` : undefined, description: ctx.texts.refund(o.order) }, ctx.texts.reason('refund', o.shipTo));
      if (e === 'noRate') { why = 'noRate'; break; }
      if (backNet !== 0) push(ref, e);
      if (backTax) push(ref, make(ref, when, o.currency, { accountDebit: ctx.foreignTax!, accountCredit: ctx.clearing, amount: fromRappen(backTax), vatCode: FOREIGN_TAX_CODE && `${ctx.codes!.negative}${FOREIGN_TAX_CODE}`, description: ctx.texts.foreignTax(o.order, o.shipTo) }, ctx.texts.reason('foreignTax', o.shipTo)) as JournalEntry);
      out.refunds++;
    }
    why ??= refunds.undated ? 'refundDate' : undefined;
    if (why) out.held.push({ order: o.order, why });
  }
  return out;
}

/**
 * Whether the provider has no transaction for an order it should have collected (#214): of its gateway,
 * no test, its day strictly inside the days a payments export's charges cover, and no row names it.
 */
export function unpaidRow(o: SaleRow, payments: PaymentFacts | undefined, gateways: readonly string[] | undefined): boolean {
  return !!payments && collectedBy(o, gateways) && !o.test && payments.inside(o.date) && !payments.orders.has(o.order);
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

/**
 * A row of a report as the legacy check sees it: its order (or fee key), its day (the day the provider
 * collected it), its amount; an export with a foreign tax also its gross, which an entry from elsewhere
 * booked onto revenue before #206 (matched by day and amount only: one naming the order books it with the net alone).
 */
interface LegacyRow { key: string; day: string; amount: number; gross?: number }

/**
 * What the books carry of a row from elsewhere: `booked`, an entry that names it with its amount books it; `named`, an
 * entry names it beside other rows or with another amount; `held`, it may be in an entry or a payout by its day; none.
 */
type Legacy = 'booked' | 'named' | 'held' | undefined;

/**
 * Which rows of a report the books may carry already from elsewhere (ReportContext.legacy). The
 * entries that name exactly one row's order (their ref ends in it, or their text names it) book that
 * row when their net amount is the row's (a person's own booking of that order, an older one per
 * order, less a reversal of it: `reversal` says which entries take back): the row is known, never
 * held again on the next taking. Every other entry holds: the rows it names (one with another net,
 * one naming several orders at once, whose sum books none of them alone), else the row of its day
 * and amount; and one on or after `since` that names no row, matches none and corrects no filed period
 * holds every row up to its day, as a payout booked otherwise does up to `through` (#242: an entry
 * naming an order, or a correction of a filed period, never holds rows by its day). One before `since` holds only the rows it
 * names or matches: the old way booked each sale onto the clearing account and paid it from there,
 * so another sale of those days is not on it yet. A row dated before `since` waits when a payout
 * before `since` not booked from the clearing account is dated after it (`paidBefore`): a payout
 * pays what was collected before its day.
 */
function legacyRows(rows: readonly LegacyRow[], legacy: ReportContext['legacy'], since: string, reversal: (e: JournalEntry) => boolean): (row: LegacyRow) => Legacy {
  if (!legacy) return () => undefined;
  const booked = new Set<string>();
  const named = new Set<string>();
  /** The rows an entry names by their order (its ref or text), not by their day and amount. */
  const nameOnly = new Set<string>();
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
    for (const k of keys) { named.add(k); nameOnly.add(k); }
    const r = keys.length ? undefined : rows.find((x) => !named.has(x.key) && !booked.has(x.key) && x.day === e.date && (toRappen(x.amount) === signed(e) || (x.gross !== undefined && toRappen(x.gross) === signed(e))));
    if (r) named.add(r.key);
    // Only an entry that names no row and corrects no filed period holds rows by its day (#242): one naming an order
    // holds that order, a correction of a filed period (a person's, dated in the open one) only what it names or matches.
    else if (!keys.length && !e.corrects && e.date >= since && e.date > through) through = e.date;
  }
  const paid = legacy.paidBefore ?? [];
  return (row) => (booked.has(row.key) ? 'booked' : nameOnly.has(row.key) ? 'named' : named.has(row.key) || row.day <= through || (row.day < since && paid.some((d) => d > row.day)) ? 'held' : undefined);
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
