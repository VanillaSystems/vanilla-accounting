/**
 * The automation in the browser: one module store, read by the Automatisierung area and, later,
 * by the status corner and the buttons in other areas. It polls GET /api/automation?since=rev
 * (every 10 s, every 2 s while a run is open or a screen hurries it, at once when the window gets focus; one loop, poller.ts) and the server answers { unchanged: true }
 * while nothing moved. It lives in src/app/automation/ so it imports neither the shell nor an area.
 */
import { useSyncExternalStore } from 'react';
import { api, errorText, STATIC_EXPORT } from '../lib/api.js';
import { t } from '../i18n/index.js';
import { poller } from './poller.js';
import type { AutomationCommand, AutomationView, CommandResult, RunDetail } from '../../workflows/model.js';

interface State { view?: AutomationView; error?: string }

let state: State = {};
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let hurry = false;

async function ask(): Promise<void> {
  if (STATIC_EXPORT) { state = { error: t('automation.apiOnly') }; emit(); return; }
  try {
    const answer = await api.automation(state.view?.rev);
    if (!('unchanged' in answer)) { state = { view: answer }; emit(); }
    else if (state.error) { state = { view: state.view }; emit(); }
  } catch (e) {
    state = { ...state, error: errorText(e) };
    emit();
  }
}

// Every 2 s while something runs or a screen waits for runs to show (`hurry`), every 10 s when it is quiet; one loop only (poller.ts).
const loop = poller(ask, () => (hurry || state.view?.runs.some((r) => r.status === 'running' || r.status === 'queued') ? 2_000 : 10_000), () => listeners.size > 0);
const onFocus = () => { void loop.now(); };

/** Asks at once, as focus does: a screen that just started work (a drop's file taken, #453) shows its run's steps without waiting 10 s. */
export const pollNow = (): void => { if (listeners.size) onFocus(); };

/** While on, the store asks every 2 s even when the last answer showed no run: the drop window while its files are worked on (#453). */
export function hurryWhile(on: boolean): void {
  const was = hurry;
  hurry = on;
  if (on && !was) pollNow();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1) { void loop.now(); window.addEventListener('focus', onFocus); }
  return () => {
    listeners.delete(l);
    if (!listeners.size) { loop.stop(); window.removeEventListener('focus', onFocus); }
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

/** POST /api/automation, then a poll at once, so the screens show the command's effect without waiting for the next tick. */
export async function automationCommand(cmd: AutomationCommand): Promise<CommandResult> {
  const result = await api.automationCommand(cmd);
  await loop.now();
  return result;
}

/** The direct way: a workflow's schedule, or null to switch it off; the view is fetched again at once. */
export async function setSchedule(workflow: string, schedule: string | null): Promise<void> {
  await api.automationSchedule(workflow, schedule);
  await loop.now();
}
