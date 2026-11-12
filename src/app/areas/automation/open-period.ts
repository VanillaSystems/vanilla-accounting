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
import { addDays, booksOpenPeriod, type FilingLength, type IsoDate, type Period } from '../../../accounting/periods.js';
import type { WaitingPayment } from '../../../accounting/receipt-due.js';
import { missingAssessments, type MissingAssessment } from '../../../booking/customs-invoice.js';
import { documents, withoutInputTax } from '../../../engines/index.js';
import { filingStage, receiptDay, type FilingStage } from '../../automation/home.js';
import { unbookedPayments } from '../bank/model.js';
import { journalOf, unsettledAtFiling, type EntryView, type Unsettled } from '../journal/model.js';
import { ledgerOf, type ReceiptView } from '../receipts/model.js';
import { countIssues, dateOn, periodIssues, receiptWaiting, type IssueCounts } from './period-issues.js';

export interface OpenPeriodContext {
  today: IsoDate;
  /** The firm files VAT returns (chargesVat). */
  vatRegistered: boolean;
  /** filing().length and filing().dueDays. */
  length: FilingLength;
  dueDays: number;
}

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
  /** Receipts without a payment. */
  unlinked: Receipt[];
  /**
   * The workflows' tasks about the period: on a payment, a receipt or a booking dated in it, or on
   * the period itself («Abrechnung prüfen»). A task of another period, or of nothing dated (a source),
   * is not this period's state.
   */
  tasks: Task[];
}

/** The day of what a task is about, or `period` when it is about the period itself; undefined: about nothing dated. */
function taskDay(books: Index, item: Task['item']): IsoDate | 'period' | undefined {
  switch (item.kind) {
    case 'transaction': return books.transactions.find((t) => t.ref === item.id)?.date;
    case 'receipt': { const r = books.receipts.find((x) => x.id === item.id); return r ? receiptDay(r) : undefined; }
    case 'entry': return (books.journalEntries ?? []).find((e) => e.id === item.id)?.date;
    case 'period': return 'period';
    default: return undefined;
  }
}

export function openPeriodState(
  books: Index, questions: readonly Question[], tasks: readonly Task[], accounts: readonly LedgerBankAccount[], ctx: OpenPeriodContext,
  orderPages: ReadonlyMap<string, OrderPage> = new Map(),
): OpenPeriodState {
  const period = booksOpenPeriod(books, ctx.today, ctx.length);
  const issues = periodIssues(books, questions, period.from, period.to, accounts, orderPages, ctx.today);
  const unbooked = issues.flatMap((i) => (i.kind === 'unbooked' ? [i.tx] : []));
  const refs = new Set(unbooked.map((t) => t.ref));
  const about = (x: Task) => { const d = taskDay(books, x.item); return d === 'period' ? x.item.id === period.token : !!d && d >= period.from && d <= period.to; };
  return {
    period,
    filing: filingStage(books, period, ctx),
    counts: countIssues(issues),
    unbooked,
    // The same payments as the issues' `waitsForReceipt` (both are receiptWaits), with what each waits for.
    waiting: receiptWaiting(books, accounts, ctx.today).filter((w) => refs.has(w.tx.ref)),
    questions: issues.flatMap((i) => (i.kind === 'question' ? [{ q: i.q, date: i.date }] : [])),
    evidence: issues.flatMap((i) => (i.kind === 'evidence' ? [{ entry: i.entry, check: i.check }] : [])),
    unlinked: issues.flatMap((i) => (i.kind === 'unlinked' ? [i.receipt] : [])),
    tasks: tasks.filter(about),
  };
}

