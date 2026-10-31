/**
 * What the VAT code views keep beside the URL: the catalogue's "used only" switch and its closed
 * families (kept in this browser), and the histogram, which Buchungen, the hover card and the
 * catalogue all open.
 */
import { useSyncExternalStore } from 'react';
import type { VatCodeFamily } from '../../../accounting/vat-codes.js';
import { store, stored } from '../../shell/storage.js';

interface State {
  usedOnly: boolean;
  collapsed: ReadonlySet<VatCodeFamily>;
  histogram: boolean;
}

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(stored(key) ?? '') as T; } catch { return fallback; }
}

let state: State = { usedOnly: false, collapsed: new Set(read<VatCodeFamily[]>('codes.collapsed', [])), histogram: false };
const listeners = new Set<() => void>();

export function setCodesUi(patch: Partial<State>): void {
  state = { ...state, ...patch };
  if (patch.collapsed) store('codes.collapsed', JSON.stringify([...state.collapsed]));
  listeners.forEach((l) => l());
}

export const codesUi = (): State => state;

export function useCodesUi(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function toggleFamily(family: VatCodeFamily, open?: boolean): void {
  const next = new Set(state.collapsed);
  if (open ?? next.has(family)) next.delete(family); else next.add(family);
  setCodesUi({ collapsed: next });
}
