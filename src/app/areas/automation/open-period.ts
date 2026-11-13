/**
 * Where the oldest period not filed stands (#342): what a person means by «was muss ich noch machen?».
 * Nothing here is computed anew. The period is the books' open one (booksOpenPeriod), its points and
 * their counts are the review's «Noch offen» list (periodIssues, countIssues: what the return's page
 * shows beside a figure that is not final), the payments the app holds for their receipt are
 * receiptWaits (receiptWaiting, with what each waits for), the due day is the home's filing stage, and
 * the tasks are the workflows' own. What waits outside the period is `elsewhereOf`: the card and the
 * note say that nothing is open only when Aufgaben has nothing either.
 * Pure: the AI sidebar's card draws it in the browser, and the server writes the same state into
 * the assistant's message (src/server/open-work.ts), so the words and the card never disagree.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { EvidenceCheck } from '../../../accounting/evidence-check.js';
import type { Question } from '../../../questions/model.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import type { OrderPage } from '../../../booking/order-pages.js';
import type { Task } from '../../../workflows/model.js';
import { addDays, booksOpenPeriod, localToday, type FilingLength, type IsoDate, type Period } from '../../../accounting/periods.js';
import type { WaitingPayment } from '../../../accounting/receipt-due.js';
import { missingAssessments, type MissingAssessment } from '../../../booking/customs-invoice.js';
import { documents, withoutInputTax } from '../../../engines/index.js';
import { filingStage, placedReceiptDay, type FilingStage } from '../../automation/home.js';
import { unbookedPayments } from '../bank/model.js';
import { journalOf, unsettledAtFiling, type EntryView, type Unsettled } from '../journal/model.js';
import { ledgerOf, type ReceiptView } from '../receipts/model.js';
import { thresholdPassed } from '../vat/model.js';
import { countIssues, dateOn, periodIssues, receiptWaiting, type IssueCounts, type PeriodIssue } from './period-issues.js';
import type { Processing } from '../../../workflows/processing.js';
import type { HeldOrder, MissingBill, ProviderIssues } from '../../../booking/provider-issues.js';
import { issuedByFirm, ownNumbers, type Firm } from '../../../intake/own-invoice.js';
import { agreedBasis } from '../../../engines/index.js';
import { missingOpenings, type MissingOpening } from '../../../accounting/opening-balance.js';
import { balanceAt } from '../../../booking/providers.js';

export interface OpenPeriodContext {
  today: IsoDate;
  /** The firm files VAT returns (chargesVat). */
  vatRegistered: boolean;
  /** filing().length and filing().dueDays. */
  length: FilingLength;
  dueDays: number;
  /** The payments to the owner that wait for her outlays (outlayWaitsOf on the server, #428). */
  outlays?: ReadonlySet<string>;
  /** The firm (company.uid, .name): an invoice it issued waits for its customer, not for the person (#428). */
  firm?: Firm;
}

/** A share the setup named, offered as a rule and not answered yet (src/saving/share-rule.ts setupShareOffers, #428). */
export type { PendingOffer } from '../../../saving/share-rule.js';
import type { PendingOffer } from '../../../saving/share-rule.js';

/** A provider's clearing account below zero at the period's end (#428): the provider paid out more than the account holds sales for. */
export interface ClearingBelow { name: string; account: string; balance: number }

