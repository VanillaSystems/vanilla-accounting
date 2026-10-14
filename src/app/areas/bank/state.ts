/**
 * What Kontoauszüge keeps beside the URL: grouping by account or month, the collapsed groups and
 * open detail sections (per viewer, in this browser: docs/urls.md), the preview overlay; and the
 * bank model of the loaded books, with the list as last shown for the keys.
 */
import { useSyncExternalStore } from 'react';
import type { Index } from '../../../types/index.js';
import { localToday } from '../../../accounting/periods.js';
import { store, stored } from '../../shell/storage.js';
import { workspaceNow } from '../../hooks/use-workspace.js';
import { bankOf, type Account, type Bank } from './model.js';

export type GroupBy = 'konto' | 'monat';
export type Section = 'zahlungen' | 'kurse' | 'datei';

interface State {
  groupBy: GroupBy;
  collapsed: ReadonlySet<string>;
  open: Record<Section, boolean>;
  overlay: 'quick' | null;
}

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(stored(key) ?? '') as T; } catch { return fallback; }
}

let state: State = {
  groupBy: stored('bank.group') === 'monat' ? 'monat' : 'konto',
  collapsed: new Set(read<string[]>('bank.collapsed', [])),
  open: { zahlungen: true, kurse: false, datei: false, ...read<Partial<Record<Section, boolean>>>('bank.open', {}) },
  overlay: null,
};
const listeners = new Set<() => void>();

export function setUi(patch: Partial<State>): void {
  state = { ...state, ...patch };
  if (patch.groupBy) store('bank.group', state.groupBy);
  if (patch.collapsed) store('bank.collapsed', JSON.stringify([...state.collapsed]));
  if (patch.open) store('bank.open', JSON.stringify(state.open));
  listeners.forEach((l) => l());
}

export const ui = (): State => state;

export function useUi(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function toggleGroup(key: string): void {
  const next = new Set(state.collapsed);
  if (next.has(key)) next.delete(key); else next.add(key);
  setUi({ collapsed: next });
}

let memo: { books: Index; accounts: readonly Account[]; bank: Bank } | undefined;

const NONE: readonly Account[] = [];

/** The bank of these books and the manifest's accounts, computed once per load. */
export function bankFor(books: Index, accounts: readonly Account[] | undefined = workspaceNow()?.bankAccounts): Bank {
  const list = accounts ?? NONE;
  if (memo?.books !== books || memo.accounts !== list) memo = { books, accounts: list, bank: bankOf(books, list, localToday()) };
  return memo.bank;
}

/** The statements as last listed, in ↑↓ order: the keys move through them. */
export const listed: { keys: string[] } = { keys: [] };
