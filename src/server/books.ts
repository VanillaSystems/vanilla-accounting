/**
 * What every route shares: the books through src/books/store.ts, golden rule 1's refusals,
 * request errors, and where the receipt PDFs live.
 */
import type { Response } from 'express';
import type { Index, Receipt } from '../types/index.js';
import { ClosedPeriodError, loadBooks, periodLock, receiptFile, saveBooks, update, PERSON, type Books } from '../books/store.js';
import type { ApiRefusal, ClosedReason } from '../types/api-error.js';
import { locateWorkspace, openWorkspace, openWorkspaceAt } from '../workspace/workspace.js';
import { demoCopy } from '../workspace/demo-copy.js';
import { parseTags, type TagRefusal, type Tags } from '../books/tags.js';

/**
 * Live: a route that changes the manifest reopens it, the desktop app opens other books, and every
 * route reads the new one. The books the desktop app opened before loading the API are the first;
 * otherwise the located ones, a bundled demo as its copy, never the original in the repository.
 */
export let WS = openWorkspace(() => demoCopy(locateWorkspace()));

export function reopenWorkspace(root: string = WS.paths.root): void {
  WS = openWorkspaceAt(root);
}

export const receiptPath = (books: Books, receipt: Receipt): string => receiptFile(WS, books, receipt);

export const readBooks = (): Books => loadBooks(WS);

/** An async `fn` would hold loaded books across an await and save over every edit made meanwhile. */
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * One change to the books by the person using the app: load, run `fn` through the write door, save, and return what `fn`
 * returns. Nothing is saved when `fn` throws. `fn` is synchronous: a route that asks a model
 * awaits it first and applies the answer here, to books loaded after the answer came.
 */
export function updateBooks<T>(fn: (books: Books) => Sync<T>): T {
  const books = readBooks();
  const result = update(books, PERSON, fn);
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
// UI can say why; the write door in withBooks catches whatever a route forgets.
export const CLOSED: Record<ClosedReason, string> = {
  editTransaction: 'Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteTransaction: 'Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  newTransaction: 'Neue Transaktionen müssen in der offenen Periode liegen. Ein Beleg aus der eingereichten Periode wird als Korrektur gebucht: «Privat oder bar bezahlt» datiert die Zahlung auf den ersten offenen Tag.',
  mapping: 'Zuordnungen zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  editReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht geändert werden.',
  deleteReceipt: 'Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht gelöscht werden.',
  editEntry: 'Korrekturen als neue Buchung in der offenen Periode erfassen.',
  deleteEntry: 'Buchungen in geschlossenen Perioden können nicht gelöscht werden.',
  newStatement: 'Ein Auszug, der ganz in einer geschlossenen Periode liegt, wird nicht mehr eingelesen.',
  newEntry: 'Neue Buchungen müssen in der offenen Periode liegen.',
  openingBalance: 'Die Eröffnungssaldi eines Jahres mit geschlossenen Perioden bleiben, wie sie sind.',
};

/**
 * Refuses a write dated in a closed or held period. A period filed with the tax authority whose books differ
 * from the return (the hold's `filed`, r10h-4) lets the write through to the write door, which
 * keeps only a change that brings the books back (src/books/store.ts update).
 */
export function assertOpen(books: Pick<Index, 'config'>, dates: Array<string | undefined>, reason: ClosedReason): void {
  const lock = periodLock(books);
  const date = dates.find((d) => lock.isClosed(d) && !lock.heldBy(d)?.filed);
  if (date) throw new ClosedPeriodError(`${lock.closedText(date)} ${CLOSED[reason]}`, lock.closedThrough, reason, lock.heldBy(date)?.period);
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

/** The code of a refusal (src/types/api-error.ts) the UI says in the person's language; none for one without. */
export function refusalOf(err: unknown): ApiRefusal | undefined {
  if (err instanceof ClosedPeriodError) return { code: 'periodClosed', params: { closedThrough: err.closedThrough ?? '', ...(err.reason ? { reason: err.reason } : {}), ...(err.approved ? { approved: err.approved } : {}), ...(err.filed ? { filed: err.filed } : {}) } };
  return err instanceof RequestError ? err.refusal : undefined;
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

const TAG_WORDS: Record<TagRefusal['code'], string> = {
  tagShape: 'tags: ein Objekt { Dimension: Wert }.',
  tagDimension: 'tags: Diese Dimension ist in der Firma nicht eingerichtet (Firma › Dimensionen).',
  tagValue: 'tags: Ein Wert ist ein Text von höchstens 64 Zeichen auf einer Zeile.',
};

/** A booking's tags as sent (#127), checked against the dimensions the workspace declares; undefined: none. */
export function tagsField(raw: unknown): Tags | undefined {
  const p = parseTags(raw, WS.dimensions ?? []);
  if (!p.ok) throw new RequestError(400, TAG_WORDS[p.refusal.code], p.refusal);
  return p.tags;
}

export function stringField(b: Record<string, unknown>, key: string): string {
  if (typeof b[key] !== 'string') throw new RequestError(400, `${key} muss ein Text sein.`);
  return b[key] as string;
}
