/**
 * A provider's order page the provider way (#253): once a provider's sales come from its sales report
 * (`reports.sales`) from the company's cut-over day on (`since`), the printed page of one of its orders
 * is no receipt of a payment. The order export books the order onto the clearing account and the
 * provider's payout settles it; no payment will ever come for the page alone. So such a page never
 * waits for a payment, is never paired with one, and goes with its sale once the export booked it
 * (linkOrdersToSales).
 *
 * Derived from the books and the business files on every read, never stored. Pure.
 */
import { identify, signalsOfReceiptRead } from '../knowledge/counterparties.js';
import type { JournalEntry, Mapping, Receipt } from '../types/index.js';
import { isNoReceipt } from '../books/discard.js';
import { orderOf, type Provider } from './providers.js';
import { saleRef } from './sales-report.js';

/**
 * Where an order page of the provider way stands: its order waits for the provider's order export
 * (`export`); the export holds it without booking it (`held`, on the export's receipt `report`); or
 * the export booked its sale (`booked`, the sale's ref), which the page goes with.
 */
export type OrderPageState = { kind: 'export' } | { kind: 'held'; report: string } | { kind: 'booked'; sale: string };

/** An order page of the provider way: whose (`provider`, its business id, and its `name`), which order, and where it stands. */
export interface OrderPage { provider: string; name: string; order: string; state: OrderPageState }

type Books = { receipts: readonly Receipt[]; mappings: readonly Mapping[]; journalEntries?: readonly JournalEntry[] };

/** Providers whose sales come from their report from a cut-over day on: the provider way. */
const reportProviders = (providers: readonly Provider[]): Provider[] => providers.filter((p) => !!p.provider.reports.sales && !!p.provider.since);

/**
 * The provider and order of `r` as an order page of the provider way, when it is one: its text has a
 * provider's `orderPage`, or its read order facts (Receipt.order) belong to the one such provider, or
 * to the one its file recognises the page by; dated on or after that provider's cut-over day.
 */
function pageOf(r: Receipt, ways: readonly Provider[]): { provider: Provider; order: string; date: string } | undefined {
  const date = r.order?.date ?? r.date;
  if (!date) return undefined;
  const byPattern = ways.find((p) => (p.provider.orderPage ?? []).some((re) => re.test(r.extractedText ?? '')));
  const routed = (): Provider | undefined => {
    if (ways.length === 1) return ways[0];
    const hit = identify(signalsOfReceiptRead(r), ways);
    return hit.kind === 'known' ? ways.find((p) => p.id === hit.counterparty) : undefined;
  };
  const provider = byPattern ?? (r.order ? routed() : undefined);
  const order = provider && orderOf(r, provider);
  return provider && order && date >= provider.provider.since! ? { provider, order, date } : undefined;
}

/**
 * Every order page of the provider way nothing is linked to yet, by receipt id. A page whose order the
 * provider's export reached past without booking or holding it is none: the provider did not collect
 * that order (paid by bank transfer, say), so it waits for its own payment like any receipt.
 */
export function orderPagesOf(books: Books, providers: readonly Provider[]): Map<string, OrderPage> {
  const ways = reportProviders(providers);
  const out = new Map<string, OrderPage>();
  if (!ways.length) return out;
  const linked = new Set(books.mappings.map((m) => m.receiptId));
  const refs = new Set((books.journalEntries ?? []).map((e) => e.transactionRef));
  const reports = books.receipts.filter((x) => x.report?.kind === 'sales');
  for (const r of books.receipts) {
    if (linked.has(r.id) || r.report || isNoReceipt(r, 0)) continue;
    const page = pageOf(r, ways);
    if (!page) continue;
    const { provider, order, date } = page;
    const state = stateOf(provider, order, date, refs, reports);
    if (state) out.set(r.id, { provider: provider.id, name: provider.name, order, state });
  }
  return out;
}

function stateOf(p: Provider, order: string, date: string, refs: ReadonlySet<string>, reports: readonly Receipt[]): OrderPageState | undefined {
  const sale = saleRef(p.id, order);
  if (refs.has(sale)) return { kind: 'booked', sale };
  const own = reports.filter((x) => x.report!.provider === p.id);
  const holding = own.find((x) => x.report!.held?.some((h) => h.order === order));
  if (holding) return { kind: 'held', report: holding.id };
  return own.some((x) => x.report!.to >= date) ? undefined : { kind: 'export' };
}

/** Whether a receipt is an order page of the provider way: it has no payment of its own and is paired with none. */
export const noPaymentOf = (books: Books, providers: readonly Provider[]): ((r: Receipt) => boolean) => {
  const pages = orderPagesOf(books, providers);
  return (r) => pages.has(r.id);
};
