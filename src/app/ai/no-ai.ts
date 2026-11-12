/**
 * Whether an AI answers on this Mac now, for the places that must say «not read» instead of
 * «read» (#344): one look of GET /api/ai/setup shared by every such place, taken again when the
 * window gets focus (she may have set one up meanwhile). «KI ganz ausschalten» counts as none.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../lib/api.js';
import { useAiOff } from './ai-off.js';

let available: boolean | undefined;
let looking = false;
let wired = false;
const listeners = new Set<() => void>();

function look(): void {
  if (looking) return;
  looking = true;
  api.aiSetup.view().then((v) => { available = v.available; for (const l of listeners) l(); }, () => undefined).finally(() => { looking = false; });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * The same look in three states: `unknown` until GET /api/ai/setup has answered, so a place that offers
 * the AI only when one answers shows neither its offer nor its lack before then (#364): an offer shown
 * first and taken back when a slow look says «none» reads as a flicker.
 */
export function useAiState(): 'unknown' | 'ready' | 'none' {
  const noAi = useNoAi();
  const now = useSyncExternalStore(subscribe, () => available);
  return noAi ? 'none' : now === undefined ? 'unknown' : 'ready';
}

/** True: no AI answers here (none set up, or switched off). False before the first look, so nothing claims a lack it has not seen. */
export function useNoAi(): boolean {
  const off = useAiOff();
  const now = useSyncExternalStore(subscribe, () => available);
  useEffect(() => {
    if (available === undefined) look();
    if (wired) return;
    wired = true;
    window.addEventListener('focus', look);
  }, []);
  return off || now === false;
}
