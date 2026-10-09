/**
 * What every route shares: the books through src/books/store.ts, golden rule 1's refusals,
 * request errors, and where the receipt PDFs live.
 */
import type { Response } from 'express';
import type { Index } from '../types/index.js';
import { loadBooks, mutateJournal, periodLock, saveBooks, type Books } from '../books/store.js';
import { openWorkspace } from '../workspace/workspace.js';

export const WS = openWorkspace();

export function receiptDir(location?: string): string {
  return location === 'staged' ? WS.paths.inbox : WS.paths.receipts;
}

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
export const CLOSED = {
  editTransaction: 'Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteTransaction: 'Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  newTransaction: 'Neue Transaktionen müssen in der offenen Periode liegen.',
  mapping: 'Zuordnungen zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  editReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  editEntry: 'Korrekturen als neue Buchung in der offenen Periode erfassen.',
  deleteEntry: 'Buchungen in geschlossenen Perioden können nicht gelöscht werden.',
} as const;

export function assertOpen(books: Pick<Index, 'config'>, dates: Array<string | undefined>, reason: string): void {
  const lock = periodLock(books);
  for (const date of dates) lock.assertOpen(date, reason);
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
  constructor(readonly status: number, message: string) { super(message); }
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
