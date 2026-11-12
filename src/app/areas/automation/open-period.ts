/**
 * Where the oldest period not filed stands (#342): what a person means by «was muss ich noch machen?».
 * Nothing here is computed anew. The period is the books' open one (booksOpenPeriod), its points are
 * the review's «Noch offen» list (periodIssues), the payments the app holds for their receipt are
 * waitingForReceipt, the due day is the home's filing stage, and the tasks are the workflows' own.
 * Pure: the AI sidebar's card draws it in the browser, and the server writes the same state into
 * the assistant's message (src/server/open-work.ts), so the words and the card never disagree.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import type { Question } from '../../../questions/model.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import type { OrderPage } from '../../../booking/order-pages.js';
import type { Task } from '../../../workflows/model.js';
import { booksOpenPeriod, type FilingLength, type IsoDate, type Period } from '../../../accounting/periods.js';
import { waitingForReceipt, type WaitingPayment } from '../../../accounting/receipt-due.js';
import { bookedStates } from '../../../accounting/payment-entries.js';
import { filingStage, type FilingStage } from '../../automation/home.js';
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
  /** The period's payments without a booking, oldest first: those the app holds for their receipt among them. */
  unbooked: BankTransaction[];
  /** Of `unbooked`, the payments that wait for their receipt or for a word on one that cannot be read. */
  waiting: WaitingPayment[];
  /** Open questions about the period's payments, receipts and bookings, each with the day of what it is about. */
  questions: Array<{ q: Question; date: string }>;
  /** Bookings whose VAT code contradicts their receipts. */
  evidence: JournalEntry[];
  /** Receipts without a payment. */
  unlinked: Receipt[];
  /**
   * The workflows' tasks that wait for the person («Abrechnung prüfen», a payment a rule asks about). A task
   * on a payment counted in `unbooked` is left out: it is that payment, named once.
   */
  tasks: Task[];
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
  return {
    period,
    filing: filingStage(books, period, ctx),
    unbooked,
    waiting: waitingForReceipt(books, (ref) => booked(ref) === 'booked', ctx.today).filter((w) => refs.has(w.tx.ref)),
    questions: issues.flatMap((i) => (i.kind === 'question' ? [{ q: i.q, date: i.date }] : [])),
    evidence: issues.flatMap((i) => (i.kind === 'evidence' ? [i.entry] : [])),
    unlinked: issues.flatMap((i) => (i.kind === 'unlinked' ? [i.receipt] : [])),
    tasks: tasks.filter((x) => !(x.item.kind === 'transaction' && refs.has(x.item.id))),
  };
}

/** Whether anything of the period waits: a card with nothing on it says so in one line. */
export const nothingOpen = (s: OpenPeriodState): boolean =>
  !s.unbooked.length && !s.questions.length && !s.evidence.length && !s.unlinked.length && !s.tasks.length;

/** One line of the state: what it counts and the first object of it, where the person starts. */
export type OpenLine =
  | { kind: 'unbooked'; n: number; waiting: number; first: BankTransaction }
  | { kind: 'questions'; n: number }
  | { kind: 'evidence'; n: number; first: JournalEntry }
  | { kind: 'unlinked'; n: number; first: Receipt }
  | { kind: 'task'; task: Task };

/** The state as the lines of its card, in the order a person works them off; the tasks last, the review among them. */
export function openLines(s: OpenPeriodState): OpenLine[] {
  return [
    ...(s.unbooked.length ? [{ kind: 'unbooked' as const, n: s.unbooked.length, waiting: s.waiting.length, first: s.unbooked[0] }] : []),
    ...(s.questions.length ? [{ kind: 'questions' as const, n: s.questions.length }] : []),
    ...(s.evidence.length ? [{ kind: 'evidence' as const, n: s.evidence.length, first: s.evidence[0] }] : []),
    ...(s.unlinked.length ? [{ kind: 'unlinked' as const, n: s.unlinked.length, first: s.unlinked[0] }] : []),
    ...s.tasks.map((task) => ({ kind: 'task' as const, task })),
  ];
}
