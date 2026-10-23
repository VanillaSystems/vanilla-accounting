/**
 * The versions of a workspace's data files, and the steps that bring an older file up to
 * date. The one place the versions are listed; docs/releasing.md says when to bump one.
 *
 *   the books              `schema` of ledger.json (books.json before 2; absent: 1)  BOOKS_MIGRATIONS
 *   belege.workspace.yaml  `schema` (absent: 1)  MANIFEST_MIGRATIONS
 *   invoices.json          `schema`              INVOICES_MIGRATIONS (src/invoices/store.ts)
 *
 * A step `n` turns a file of schema n into schema n + 1. Steps are pure, run forward only, and
 * run in memory on every load (src/books/store.ts loadBooks, src/workspace/manifest.ts), so the
 * app reads old files as they are; `npm run update` writes the result back, after a backup.
 * A books step never changes a record dated on or before closedThrough: the seals of the filed
 * quarters (src/books/seal.ts) are checked after it and refuse books it changed.
 */
import { isMap, isSeq, type Document } from 'yaml';
import { roleBefore } from './banks.js';

/**
 * 2: the books split by fiscal year (ADR 0013); the move itself is the layout migration (src/workspace/layout.ts).
 * 3: money accounts as equals (#88): a movement on any money account, a hand movement a statement
 * confirmed (BankTransaction.statement). An app of schema 2 would book a cash box's movement onto
 * its first bank account and import a confirmed row a second time, so it must refuse these books.
 * 4: reporting dimensions (#127): an entry may carry `tags` ({ projekt: "alpha" }) the reports
 * filter and group by. An app of schema 3 would keep the field it does not know on an entry it
 * edits, but not offer it, check it or carry it into the bookings it makes from that entry
 * (a copy, a correction, an undo), so it must refuse these books.
 */
export const BOOKS_SCHEMA = 4;
/** 2: every money account names its `role` (#88). */
export const WORKSPACE_SCHEMA = 2;
export const INVOICES_SCHEMA = 1;

/** Step n: schema n → n + 1. */
export type Ladder<T> = Readonly<Record<number, (doc: T) => T>>;

export const BOOKS_MIGRATIONS: Ladder<Record<string, unknown>> = {
  // The records stay as they are; only where they lie changed.
  1: (doc) => doc,
  // The origin was stored already (`source: 'manual'`, absent for a statement row) and a filed
  // record keeps every byte: the records stay; the number makes an older app refuse the books.
  2: (doc) => doc,
  // No record has tags before; the number makes an older app refuse the books.
  3: (doc) => doc,
};
/** On the YAML document, so the comments of the manifest survive the step. */
export const MANIFEST_MIGRATIONS: Ladder<Document> = {
  // Each account gets the role it had implicitly: the owner's for `manual`, a card for a card issuer, else a bank.
  1: (doc) => {
    const seq = doc.get('bankAccounts');
    if (!isSeq(seq)) return doc;
    for (const item of seq.items) if (isMap(item) && !item.has('role')) item.set('role', roleBefore(String(item.get('bank'))));
    return doc;
  },
};

/** The manifest document named at the current schema: its `schema:` set where it stands (its comments with it), else added as the first key. */
export function stampManifest(doc: Document): Document {
  if (!isMap(doc.contents)) throw new Error('belege.workspace.yaml: not a YAML mapping');
  if (doc.contents.has('schema')) doc.contents.set('schema', WORKSPACE_SCHEMA);
  else doc.contents.items.unshift(doc.createPair('schema', WORKSPACE_SCHEMA));
  return doc;
}

/** The manifest as text, written as the Firma page writes it: a one-line `{ … }` stays one line. */
export const manifestText = (doc: Document): string => doc.toString({ lineWidth: 0, doubleQuotedAsJSON: true });
export const INVOICES_MIGRATIONS: Ladder<Record<string, unknown>> = {};

/** A file written by a newer version of the app than this one. */
export class SchemaTooNewError extends Error {}

/** The schema a file names; a file from before versioning names none and is schema 1. */
export function schemaOf(value: unknown, file: string): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${file}: schema must be a whole number from 1 (found ${String(value)})`);
  return value as number;
}

/** `doc` (schema `from`) brought to `to` by the steps of `ladder`. Pure: `doc` is not changed. */
export function climb<T>(doc: T, from: number, to: number, ladder: Ladder<T>, file: string, clone: (doc: T) => T): T {
  if (from > to) {
    throw new SchemaTooNewError(`${file} has schema ${from}; this version of the app reads up to ${to}. Update the app: npm run update`);
  }
  let out = from < to ? clone(doc) : doc;
  for (let n = from; n < to; n++) {
    const step = ladder[n];
    if (!step) throw new Error(`${file}: no migration from schema ${n} to ${n + 1} (src/workspace/schema.ts)`);
    out = step(out);
  }
  return out;
}
