/**
 * What Verkauf keeps beside the URL: the open dialog (a dialog is an action, not a place:
 * docs/urls.md), the draft shown as Vorschau, a reminder being written, the rows ticked in a
 * table, the filters of Versendet, and per viewer in this browser the margin sections open and
 * each table's sort.
 */
import { useSyncExternalStore } from 'react';
import { store, stored } from '../../shell/storage.js';
import { DEFAULT_SORT, DOC_VIEWS, type DocView, type Sort } from './table.js';
import type { DocumentKind, WriteOffReason } from '../../../invoices/model.js';

export type Section = 'draft' | 'look' | 'chain' | 'plan' | 'customer' | 'money' | 'sent' | 'comments' | 'log';

export type Dialog =
  /** Whom a new document is for; `doc`: its kind (absent: a Rechnung). */
  | { kind: 'new'; doc?: DocumentKind }
  /** A conversion of the open document into `to` (spec 4.4.1): its positions with the quantities still open. */
  | { kind: 'convert'; to: DocumentKind }
  /**
   * A warning of spec 4.11 the API gave (`code`, its words in `text`): «Trotzdem …» (`anyway`, the
   * button's words) runs `run` again with the person's confirmation.
   */
  | { kind: 'warn'; title: string; text: string; anyway: string; run: () => Promise<unknown> }
  /** The contact form; `then` names what follows a new contact: a draft (of a kind) for it, or the draft being written gets it. */
  | { kind: 'contact'; id?: string; then?: 'invoice' | { draft: string } | { kind: DocumentKind }; name?: string }
  /** Kontakte importieren: a CSV with its column mapping. */
  | { kind: 'contactImport' }
  /** A new Artikel; Artikel importieren; «＋ Artikel» on the draft `draft`, after its position `after` (-1: at the end). */
  | { kind: 'article' }
  | { kind: 'articleImport' }
  | { kind: 'articlePick'; draft: string; after: number }
  | { kind: 'cancel' }
  /** «Zahlungseingang erfassen» on the open invoice. */
  | { kind: 'handPayment' }
  /** «Rest ausbuchen»: the reason (and amount) proposed, e.g. a shortfall as Spesen. */
  | { kind: 'writeOff'; reason?: WriteOffReason; amount?: number }
  /** Ausziffern of an incoming payment over a customer's open invoices. */
  | { kind: 'allocate'; transactionRef: string; customerId?: string }
  | { kind: 'credit' }
  | { kind: 'delete' }
  /** «Zurück zum Entwurf» of an unsent document, and «Konten ändern» of an issued invoice (spec 4.4.2). */
  | { kind: 'backToDraft' }
  | { kind: 'accounts' }
  /**
   * Sending the invoice with its PDF shown, or the reminder written on the sheet, by e-mail or as a download.
   * `issued`: opened by «Ausstellen» itself, so the document to take away is in front of the person at once.
   */
  /** «PDF herunterladen» of a Rechnung or Gutschrift never sent: «Ja, festhalten» records the download as its sending, «Nur ansehen» saves it only. */
  | { kind: 'download' }
  | { kind: 'send'; reminder?: { level: number; title: string }; issued?: true; instalment?: true }
  /** The Mahnlauf (spec 4.4.7): every overdue Rechnung on a reference date, or the ticked ones (`ids`). */
  | { kind: 'dunning'; ids?: string[] }
  /** The Teilrechnungsplan of the open Auftrag (spec 4.4.9). */
  | { kind: 'plan' }
  /** The ticked documents (their ids), sent by e-mail one by one, or their PDFs downloaded. */
  | { kind: 'bulk-send'; ids: string[] }
  | { kind: 'bulk-pdf'; ids: string[] };

/** The tables that sort: one per kind of document. */
export type Sorted = DocView;

/** Versendet's filters: a contact (its id), a kind of document, a channel; absent: all. */
export interface SentFilter { customer?: string; kind?: string; channel?: string }

interface State {
  dialog: Dialog | null;
  preview: boolean;
  /** With a Mahnung written and not sent: which sheet the detail shows, the Mahnung (its tab, the default) or the Rechnung. */
  sheet: 'reminder' | 'invoice';
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
  sheet: 'reminder',
  open: { draft: true, look: false, chain: true, plan: true, customer: false, money: true, sent: true, comments: true, log: false, ...read<Partial<Record<Section, boolean>>>('invoices.open', {}) },
  sort: { ...(Object.fromEntries(DOC_VIEWS.map((v) => [v, DEFAULT_SORT])) as Record<Sorted, Sort>), ...read<Partial<Record<Sorted, Sort>>>('invoices.sort', {}) },
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
