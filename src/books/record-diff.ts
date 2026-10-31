/**
 * What one change did to the books' records, kept so it can be taken back exactly (the undo of
 * «Auszug entfernen»): each record of each part (src/books/years.ts) by its key, as it was and as it
 * became. Taking it back puts every record as it was, so the books' files read byte for byte as before.
 */
import { PARTS, keyOf, type Part } from './years.js';
import type { Index } from '../types/index.js';

type Rec = Record<string, unknown>;
/** Each part's records by key (a key that repeats gets `#n`), as JSON; absent when the books had no such part. */
export type RecordSnapshot = Map<Part, Map<string, string> | undefined>;
/** One record a change touched: its JSON before (absent: it was new) and after (absent: it was removed). */
export interface RecordChange { part: Part; key: string; before?: string; after?: string }

const recordsOf = (books: Index, part: Part): Rec[] | undefined => (books as unknown as Record<Part, Rec[] | undefined>)[part];

function keyed(part: Part, records: readonly Rec[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const r of records) {
    const key = (keyOf[part] as unknown as (r: Rec) => string)(r);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.set(n ? `${key}#${n}` : key, JSON.stringify(r));
  }
  return out;
}

export function snapshot(books: Index): RecordSnapshot {
  return new Map(PARTS.map((part) => {
    const records = recordsOf(books, part);
    return [part, records ? keyed(part, records) : undefined];
  }));
}

/** The records that differ between `was` and `books` now. */
export function changesSince(was: RecordSnapshot, books: Index): RecordChange[] {
  const now = snapshot(books);
  return PARTS.flatMap((part) => {
    const a = was.get(part) ?? new Map<string, string>(), b = now.get(part) ?? new Map<string, string>();
    return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).map((key) => ({ part, key, before: a.get(key), after: b.get(key) }));
  });
}

/** Whether every record the change touched is still as the change left it. */
export function stillAsLeft(changes: readonly RecordChange[], books: Index): boolean {
  const now = snapshot(books);
  return changes.every((c) => now.get(c.part)?.get(c.key) === c.after);
}

/** Puts every record the change touched back as it was; a part the books did not have before and is empty again goes. */
export function takeBack(changes: readonly RecordChange[], books: Index, was: ReadonlySet<Part>): void {
  const target = books as unknown as Record<Part, Rec[] | undefined>;
  for (const part of new Set(changes.map((c) => c.part))) {
    const mine = changes.filter((c) => c.part === part);
    const touched = new Set(mine.map((c) => c.key));
    const now = keyed(part, target[part] ?? []);
    const kept = [...now].filter(([key]) => !touched.has(key)).map(([, json]) => JSON.parse(json) as Rec);
    const back = mine.flatMap((c) => (c.before === undefined ? [] : [JSON.parse(c.before) as Rec]));
    const records = [...kept, ...back];
    if (records.length || was.has(part)) target[part] = records;
    else delete target[part];
  }
}

/** The parts the books had at the snapshot. */
export const partsOf = (s: RecordSnapshot): Set<Part> => new Set([...s].filter(([, m]) => m !== undefined).map(([part]) => part));