export interface OpenPeriodState {
  period: Period;
  filing: FilingStage;
  /** The counts of the review's list for the period (countIssues): the numbers the return's page shows. */
  counts: IssueCounts;
  /** The period's payments without a booking, oldest first: those the app holds among them. */
  unbooked: BankTransaction[];
  /**
   * Of `unbooked`, the payments the app holds (receiptWaits, so `counts.waitingReceipt` of them): `waits` for its receipt (the app's work),
   * `asks` for it (the return is near: the person's, a task), `unread` (its receipt is linked and its
   * VAT cannot be read: the person's, at once).
   */
  waiting: WaitingPayment[];
  /** Open questions about the period's payments, receipts and bookings, each with the day of what it is about. */
  questions: Array<{ q: Question; date: string }>;
  /** Bookings whose VAT code contradicts their receipts, each with what contradicts. */
  evidence: Array<{ entry: JournalEntry; check: EvidenceCheck }>;
  /** Receipts without a payment, the firm's own invoices not among them. */
  unlinked: Receipt[];
  /** The firm's own invoices that only wait for their customer (waitsForCustomer): nothing for the person to do (#428). */
  issued: Receipt[];
  /** The first year's bank accounts the books open at nothing while their statements say they held money (missingOpenings, any currency): Firma › Eröffnung (#428). */
  openings: MissingOpening[];
  /** The providers' clearing accounts below zero at the period's end (#428). */
  clearing: ClearingBelow[];
  /** The setup's shares offered as rules and not answered yet (#428). */
  offers: PendingOffer[];
  /** Orders a provider's sales report holds: their turnover is not in the return yet (#405). */
  held: HeldOrder[];
  /** Months of a provider's fees whose bill is not in the books (#405). */
  bills: MissingBill[];
  /**
   * The receipts that wait for the person's own word (#398): periodIssues' `own`, Belege's «braucht dich»
   * that lack their date or amount, their reading, or her word that they are no copy. None is in `unlinked`.
   */
  yours: YourReceipt[];
  /**
   * The workflows' tasks about the period: on a payment, a receipt or a booking dated in it, or on
   * the period itself («Abrechnung prüfen»). A task of another period, or of nothing dated (a source),
   * is not this period's state.
   */
  tasks: Task[];
}

export type { Lack } from './period-issues.js';
/** A receipt that waits for the person's own word: the issue of periodIssues (#398). */
export type YourReceipt = Extract<PeriodIssue, { kind: 'own' }>;

