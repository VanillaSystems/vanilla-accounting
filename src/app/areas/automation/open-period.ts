/**
 * Where the oldest period not filed stands (#342): what a person means by «was muss ich noch machen?».
 * Nothing here is computed anew. The period is the books' open one (booksOpenPeriod), its points are
 * the review's «Noch offen» list (periodIssues), the payments the app holds for their receipt are
 * waitingForReceipt, the due day is the home's filing stage, and the tasks are the workflows' own.
 * Pure: the AI sidebar's card draws it in the browser, and the server writes the same state into
 * the assistant's message (src/server/open-work.ts), so the words and the card never disagree.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { EvidenceCheck } from '../../../accounting/evidence-check.js';
import type { Question } from '../../../questions/model.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import type { OrderPage } from '../../../booking/order-pages.js';
import type { Task } from '../../../workflows/model.js';
import { booksOpenPeriod, type FilingLength, type IsoDate, type Period } from '../../../accounting/periods.js';
import { waitingForReceipt, type WaitingPayment } from '../../../accounting/receipt-due.js';
import { bookedStates } from '../../../accounting/payment-entries.js';
import { filingStage, receiptDay, type FilingStage } from '../../automation/home.js';
import { periodIssues } from './period-issues.js';

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
  /** The period's payments without a booking, oldest first: those the app holds among them. */
  unbooked: BankTransaction[];
  /**
   * Of `unbooked`, the payments the app holds (receiptState): `waits` for its receipt (the app's work),
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
  const issues = periodIssues(books, questions, period.from, period.to, accounts, orderPages);
  const booked = bookedStates(books, accounts);
  const unbooked = issues.flatMap((i) => (i.kind === 'unbooked' ? [i.tx] : []));
  const refs = new Set(unbooked.map((t) => t.ref));
  const about = (x: Task) => { const d = taskDay(books, x.item); return d === 'period' ? x.item.id === period.token : !!d && d >= period.from && d <= period.to; };
  return {
    period,
    filing: filingStage(books, period, ctx),
    unbooked,
    waiting: waitingForReceipt(books, (ref) => booked(ref) === 'booked', ctx.today).filter((w) => refs.has(w.tx.ref)),
    questions: issues.flatMap((i) => (i.kind === 'question' ? [{ q: i.q, date: i.date }] : [])),
    evidence: issues.flatMap((i) => (i.kind === 'evidence' ? [{ entry: i.entry, check: i.check }] : [])),
    unlinked: issues.flatMap((i) => (i.kind === 'unlinked' ? [i.receipt] : [])),
    tasks: tasks.filter(about),
  };
}

/** Whether anything of the period waits: a card with nothing on it says so in one line. */
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
  /** `waiting`: of them held until their receipt comes (waits and asks); `unread`: held because their receipt cannot be read. */
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
    ...(s.unbooked.length ? [{ kind: 'unbooked' as const, n: s.unbooked.length, waiting: kinds.waits + kinds.asks, unread: kinds.unread, first: s.unbooked[0] }] : []),
    ...(s.questions.length ? [{ kind: 'questions' as const, n: s.questions.length }] : []),
    ...(s.evidence.length ? [{ kind: 'evidence' as const, n: s.evidence.length, first: s.evidence[0].entry }] : []),
    ...(s.unlinked.length ? [{ kind: 'unlinked' as const, n: s.unlinked.length, first: s.unlinked[0] }] : []),
    ...tasks.slice(0, TASKS_SHOWN).map((task) => ({ kind: 'task' as const, task })),
    ...(tasks.length > TASKS_SHOWN ? [{ kind: 'moreTasks' as const, n: tasks.length - TASKS_SHOWN }] : []),
  ];
}
