/**
 * The automation in the browser: one module store, read by the Automatisierung area and, later,
 * by the status corner and the buttons in other areas. It polls GET /api/automation?since=rev
 * (every 10 s, at once when the window gets focus) and the server answers { unchanged: true }
 * while nothing moved. It lives in src/app/automation/ so it imports neither the shell nor an area.
 */
import { useSyncExternalStore } from 'react';
import { api, errorText, STATIC_EXPORT } from '../lib/api.js';
import { t } from '../i18n/index.js';
import type { AutomationView, RunDetail } from '../../workflows/model.js';

interface State { view?: AutomationView; error?: string }

let state: State = {};
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let timer: ReturnType<typeof setTimeout> | undefined;

async function poll(): Promise<void> {
  if (STATIC_EXPORT) { state = { error: t('automation.apiOnly') }; emit(); return; }
  try {
    const answer = await api.automation(state.view?.rev);
    if (!('unchanged' in answer)) { state = { view: answer }; emit(); }
    else if (state.error) { state = { view: state.view }; emit(); }
  } catch (e) {
    state = { ...state, error: errorText(e) };
    emit();
  }
  if (listeners.size) timer = setTimeout(poll, 10_000);
}

const onFocus = () => { clearTimeout(timer); void poll(); };

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1) { void poll(); window.addEventListener('focus', onFocus); }
  return () => {
    listeners.delete(l);
    if (!listeners.size) { clearTimeout(timer); window.removeEventListener('focus', onFocus); }
  };
}

export function useAutomation(): State {
  return useSyncExternalStore(subscribe, () => state);
}

const runs = new Map<string, { data?: RunDetail; error?: string }>();
const runListeners = new Set<() => void>();

/** One run with its step records, fetched again whenever the view's revision moves. */
export function useRun(id: string, rev: string | undefined): { data?: RunDetail; error?: string } {
  const key = `${id}@${rev ?? ''}`;
  if (!runs.has(key)) {
    runs.set(key, runs.get([...runs.keys()].find((k) => k.startsWith(`${id}@`)) ?? '') ?? {});
    api.automationRun(id).then(
      (data) => { runs.set(key, { data }); for (const l of runListeners) l(); },
      (e) => { runs.set(key, { error: errorText(e) }); for (const l of runListeners) l(); },
    );
  }
  return useSyncExternalStore((l) => { runListeners.add(l); return () => { runListeners.delete(l); }; }, () => runs.get(key)!);
}

/** The view as last fetched, for code outside React (an area's key handler). */
export const automationNow = (): AutomationView | undefined => state.view;
