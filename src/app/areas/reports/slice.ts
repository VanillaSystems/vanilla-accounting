/**
 * What the Erfolgsrechnung is sliced by (#127), for this session: the tag values it keeps (any of a
 * dimension's, every dimension named) and the dimension it shows a column per value of. Kept beside
 * the URL: a tag value may be a client's name, and a URL carries none (docs/urls.md rule 8).
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { Dimension, TagFilter } from '../../../books/tags.js';
import type { Index } from '../../../types/index.js';
import type { Report } from '../../shell/route.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { slicedBooks } from './model.js';

export interface Slice { filter: TagFilter; by?: string }

let slice: Slice = { filter: {} };
const listeners = new Set<() => void>();

export const useSlice = (): Slice => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => slice);

export function setSlice(next: Slice): void {
  slice = next;
  for (const l of listeners) l();
}

/** The filter with `value` of `dimension` added ('' : the entries without one). */
export const withValue = (s: Slice, dimension: string, value: string): Slice =>
  ({ ...s, filter: { ...s.filter, [dimension]: [...new Set([...(s.filter[dimension] ?? []), value])] } });

/** The filter without `value` of `dimension`; a dimension left without values is dropped. */
export function withoutValue(s: Slice, dimension: string, value: string): Slice {
  const rest = (s.filter[dimension] ?? []).filter((v) => v !== value);
  const { [dimension]: _, ...others } = s.filter;
  return { ...s, filter: rest.length ? { ...others, [dimension]: rest } : others };
}

/** The slice with only the dimensions the firm still declares. */
export function sliceFor(s: Slice, declared: readonly { id: string }[]): Slice {
  const known = (d: string) => declared.some((x) => x.id === d);
  return { filter: Object.fromEntries(Object.entries(s.filter).filter(([d]) => known(d))), ...(s.by && known(s.by) ? { by: s.by } : {}) };
}

/**
 * The slice as this firm can have it: its declared dimensions only, none on the Bilanz and the
 * Saldobilanz. The books the Erfolgsrechnung and its ledger read follow it.
 */
export function useSliced(report: Report | undefined, books: Index): { dimensions: readonly Dimension[]; slice: Slice; books: Index } {
  const dimensions = useWorkspace()?.dimensions ?? [];
  const all = useSlice();
  const key = JSON.stringify(all) + dimensions.map((d) => d.id).join(',');
  const slice = useMemo(() => (report === 'income' ? sliceFor(all, dimensions) : { filter: {} }), [key, report]);
  const sliced = useMemo(() => slicedBooks(books, slice.filter), [books, slice]);
  return { dimensions, slice, books: sliced };
}
