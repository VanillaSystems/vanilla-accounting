/**
 * What every route shares: the books through src/books/store.ts, golden rule 1's refusals,
 * request errors, and where the receipt PDFs live.
 */
import type { Response } from 'express';
import { loadBooks, mutateJournal, saveBooks, type Books } from '../books/store.js';
import type { ApiRefusal } from '../types/api-error.js';
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
export function updateBooks<T>(fn: (books: Books) => Sync<T>, action = 'UI'): T {
  const books = readBooks();
  const result = mutateJournal(books, fn);
  saveBooks(WS, books, action);
  return result;
}

/**
 * One request's change to the books, sent as the response. The error handler in api.ts turns
 * a ClosedPeriodError into 403 and a RequestError into its status.
 */
export function withBooks<T>(res: Response, fn: (books: Books) => Sync<T>): void {
  res.json(updateBooks(fn, `UI: ${res.req.method} ${decodeURIComponent(res.req.originalUrl)}`));
}

export { assertOpen, CLOSED, receiptDates, refDates } from '../books/lock.js';

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
