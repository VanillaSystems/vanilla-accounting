/**
 * What a payment provider's reports leave open in a period (#405), derived from the books and the
 * business files on every read, never stored. Two kinds:
 *
 * - `held`: an order the sales report did not book (report.held on its receipt): its turnover is
 *   missing from the return of the period of its day until the person books it. Gone once an entry
 *   books it: the report's own (its sale ref), or one of the person's or the AI's that names the order
 *   on the clearing account.
 * - `bill`: a month whose fees the fee report booked while no bill of the provider's file that proves
 *   a VAT-only correction (`proves: vat-correction`, src/booking/vat-corrections.ts) is in the books
 *   for it: the VAT on those fees is not deducted yet. Only for a firm that deducts input tax, only
 *   for a month that has ended. A bill covers the month of its day, and the month before when it is
 *   dated in the first CORRECTION_DAYS.before days of a month (a bill written after its month).
 *
 * Pure: the server derives it (GET /api/receipts/provider-issues), the browser reads it beside the
 * books, and periodIssues (src/app/areas/automation/period-issues.ts) lists each in its period.
 */
import type { JournalEntry, Receipt, SalesReportFacts } from '../types/index.js';
import type { Provider } from './providers.js';
import { feeRef, saleRef, textNames } from './sales-report.js';
import { CORRECTION_DAYS, provenBy } from './vat-corrections.js';

export type HeldWhy = NonNullable<SalesReportFacts['held']>[number]['why'];

/** An order a provider's sales report holds: whose, which report, the order, why, its day (the report's last day when it gave none), its gross. */
/** `filed`: its day lies in a filed period: it stays named on the report, no open item of any period and no split (#405). */
export interface HeldOrder { provider: string; name: string; receipt: string; order: string; why: HeldWhy; date: string; gross?: number; currency?: string; filed?: true }

/** A month of a provider's fees without its bill: whose, the month (YYYY-MM), its last day, the fees booked in it. */
export interface MissingBill { provider: string; name: string; month: string; date: string; fees: number }

/** `payouts`: the provider's name by the ref of each payment code takes for its payout (providerOfMoneyIn): a list names it so, not by the processor that paid it (#405). */
export interface ProviderIssues { held: HeldOrder[]; bills: MissingBill[]; payouts: Record<string, string> }

type Books = { receipts: readonly Receipt[]; journalEntries?: readonly JournalEntry[] };

const lastDayOf = (month: string): string => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const monthBefore = (month: string): string => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);

/** `lockedThrough`: the last day of the filed periods: a held order of them is `filed`, a month of them is no missing bill. */
export function providerIssuesOf(books: Books, providers: readonly Provider[], opts: { inputTax: boolean; today: string; lockedThrough?: string }): ProviderIssues {
  const filed = (d: string) => !!opts.lockedThrough && d <= opts.lockedThrough;
  const entries = books.journalEntries ?? [];
  const byId = new Map(providers.map((p) => [p.id, p]));
  const refs = new Set(entries.map((e) => e.transactionRef));
  const held = books.receipts.flatMap((r): HeldOrder[] => {
    const rep = r.report;
    const p = rep?.kind === 'sales' ? byId.get(rep.provider) : undefined;
    if (!p || !rep?.held?.length || r.kind === 'duplicate') return [];
    const clearing = p.provider.clearing;
    const booked = (order: string) => refs.has(saleRef(p.id, order)) || entries.some((e) => !!clearing && e.accountDebit === clearing && textNames(e.description, order));
    // A refund of an order the person split stays held while its sale is booked: the refund is hers to book.
    return rep.held.filter((h) => h.why === 'refundSplit' || !booked(h.order)).map((h) => {
      const date = h.date ?? rep.to;
      return {
        provider: p.id, name: p.name, receipt: r.id, order: h.order, why: h.why, date,
        ...(h.gross !== undefined ? { gross: h.gross } : {}), ...(h.currency ? { currency: h.currency } : {}), ...(filed(date) ? { filed: true as const } : {}),
      };
    });
  });
  if (!opts.inputTax) return { held, bills: [], payouts: {} };
  const bills = providers.flatMap((p): MissingBill[] => {
    if (!p.documents.some((d) => d.proves === 'vat-correction')) return [];
    const prefix = `${feeRef(p.id, '')}`;
    const fees = new Map<string, number>();
    for (const e of entries) if (e.transactionRef.startsWith(prefix)) fees.set(e.date.slice(0, 7), (fees.get(e.date.slice(0, 7)) ?? 0) + Math.round(e.amount * 100));
    if (!fees.size) return [];
    const covered = new Set(books.receipts.flatMap((r) => {
      if (!r.date || r.kind === 'duplicate' || provenBy(r, [p])?.cp.id !== p.id) return [];
      const month = r.date.slice(0, 7);
      return Number(r.date.slice(8, 10)) <= CORRECTION_DAYS.before ? [month, monthBefore(month)] : [month];
    }));
    return [...fees].filter(([month]) => !covered.has(month) && lastDayOf(month) < opts.today && !filed(lastDayOf(month))).sort(([a], [b]) => a.localeCompare(b))
      .map(([month, rp]) => ({ provider: p.id, name: p.name, month, date: lastDayOf(month), fees: rp / 100 }));
  });
  return { held, bills, payouts: {} };
}
