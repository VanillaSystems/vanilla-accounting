/**
 * Golden rule 1 (AGENTS.md) as the browser can run it too: nothing dated on or before
 * config.closedThrough changes. The API, the CLIs and the review package (src/review/) refuse a
 * closed date with the same words. No Node import: the review package's UI applies these rules
 * to the Treuhänder's copy of the books.
 */
import type { AccountingConfig, Index, JournalEntry } from '../types/index.js';
import type { ClosedReason } from '../types/api-error.js';

export type Books = Index & { journalEntries: JournalEntry[]; config: AccountingConfig };

export class ClosedPeriodError extends Error {
  /** `reason` names which refusal (src/types/api-error.ts) when assertOpen threw it. */
  constructor(message: string, readonly closedThrough?: string, readonly reason?: ClosedReason) { super(message); }
}

export interface PeriodLock {
  closedThrough: string | undefined;
  isClosed(date: string | undefined): boolean;
  assertOpen(date: string | undefined, what: string): void;
}

export function periodLock(books: Pick<Index, 'config'>): PeriodLock {
  const closedThrough = books.config?.closedThrough;
  const isClosed = (date: string | undefined) => !!closedThrough && !!date && date <= closedThrough;
  return {
    closedThrough,
    isClosed,
    assertOpen(date, what) {
      if (isClosed(date)) throw new ClosedPeriodError(`Periode geschlossen bis ${closedThrough}. ${what}`, closedThrough);
    },
  };
}

// Every write that touches the books refuses a closed date with one of these first, so the UI
// can say why; mutateJournal catches whatever a writer forgets.
export const CLOSED: Record<ClosedReason, string> = {
  editTransaction: 'Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteTransaction: 'Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  newTransaction: 'Neue Transaktionen müssen in der offenen Periode liegen.',
  mapping: 'Zuordnungen zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  editReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  editEntry: 'Korrekturen als neue Buchung in der offenen Periode erfassen.',
  deleteEntry: 'Buchungen in geschlossenen Perioden können nicht gelöscht werden.',
};

export function assertOpen(books: Pick<Index, 'config'>, dates: Array<string | undefined>, reason: ClosedReason): void {
  const lock = periodLock(books);
  if (dates.some(lock.isClosed)) {
    throw new ClosedPeriodError(`Periode geschlossen bis ${lock.closedThrough}. ${CLOSED[reason]}`, lock.closedThrough, reason);
  }
}

/** The dates a transaction ref stands for: the transaction's, and its entries' (an Eigenverbrauch ref has only entries). */
export function refDates(books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string): string[] {
  return [
    ...books.transactions.filter((t) => t.ref === ref).map((t) => t.date),
    ...(books.journalEntries ?? []).filter((je) => je.transactionRef === ref).map((je) => je.date),
  ];
}

/** The dates of every transaction a receipt is linked to. */
export function receiptDates(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings'>, receiptId: string): string[] {
  return books.mappings.filter((m) => m.receiptId === receiptId).flatMap((m) => refDates(books, m.transactionRef));
}
