/**
 * «KI ganz ausschalten» (Firma › KI, issue #212) as the page knows it: read with the API's status
 * (src/app/hooks/use-api-status.ts, every few seconds) and set at once by the switch itself, so
 * every place that would ask the AI says it is off instead.
 */
import { useSyncExternalStore } from 'react';

let off = false;
const listeners = new Set<() => void>();

export function setAiOff(next: boolean): void {
  if (next === off) return;
  off = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** For words chosen outside a component (a run's note, a mark): the switch as last read. */
export const aiIsOff = (): boolean => off;

export const useAiOff = (): boolean => useSyncExternalStore(subscribe, () => off);
