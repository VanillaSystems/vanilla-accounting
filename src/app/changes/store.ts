/**
 * Änderungen in the browser: one module store polling GET /api/changes?since=rev (every 10 s, at
 * once on focus), and the saves and diffs it opens, fetched once per revision.
 */
import { useSyncExternalStore } from 'react';
import { api, errorText, STATIC_EXPORT } from '../lib/api.js';
import { t } from '../i18n/index.js';
import type { ChangesView, FileDiff, SaveDetail } from '../../saving/model.js';

interface State { view?: ChangesView; error?: string }

let state: State = {};
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let timer: ReturnType<typeof setTimeout> | undefined;

export async function pollChanges(): Promise<void> {
  if (STATIC_EXPORT) { state = { error: t('automation.apiOnly') }; emit(); return; }
  try {
    const answer = await api.changes(state.view?.rev);
    if (!('unchanged' in answer)) { state = { view: answer }; emit(); }
  } catch (e) {
    state = { ...state, error: errorText(e) };
    emit();
  }
  clearTimeout(timer);
  if (listeners.size) timer = setTimeout(pollChanges, 10_000);
}

const onFocus = () => { void pollChanges(); };

export function useChanges(): State {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    if (listeners.size === 1) { void pollChanges(); window.addEventListener('focus', onFocus); }
    return () => { listeners.delete(l); if (!listeners.size) { clearTimeout(timer); window.removeEventListener('focus', onFocus); } };
  }, () => state);
}

const cache = new Map<string, { data?: unknown; error?: string }>();
const cacheListeners = new Set<() => void>();

function useFetched<T>(key: string, load: () => Promise<T>): { data?: T; error?: string } {
  if (!cache.has(key)) {
    cache.set(key, {});
    load().then(
      (data) => { cache.set(key, { data }); for (const l of cacheListeners) l(); },
      (e) => { cache.set(key, { error: errorText(e) }); for (const l of cacheListeners) l(); },
    );
  }
  return useSyncExternalStore((l) => { cacheListeners.add(l); return () => { cacheListeners.delete(l); }; }, () => cache.get(key)!) as { data?: T; error?: string };
}

export const useSave = (oid: string) => useFetched<SaveDetail>(`save:${oid}`, () => api.changesSave(oid));
/** A draft's or an outside edit's diff changes with the files: keyed by the view's revision. */
export const useDiff = (source: string, path: string, rev: string | undefined) => useFetched<FileDiff>(`diff:${source}:${path}:${source === 'draft' || source === 'outside' ? rev : ''}`, () => api.changesDiff(source, path));

/** The view as last fetched, for an area's key handler. */
export const changesNow = (): ChangesView | undefined => state.view;
