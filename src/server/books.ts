/**
 * What every route shares: the books through src/books/store.ts, golden rule 1's refusals,
 * request errors, and where the receipt PDFs live.
 */
import type { Response } from 'express';
import type { Index } from '../types/index.js';
import { ClosedPeriodError, loadBooks, mutateJournal, periodLock, saveBooks, type Books } from '../books/store.js';
import type { ApiRefusal, ClosedReason } from '../types/api-error.js';
import { openWorkspace } from '../workspace/workspace.js';
import { receiptDirOf } from '../workspace/reads.js';

export const WS = openWorkspace();

export const receiptDir = (location?: string): string => receiptDirOf(WS, location);

export const readBooks = (): Books => loadBooks(WS);

/** An async `fn` would hold loaded books across an await and save over every edit made meanwhile. */
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * One change to the books: load, run `fn` inside mutateJournal, save, and return what `fn`
 * returns. Nothing is saved when `fn` throws. `fn` is synchronous: a route that asks a model
 * awaits it first and applies the answer here, to books loaded after the answer came.
 */
export function updateBooks<T>(fn: (books: Books) => Sync<T>): T {
  const books = readBooks();
  const result = mutateJournal(books, fn);
  saveBooks(WS, books);
  return result;
}

/**
 * One request's change to the books, sent as the response. The error handler in api.ts turns
 * a ClosedPeriodError into 403 and a RequestError into its status.
 */
export function withBooks<T>(res: Response, fn: (books: Books) => Sync<T>): void {
  res.json(updateBooks(fn));
}

// Golden rule 1 (AGENTS.md): nothing dated on or before config.closedThrough may change.
// Every route that writes the books refuses a closed date with one of these first, so the
// UI can say why; mutateJournal in withBooks catches whatever a route forgets.
export const CLOSED: Record<ClosedReason, string> = {
  editTransaction: 'Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteTransaction: 'Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  newTransaction: 'Neue Transaktionen müssen in der offenen Periode liegen.',
  mapping: 'Zuordnungen zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  editReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  editEntry: 'Korrekturen als neue Buchung in der offenen Periode erfassen.',
  deleteEntry: 'Buchungen in geschlossenen Perioden können nicht gelöscht werden.',
  newStatement: 'Ein Auszug, der ganz in einer geschlossenen Periode liegt, wird nicht mehr eingelesen.',
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

/** A request the API refuses with this status; the error handler in api.ts sends it. */
export class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly refusal?: ApiRefusal) { super(message); }
}

export function patchBody(body: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'JSON-Objekt erwartet.');
  const unknown = Object.keys(body).filter((k) => !fields.includes(k));
  if (unknown.length) throw new RequestError(400, `Unbekannte Felder: ${unknown.join(', ')}`);
  return body as Record<string, unknown>;
}

export function stringField(b: Record<string, unknown>, key: string): string {
  if (typeof b[key] !== 'string') throw new RequestError(400, `${key} muss ein Text sein.`);
  return b[key] as string;
}
