/** Which report the form of Eigene Berichte edits, shared by the list («Neuer Bericht») and the detail (the form): none, a new one, or a saved one by its slug. */
import { useSyncExternalStore } from 'react';
import type { ReportSpec } from '../../../../reports/spec.js';

export interface Editing { slug?: string; spec?: ReportSpec }

let current: Editing | null = null;
const subs = new Set<() => void>();

export const editing = {
  get: (): Editing | null => current,
  set(e: Editing | null): void { current = e; for (const f of subs) f(); },
};
export const startEditing = (e: Editing): void => editing.set(e);
export const useEditing = (): Editing | null => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current);