/** The day of what a task is about, or `period` when it is about the period itself; undefined: about nothing dated. */
function taskDay(books: Index, item: Task['item'], openFrom: IsoDate): IsoDate | 'period' | undefined {
  switch (item.kind) {
    case 'transaction': return books.transactions.find((t) => t.ref === item.id)?.date;
    // The day Belege lists it under (#385 review): an undated receipt is the working period's, one paid later its payment's.
    case 'receipt': { const r = books.receipts.find((x) => x.id === item.id); return r ? placedReceiptDay(books, r, openFrom) : undefined; }
    case 'entry': return (books.journalEntries ?? []).find((e) => e.id === item.id)?.date;
    case 'period': return 'period';
    default: return undefined;
  }
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether a receipt without a payment is the firm's own invoice that only waits for its customer,
 * nothing for the person to do (#428). Only when that is sure: the receipt shows the firm's UID and
 * no other (a name alone is no proof), no money in may be its payment (one booked without the link
 * is hers to pair), and on the agreed basis its issue is booked as a
 * receivable (an invoice dropped, not issued in the app, has no event: its turnover is VAT work).
 */
/** Money in, on or after the invoice's day and linked to no receipt, of its amount or naming its number: it may be its payment, booked without the link. */
function mayBePaid(books: Index, r: Receipt): boolean {
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const numbers = ownNumbers(r).map(squash);
  return books.transactions.some((t) => t.direction === 'CRDT' && !linked.has(t.ref) && (!r.date || t.date >= r.date)
    && ((r.amount != null && t.currency === (r.currency ?? t.currency) && Math.round(t.amount * 100) === Math.round(Math.abs(r.amount) * 100))
      || numbers.some((n) => n.length >= 4 && squash(`${t.description} ${t.reference ?? ''} ${t.remarks ?? ''}`).includes(n))));
}

export function waitsForCustomer(books: Index, r: Receipt, firm: Firm | undefined): boolean {
  if (issuedByFirm(r, firm) !== 'uid') return false;
  if (mayBePaid(books, r)) return false;
  if (!agreedBasis()) return true;
  const events = new Set((books.journalEntries ?? []).filter((e) => /^(RE|GS)-/.test(e.transactionRef) && !e.transactionRef.endsWith('-storno')).map((e) => squash(e.transactionRef)));
  return ownNumbers(r).some((n) => events.has(squash(n)) || events.has(`re${squash(n)}`));
}

export function openPeriodState(
  books: Index, questions: readonly Question[], tasks: readonly Task[], accounts: readonly LedgerBankAccount[], ctx: OpenPeriodContext,
  orderPages: ReadonlyMap<string, OrderPage> = new Map(), processing: ReadonlyMap<string, Processing> = new Map(), provider?: ProviderIssues,
  offers: readonly PendingOffer[] = [],
): OpenPeriodState {
  const period = booksOpenPeriod(books, ctx.today, ctx.length);
  const issues = periodIssues(books, questions, period.from, period.to, accounts, orderPages, ctx.today, processing, provider, ctx.outlays);
  const unbooked = issues.flatMap((i) => (i.kind === 'unbooked' ? [i.tx] : []));
  const unlinked = issues.flatMap((i) => (i.kind === 'unlinked' ? [i.receipt] : []));
  const refs = new Set(unbooked.map((t) => t.ref));
  const about = (x: Task) => { const d = taskDay(books, x.item, period.from); return d === 'period' ? x.item.id === period.token : !!d && d >= period.from && d <= period.to; };
  return {
    period,
    filing: filingStage(books, period, ctx),
    counts: countIssues(issues),
    unbooked,
    // The same payments as the issues' `waitsForReceipt` (both are receiptWaits), with what each waits for.
    waiting: receiptWaiting(books, accounts, ctx.today, ctx.outlays).filter((w) => refs.has(w.tx.ref)),
    questions: issues.flatMap((i) => (i.kind === 'question' ? [{ q: i.q, date: i.date }] : [])),
    evidence: issues.flatMap((i) => (i.kind === 'evidence' ? [{ entry: i.entry, check: i.check }] : [])),
    unlinked: unlinked.filter((r) => !waitsForCustomer(books, r, ctx.firm)),
    issued: unlinked.filter((r) => waitsForCustomer(books, r, ctx.firm)),
    openings: missingOpenings(books, accounts, period.to.slice(0, 4), 'all'),
    clearing: (provider?.clearing ?? []).flatMap((c): ClearingBelow[] => {
      const balance = balanceAt(books.journalEntries ?? [], c.account, period.to, books.config?.openingBalances);
      return balance < 0 ? [{ name: c.name, account: c.account, balance }] : [];
    }),
    // Only the period's: its payment is dated in it, as everything the state counts.
    offers: offers.filter((o) => o.date >= period.from && o.date <= period.to),
    yours: issues.flatMap((i) => (i.kind === 'own' ? [i] : [])),
    held: issues.flatMap((i) => (i.kind === 'held' ? [i.held] : [])),
    bills: issues.flatMap((i) => (i.kind === 'bill' ? [i.bill] : [])),
    tasks: tasks.filter(about),
  };
}

/**
 * What waits for the person under Aufgaben outside the period `s` describes: questions, tasks and
 * stopped runs, payments of the other open days without a booking (unbookedPayments, the payments
 * unbookedOpen counts), bookings against their receipts, those a filing left, possible duplicates and
 * missing customs assessments, and the turnover threshold a firm not registered passed. Nothing of `s` is in it. `stuck`: the runs that stopped.
 */
export interface Elsewhere<T extends Task = Task> {
  open: Question[];
  /** Questions answered, not yet marked done by the person who asked (the app's own need no reading). */
  answered: Question[];
  tasks: T[];
  unbooked: BankTransaction[];
  contradicting: EntryView[];
  unsettled?: { period: string; items: Unsettled[] };
  twins: ReceiptView[];
  assessments: MissingAssessment[];
  stuck: number;
  /** The years whose turnover passed the registration threshold of a firm not registered (thresholdPassed): a task on Aufgaben without a run. */
  threshold: string[];
}

export function elsewhereOf<T extends Task>(books: Index, questions: readonly Question[], tasks: readonly T[], accounts: readonly LedgerBankAccount[], s: OpenPeriodState, length: FilingLength, stuck = 0, registered?: boolean, today: IsoDate = localToday()): Elsewhere<T> {
  const closed = books.config?.closedThrough;
  const inOpen = (date: string | undefined) => !closed || !date || date > closed;
  const listed = { questions: new Set(s.questions.map((x) => x.q.id)), tasks: new Set(s.tasks.map((x) => x.run)), payments: new Set(s.unbooked.map((p) => p.ref)), entries: new Set(s.evidence.map((x) => x.entry.id)), receipts: new Set(s.yours.map((x) => x.receipt.id)) };
  const left = questions.filter((q) => q.status !== 'closed' && inOpen(dateOn(books, q)) && !listed.questions.has(q.id));
  const others = tasks.filter((x) => !listed.tasks.has(x.run));
  const taskRefs = new Set(others.filter((x) => x.item.kind === 'transaction').map((x) => x.item.id));
  const journal = journalOf(books);
  const unsettled = unsettledAtFiling(journal, length);
  return {
    open: left.filter((q) => q.status === 'open'),
    answered: left.filter((q) => q.status === 'answered' && q.origin !== 'booking'),
    tasks: others,
    unbooked: unbookedPayments(books, accounts).filter((p) => !listed.payments.has(p.ref) && !taskRefs.has(p.ref)),
    contradicting: journal.views.filter((v) => v.evidence && !listed.entries.has(v.e.id)),
    ...(unsettled?.items.length ? { unsettled } : {}),
    twins: ledgerOf(books, closed ? addDays(closed, 1) : '0000-01-01').views.filter((v) => v.twin?.relation === 'duplicate' && !v.none && !v.locked && !listed.receipts.has(v.r.id)),
    assessments: missingAssessments(books, documents().customs, !withoutInputTax()),
    stuck,
    threshold: thresholdPassed(books, registered, today).map((w) => w.year),
  };
}

/** How many things wait outside the period, each counted once. */
export const elsewhereCount = (e: Elsewhere): number =>
  e.open.length + e.answered.length + e.tasks.length + e.unbooked.length + e.contradicting.length + (e.unsettled?.items.length ?? 0) + e.twins.length + e.assessments.length + e.stuck + e.threshold.length;

/** Whether anything of the period waits: a card with nothing on it says so in one line (and that nothing else does, only when `elsewhereOf` is empty too). */
export const nothingOpen = (s: OpenPeriodState): boolean =>
  !s.unbooked.length && !s.questions.length && !s.evidence.length && !s.unlinked.length && !s.yours.length && !s.held.length && !s.tasks.length
  && !s.offers.length && !s.openings.length && !s.clearing.length;

/** How many of the held payments are of each kind. */
export const waitingKinds = (s: Pick<OpenPeriodState, 'waiting'>): Record<WaitingPayment['kind'] | 'outlays', number> => ({
  waits: s.waiting.filter((w) => w.kind === 'waits' && !w.outlays).length,
  asks: s.waiting.filter((w) => w.kind === 'asks' && !w.outlays).length,
  unread: s.waiting.filter((w) => w.kind === 'unread').length,
  outlays: s.waiting.filter((w) => w.outlays).length,
});

/** The most tasks the card lists one by one; the rest is counted in one line. */
export const TASKS_SHOWN = 5;

/** The most objects a line names one by one (#398): the rest is counted, with the way to all of them. */
export const ITEMS_SHOWN = 5;

/** One line of the state: what it counts, the objects it names one by one (at most ITEMS_SHOWN, `more` beyond them), and the first, where the person starts. */
export type OpenLine =
  /** The receipts that wait for her own word (`yours`). */
  | { kind: 'yours'; n: number; items: YourReceipt[]; more: number }
  /** `waiting`: of them held by receiptWaits (countIssues' `waitingReceipt`, as the return's page says); `unread`: of those, held because their receipt's VAT cannot be read. */
  | { kind: 'unbooked'; n: number; waiting: number; outlays: number; unread: number; first: BankTransaction; items: BankTransaction[]; more: number }
  | { kind: 'questions'; n: number }
  | { kind: 'evidence'; n: number; first: JournalEntry }
  /** The receipts without a payment (none of `yours` among them). */
  | { kind: 'unlinked'; n: number; first: Receipt; items: Receipt[]; more: number }
  | { kind: 'held'; n: number; first: HeldOrder }
  | { kind: 'bills'; n: number; first: MissingBill }
  /** The setup's shares offered as rules, each on its payment: one click there (#428). */
  | { kind: 'offers'; n: number; first: PendingOffer; items: PendingOffer[]; more: number }
  /** Bank accounts without their opening balance: Firma › Eröffnung (#428). */
  | { kind: 'openings'; n: number; first: MissingOpening; items: MissingOpening[]; more: number }
  /** A provider's clearing account below zero at the period's end (#428). */
  | { kind: 'clearing'; n: number; first: ClearingBelow; items: ClearingBelow[]; more: number }
  | { kind: 'task'; task: Task }
  /** The tasks beyond TASKS_SHOWN. */
  | { kind: 'moreTasks'; n: number };

const shown = <T>(all: readonly T[]) => ({ n: all.length, items: all.slice(0, ITEMS_SHOWN), more: Math.max(0, all.length - ITEMS_SHOWN) });

/**
 * The state as the lines of its card, most important first, as code ranks them (#428): what holds
 * the return's approval (an order a report could not split, an open VAT question), what only she can
 * say of a receipt, the payments without a booking, the bookings against their receipts, an offer
 * that waits for one click, a missing opening, a clearing account below zero, the receipts without a
 * payment, the provider's missing bills, and the tasks last, the review among them. The AI's note
 * lists its facts in the same order and the model starts with the first. A task on a payment counted
 * in the payments' line is that payment, and a receipt of `yours` is not among those without a
 * payment: each object is named once. At most TASKS_SHOWN tasks are lines of their own.
 */
export function openLines(s: OpenPeriodState): OpenLine[] {
  const refs = new Set(s.unbooked.map((t) => t.ref));
  const tasks = s.tasks.filter((x) => !(x.item.kind === 'transaction' && refs.has(x.item.id)));
  const kinds = waitingKinds(s);
  const unlinked = s.unlinked;
  return [
    ...(s.held.length ? [{ kind: 'held' as const, n: s.held.length, first: s.held[0] }] : []),
    ...(s.counts.questions ? [{ kind: 'questions' as const, n: s.counts.questions }] : []),
    ...(s.yours.length ? [{ kind: 'yours' as const, ...shown(s.yours) }] : []),
    ...(s.counts.unbooked ? [{ kind: 'unbooked' as const, ...shown(s.unbooked), n: s.counts.unbooked, waiting: s.counts.waitingReceipt, outlays: s.counts.waitingOutlays, unread: kinds.unread, first: s.unbooked[0] }] : []),
    ...(s.counts.evidence ? [{ kind: 'evidence' as const, n: s.counts.evidence, first: s.evidence[0].entry }] : []),
    ...(s.offers.length ? [{ kind: 'offers' as const, ...shown(s.offers), first: s.offers[0] }] : []),
    ...(s.openings.length ? [{ kind: 'openings' as const, ...shown(s.openings), first: s.openings[0] }] : []),
    ...(s.clearing.length ? [{ kind: 'clearing' as const, ...shown(s.clearing), first: s.clearing[0] }] : []),
    ...(unlinked.length ? [{ kind: 'unlinked' as const, ...shown(unlinked), first: unlinked[0] }] : []),
    ...(s.bills.length ? [{ kind: 'bills' as const, n: s.bills.length, first: s.bills[0] }] : []),
    ...tasks.slice(0, TASKS_SHOWN).map((task) => ({ kind: 'task' as const, task })),
    ...(tasks.length > TASKS_SHOWN ? [{ kind: 'moreTasks' as const, n: tasks.length - TASKS_SHOWN }] : []),
  ];
}
