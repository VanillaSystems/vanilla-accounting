/**
 * What Rechnungen keeps beside the URL: the open dialog (a dialog is an action, not a place:
 * docs/urls.md), the draft shown as Vorschau, a reminder being written, and which margin
 * sections and list groups are open (per viewer, kept in this browser).
 */
import { useSyncExternalStore } from 'react';
import { store, stored } from '../../shell/prefs.js';
import type { RowState } from './model.js';

export type Section = 'draft' | 'look' | 'customer' | 'sent' | 'comments' | 'log';

export type Dialog =
  | { kind: 'new' }
  /** The customer form; `then` names what follows a new customer: a draft for it, or the draft being written gets it. */
  | { kind: 'customer'; id?: string; then?: 'invoice' | { draft: string } }
  | { kind: 'cancel' }
  | { kind: 'credit' }
  | { kind: 'delete' }
  /** Sending the invoice, or the reminder written on the sheet, by e-mail or as a download. */
  | { kind: 'send'; reminder?: Omit<ReminderEdit, 'invoiceId'> & { level: number } };

/** A reminder written on the sheet before it is sent: for this invoice, with these texts and fee. */
export interface ReminderEdit { invoiceId: string; fee?: number; intro?: string; closing?: string }

interface State {
  dialog: Dialog | null;
  preview: boolean;
  reminder: ReminderEdit | null;
  open: Record<Section, boolean>;
  collapsed: ReadonlySet<RowState>;
  /** A field of the sheet to put the caret in once it shows (a new draft's first line). */
  focus?: string;
}

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(stored(key) ?? '') as T; } catch { return fallback; }
}

let state: State = {
  dialog: null,
  preview: false,
  reminder: null,
  open: { draft: true, look: false, customer: false, sent: true, comments: true, log: false, ...read<Partial<Record<Section, boolean>>>('invoices.open', {}) },
  collapsed: new Set(read<RowState[]>('invoices.collapsed', [])),
};
const listeners = new Set<() => void>();

export function setUi(patch: Partial<State>): void {
  state = { ...state, ...patch };
  if (patch.open) store('invoices.open', JSON.stringify(state.open));
  if (patch.collapsed) store('invoices.collapsed', JSON.stringify([...state.collapsed]));
  listeners.forEach((l) => l());
}

export const ui = (): State => state;

export function useUi(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function toggleGroup(key: RowState): void {
  const next = new Set(state.collapsed);
  if (next.has(key)) next.delete(key); else next.add(key);
  setUi({ collapsed: next });
}

/** The rows of the list as shown, in order, for ↑/↓ (the list writes it, the keys read it). */
export const listed: { ids: string[] } = { ids: [] };
