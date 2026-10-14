/**
 * The sidebar's state: feat/chat's shell/chat/model.ts reducer, grown by the list, the context
 * chips, the mode and the model. Pure; Sidebar.tsx renders it, a module store keeps it across the
 * Shell remount on a language change (grounding §1: state that must survive lives in a module store).
 */
// The wire types move to src/types/assistant.ts (as feat/chat's src/types/chat.ts); assistant.ts imports them from there.
import type { ContextRef, AssistantEvent, AssistantMode, Conversation, ModelChoice } from '../../../types/assistant.js';

export type SidebarView = { kind: 'list' } | { kind: 'conversation'; id: string } | { kind: 'new' };

export interface SidebarState {
  open: boolean;
  view: SidebarView;
  conversations: Conversation[];
  /** The view's context: follows navigation until the first message (dashed chip); null after × ("ohne Kontext"). */
  viewContext: ContextRef | null;
  viewContextOff: boolean;
  /** Chips added with @, the + menu, or «Mit KI ändern…». */
  pinned: ContextRef[];
  draft: string;
  mode: AssistantMode;
  model: ModelChoice;
  phase: { kind: 'idle' } | { kind: 'sending' } | { kind: 'streaming'; conversation: string } | { kind: 'error'; message: string };
  turns: Array<{ me: string; events: AssistantEvent[] }>;
  mention: { query: string } | null;
}

export type SidebarAction =
  | { kind: 'toggle' }
  /** «Mit KI ändern…» / «Ändern…» on an object: open, new conversation, that object pinned as context, mode change. */
  | { kind: 'open-with'; context: ContextRef }
  | { kind: 'navigated'; context: ContextRef | null }
  | { kind: 'draft'; text: string }
  | { kind: 'mention'; query: string | null }
  | { kind: 'pick'; context: ContextRef }
  | { kind: 'unpin'; index: number }
  | { kind: 'view-context-off' }
  | { kind: 'mode'; mode: AssistantMode }
  | { kind: 'model'; model: ModelChoice }
  | { kind: 'sent' }
  | { kind: 'event'; conversation: string; event: AssistantEvent }
  | { kind: 'list'; conversations: Conversation[] }
  | { kind: 'show'; view: SidebarView };

export function sidebarReducer(s: SidebarState, a: SidebarAction): SidebarState {
  throw new Error('not implemented');
}

/** The context the next message carries: the view's (unless off or a conversation already started) plus the pinned ones. */
export function contextToSend(s: SidebarState): ContextRef[] {
  throw new Error('not implemented');
}

/** The view's context from the route: a run, a workflow (+ step), an entry, a receipt, a payment, a period, Änderungen. One switch over Route. */
export function contextOfRoute(route: unknown /* Route */, period: string): ContextRef | null {
  throw new Error('not implemented');
}
