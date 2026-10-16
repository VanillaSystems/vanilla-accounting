/**
 * The AI sidebar in the browser (docs/0.4.0/views.md, "The AI, as a sidebar"): whether it is
 * open, the conversation in it, what it refers to beyond the page, and the answer as it streams,
 * with the changes it made to the books. Which conversation it continues, across pages and a
 * reload: src/app/assistant/thread.ts. One store for the shell, the areas' «Mit KI …» and the sidebar itself. Open, the
 * sidebar takes its width from the page (--aiw), and every fixed element centres on what is left.
 */
import { useSyncExternalStore } from 'react';
import { api, errorText } from '../lib/api.js';
import { language } from '../i18n/index.js';
import { store as remember, stored } from '../shell/storage.js';
import { reloadWorkspace } from '../hooks/use-workspace.js';
import { reloadInvoices } from '../areas/invoices/data.js';
import type { AssistantEvent, ContextRef, ConversationSummary, MadeChange, Turn } from '../../types/assistant.js';
import { KEPT_CONVERSATION, askAboutThread, messageOf, newThread, startThread, type Thread } from './thread.js';

/** 400 px, less on a small window, so the page keeps room for its list and its detail. */
export const SIDEBAR_WIDTH = 'min(400px, 34vw)';

export interface AssistantState extends Thread {
  /** The conversations list instead of a conversation. */
  listing: boolean;
  sending: boolean;
  conversations?: ConversationSummary[];
  error?: string;
}

let state: AssistantState = { open: stored('assistant.open') === '1', listing: false, turns: [], extra: [], pageOff: false, sending: false, ...startThread(stored) };
const listeners = new Set<() => void>();
let stop: AbortController | undefined;

function set(patch: Partial<AssistantState>): void {
  state = { ...state, ...patch };
  if ('open' in patch) {
    remember('assistant.open', state.open ? '1' : null);
    document.documentElement.style.setProperty('--aiw', state.open ? SIDEBAR_WIDTH : '0px');
  }
  if ('conversation' in patch) remember(KEPT_CONVERSATION, state.conversation ?? null);
  for (const l of listeners) l();
}

/** The conversation open before the window was loaded again: its turns, or a new one when it is gone. */
if (state.conversation) {
  const id = state.conversation;
  api.assistantConversation(id).then(
    (c) => { if (state.conversation === id && !state.turns.length) set({ turns: c.turns, pageOff: false }); },
    () => { if (state.conversation === id && !state.turns.length) set({ conversation: undefined }); },
  );
}

export const useAssistant = (): AssistantState => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

/** The shell sets the page's width at start, from the remembered state. */
export const syncSidebarWidth = () => document.documentElement.style.setProperty('--aiw', state.open ? SIDEBAR_WIDTH : '0px');

export function toggleAssistant(): void { set({ open: !state.open }); }
export function closeAssistant(): void { set({ open: false }); }

/** «Mit KI …» on an object (src/app/assistant/thread.ts askAboutThread): into the open conversation, or a new one when the sidebar was closed. */
export function askAbout(ref: ContextRef): void {
  if (state.sending) { set({ open: true }); return; }
  set({ listing: false, error: undefined, ...askAboutThread(state, ref) });
}

/** The page reloads the books when an answer changed them or a change was taken back. */
const changed = new Set<() => void>();
export function onBooksChanged(f: () => void): () => void { changed.add(f); return () => { changed.delete(f); }; }
/** An answer may change the chart, the invoicing settings or the invoices too: they are read again with the books. */
const booksChanged = () => { reloadWorkspace(); void reloadInvoices(); for (const f of changed) f(); };
export function addContext(ref: ContextRef): void { if (!state.extra.some((r) => r.kind === ref.kind && r.id === ref.id)) set({ extra: [...state.extra, ref] }); }
/** The page's reference goes with the next message again, after it was taken off. */
export function keepPage(): void { set({ pageOff: false }); }
export function removeContext(ref: ContextRef | 'page'): void { set(ref === 'page' ? { pageOff: true } : { extra: state.extra.filter((r) => !(r.kind === ref.kind && r.id === ref.id)) }); }
export function newConversation(): void { if (!state.sending) set({ listing: false, error: undefined, ...newThread() }); }

export async function showConversations(): Promise<void> {
  set({ listing: true });
  try { set({ conversations: await api.assistantList() }); } catch (e) { set({ error: errorText(e) }); }
}

/** Back from the list to the conversation open before it. */
export function hideConversations(): void { set({ listing: false }); }

