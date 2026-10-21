/**
 * The setup in the browser (docs/0.4.0/onboarding.md): the checklist, the answers and the facts as
 * the server keeps them, read again after every answer that changed something; the conversation's
 * steps drawn from them (src/onboarding/conversation.ts); and the one way in: the AI sidebar opened
 * wide on the setup conversation, continued when there is one.
 */
import { useSyncExternalStore } from 'react';
import { api, errorText } from '../lib/api.js';
import { newPurposeConversation, onBooksChanged, openAssistant, showConversation } from '../assistant/store.js';
import { reloadWorkspace } from '../hooks/use-workspace.js';
import { openStep, setupThread, typedChoice, type SetupStep } from '../../onboarding/conversation.js';
import type { QuestionId } from '../../onboarding/model.js';
import type { SetupView } from '../../onboarding/facts.js';
import type { VatSetup } from '../../workspace/vat-setup.js';
import { say } from './words.js';

export interface SetupState { view?: SetupView; steps?: SetupStep[]; error?: string; busy?: boolean }

let state: SetupState = {};
const listeners = new Set<() => void>();
const set = (s: SetupState) => { state = s; for (const l of listeners) l(); };
const withView = (view: SetupView): SetupState => ({ view, steps: setupThread(view.progress, view.facts) });

export const useSetup = (): SetupState => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

export async function loadSetup(): Promise<SetupView | undefined> {
  try { const view = await api.onboarding(); set(withView(view)); return view; } catch { return undefined; }
}

onBooksChanged(() => { void loadSetup(); });

/** A click on one of the open question's answers (or a step passed); `null` takes an answer back. */
export async function answer(q: QuestionId, value: string | null): Promise<void> {
  set({ ...state, busy: true, error: undefined });
  try { set(withView(await api.onboardingAnswer(q, value))); } catch (e) { set({ ...state, busy: false, error: errorText(e) }); }
}

/** Typed text that names one of the open question's answers answers it, as a click would; true when it did. */
export function answerTyped(text: string): boolean {
  const step = openStep(state.steps ?? []);
  const value = typedChoice(step, text, (c) => say(c.label));
  if (!step || value === undefined) return false;
  void answer(step.id as QuestionId, value);
  return true;
}

/**
 * «Übernehmen» on the VAT card: saved through the Firma page's own PATCH /api/workspace (its checks,
 * its refusal of a method change in a year with entries), then kept on the answer with the setup
 * before, for «Rückgängig». A refusal shows on the card.
 */
export async function keepVat(next: VatSetup, before: VatSetup): Promise<string | undefined> {
  try {
    await api.patchWorkspace({ vat: next });
    reloadWorkspace();
    set(withView(await api.onboardingAnswer('vat', state.view?.progress.answers.vat?.value ?? null, before)));
    return undefined;
  } catch (e) { return errorText(e); }
}

/** «Rückgängig» on the VAT card: the setup as it was, through the same path. */
export async function undoVat(before: VatSetup): Promise<string | undefined> {
  try {
    await api.patchWorkspace({ vat: before });
    reloadWorkspace();
    set(withView(await api.onboardingAnswer('vat', state.view?.progress.answers.vat?.value ?? null, null)));
    return undefined;
  } catch (e) { return errorText(e); }
}

/** Opens the setup: the conversation it ran in, or a new one. */
export async function openSetup(): Promise<void> {
  let view: SetupView;
  try { view = await api.onboardingStart(); } catch (e) { set({ ...state, error: errorText(e) }); return; }
  set(withView(view));
  const id = view.progress.conversation;
  if (id && await api.assistantConversation(id).then(() => true, () => false)) { await showConversation(id); return; }
  newPurposeConversation('onboarding');
  openAssistant();
}

/** At start: an empty workspace never set up opens the setup by itself, once. */
export async function openSetupOnFirstStart(): Promise<void> {
  const view = await loadSetup();
  if (view?.firstStart) await openSetup();
}
