/**
 * What is still open in a period before its return is filed (r4c-38): the questions about its
 * payments, receipts and bookings, the bookings whose code contradicts their receipts (input tax
 * without a receipt, a receipt that shows VAT on a zero code), the payments nobody booked, and the
 * receipts without a payment, the orders a provider's sales report holds and the months of a
 * provider's fees whose bill is not in the books (src/booking/provider-issues.ts, #405). The review
 * lists them, each a link; an open VAT question and a held order withhold the approval
 * (filing-summary.ts approvalWithheld, r8h-24, #405), the rest blocks nothing.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { EvidenceCheck } from '../../../accounting/evidence-check.js';
import type { Question } from '../../../questions/model.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { journalOf } from '../journal/model.js';
import { ledgerOf, needsYou, type ReceiptView } from '../receipts/model.js';
import type { Processing } from '../../../workflows/processing.js';
import { waitsForReading } from '../../../parsers/receipt-text.js';
import type { OrderPage } from '../../../booking/order-pages.js';
import { unbookedPayments } from '../bank/model.js';
import { bookedStates } from '../../../accounting/payment-entries.js';
import { waitingForReceipt, type WaitingPayment } from '../../../accounting/receipt-due.js';
import { localToday, type IsoDate } from '../../../accounting/periods.js';
import type { HeldOrder, MissingBill, ProviderIssues } from '../../../booking/provider-issues.js';
import { repaysOwnerShape } from '../../../booking/owner-outlays.js';

export type PeriodIssue =
  | { kind: 'question'; q: Question; date: string }
  | { kind: 'evidence'; entry: JournalEntry; check: EvidenceCheck }
  /** `waitsForReceipt`: the app holds it until its receipt comes or can be read (receiptWaits); `waitsForOutlays`: a payment to the owner held until the outlays it pays back are booked (#428). */
  | { kind: 'unbooked'; tx: BankTransaction; waitsForReceipt?: true; waitsForOutlays?: true }
  | { kind: 'unlinked'; receipt: Receipt }
  /** A receipt that waits for the person's own word (#398): its date, its amount, its reading, or whether it is a copy (`copyOf`). */
  | { kind: 'own'; receipt: Receipt; name: string; lacks: Lack[]; day: string; copyOf?: string }
  /** An order a provider's sales report did not book: its turnover is not in the return yet (#405). */
  | { kind: 'held'; held: HeldOrder }
  /** A month of a provider's fees without its bill: the VAT on them is not deducted yet (#405). */
  | { kind: 'bill'; bill: MissingBill };

/** What a receipt lacks for the app to go on without the person: its date, its amount, its reading, or her word that it is no copy. */
export type Lack = 'date' | 'amount' | 'reading' | 'copy';

/** The words of each lack, as Belege's row says them: the keys of the app's dictionaries. */
export const LACK_WORDS: Record<Lack, 'receipts.dateMissing' | 'receipts.amountMissing' | 'openPeriod.lack.reading' | 'openPeriod.lack.copy'> = {
  date: 'receipts.dateMissing', amount: 'receipts.amountMissing', reading: 'openPeriod.lack.reading', copy: 'openPeriod.lack.copy',
};

/** What `v` lacks, in the order Belege's row says it; empty when it only waits for its payment. */
export function lacksOf(v: ReceiptView): Lack[] {
  const reading = waitsForReading(v.r);
  return [
    ...(reading ? ['reading' as const] : [...(!v.date ? ['date' as const] : []), ...(v.r.amount == null ? ['amount' as const] : [])]),
    ...(v.twin?.relation === 'duplicate' ? ['copy' as const] : []),
  ];
}

/** The date of what a question is about, or undefined when it is gone from the books. */
export function dateOn(books: Pick<Index, 'transactions' | 'receipts' | 'journalEntries'>, q: Question): string | undefined {
  switch (q.on.kind) {
    case 'payment': return books.transactions.find((t) => t.ref === q.on.id)?.date;
    case 'receipt': return books.receipts.find((r) => r.id === q.on.id)?.date;
    case 'entry': return (books.journalEntries ?? []).find((e) => e.id === q.on.id)?.date;
  }
}

