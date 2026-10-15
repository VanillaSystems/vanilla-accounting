/**
 * What the runs table (Runs.tsx) says about a run, without the page: one line per file that came
 * in, with its result read from the books, and where the run stands for the person checking it.
 */
import { bookBalanceNative, nativeOpening } from '../../../accounting/reconcile-bank.js';
import { toRappen } from '../../../accounting/rappen.js';
import { openingOffer, type OpeningOffer } from '../../../accounting/opening-balance.js';
import { salesWithoutVat, type SaleWithoutVat } from '../../../accounting/sales-without-vat.js';
import type { Arrival, RunSummary } from '../../../workflows/model.js';
import type { Index } from '../../../types/index.js';

/** Where a run stands for the person checking it; the first that applies wins. */
export type Stand = 'running' | 'error' | 'you' | 'discarded' | 'reviewed' | 'check' | 'idle' | 'ok';

export type Line =
  | { kind: 'statement'; a: Extract<Arrival, { kind: 'statement' }>; balance: Balance; opening?: OpeningOffer; withoutVat: SaleWithoutVat[] }
  | { kind: 'receipt'; a: Extract<Arrival, { kind: 'receipt' }>; receipt?: Index['receipts'][number]; payments: Index['transactions']; entries: number }
  | { kind: 'refused'; a: Extract<Arrival, { kind: 'refused' }> }
  | { kind: 'file'; name: string }
  | { kind: 'poorScan'; file: string; receipt?: Index['receipts'][number] };

/** The bank's closing balance against the books on the same day, in the account's currency. */
export type Balance = { kind: 'none' } | { kind: 'matches'; date: string } | { kind: 'differs'; date: string; diff: number };

export function balanceOf(a: Extract<Arrival, { kind: 'statement' }>, books: Index): Balance {
  const closing = a.closing ?? books.statementBalances?.filter((b) => b.account === a.account && b.date === a.to).map((b) => ({ date: b.date, amount: b.amount }))[0];
  if (!closing) return { kind: 'none' };
  const year = closing.date.slice(0, 4);
  const book = bookBalanceNative(books.journalEntries ?? [], a.account, a.currency, year, closing.date, nativeOpening(books, a.account, a.currency, year));
  const diff = (toRappen(book) - toRappen(closing.amount)) / 100;
  return Math.abs(diff) <= 0.01 ? { kind: 'matches', date: closing.date } : { kind: 'differs', date: closing.date, diff };
}

/** The statement's customer payments booked without output tax for want of an invoice. */
const withoutVatOf = (a: Extract<Arrival, { kind: 'statement' }>, sales: SaleWithoutVat[]) => sales.filter(({ payment: p }) =>
  p.bank === a.bank && p.currency === a.currency && p.date >= (a.from ?? `${a.to.slice(0, 7)}-01`) && p.date <= a.to);

export function linesOf(r: RunSummary, books: Index, vatRegistered: boolean): Line[] {
  const poor = (r.digest.poorScans ?? []).map((file): Line => ({ kind: 'poorScan', file, receipt: books.receipts.find((x) => x.filename === file) }));
  if (!r.arrived?.length) return [...r.digest.files.map((name): Line => ({ kind: 'file', name })), ...poor];
  const sales = r.arrived.some((a) => a.kind === 'statement') ? salesWithoutVat(books, vatRegistered) : [];
  return [...r.arrived.map((a): Line => {
    if (a.kind === 'statement') {
      const balance = balanceOf(a, books);
      const opening = balance.kind === 'differs' ? openingOffer(books, a) : undefined;
      return { kind: 'statement', a, balance, ...(opening && { opening }), withoutVat: withoutVatOf(a, sales) };
    }
    if (a.kind === 'refused') return { kind: 'refused', a };
    const refs = new Set(books.mappings.filter((m) => m.receiptId === a.id).map((m) => m.transactionRef));
    return {
      kind: 'receipt', a, receipt: books.receipts.find((x) => x.id === a.id),
      payments: books.transactions.filter((x) => refs.has(x.ref)),
      entries: (books.journalEntries ?? []).filter((e) => refs.has(e.transactionRef)).length,
    };
  }), ...poor];
}

/** A line the person has to look at: a balance that differs or a sale booked without VAT, a refused file, a receipt the finished run did not read. */
const isIssue = (l: Line, finished: boolean) => (l.kind === 'statement' && (l.balance.kind === 'differs' || l.withoutVat.length > 0)) || l.kind === 'refused' || l.kind === 'poorScan' || (l.kind === 'receipt' && finished && !l.receipt);

export function standOf(r: RunSummary, lines: Line[]): Stand {
  if (r.status === 'queued' || r.status === 'running' || r.status === 'parked') return 'running';
  if (r.status === 'stuck') return 'error';
  if (r.status === 'waiting') return 'you';
  if (r.status === 'discarded') return 'discarded';
  if (r.reviewed) return 'reviewed';
  if (lines.some((l) => isIssue(l, true))) return 'check';
  if (!r.arrived?.length && !r.digest.files.length && !r.digest.poorScans?.length && !r.digest.receipts && !r.digest.links && !r.digest.entries) return 'idle';
  return 'ok';
}
