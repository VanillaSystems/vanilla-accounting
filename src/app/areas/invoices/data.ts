/**
 * The invoicing records as the API serves them (invoices.json): customers, invoices and sent
 * documents, read once per page and again after every change. A draft edited on the sheet is
 * put back here at once, so the list follows while the API saves it.
 */
import { useSyncExternalStore } from 'react';
import type { Customer, Invoice } from '../../../invoices/model.js';
import { api, STATIC_EXPORT, type InvoiceList } from '../../lib/api.js';

export type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: InvoiceList };

let load: Load = { state: 'loading' };
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Reads the records again; resolves when they are in. */
export function reloadInvoices(): Promise<void> {
  if (STATIC_EXPORT) {
    load = { state: 'failed' };
    emit();
    return Promise.resolve();
  }
  pending = api.invoices().then(
    (data) => { load = { state: 'ready', data }; emit(); },
    () => { if (load.state !== 'ready') { load = { state: 'failed' }; emit(); } },
  );
  return pending;
}

export function useInvoices(): Load {
  const l = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => load);
  if (l.state === 'loading' && !pending) void reloadInvoices();
  return l;
}

/** The records for code outside components (⌘K, the tab title, keys). */
export const invoicesNow = (): InvoiceList | undefined => (load.state === 'ready' ? load.data : undefined);

/** A record changed by this page: shown at once, before the next read. */
export function put(change: { invoice?: Invoice; customer?: Customer }): void {
  if (load.state !== 'ready') return;
  const d = load.data;
  const upsert = <T extends { id: string }>(xs: T[], x: T | undefined) => (!x ? xs : xs.some((y) => y.id === x.id) ? xs.map((y) => (y.id === x.id ? x : y)) : [...xs, x]);
  load = { state: 'ready', data: { ...d, invoices: upsert(d.invoices, change.invoice), customers: upsert(d.customers, change.customer) } };
  emit();
}