/**
 * The open issues of the days `from`–`to`, in the order a person works them off: questions, held orders, contradicting codes,
 * unbooked payments, receipts that wait for her word, receipts without a payment, missing bills of a provider. `provider`:
 * what the providers' reports leave open (#405). `owner`: the owner's name (company.owner), which tells a payment to her that
 * waits for her outlays from one that waits for its receipt (#428).
 */
export function periodIssues(books: Index, questions: readonly Question[], from: string, to: string, accounts: readonly LedgerBankAccount[], orderPages: ReadonlyMap<string, OrderPage> = new Map(), today: IsoDate = localToday(), processing: ReadonlyMap<string, Processing> = new Map(), provider?: ProviderIssues, owner?: string): PeriodIssue[] {
  const within = (d: string | undefined): d is string => !!d && d >= from && d <= to;
  const asked = questions.flatMap((q): PeriodIssue[] => {
    const date = q.status === 'open' ? dateOn(books, q) : undefined;
    return within(date) ? [{ kind: 'question', q, date }] : [];
  });
  const evidence = journalOf(books).views.flatMap((v): PeriodIssue[] => (v.evidence && within(v.e.date) ? [{ kind: 'evidence', entry: v.e, check: v.evidence }] : []));
  const waits = new Map(receiptWaiting(books, accounts, today, owner).map((w) => [w.tx.ref, w]));
  const unbooked = unbookedPayments(books, accounts).filter((t) => within(t.date)).map((tx): PeriodIssue => {
    const w = waits.get(tx.ref);
    return { kind: 'unbooked', tx, ...(w ? (w.outlays ? { waitsForOutlays: true as const } : { waitsForReceipt: true as const }) : {}) };
  });
  const l = ledgerOf(books, from, processing, orderPages);
  // The receipts that wait for her own word (#398), placed as Belege places them (an undated one in the working period), each named
  // once: not again among those without a payment. A receipt a run still reads is not hers yet (needsYou, `processing`).
  const own = l.views.flatMap((v): PeriodIssue[] => {
    const lacks = lacksOf(v);
    return lacks.length && needsYou(v, l) && within(v.day) && !v.r.filedPayment
      ? [{ kind: 'own', receipt: v.r, name: v.vendor || v.r.filename, lacks, day: v.day!, ...(v.twin?.relation === 'duplicate' ? { copyOf: v.twin.of } : {}) }] : [];
  });
  const mine = new Set(own.map((i) => (i as { receipt: Receipt }).receipt.id));
  const unlinked = l.views.filter((v) => needsYou(v, l) && within(v.date) && !v.r.filedPayment && !mine.has(v.r.id)).map((v): PeriodIssue => ({ kind: 'unlinked', receipt: v.r }));
  const orders = (provider?.held ?? []).filter((h) => !h.filed && within(h.date)).map((h): PeriodIssue => ({ kind: 'held', held: h }));
  const bills = (provider?.bills ?? []).filter((b) => within(b.date)).map((b): PeriodIssue => ({ kind: 'bill', bill: b }));
  return [...asked, ...orders, ...evidence, ...unbooked, ...own, ...unlinked, ...bills];
}

/**
 * The payments the app does not book because their receipt is not there or cannot be read
 * (src/accounting/receipt-due.ts `waitingForReceipt`, issue #29, #57), by ref: the one answer to
 * «wartet auf ihren Beleg» for the drop's summary, the return's page, Automatisierung and Aufgaben.
 * It holds the ones whose return is near too (then a task of the person's on Aufgaben). Given the
 * owner's name, not the payments to her that wait for her outlays (#428): no receipt of theirs is missing.
 */
export function receiptWaits(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts' | 'config'>, accounts: readonly LedgerBankAccount[], today: IsoDate = localToday(), owner?: string): Set<string> {
  return new Set(receiptWaiting(books, accounts, today, owner).filter((w) => !w.outlays).map((w) => w.tx.ref));
}

/**
 * `receiptWaits` with what each payment waits for (`waits`, `asks`, `unread`): the AI sidebar's card and note tell the kinds apart (#342).
 * `outlays`: a payment to the owner by name (`owner`, on a firm with her account) waits for the outlays it pays back (#428).
 */
