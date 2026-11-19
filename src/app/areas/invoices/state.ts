/**
 * What Verkauf keeps beside the URL: the open dialog (a dialog is an action, not a place:
 * docs/urls.md), the draft shown as Vorschau, a reminder being written, the rows ticked in a
 * table, the filters of Versendet, and per viewer in this browser the margin sections open and
 * each table's sort.
 */
import { useSyncExternalStore } from 'react';
import { store, stored } from '../../shell/storage.js';
import { DEFAULT_SORT, type Sort } from './table.js';
import type { WriteOffReason } from '../../../invoices/model.js';

export type Section = 'draft' | 'look' | 'customer' | 'money' | 'sent' | 'comments' | 'log';

export type Dialog =
  | { kind: 'new' }
  /** The customer form; `then` names what follows a new customer: a draft for it, or the draft being written gets it. */
  | { kind: 'customer'; id?: string; then?: 'invoice' | { draft: string }; name?: string }
  | { kind: 'cancel' }
  /** «Zahlungseingang erfassen» on the open invoice. */
  | { kind: 'handPayment' }
  /** «Rest ausbuchen»: the reason (and amount) proposed, e.g. a shortfall as Spesen. */
  | { kind: 'writeOff'; reason?: WriteOffReason; amount?: number }
  /** Ausziffern of an incoming payment over a customer's open invoices. */
  | { kind: 'allocate'; transactionRef: string; customerId?: string }
  | { kind: 'credit' }
  | { kind: 'delete' }
  /**
   * Sending the invoice with its PDF shown, or the reminder written on the sheet, by e-mail or as a download.
   * `issued`: opened by «Ausstellen» itself, so the document to take away is in front of the person at once.
   */
  | { kind: 'send'; reminder?: Omit<ReminderEdit, 'invoiceId'> & { level: number }; issued?: true }
  /** The ticked documents (their ids), sent by e-mail one by one, or their PDFs downloaded. */
  | { kind: 'bulk-send'; ids: string[] }
  | { kind: 'bulk-pdf'; ids: string[] };

/** The tables that sort: Rechnungen, Gutschriften. */
export type Sorted = 'list' | 'credit-notes';

/** Versendet's filters: a contact (its id), a kind of document, a channel; absent: all. */
export interface SentFilter { customer?: string; kind?: string; channel?: string }

/** A reminder written on the sheet before it is sent: for this invoice, with these texts and fee. */
export interface ReminderEdit { invoiceId: string; fee?: number; intro?: string; closing?: string }

interface State {
  dialog: Dialog | null;
  preview: boolean;
  reminder: ReminderEdit | null;
  open: Record<Section, boolean>;
  sort: Record<Sorted, Sort>;
  /** The documents ticked in the table shown (their ids); another view or tab starts with none. */
  ticked: ReadonlySet<string>;
  sentFilter: SentFilter;
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
  open: { draft: true, look: false, customer: false, money: true, sent: true, comments: true, log: false, ...read<Partial<Record<Section, boolean>>>('invoices.open', {}) },
  sort: { list: DEFAULT_SORT, 'credit-notes': DEFAULT_SORT, ...read<Partial<Record<Sorted, Sort>>>('invoices.sort', {}) },
  ticked: new Set(),
  sentFilter: {},
};
const listeners = new Set<() => void>();

export function setUi(patch: Partial<State>): void {
  state = { ...state, ...patch };
  if (patch.open) store('invoices.open', JSON.stringify(state.open));
  if (patch.sort) store('invoices.sort', JSON.stringify(state.sort));
  listeners.forEach((l) => l());
}

export const ui = (): State => state;

export function useUi(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function toggleTick(id: string): void {
  const next = new Set(state.ticked);
  if (next.has(id)) next.delete(id); else next.add(id);
  setUi({ ticked: next });
}

/** The rows of the list as shown, in order, for ↑/↓ (the list writes it, the keys read it). */
export const listed: { ids: string[] } = { ids: [] };
