/**
 * What Geschäftspartner and Wissen read from the API, read once per page and again after a save,
 * a rule switched, or an answer of the AI sidebar that changed the books or the knowledge. The
 * static audit export has no API: these pages then say they cannot be read.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { STATIC_EXPORT, api, errorText } from '../../lib/api.js';
import { onBooksChanged } from '../../assistant/store.js';
import { t } from '../../i18n/index.js';

export type Load<T> = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; data: T };

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Everything these pages read is read again. */
export function refreshKnowledge(): void {
  version++;
  listeners.forEach((l) => l());
}
onBooksChanged(refreshKnowledge);

/** One read, by `key`; again when the key changes or after refreshKnowledge. The last answer stays shown while the next is on the way. */
export function useFetched<T>(key: string, fetch: () => Promise<T>): Load<T> {
  const v = useSyncExternalStore(subscribe, () => version);
  const [load, setLoad] = useState<{ key: string; load: Load<T> }>({ key, load: { state: 'loading' } });
  useEffect(() => {
    if (STATIC_EXPORT) { setLoad({ key, load: { state: 'failed', error: t('partners.notInAudit') } }); return; }
    let live = true;
    fetch().then((data) => { if (live) setLoad({ key, load: { state: 'ready', data } }); }, (e) => { if (live) setLoad({ key, load: { state: 'failed', error: errorText(e) } }); });
    return () => { live = false; };
  }, [key, v]);
  return load.key === key ? load.load : { state: 'loading' };
}

/** The same read shared by every component that asks during one render of the page: the list and its detail. */
const shared = new Map<string, { v: number; p: Promise<unknown> }>();
export function once<T>(key: string, fetch: () => Promise<T>): () => Promise<T> {
  return () => {
    const hit = shared.get(key);
    if (hit && hit.v === version) return hit.p as Promise<T>;
    const p = fetch();
    shared.set(key, { v: version, p });
    p.catch(() => shared.delete(key));
    return p;
  };
}

/** The partners of the open year, one read shared by Geschäftspartner and the lists' filters. */
export const readPartners = once('partners', () => api.partners());

/**
 * Which business a receipt or an entry belongs to, as Geschäftspartner routes them (src/knowledge/partners.ts,
 * the open year): the lists' filter chips read it. Undefined while loading or where there is no API.
 */
export interface PartnerIndex {
  name(id: string): string | undefined;
  ofReceipt(id: string): string | undefined;
  /** An entry can belong to several partners (a Sammelzahlung's parts). */
  ofEntry(id: string): readonly string[];
}

export function usePartnerIndex(): PartnerIndex | undefined {
  const load = useFetched('partners', readPartners);
  return useMemo(() => {
    if (load.state !== 'ready') return undefined;
    const names = new Map<string, string>();
    const receipts = new Map<string, string>();
    const entries = new Map<string, string[]>();
    for (const p of load.data.partners) {
      names.set(p.id, p.name);
      for (const r of p.receipts) if (!receipts.has(r)) receipts.set(r, p.id);
      for (const e of p.entries) entries.set(e, [...(entries.get(e) ?? []), p.id]);
    }
    return { name: (id: string) => names.get(id), ofReceipt: (id: string) => receipts.get(id), ofEntry: (id: string) => entries.get(id) ?? [] };
  }, [load]);
}