export async function openConversation(id: string): Promise<void> {
  try {
    const c = await api.assistantConversation(id);
    set({ listing: false, conversation: c.id, turns: c.turns, extra: [], pageOff: true, error: undefined });
  } catch (e) { set({ error: errorText(e) }); }
}

/** A booking the AI changed opens the conversation it was changed in (Buchungen › Erfasst › «Gespräch öffnen»). */
export async function showConversation(id: string): Promise<void> {
  set({ open: true });
  await openConversation(id);
}

export function stopAnswer(): void { stop?.abort(); }

type Ai = Extract<Turn, { role: 'ai' }>;
const withAi = (f: (t: Ai) => Ai) => {
  const last = state.turns.at(-1);
  if (last?.role === 'ai') set({ turns: [...state.turns.slice(0, -1), f(last)] });
};

function apply(e: AssistantEvent): void {
  switch (e.type) {
    case 'conversation': set({ conversation: e.id }); break;
    case 'text': withAi((t) => ({ ...t, text: t.text + e.text })); break;
    case 'tool': withAi((t) => ({ ...t, tools: [...t.tools, { name: e.name, detail: e.detail, ...(e.denied ? { denied: true } : {}) }] })); break;
    case 'error': withAi((t) => ({ ...t, error: e.message, done: true })); break;
    case 'changes': withAi((t) => ({ ...t, changes: e.changes })); booksChanged(); break;
    case 'held': withAi((t) => ({ ...t, held: e.held })); break;
    case 'refused': withAi((t) => ({ ...t, text: '', withdrawn: t.text, refused: e.message, ...(e.refusal ? { refusal: e.refusal } : {}) })); break;
    case 'replace': withAi((t) => ({ ...t, text: e.text })); break;
    case 'done': withAi((t) => ({ ...t, done: true })); break;
    case 'session': break;
  }
}

/** Sends a message with the page's reference (unless taken off) and the added ones; the answer streams into the last turn. */
export async function sendMessage(text: string, page: ContextRef | undefined): Promise<void> {
  if (state.sending || !text.trim()) return;
  const { conversation, context } = messageOf(state, page);
  const at = new Date().toISOString();
  set({
    sending: true, error: undefined, extra: [], pageOff: false,
    turns: [...state.turns, { role: 'me', text, at, context }, { role: 'ai', text: '', at, tools: [], done: false }],
  });
  stop = new AbortController();
  try {
    const res = await fetch('/api/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: stop.signal,
      body: JSON.stringify({ conversation, text, context, language: language() }),
    });
    if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) apply(JSON.parse(l) as AssistantEvent);
    }
  } catch (e) {
    if (!stop.signal.aborted) withAi((t) => ({ ...t, error: errorText(e), done: true }));
  } finally {
    withAi((t) => ({ ...t, done: true }));
    set({ sending: false });
  }
}

/** Whether an answer wrote into the draft: the sidebar then links to Änderungen. */
export const wroteDraft = (t: Turn): boolean => t.role === 'ai' && t.tools.some((u) => !u.denied && /^(Edit|Write)$/.test(u.name) && u.detail.startsWith('data/draft/'));

/** «Rückgängig» on one change an answer made; the others of its answer on the same payment go with it. */
export async function undoChange(change: MadeChange): Promise<void> {
  if (!state.conversation) return;
  try {
    const undone = new Set((await api.assistantUndo(state.conversation, change.id)).map((c) => c.id));
    set({ turns: state.turns.map((t) => (t.role === 'ai' && t.changes?.some((c) => undone.has(c.id)) ? { ...t, changes: t.changes.map((c) => (undone.has(c.id) ? { ...c, undone: true } : c)) } : t)) });
    booksChanged();
  } catch (e) { set({ error: errorText(e) }); }
}

/** «Übernehmen» (`take`) or «Verwerfen» on the changes the app held for the answer at `turn`. */
export async function settleHeld(turn: number, take: boolean): Promise<void> {
  const id = state.conversation;
  if (!id) return;
  try {
    const settled = await api.assistantHeld(id, turn, take, language());
    if (state.conversation === id) set({ turns: state.turns.map((x, i) => (i === turn ? settled : x)) });
    if (take) booksChanged();
  } catch (e) { set({ error: errorText(e) }); }
}

/** «Alle rückgängig» on the changes a held answer made once taken: each that stands, newest first. */
export async function undoAll(turn: number): Promise<void> {
  const of = () => { const t = state.turns[turn]; return t?.role === 'ai' ? t.changes ?? [] : []; };
  for (const id of of().map((c) => c.id).reverse()) {
    const c = of().find((x) => x.id === id);
    if (c && !c.undone && c.undo) await undoChange(c);
  }
}
