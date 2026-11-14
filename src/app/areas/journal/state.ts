/**
 * What Buchungen keeps beside the URL (the filter chips and ?vat= are in it): the closed months
 * and the open detail sections (per viewer, kept in this browser), the new-entry dialog, and the list
 * as last shown, which the keys walk.
 */
import { useSyncExternalStore } from 'react';
import type { JournalEntryInput } from '../../lib/api.js';
import type { DeletedEntry } from '../../../books/entry-input.js';
import { store, stored } from '../../shell/storage.js';
import type { CorrectionKind } from '../../../accounting/correction.js';

export type Section = 'teile' | 'buchung' | 'herkunft';

interface State {
  collapsed: ReadonlySet<string>;
  open: Record<Section, boolean>;
  /** The new-entry dialog with what it starts from. */
  overlay: { kind: 'new'; draft: Partial<JournalEntryInput>; correcting?: { entry: string; as: CorrectionKind; from?: string } } | null;
  /** A field of the entry form to focus once it shows. */
  focus?: string;
  /** The entry just deleted: the detail keeps its place with «Rückgängig», so no row moves under the pointer (r6h-28). */
  deleted?: DeletedEntry;
}

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(stored(key) ?? '') as T; } catch { return fallback; }
}

let state: State = {
  collapsed: new Set(read<string[]>('journal.collapsed', [])),
  open: { teile: true, buchung: false, herkunft: false, ...read<Partial<Record<Section, boolean>>>('journal.open', {}) },
  overlay: null,
};
const listeners = new Set<() => void>();

export function setUi(patch: Partial<State>): void {
  state = { ...state, ...patch };
  if (patch.open) store('journal.open', JSON.stringify(state.open));
  if (patch.collapsed) store('journal.collapsed', JSON.stringify([...state.collapsed]));
  listeners.forEach((l) => l());
}

export const ui = (): State => state;

export function useUi(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function toggleMonth(month: string, open?: boolean): void {
  const next = new Set(state.collapsed);
  if (open ?? next.has(month)) next.delete(month); else next.add(month);
  setUi({ collapsed: next });
}

/** The entry ids as last shown, in ↑↓ order; `pending`, an entry just booked that the books loaded next will hold. */
export const listed: { ids: string[]; pending?: string } = { ids: [] };

/** Selects an entry the API just wrote, before the books that hold it have loaded. */
export function selectNew(nav: { select(route: { area: 'journal'; id: string }): void }, id: string): void {
  listed.pending = id;
  nav.select({ area: 'journal', id });
}
