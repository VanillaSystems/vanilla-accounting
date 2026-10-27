/**
 * A payment provider's sales report booked onto its clearing account (#203). The provider's own
 * export for a period (a CSV: one row per order, or per line of an order) names each order's day,
 * delivery country, gross, tax and refunds; its fee export each charge's fee. Code reads both by the
 * columns the provider's file names (src/knowledge/provider.ts) and books:
 *
 *   each order      clearing / revenue   gross, the domestic sale code for a delivery into the VAT
 *                                        territory, the export code for one abroad
 *   each refund     revenue / clearing   its amount, the sale's code with the minus
 *   each fee        fees / clearing      the provider's fee, the company's fee code
 *
 * The payout itself is booked bank / clearing without VAT (src/booking/classify.ts), so the clearing
 * account comes back to what the provider holds unpaid (src/booking/providers.ts clearingCheck).
 *
 * The tax point: on the cash basis the day the provider collected the payment (`date`); on the
 * agreed basis the day of the order (`ordered`, else `date`). Each order has a ref of its own
 * (SR-<provider>-<order>), so a report read twice, or two that overlap, book each order once; an
 * order the books carry with other figures is named, never booked again. Nothing is booked into a
 * filed period or before the books begin: such orders are counted, a correction is the person's
 * (golden rule 1). A domestic order whose tax column shows no tax, or another rate than the normal
 * one, is a new case for the person, never a sale without output tax
 * (processes/suppliers/shopify.yaml sv-delivery-decides); a foreign tax on an export is no reason to
 * hold it (sv-eu-vat). Browser-safe apart from the engines' globals.
 */
