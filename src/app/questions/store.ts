/**
 * The questions in the browser (src/questions/model.ts): one module store, read by Aufgaben, the
 * dock's widget, the status corner and every payment, receipt and booking. It fetches GET
 * /api/questions every 15 s and when the window gets focus, so an answer that came in with the
 * shared books folder shows without a reload. Who the viewer is («ich bin …») is a per-viewer
 * preference, kept in this browser.
 */
import { useSyncExternalStore } from 'react';
import { api, errorText, STATIC_EXPORT } from '../lib/api.js';
import { store as keep, stored } from '../shell/storage.js';
import type { Answer, Choice, Question, QuestionsView, QuestionTarget } from '../../questions/model.js';

interface State { view?: QuestionsView; error?: string; me: string }

let state: State = { me: stored('questions.me') ?? '' };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let timer: ReturnType<typeof setTimeout> | undefined;

async function poll(): Promise<void> {
  clearTimeout(timer);
  if (STATIC_EXPORT) return;
  try {
    state = { ...state, view: await api.questions(), error: undefined };
  } catch (e) {
    state = { ...state, error: errorText(e) };
  }
  emit();
  if (listeners.size) timer = setTimeout(poll, 15_000);
}

const onFocus = () => { void poll(); };

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1) { void poll(); window.addEventListener('focus', onFocus); }
  return () => {
    listeners.delete(l);
    if (!listeners.size) { clearTimeout(timer); window.removeEventListener('focus', onFocus); }
  };
}

/** The questions and who the viewer is: the name they chose, else the company's owner. */
export function useQuestions(): State & { questions: Question[]; people: string[] } {
  const s = useSyncExternalStore(subscribe, () => state);
  return withDefaults(s);
}

const withDefaults = (s: State) => ({ ...s, me: s.me || s.view?.people[0] || '', questions: s.view?.questions ?? [], people: s.view?.people ?? [] });

/** The store as last fetched, for code outside React. */
export const questionsNow = () => withDefaults(state);

export function setMe(name: string): void {
  state = { ...state, me: name.trim() };
  keep('questions.me', state.me || null);
  emit();
}

/** Each command fetches the list again at once, so every place shows its effect. */
async function after<T>(p: Promise<T>): Promise<T> {
  const r = await p;
  await poll();
  return r;
}

export const askQuestion = (on: QuestionTarget, text: string, choices: Choice[], to?: string) =>
  after(api.ask({ on, by: questionsNow().me, text, choices, ...(to ? { to } : {}) }));
export const answerQuestion = (id: string, answer: Answer) => after(api.answerQuestion(id, questionsNow().me, answer));
export const undoAnswer = (id: string) => after(api.undoAnswer(id, questionsNow().me));
export const closeQuestion = (id: string, how: 'done' | 'withdrawn') => after(api.closeQuestion(id, questionsNow().me, how));
