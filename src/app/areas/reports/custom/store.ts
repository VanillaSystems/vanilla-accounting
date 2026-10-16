/**
 * What Eigene Berichte shares between its list, its detail, its form and the sidebar's card: the
 * saved reports (loaded once, again after every write) and which one the form edits.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api, errorText } from '../../../lib/api.js';
import type { ReportSpec } from '../../../../reports/spec.js';
import type { SavedReport, SavedWrite } from '../../../../reports/saved.js';

export interface Editing { slug?: string; spec?: ReportSpec }

let current: Editing | null = null;
const subs = new Set<() => void>();

export const editing = {
  get: (): Editing | null => current,
  set(e: Editing | null): void { current = e; for (const f of subs) f(); },
};
export const startEditing = (e: Editing): void => editing.set(e);
const watch = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useEditing = (): Editing | null => useSyncExternalStore(watch, () => current);

/** The saved reports, loaded once and again after every write of this page or the sidebar's card. */
const store: { list: SavedReport[] | undefined; error: string; subs: Set<() => void> } = { list: undefined, error: '', subs: new Set() };
let version = 0;
const notify = () => { version++; for (const f of store.subs) f(); };
const subscribe = (f: () => void) => { store.subs.add(f); return () => { store.subs.delete(f); }; };
export async function reloadSaved(): Promise<void> {
  try { store.list = await api.savedReports(); store.error = ''; } catch (e) { store.error = errorText(e); store.list = store.list ?? []; }
  notify();
}
/** The saved reports for a component; the first one to ask loads them. */
export function useSaved(): { list: SavedReport[] | undefined; error: string } {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => { if (store.list === undefined) void reloadSaved(); }, []);
  return { list: store.list, error: store.error };
}

/** A save made somewhere, with its «Rückgängig»: the file as it was. */
export async function undoWrite(w: SavedWrite): Promise<void> {
  await api.restoreReport(w);
  await reloadSaved();
}

