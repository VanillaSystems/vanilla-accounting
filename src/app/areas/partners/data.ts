/**
 * What Geschäftspartner and Wissen read from the API, read once per page and again after a save,
 * a rule switched, or an answer of the AI sidebar that changed the books or the knowledge. The
 * static audit export has no API: these pages then say they cannot be read.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { STATIC_EXPORT, errorText } from '../../lib/api.js';
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
