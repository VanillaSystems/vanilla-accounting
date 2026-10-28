/**
 * What Belege keeps beside the URL: the open overlay (link dialog, preview, delete), which detail
 * sections and list groups are open (per viewer, kept in this browser: docs/urls.md), and the
 * inbox files still waiting to be read. The list, the detail and the keys share it.
 */
import { useSyncExternalStore } from 'react';
import type { InboxFile } from '../../../types/index.js';
import { api } from '../../lib/api.js';
import { store, stored } from '../../shell/storage.js';
import type { GroupKey } from './model.js';

export type Section = 'zahlung' | 'angaben' | 'datei';
export type Overlay = 'link' | 'quick' | 'delete' | 'discard' | null;

/** Files «Löschen» deletes for good once confirmed (#228): from the quarantine (by file name) or listed as «keine Belege» (by receipt id). `all`: «Alle in der Quarantäne löschen». */
export interface Discard { from: 'quarantine' | 'hidden'; files: Array<{ id: string; file: string }>; all?: boolean }

interface State {
  overlay: Overlay;
  open: Record<Section, boolean>;
  collapsed: ReadonlySet<GroupKey>;
  showHidden: boolean;
  showLater: boolean;
  inbox: InboxFile[];
  /** A field of Angaben to focus once the form shows. */
  focus?: string;
  /** The link dialog opens on this form instead of the payments (the Aktionen menu, #216). */
  linkStart?: 'private' | 'employee';
  /** What the open «Löschen» confirmation deletes. */
  discard?: Discard;
}

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(stored(key) ?? '') as T; } catch { return fallback; }
}

let state: State = {
  overlay: null,
  open: { zahlung: true, angaben: false, datei: false, ...read<Partial<Record<Section, boolean>>>('receipts.open', {}) },
  collapsed: new Set(read<GroupKey[]>('receipts.collapsed', [])),
  showHidden: false,
  showLater: false,
  inbox: [],
};
const listeners = new Set<() => void>();

export function setUi(patch: Partial<State>): void {
  state = { ...state, ...patch };
  if (patch.open) store('receipts.open', JSON.stringify(state.open));
  if (patch.collapsed) store('receipts.collapsed', JSON.stringify([...state.collapsed]));
  listeners.forEach((l) => l());
}

export const ui = (): State => state;

export function useUi(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function openSection(section: Section, focus?: string): void {
  setUi({ open: { ...state.open, [section]: true }, focus });
}

export function toggleGroup(key: GroupKey): void {
  const next = new Set(state.collapsed);
  if (next.has(key)) next.delete(key); else next.add(key);
  setUi({ collapsed: next });
}

let polling: ReturnType<typeof setTimeout> | undefined;

/**
 * Reads the inbox again; while files wait there, again every few seconds. `onRead` runs when a
 * file left it (extract read it into the books), so the books are loaded again.
 */
export async function pollInbox(onRead: () => void): Promise<void> {
  clearTimeout(polling);
  const before = new Set(state.inbox.map((f) => f.id));
  const inbox = await api.inbox().catch(() => state.inbox);
  setUi({ inbox });
  if ([...before].some((id) => !inbox.some((f) => f.id === id))) onRead();
  if (inbox.length) polling = setTimeout(() => pollInbox(onRead), 3000);
}
