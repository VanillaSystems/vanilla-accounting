/**
 * What the ways in of Belege keep beside the URL: the open dialog («Handy koppeln», «Weg
 * hinzufügen», «Alle Wege», the forwarding steps) and the Mac app's phone access, read once and
 * again after each switch, so the strip and the dialog show the same state.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../../lib/api.js';
import { desktop } from '../../desktop/bridge.js';
import type { PhoneInfo } from '../../../types/desktop.js';
import type { MailHost } from '../../../platform/sources/mail-host.js';

export type InflowDialog =
  | { kind: 'pair'; step: 'install' | 'pair' }
  | { kind: 'add' }
  | { kind: 'all' }
  | { kind: 'forward'; address: string; host?: MailHost };

interface State { dialog: InflowDialog | null; phone?: PhoneInfo; phoneError?: string }

let state: State = { dialog: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };

export const useInflow = (): State => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);
export const openInflow = (dialog: InflowDialog): void => set({ dialog });
export const closeInflow = (): void => set({ dialog: null });

/** The Mac app's phone access (GET /api/desktop/phone); nothing to read in a browser. */
export async function loadPhone(): Promise<void> {
  if (!desktop) return;
  try { set({ phone: await api.desktop.phone(), phoneError: undefined }); } catch (e) { set({ phoneError: (e as Error).message }); }
}

/** Switches the access on or off, as Firma › Handy does; the answer carries the pairing code while on. */
export async function switchPhone(on: boolean): Promise<PhoneInfo> {
  const phone = await api.desktop.setPhone(on);
  set({ phone });
  return phone;
}
