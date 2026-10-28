/**
 * The selection of the open list (#216) in the browser: one at a time, beside the URL. The lists
 * say which rows they show (useShown), so ⌘A, a ⇧-range and a filter all work on the rows a
 * person sees; the shell clears it when the area changes and on Esc.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { t } from '../i18n/index.js';
import { MAX_SELECTED, all, clickWay, keepShown, ofKind, range, toggle, type Picked, type SelectKind, type Selection } from './model.js';

let selection: Selection | undefined;
const shown: Record<SelectKind, readonly string[]> = { receipt: [], payment: [], entry: [] };
const listeners = new Set<() => void>();

export function setSelection(next: Selection | undefined): void {
  if (next === selection) return;
  selection = next;
  for (const l of listeners) l();
}

export const clearSelection = (): void => setSelection(undefined);
export const selectionNow = (): Selection | undefined => selection;

export function useSelection(kind?: SelectKind): Selection | undefined {
  const sel = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => selection);
  return kind ? ofKind(sel, kind) : sel;
}

/** The rows a list shows now, in order; rows it no longer shows leave the selection. */
export function useShown(kind: SelectKind, ids: readonly string[]): void {
  shown[kind] = ids;
  const key = ids.join('\n');
  useEffect(() => {
    if (selection?.kind === kind) setSelection(keepShown(selection, shown[kind]));
  }, [kind, key]);
}

export const shownNow = (kind: SelectKind): readonly string[] => shown[kind];

/** The limit's sentence when a pick left rows out: never cut silently. */
const told = (p: Picked, toast: (msg: string) => void): void => {
  if (p.leftOut) toast(t('selection.limit', { max: MAX_SELECTED, n: p.leftOut }));
};

/**
 * A click on a row: ⌘ toggles it, ⇧ picks the range, a plain click opens it (`open`) and drops the
 * selection. `current`: the row open now. True when the click changed the selection, not the route.
 */
export function clickRow(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, kind: SelectKind, id: string, current: string | undefined, open: (id: string) => void, toast: (msg: string) => void): boolean {
  const way = clickWay(e);
  if (way === 'open') { clearSelection(); open(id); return false; }
  // ⇧-click would also select the rows' text.
  if (way === 'range') window.getSelection()?.removeAllRanges();
  const p = way === 'toggle' ? toggle(selection, kind, id, current) : range(selection, kind, shown[kind], id, current);
  setSelection(p.sel);
  told(p, toast);
  return true;
}

/** The hover checkbox: in or out, with nothing else picked by it. */
export function checkRow(kind: SelectKind, id: string, toast: (msg: string) => void): void {
  const p = toggle(selection, kind, id);
  setSelection(p.sel);
  told(p, toast);
}

/** ⌘A: the shown rows of this list; false when it shows none. */
export function selectAll(kind: SelectKind, toast: (msg: string) => void): boolean {
  if (!shown[kind].length) return false;
  const p = all(kind, shown[kind]);
  setSelection(p.sel);
  told(p, toast);
  return true;
}
