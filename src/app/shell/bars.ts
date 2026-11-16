/**
 * The top bar's pin (docs/0.4.0/views.md, "The top bar"). The bar stands open by default: people did
 * not find it while it folded by itself. Unpinned, it folds to a pill and opens on hover, focus or a
 * click on the pill. The choice is one value in localStorage, edited by the bar's pin and by Firma ›
 * Darstellung alike.
 */
import { useSyncExternalStore } from 'react';
import { store, stored } from './storage.js';

export type BarMode = 'always' | 'auto';

/** What a person who never touched the pin gets. */
export const DEFAULT_MODE: BarMode = 'always';

/**
 * A key of its own: the earlier `bar.top` was also set to 'auto' by the bar folding itself after three
 * uses, so it does not tell a person's choice from the old default; everyone starts with the bar open.
 */
const KEY = 'bar.top.pin';

export const parseMode = (v: string | null): BarMode => (v === 'auto' || v === 'always' ? v : DEFAULT_MODE);

let mode: BarMode = parseMode(stored(KEY));
const listeners = new Set<() => void>();

export function setPinned(on: boolean): void {
  const next: BarMode = on ? 'always' : 'auto';
  if (next === mode) return;
  mode = next;
  store(KEY, next);
  for (const l of listeners) l();
}

export function useBarMode(): BarMode {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => mode);
}
