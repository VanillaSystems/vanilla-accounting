/**
 * The top bar and the dock fold to a small pill and each has its own pin (docs/0.4.0/views.md,
 * "Both bars"). A new person sees both open until they used each three times; then that bar folds
 * once, with a tip pointing at its pin. Pinned, a bar stays open; unpinned, it opens on hover,
 * focus or a click on its pill and folds when the mouse leaves. The state per bar is one value in
 * localStorage, edited by the bar's pin and by Firma › Darstellung alike.
 */
import { useSyncExternalStore } from 'react';
import { store, stored } from './storage.js';

export type BarId = 'top' | 'dock';
export type BarMode = 'new' | 'auto' | 'always';

export interface BarState {
  mode: BarMode;
  /** Uses counted while the bar is new; at USES_BEFORE_FOLD it folds. */
  uses: number;
  /** The tip "it folds from now on" is showing. */
  tip: boolean;
}

export type BarEvent =
  /** The person used the bar: went to an area, opened search, the period, the export. */
  | { kind: 'used' }
  | { kind: 'pin'; on: boolean }
  /** «Verstanden» on the tip. */
  | { kind: 'tip-ok' }
  /** «Immer zeigen» on the tip. */
  | { kind: 'tip-always' };

export const USES_BEFORE_FOLD = 3;
export const NEW_BAR: BarState = { mode: 'new', uses: 0, tip: false };

export function reduce(s: BarState, e: BarEvent): BarState {
  switch (e.kind) {
    case 'used':
      if (s.mode !== 'new') return s;
      return s.uses + 1 >= USES_BEFORE_FOLD ? { mode: 'auto', uses: s.uses + 1, tip: true } : { ...s, uses: s.uses + 1 };
    case 'pin': return { ...s, mode: e.on ? 'always' : 'auto', tip: false };
    case 'tip-ok': return { ...s, tip: false };
    case 'tip-always': return { ...s, mode: 'always', tip: false };
  }
}

/** Whether the bar shows open by itself, before any hover or focus. */
export const staysOpen = (s: BarState): boolean => s.mode !== 'auto';

const KEY = (id: BarId) => `bar.${id}`;

function read(id: BarId): BarState {
  try {
    const v = JSON.parse(stored(KEY(id)) ?? 'null') as BarState | null;
    return v && (v.mode === 'new' || v.mode === 'auto' || v.mode === 'always') ? { mode: v.mode, uses: Number(v.uses) || 0, tip: !!v.tip } : NEW_BAR;
  } catch {
    return NEW_BAR;
  }
}

let states: Record<BarId, BarState> = { top: read('top'), dock: read('dock') };
const listeners = new Set<() => void>();

export function dispatchBar(id: BarId, e: BarEvent): void {
  const next = reduce(states[id], e);
  if (next === states[id]) return;
  states = { ...states, [id]: next };
  store(KEY(id), JSON.stringify(next));
  for (const l of listeners) l();
}

export function useBar(id: BarId): BarState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => states[id]);
}
