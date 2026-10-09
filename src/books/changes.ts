/**
 * The one unit of "a change to the books": a record before and after. The Protokoll (git
 * history, src/books/history.ts), the Treuhänder's corrections (src/review/) and the owner's
 * merge of them all speak it. Browser-safe: the review package applies changes in the browser.
 */
import type { AccountingConfig, BankStatement, BankTransaction, Index, JournalEntry, Mapping, Receipt, StatementClosingBalance } from '../types/index.js';
import { canonical } from './canonical.js';

interface RecordTypes {
  entries: JournalEntry;
  transactions: BankTransaction;
  receipts: Receipt;
  mappings: Mapping;
  statements: BankStatement;
  statementBalances: StatementClosingBalance;
}
type ListCollection = keyof RecordTypes;
export type Collection = ListCollection | 'config';

/** `before` absent: the record was added. `after` absent: it was removed. */
export type RecordChange =
  | { [C in ListCollection]: { collection: C; key: string; before?: RecordTypes[C]; after?: RecordTypes[C] } }[ListCollection]
  | { collection: 'config'; key: keyof AccountingConfig; before?: unknown; after?: unknown };

type ListField = 'journalEntries' | 'transactions' | 'receipts' | 'mappings' | 'bankStatements' | 'statementBalances';

/** Where each collection lives in books.json, and the natural key of its records. */
const LISTS: { [C in ListCollection]: { field: ListField; key: (r: RecordTypes[C]) => string } } = {
  entries: { field: 'journalEntries', key: (e) => e.id },
  transactions: { field: 'transactions', key: (t) => t.ref },
  receipts: { field: 'receipts', key: (r) => r.id },
  mappings: { field: 'mappings', key: (m) => `${m.transactionRef} ↔ ${m.receiptId}` },
  statements: { field: 'bankStatements', key: (s) => `${s.bank}/${s.filename}` },
  statementBalances: { field: 'statementBalances', key: (b) => `${b.account}/${b.date}` },
};
const LIST_ORDER = Object.keys(LISTS) as ListCollection[];

export type ChangeableBooks = Pick<Index, ListField | 'config'>;

/** A key that repeats in a list gets `#2`, `#3`, … in the order the records stand. */
function keyed<C extends ListCollection>(books: ChangeableBooks, c: C): Map<string, { record: RecordTypes[C]; index: number }> {
  const list = (books[LISTS[c].field] ?? []) as RecordTypes[C][];
  const out = new Map<string, { record: RecordTypes[C]; index: number }>();
  const seen = new Map<string, number>();
  list.forEach((record, index) => {
    const base = LISTS[c].key(record);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base}#${n}`, { record, index });
  });
  return out;
}

const same = (a: unknown, b: unknown) => (a === undefined ? b === undefined : b !== undefined && canonical(a) === canonical(b));

/** Every record that differs between two books, in a fixed order. diffBooks(a, a) is []. Array order is not a change. */
export function diffBooks(a: ChangeableBooks, b: ChangeableBooks): RecordChange[] {
  const out: RecordChange[] = [];
  for (const c of LIST_ORDER) {
    const before = keyed(a, c);
    const after = keyed(b, c);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const x = before.get(key)?.record;
      const y = after.get(key)?.record;
      if (!same(x, y)) out.push({ collection: c, key, before: x, after: y } as RecordChange);
    }
  }
  const ca = (a.config ?? {}) as Record<string, unknown>;
  const cb = (b.config ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
    if (!same(ca[key], cb[key])) out.push({ collection: 'config', key: key as keyof AccountingConfig, before: ca[key], after: cb[key] });
  }
  return out;
}

export type ApplyStatus = 'applied' | 'alreadySo' | 'conflict';

/** The record a change's key names in these books, if any. */
export function currentOf(books: ChangeableBooks, change: RecordChange): unknown {
  if (change.collection === 'config') return (books.config as Record<string, unknown> | undefined)?.[change.key];
  return keyed(books, change.collection).get(change.key)?.record;
}

/**
 * Applies one change to `books` in place. The record as it is now decides: equal to `after`
 * is alreadySo (a retry, or someone made the same change), equal to `before` is applied,
 * anything else is a conflict and nothing changes. The caller wraps it in mutateJournal.
 */
export function applyChange(books: ChangeableBooks, change: RecordChange): ApplyStatus {
  const now = currentOf(books, change);
  if (same(now, change.after)) return 'alreadySo';
  if (!same(now, change.before)) return 'conflict';
  if (change.collection === 'config') {
    const config = (books.config ??= {}) as Record<string, unknown>;
    if (change.after === undefined) delete config[change.key];
    else config[change.key] = structuredClone(change.after);
    return 'applied';
  }
  const { field } = LISTS[change.collection];
  const list = ((books as Record<ListField, unknown[] | undefined>)[field] ??= []);
  const at = keyed(books, change.collection).get(change.key)?.index;
  if (change.after === undefined) list.splice(at!, 1);
  else if (at === undefined) list.push(structuredClone(change.after));
  else list[at] = structuredClone(change.after);
  return 'applied';
}

/** The same change, undone. */
export const invert = (change: RecordChange): RecordChange => ({ ...change, before: change.after, after: change.before }) as RecordChange;

export interface FieldDiff { field: string; before: unknown; after: unknown }

/** The top-level fields of a record that differ, for showing a change to a person. */
export function fieldDiffs(change: RecordChange): FieldDiff[] {
  const a = (change.before ?? {}) as Record<string, unknown>;
  const b = (change.after ?? {}) as Record<string, unknown>;
  if (change.collection === 'config' || typeof change.before !== 'object' || typeof change.after !== 'object') {
    return [{ field: change.collection === 'config' ? change.key : '', before: change.before, after: change.after }];
  }
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((f) => !same(a[f], b[f]))
    .map((field) => ({ field, before: a[field], after: b[field] }));
}

/** The dates a change touches: the record's own date before and after, and for a mapping its transaction's. */
export function datesOf(books: Pick<Index, 'transactions' | 'journalEntries'>, change: RecordChange): string[] {
  const dated = (r: unknown) => (r && typeof r === 'object' && 'date' in r && typeof r.date === 'string' ? [r.date] : []);
  if (change.collection === 'mappings') {
    const ref = (change.after ?? change.before)!.transactionRef;
    return [
      ...books.transactions.filter((t) => t.ref === ref).map((t) => t.date),
      ...(books.journalEntries ?? []).filter((e) => e.transactionRef === ref).map((e) => e.date),
    ];
  }
  return [...dated(change.before), ...dated(change.after)];
}
