/**
 * What is still open in a period before its return is filed (r4c-38): the questions about its
 * payments, receipts and bookings, the bookings whose code contradicts their receipts (input tax
 * without a receipt, a receipt that shows VAT on a zero code), the payments nobody booked, and the
 * receipts without a payment. The review lists them, each a link; none blocks the filing.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { EvidenceCheck } from '../../../accounting/evidence-check.js';
import type { Question } from '../../../questions/model.js';
import { journalOf } from '../journal/model.js';
import { ledgerOf, needsYou } from '../receipts/model.js';
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
export function periodIssues(books: Index, questions: readonly Question[], from: string, to: string): PeriodIssue[] {
  const within = (d: string | undefined): d is string => !!d && d >= from && d <= to;
  const asked = questions.flatMap((q): PeriodIssue[] => {
    const date = q.status === 'open' ? dateOn(books, q) : undefined;
    return within(date) ? [{ kind: 'question', q, date }] : [];
  });
  const evidence = journalOf(books).views.flatMap((v): PeriodIssue[] => (v.evidence && within(v.e.date) ? [{ kind: 'evidence', entry: v.e, check: v.evidence }] : []));
  const unbooked = unbookedPayments(books).filter((t) => within(t.date)).map((tx): PeriodIssue => ({ kind: 'unbooked', tx }));
  const l = ledgerOf(books, from);
  const unlinked = l.views.filter((v) => needsYou(v, l) && within(v.date) && !v.r.filedPayment).map((v): PeriodIssue => ({ kind: 'unlinked', receipt: v.r }));
  return [...asked, ...evidence, ...unbooked, ...unlinked];
}
