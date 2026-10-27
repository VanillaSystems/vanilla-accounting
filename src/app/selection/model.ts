/**
 * Several rows of one list picked at once (#216): receipts, payments or journal entries. ⌘-click
 * toggles a row, ⇧-click picks the range from the last row clicked, ⌘A the rows shown, Esc none.
 * Pure, so a test walks it without a browser; the store and the rows use it (store.ts, Pick.tsx).
 * A selection lives beside the URL, never in it, and keeps only rows still shown.
 */

/** What a list's rows are. */
export type SelectKind = 'receipt' | 'payment' | 'entry';

export interface Selection {
  kind: SelectKind;
  ids: readonly string[];
  /** The row a ⇧-click ranges from: the last one toggled or clicked. */
  anchor?: string;
}

/** At most this many rows at once: a batch runs in one write, and the chat names each. */
export const MAX_SELECTED = 200;

/** A change of the selection, and how many rows it left out at the limit (0: none). */
export interface Picked { sel: Selection | undefined; leftOut: number }

const capped = (kind: SelectKind, ids: readonly string[], anchor?: string): Picked => {
  const unique = [...new Set(ids)];
  const kept = unique.slice(0, MAX_SELECTED);
  return { sel: kept.length ? { kind, ids: kept, ...(anchor ? { anchor } : {}) } : undefined, leftOut: unique.length - kept.length };
};

/** The selection of this kind, or none: another list's selection is no selection here. */
export const ofKind = (sel: Selection | undefined, kind: SelectKind): Selection | undefined => (sel?.kind === kind ? sel : undefined);

/**
 * ⌘-click on `id`: in or out. A first ⌘-click while one row is open (`current`, the route's) picks
 * both, as a file manager does: the open row is the one the person looked at.
 */
export function toggle(sel: Selection | undefined, kind: SelectKind, id: string, current?: string): Picked {
  const have = ofKind(sel, kind)?.ids ?? [];
  if (have.includes(id)) return capped(kind, have.filter((x) => x !== id), id);
  const start = !have.length && current && current !== id ? [current] : have;
  return capped(kind, [...start, id], id);
}

/**
 * ⇧-click on `id`: every shown row from the anchor (else the open row, else the first shown) to
 * `id`, added to what is picked. Rows not shown are never picked.
 */
export function range(sel: Selection | undefined, kind: SelectKind, shown: readonly string[], id: string, current?: string): Picked {
  const have = ofKind(sel, kind);
  const from = [have?.anchor, current].find((x) => x && shown.includes(x)) ?? shown[0];
  const a = shown.indexOf(from ?? id);
  const b = shown.indexOf(id);
  if (b < 0) return { sel, leftOut: 0 };
  const span = shown.slice(Math.min(a, b), Math.max(a, b) + 1);
  return capped(kind, [...(have?.ids ?? []), ...span], have?.anchor ?? from);
}

/** ⌘A: the rows shown now, in their order. */
export const all = (kind: SelectKind, shown: readonly string[]): Picked => capped(kind, shown, shown[0]);

/** The rows a filter, a search or a closed group took away leave the selection; none left: no selection. */
export function keepShown(sel: Selection | undefined, shown: readonly string[]): Selection | undefined {
  if (!sel) return undefined;
  const set = new Set(shown);
  const ids = sel.ids.filter((id) => set.has(id));
  if (ids.length === sel.ids.length) return sel;
  return ids.length ? { ...sel, ids, ...(sel.anchor && set.has(sel.anchor) ? {} : { anchor: undefined }) } : undefined;
}

/** What a click on a row does, by its keys: a plain click opens the row and drops the selection. */
export type ClickWay = 'toggle' | 'range' | 'open';
export const clickWay = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): ClickWay =>
  (e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'open');

/** The days a selection spans: its first and last date, or none when no row has one. */
export function spanOf(dates: ReadonlyArray<string | undefined>): { from: string; to: string } | undefined {
  const ds = dates.filter((d): d is string => !!d).sort();
  return ds.length ? { from: ds[0], to: ds[ds.length - 1] } : undefined;
}