import type { BankTransaction, JournalEntry, Mapping, Receipt, SalesReportFacts } from '../types/index.js';
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
export interface SaleRow { order: string; date: string; ordered?: string; shipTo?: string; gross: number; tax?: number; refunded: number; refundedAt?: string; currency?: string }
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
export function readReport(text: string, kind: ReportKind, facts: Pick<ProviderFacts, 'reports'>): ReadReport | { missing: string[] } {
  const [header, ...lines] = csvRows(text);
  const cell = (row: string[], i: number | undefined) => (i === undefined ? undefined : row[i]?.trim() || undefined);
  if (kind === 'sales') {
    const placed = placeColumns<SalesColumn>(header ?? [], facts.reports.sales ?? {}, SALES_NEEDS);
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
    });
    const rows: SaleRow[] = [];
    for (const { row: r, lines: at2 } of byOrder.values()) {
      if (!r.date || r.gross === undefined) { unread.push(at2[0]); continue; }
      rows.push({ order: r.order!, date: r.date, gross: r.gross, refunded: Math.abs(r.refunded ?? 0), ...(r.ordered && { ordered: r.ordered }), ...(r.shipTo && { shipTo: r.shipTo }), ...(r.tax !== undefined && { tax: r.tax }), ...(r.refundedAt && { refundedAt: r.refundedAt }), ...(r.currency && { currency: r.currency }) });
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

/** What the booking needs beside the books: the provider's accounts, the firm's codes and basis, the rates, the lock. */
export interface ReportContext {
  provider: { id: string; name: string };
  clearing: string;
  revenue: string;
  fees?: { account: string; vat?: string };
  /** The report's receipt: every entry names it. */
  receipt: string;
  /** The books' currency; another one converts at `rate`. */
  base: string;
  rate: (currency: string, date: string) => number | undefined;
  /** The domestic sale code, its rate, the export code, the minus; absent: the firm books no codes. */
  codes?: { domestic: string; rate: number; abroad?: string; negative: string };
  territory: readonly string[];
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
  fee(key: string): string;
  reason(kind: 'domestic' | 'abroad' | 'none' | 'refund' | 'fee', country: string | undefined): string;
}

/** Why an order is not booked by code: its tax column disagrees with its delivery, no country, its figures in the books differ, no rate of its day. */
export type ReportHold =
  | { order: string; why: 'noTax' | 'rate' | 'country' | 'changed' | 'noRate' };

/** What a report booked and left: counts, the orders held with why, and the rows dated in a filed period or before the books. */
export interface ReportOutcome {
  orders: number;
  refunds: number;
  fees: number;
  /** Already in the books with the same figures. */
  known: number;
  filed: number;
  before: number;
  held: ReportHold[];
  entries: JournalEntry[];
  links: Mapping[];
}

const TAX_SLACK = 0.02;

/** Whether an order's own tax shows the normal rate on its gross, within two percent of the tax or 0.05. */
function showsRate(gross: number, tax: number, rate: number): boolean {
  const want = (gross * rate) / (100 + rate);
  return Math.abs(tax - want) <= Math.max(0.05, want * TAX_SLACK);
}

/**
 * The entries of `read` for the books `books`, by `ctx`. Pure: the caller pushes the entries and
 * links inside the write door. Each entry has origin 'classify' and names the check `payoutReport` (a check older builds keep).
 */
export function bookReport(books: { journalEntries: readonly JournalEntry[] }, read: ReadReport, ctx: ReportContext): ReportOutcome {
  const out: ReportOutcome = { orders: 0, refunds: 0, fees: 0, known: 0, filed: 0, before: 0, held: [], entries: [], links: [] };
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) if (isReportRef(e.transactionRef)) (byRef.get(e.transactionRef) ?? byRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  const dated = (date: string): 'filed' | 'before' | undefined => (ctx.beforeBooks(date) ? 'before' : ctx.isClosed(date) ? 'filed' : undefined);
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
  /** An entry the books carry under `ref`: the same amount is known, another one is changed. */
  const known = (ref: string, amount: number): 'same' | 'changed' | undefined => {
    const had = byRef.get(ref);
    if (!had) return undefined;
    return had.some((e) => toRappen(e.amount) === toRappen(amount)) ? 'same' : 'changed';
  };
  const push = (ref: string, e: JournalEntry) => {
    out.entries.push(e);
    if (!out.links.some((m) => m.transactionRef === ref)) out.links.push({ transactionRef: ref, receiptId: ctx.receipt, by: 'rule', rule: REPORT_LINK_RULE });
    byRef.set(ref, [e]);
  };

  if (read.kind === 'fees') {
    for (const f of read.rows) {
      if (!ctx.fees) break;
      const key = f.order ?? f.date;
      const ref = feeRef(ctx.provider.id, key);
      const k = known(ref, f.fee);
      if (k === 'same') { out.known++; continue; }
      if (k === 'changed') { out.held.push({ order: key, why: 'changed' }); continue; }
      const where = dated(f.date);
      if (where) { out[where]++; continue; }
      const e = make(ref, f.date, f.currency, { accountDebit: ctx.fees.account, accountCredit: ctx.clearing, amount: f.fee, vatCode: ctx.fees.vat, description: ctx.texts.fee(key) }, ctx.texts.reason('fee', undefined));
      if (e === 'noRate') { out.held.push({ order: key, why: 'noRate' }); continue; }
      push(ref, e);
      out.fees++;
    }
    return out;
  }

  for (const o of read.rows) {
    const day = ctx.agreed ? o.ordered ?? o.date : o.date;
    const domestic = !!o.shipTo && ctx.territory.includes(o.shipTo);
    let code: string | undefined;
    let kind: 'domestic' | 'abroad' | 'none' = 'none';
    if (ctx.codes) {
      if (!o.shipTo) { out.held.push({ order: o.order, why: 'country' }); continue; }
      if (domestic) {
        if (o.tax !== undefined && o.tax <= 0) { out.held.push({ order: o.order, why: 'noTax' }); continue; }
        if (o.tax !== undefined && !showsRate(o.gross, o.tax, ctx.codes.rate)) { out.held.push({ order: o.order, why: 'rate' }); continue; }
        code = ctx.codes.domestic;
        kind = 'domestic';
      } else {
        code = ctx.codes.abroad;
        kind = 'abroad';
      }
    }
    const sale = saleRef(ctx.provider.id, o.order);
    const k = known(sale, o.gross);
    if (k === 'changed') { out.held.push({ order: o.order, why: 'changed' }); continue; }
    if (k === 'same') out.known++;
    else {
      const where = dated(day);
      if (where) { out[where]++; continue; }
      const e = make(sale, day, o.currency, { accountDebit: ctx.clearing, accountCredit: ctx.revenue, amount: o.gross, vatCode: code, description: ctx.texts.sale(o.order, o.shipTo) }, ctx.texts.reason(kind, o.shipTo));
      if (e === 'noRate') { out.held.push({ order: o.order, why: 'noRate' }); continue; }
      push(sale, e);
      out.orders++;
    }
    if (o.refunded > 0) {
      const ref = refundRef(ctx.provider.id, o.order);
      const kr = known(ref, o.refunded);
      if (kr === 'same') { out.known++; continue; }
      if (kr === 'changed') { out.held.push({ order: o.order, why: 'changed' }); continue; }
      const when = o.refundedAt ?? day;
      const where = dated(when);
      if (where) { out[where]++; continue; }
      const e = make(ref, when, o.currency, { accountDebit: ctx.revenue, accountCredit: ctx.clearing, amount: o.refunded, vatCode: code ? `${ctx.codes!.negative}${code}` : undefined, description: ctx.texts.refund(o.order) }, ctx.texts.reason('refund', o.shipTo));
      if (e === 'noRate') { out.held.push({ order: o.order, why: 'noRate' }); continue; }
      push(ref, e);
      out.refunds++;
    }
  }
  return out;
}

// ─── Export proof: order documents to their sale ─────────────────────────────

/**
 * Order documents linked to the sale a sales report booked for their order (#203 4): an order page
 * or a shipping document whose facts name the order (Receipt.order.number) proves where the goods
 * went, so it goes with the sale, never with the payout. A sale of a filed period gets no new link.
 */
export function linkOrdersToSales(books: { receipts: readonly Receipt[]; mappings: Mapping[]; journalEntries: readonly JournalEntry[]; transactions?: readonly BankTransaction[] }, isOpen: (date: string) => boolean): Array<{ receipt: string; sale: string }> {
  const sales = new Map<string, string[]>();
  for (const e of books.journalEntries) {
    if (!e.transactionRef.startsWith('SR-') || e.transactionRef.endsWith('-refund') || !isOpen(e.date)) continue;
    const order = e.transactionRef.slice(e.transactionRef.lastIndexOf('-') + 1);
    const refs = sales.get(order) ?? sales.set(order, []).get(order)!;
    if (!refs.includes(e.transactionRef)) refs.push(e.transactionRef);
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