/**
 * What waits for the person under Aufgaben outside the period `s` describes: questions, tasks and
 * stopped runs, payments of the other open days without a booking (unbookedPayments, the payments
 * unbookedOpen counts), bookings against their receipts, those a filing left, possible duplicates and
 * missing customs assessments. Nothing of `s` is in it. `stuck`: the runs that stopped.
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
}

export function elsewhereOf<T extends Task>(books: Index, questions: readonly Question[], tasks: readonly T[], accounts: readonly LedgerBankAccount[], s: OpenPeriodState, length: FilingLength, stuck = 0): Elsewhere<T> {
  const closed = books.config?.closedThrough;
  const inOpen = (date: string | undefined) => !closed || !date || date > closed;
  const listed = { questions: new Set(s.questions.map((x) => x.q.id)), tasks: new Set(s.tasks.map((x) => x.run)), payments: new Set(s.unbooked.map((p) => p.ref)), entries: new Set(s.evidence.map((x) => x.entry.id)) };
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
    twins: ledgerOf(books, closed ? addDays(closed, 1) : '0000-01-01').views.filter((v) => v.twin?.relation === 'duplicate' && !v.none && !v.locked),
    assessments: missingAssessments(books, documents().customs, !withoutInputTax()),
    stuck,
  };
}

/** How many things wait outside the period, each counted once. */
export const elsewhereCount = (e: Elsewhere): number =>
  e.open.length + e.answered.length + e.tasks.length + e.unbooked.length + e.contradicting.length + (e.unsettled?.items.length ?? 0) + e.twins.length + e.assessments.length + e.stuck;

/** Whether anything of the period waits: a card with nothing on it says so in one line (and that nothing else does, only when `elsewhereOf` is empty too). */
export const nothingOpen = (s: OpenPeriodState): boolean =>
  !s.unbooked.length && !s.questions.length && !s.evidence.length && !s.unlinked.length && !s.tasks.length;

/** How many of the held payments are of each kind. */
export const waitingKinds = (s: Pick<OpenPeriodState, 'waiting'>): Record<WaitingPayment['kind'], number> => ({
  waits: s.waiting.filter((w) => w.kind === 'waits').length,
  asks: s.waiting.filter((w) => w.kind === 'asks').length,
  unread: s.waiting.filter((w) => w.kind === 'unread').length,
});

/** The most tasks the card lists one by one; the rest is counted in one line. */
export const TASKS_SHOWN = 5;

/** One line of the state: what it counts and the first object of it, where the person starts. */
export type OpenLine =
  /** `waiting`: of them held by receiptWaits (countIssues' `waitingReceipt`, as the return's page says); `unread`: of those, held because their receipt's VAT cannot be read. */
  | { kind: 'unbooked'; n: number; waiting: number; unread: number; first: BankTransaction }
  | { kind: 'questions'; n: number }
  | { kind: 'evidence'; n: number; first: JournalEntry }
  | { kind: 'unlinked'; n: number; first: Receipt }
  | { kind: 'task'; task: Task }
  /** The tasks beyond TASKS_SHOWN. */
  | { kind: 'moreTasks'; n: number };

/**
 * The state as the lines of its card, in the order a person works them off; the tasks last, the
 * review among them. A task on a payment counted in the first line is that payment, named once.
 * At most TASKS_SHOWN tasks are lines of their own: the card says how many more there are.
 */
export function openLines(s: OpenPeriodState): OpenLine[] {
  const refs = new Set(s.unbooked.map((t) => t.ref));
  const tasks = s.tasks.filter((x) => !(x.item.kind === 'transaction' && refs.has(x.item.id)));
  const kinds = waitingKinds(s);
  return [
    ...(s.counts.unbooked ? [{ kind: 'unbooked' as const, n: s.counts.unbooked, waiting: s.counts.waitingReceipt, unread: kinds.unread, first: s.unbooked[0] }] : []),
    ...(s.counts.questions ? [{ kind: 'questions' as const, n: s.counts.questions }] : []),
    ...(s.counts.evidence ? [{ kind: 'evidence' as const, n: s.counts.evidence, first: s.evidence[0].entry }] : []),
    ...(s.counts.unlinked ? [{ kind: 'unlinked' as const, n: s.counts.unlinked, first: s.unlinked[0] }] : []),
    ...tasks.slice(0, TASKS_SHOWN).map((task) => ({ kind: 'task' as const, task })),
    ...(tasks.length > TASKS_SHOWN ? [{ kind: 'moreTasks' as const, n: tasks.length - TASKS_SHOWN }] : []),
  ];
}