export function receiptWaiting(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts' | 'config'>, accounts: readonly LedgerBankAccount[], today: IsoDate = localToday(), owner?: string): WaitingPayment[] {
  const booked = bookedStates(books, accounts);
  const hers = !!owner && accounts.some((a) => a.role === 'owner');
  return waitingForReceipt(books, (ref) => booked(ref) === 'booked', today)
    .map((w) => (hers && w.kind !== 'unread' && repaysOwnerShape(w.tx, owner) ? { ...w, outlays: true as const } : w));
}

/**
 * What of the list withholds the approval of the return, as filing-summary.ts approvalWithheld
 * reads it: the open VAT questions about its sales and the orders a sales report could not split by
 * rate. `rest`: what holds nothing up. The list's lead names only what is there (#428): a firm
 * without a provider never reads of a sales report.
 */
export function withholding(issues: readonly PeriodIssue[]): { questions: number; orders: number; rest: number } {
  const questions = issues.filter((i) => i.kind === 'question' && i.q.topic === 'saleVat').length;
  const orders = issues.filter((i) => i.kind === 'held' && i.held.why === 'rate').length;
  return { questions, orders, rest: issues.length - questions - orders };
}

/** A text of the app's dictionaries (the UI's `t`, or formatIn of one language). */
export type Say = (key: string, vars?: Record<string, string | number>) => string;

/** The list's lead: what of it withholds the approval, named only when it is there (withholding), and whether the rest blocks nothing. */
export function issuesLead(issues: readonly PeriodIssue[], say: Say): string {
  const w = withholding(issues);
  const parts = [w.questions ? say('issues.lead.question', { n: w.questions }) : '', w.orders ? say('issues.lead.order', { n: w.orders }) : ''].filter(Boolean);
  if (!parts.length) return say('issues.lead.nothing');
  const what = parts.length === 2 ? say('issues.lead.and', { a: parts[0], b: parts[1] }) : parts[0];
  const held = say(w.questions + w.orders === 1 ? 'issues.lead.withholdsOne' : 'issues.lead.withholdsMany', { what: what.charAt(0).toUpperCase() + what.slice(1) });
  return w.rest ? `${held} ${say('issues.lead.rest')}` : held;
}

/**
 * How many issues of each kind are open: one line beside a figure that is not final (the return's
 * page, #341). `waitingReceipt`: of the unbooked payments, those in `receiptWaits`; `waitingOutlays`:
 * those to the owner that wait for her outlays (#428).
 */
export interface IssueCounts { total: number; questions: number; evidence: number; unbooked: number; waitingReceipt: number; waitingOutlays: number; unlinked: number; own: number; held: number; bills: number }

export function countIssues(issues: readonly PeriodIssue[]): IssueCounts {
  const of = (kind: PeriodIssue['kind']) => issues.filter((i) => i.kind === kind).length;
  return {
    // A missing bill is information, not an open item: the period's figure is final without it.
    total: issues.length - of('bill'), questions: of('question'), evidence: of('evidence'), unbooked: of('unbooked'), unlinked: of('unlinked'), own: of('own'), held: of('held'), bills: of('bill'),
    waitingReceipt: issues.filter((i) => i.kind === 'unbooked' && i.waitsForReceipt).length,
    waitingOutlays: issues.filter((i) => i.kind === 'unbooked' && i.waitsForOutlays).length,
  };
}

/**
 * The payments of every period not filed that nobody booked, and the oldest of them: what «nothing
 * waits for you» must not hide (#341). The same payments as the period's issues, over all open days.
 */
export function unbookedOpen(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts' | 'config'>, accounts: readonly LedgerBankAccount[], today: IsoDate = localToday(), owner?: string): { unbooked: number; waitingReceipt: number; waitingOutlays: number; first?: BankTransaction } {
  const open = unbookedPayments(books, accounts);
  const waits = new Map(receiptWaiting(books, accounts, today, owner).map((w) => [w.tx.ref, w]));
  const count = (outlays: boolean) => open.filter((t) => waits.has(t.ref) && !!waits.get(t.ref)!.outlays === outlays).length;
  return { unbooked: open.length, waitingReceipt: count(false), waitingOutlays: count(true), ...(open[0] ? { first: open[0] } : {}) };
}
