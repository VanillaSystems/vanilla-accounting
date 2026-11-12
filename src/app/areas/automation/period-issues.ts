/**
 * What is still open in a period before its return is filed (r4c-38): the questions about its
 * payments, receipts and bookings, the bookings whose code contradicts their receipts (input tax
 * without a receipt, a receipt that shows VAT on a zero code), the payments nobody booked, and the
 * receipts without a payment. The review lists them, each a link; an open VAT question withholds
 * the approval (filing-summary.ts approvalWithheld, r8h-24), the rest blocks nothing.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { EvidenceCheck } from '../../../accounting/evidence-check.js';
import type { Question } from '../../../questions/model.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { journalOf } from '../journal/model.js';
import { ledgerOf, needsYou } from '../receipts/model.js';
import type { OrderPage } from '../../../booking/order-pages.js';
import { unbookedPayments } from '../bank/model.js';

export type PeriodIssue =
  | { kind: 'question'; q: Question; date: string }
  | { kind: 'evidence'; entry: JournalEntry; check: EvidenceCheck }
  | { kind: 'unbooked'; tx: BankTransaction }
  | { kind: 'unlinked'; receipt: Receipt };

/** The date of what a question is about, or undefined when it is gone from the books. */
function dateOn(books: Index, q: Question): string | undefined {
  switch (q.on.kind) {
    case 'payment': return books.transactions.find((t) => t.ref === q.on.id)?.date;
    case 'receipt': return books.receipts.find((r) => r.id === q.on.id)?.date;
    case 'entry': return (books.journalEntries ?? []).find((e) => e.id === q.on.id)?.date;
  }
}

/** The open issues of the days `from`–`to`, in the order a person works them off: questions, contradicting codes, unbooked payments, receipts without a payment. */
export function periodIssues(books: Index, questions: readonly Question[], from: string, to: string, accounts: readonly LedgerBankAccount[], orderPages: ReadonlyMap<string, OrderPage> = new Map()): PeriodIssue[] {
  const within = (d: string | undefined): d is string => !!d && d >= from && d <= to;
  const asked = questions.flatMap((q): PeriodIssue[] => {
    const date = q.status === 'open' ? dateOn(books, q) : undefined;
    return within(date) ? [{ kind: 'question', q, date }] : [];
  });
  const evidence = journalOf(books).views.flatMap((v): PeriodIssue[] => (v.evidence && within(v.e.date) ? [{ kind: 'evidence', entry: v.e, check: v.evidence }] : []));
  const unbooked = unbookedPayments(books, accounts).filter((t) => within(t.date)).map((tx): PeriodIssue => ({ kind: 'unbooked', tx }));
  const l = ledgerOf(books, from, undefined, orderPages);
  const unlinked = l.views.filter((v) => needsYou(v, l) && within(v.date) && !v.r.filedPayment).map((v): PeriodIssue => ({ kind: 'unlinked', receipt: v.r }));
  return [...asked, ...evidence, ...unbooked, ...unlinked];
}

/**
 * How many issues of each kind are open: one line beside a figure that is not final (the return's page, #341).
 * `waitingReceipt`: of the unbooked payments, those the app holds until their receipt comes.
 */
export interface IssueCounts { total: number; questions: number; evidence: number; unbooked: number; waitingReceipt: number; unlinked: number }

const heldForReceipt = (t: BankTransaction) => !!t.waitsForReceipt && !t.noReceiptNeeded;

export function countIssues(issues: readonly PeriodIssue[]): IssueCounts {
  const of = (kind: PeriodIssue['kind']) => issues.filter((i) => i.kind === kind).length;
  return {
    total: issues.length, questions: of('question'), evidence: of('evidence'), unbooked: of('unbooked'), unlinked: of('unlinked'),
    waitingReceipt: issues.filter((i) => i.kind === 'unbooked' && heldForReceipt(i.tx)).length,
  };
}

/**
 * The payments of every period not filed that nobody booked, and the oldest of them: what «nothing
 * waits for you» must not hide (#341). The same payments as the period's issues, over all open days.
 */
export function unbookedOpen(books: Pick<Index, 'transactions' | 'journalEntries' | 'config'>, accounts: readonly LedgerBankAccount[]): { unbooked: number; waitingReceipt: number; first?: BankTransaction } {
  const open = unbookedPayments(books, accounts);
  return { unbooked: open.length, waitingReceipt: open.filter(heldForReceipt).length, ...(open[0] ? { first: open[0] } : {}) };
}
