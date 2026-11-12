/**
 * The AI sidebar in the browser (docs/0.4.0/views.md, "The AI, as a sidebar"): whether it is
 * open, the conversation in it, what it refers to beyond the page, and the answer as it streams,
 * with the changes it made to the books. Which conversation it continues, across pages and a
 * reload: src/app/assistant/thread.ts. One store for the shell, the areas' «Mit KI …» and the sidebar itself. Open, the
 * sidebar takes its width from the page (--aiw), and every fixed element centres on what is left.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, api, apiFetch, errorText } from '../lib/api.js';
import { language, t, tWith } from '../i18n/index.js';
import { store as remember, stored } from '../shell/storage.js';
import { reloadWorkspace } from '../hooks/use-workspace.js';
import { reloadInvoices } from '../areas/invoices/data.js';
import type { AssistantEvent, ContextRef, ConversationSummary, MadeChange, Purpose, Turn } from '../../types/assistant.js';
import { KEPT_CONVERSATION, KEPT_PURPOSE, afterSend, askAboutThread, leavesSetup, messageOf, newThread, startThread, type Thread } from './thread.js';
import { attachmentRefusal, attachmentType, showsAsImage, type Attachment, type AttachmentType } from '../../types/attachment.js';
import { CHAT_TAKES, leftOut, type Dropped } from '../lib/folder-drop.js';
import { sidebarFit, sidebarWidths } from '../shell/look.js';

export interface AssistantState extends Thread {
  /** The conversations list instead of a conversation. */
  listing: boolean;
  sending: boolean;
  conversations?: ConversationSummary[];
  error?: string;
  /** The files the next message carries, each uploading until it has its `attachment`. */
  files: ComposerFile[];
  /** Why the last file given was not attached (its type, its size, the upload). */
  fileError?: string;
}

/** A file in the composer: `preview` an object URL of an image the browser shows. */
export interface ComposerFile { key: string; name: string; type: AttachmentType; preview?: string; attachment?: Attachment }

let state: AssistantState = { open: stored('assistant.open') === '1', listing: false, turns: [], extra: [], files: [], pageOff: false, sending: false, ...startThread(stored) };
const listeners = new Set<() => void>();
let stop: AbortController | undefined;

/** The setup as src/app/onboarding/state.ts reads it: over once the person ended it; wanted while she has it open by her own click. */
const setup = { over: false, wanted: false };

function set(patch: Partial<AssistantState>): void {
  state = { ...state, ...patch };
  if ('purpose' in patch && state.purpose !== 'onboarding') setup.wanted = false;
  if ('open' in patch) remember('assistant.open', state.open ? '1' : null);
  if ('open' in patch || 'purpose' in patch) refit();
  if ('conversation' in patch) remember(KEPT_CONVERSATION, state.conversation ?? null);
  if ('conversation' in patch || 'purpose' in patch) remember(KEPT_PURPOSE, state.conversation ? null : state.purpose ?? null);
  for (const l of listeners) l();
  if ('purpose' in patch) leaveSetup();
}

/** A setup that is over gives way to an ordinary conversation (src/app/assistant/thread.ts leavesSetup); an answer still streaming is left alone. */
function leaveSetup(): void {
  if (!state.sending && leavesSetup(state, setup)) set({ listing: false, error: undefined, ...newThread() });
}

/** Whether the setup has ended, told whenever the setup's state is read. */
export function setupOver(over: boolean): void { setup.over = over; leaveSetup(); }
/** Firma › «Einrichtung …»: the person opens the setup herself, so it stays open though it has ended. */
export function keepSetup(): void { setup.wanted = true; }
/** «Los geht's»: the setup ends, and the sidebar is the ordinary one from now on. */
export function endSetup(): void { setup.wanted = false; setup.over = true; leaveSetup(); }

/** The conversation open before the window was loaded again: its turns, or a new one when it is gone. */
if (state.conversation) {
  const id = state.conversation;
  api.assistantConversation(id).then(
    (c) => { if (state.conversation === id && !state.turns.length) set({ turns: c.turns, purpose: c.purpose, pageOff: !!c.purpose }); },
    () => { if (state.conversation === id && !state.turns.length) set({ conversation: undefined }); },
  );
}

export const useAssistant = (): AssistantState => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

/**
 * The sidebar's width (--aiw) and whether it lies over the page (html.aiover) for the window as it is now
 * (src/app/shell/look.ts sidebarFit). Says whether either changed.
 */
function fitSidebar(): boolean {
  const root = document.documentElement;
  const windowWidth = innerWidth / (Number(root.style.zoom) || 1);
  const phone = root.classList.contains('phone');
  const dock = phone ? 0 : document.querySelector<HTMLElement>('.activity')?.offsetWidth ?? 0;
  const wanted = sidebarWidths(windowWidth, state.purpose === 'onboarding');
  // A phone keeps the sidebar beside its one column, as before #34.
  const fit = !state.open ? { width: 0, over: false } : phone ? { width: wanted.want, over: false } : sidebarFit(windowWidth - dock, wanted);
  const width = `${Math.round(fit.width)}px`;
  if (root.style.getPropertyValue('--aiw') === width && root.classList.contains('aiover') === fit.over && root.classList.contains('aiopen') === state.open) return false;
  root.style.setProperty('--aiw', width);
  root.classList.toggle('aiover', fit.over);
  root.classList.toggle('aiopen', state.open);
  return true;
}
const refit = () => { if (fitSidebar()) dispatchEvent(new Event('resize')); };

/** The shell sets the page's width at start, from the remembered state, and again whenever the window, the zoom or the dock changes. */
export function syncSidebarWidth(): () => void {
  refit();
  addEventListener('resize', refit);
  return () => removeEventListener('resize', refit);
}

export function toggleAssistant(): void { set({ open: !state.open }); }
export function openAssistant(): void { set({ open: true, listing: false }); }
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
let fileKey = 0;
const forget = (f: ComposerFile) => { if (f.preview) URL.revokeObjectURL(f.preview); };

/**
 * Files dropped on the chat, pasted into the composer or picked with «+»: each is checked here as
 * the server checks it, then uploaded at once, so a refusal shows before the message is sent.
 * `open`: dropped on the window's edge with the sidebar closed, it opens on a new conversation as
 * «Mit KI …» does.
 */
export function attachFiles(files: File[], open = false): void {
  if (open && !state.open) set(state.sending ? { open: true } : { listing: false, error: undefined, ...newThread(), open: true });
  else if (state.listing) set({ listing: false });
  set({ fileError: undefined });
  for (const file of files) {
    const refused = attachmentRefusal(file);
    if (refused) { set({ fileError: errorText(new ApiError({ error: '', ...refused })) }); continue; }
    const type = attachmentType(file)!;
    const f: ComposerFile = { key: `f${++fileKey}`, name: file.name, type, ...(showsAsImage(type) ? { preview: URL.createObjectURL(file) } : {}) };
    set({ files: [...state.files, f] });
    api.assistantAttach(file).then(
      (attachment) => {
        // Taken off while it uploaded: the upload goes too.
        if (!state.files.some((x) => x.key === f.key)) { void api.assistantDetach(attachment.id).catch(() => undefined); return; }
        set({ files: state.files.map((x) => (x.key === f.key ? { ...x, attachment, name: attachment.name } : x)) });
      },
      (e) => { forget(f); set({ files: state.files.filter((x) => x.key !== f.key), fileError: errorText(e) }); },
    );
  }
}

/** A drop with folders in it (src/app/lib/folder-drop.ts): their files attached, and one line for what stayed behind. */
export function attachDropped(d: Dropped): void {
  attachFiles(d.files, true);
  const note = leftOut(d, CHAT_TAKES).map((x) => tWith(x.key, x.vars)).join(' ');
  if (note) set({ fileError: note });
}

export function removeFile(key: string): void {
  const f = state.files.find((x) => x.key === key);
  if (f) forget(f);
  if (f?.attachment) void api.assistantDetach(f.attachment.id).catch(() => undefined);
  set({ files: state.files.filter((x) => x.key !== key), fileError: undefined });
}

/** Whether a file of the next message is still uploading: the message waits for it. */
export const uploading = (s: AssistantState): boolean => s.files.some((f) => !f.attachment);

export function newConversation(): void { if (!state.sending) set({ listing: false, error: undefined, ...newThread() }); }

/** A button with a purpose («Mit KI einrichten») starts a new conversation without the page's reference; «+» adds it back. */
export function newPurposeConversation(purpose: Purpose): void { if (!state.sending) set({ listing: false, error: undefined, ...newThread(purpose) }); }

export async function showConversations(): Promise<void> {
  set({ listing: true });
  try { set({ conversations: await api.assistantList() }); } catch (e) { set({ error: errorText(e) }); }
}

/** Back from the list to the conversation open before it. */
export function hideConversations(): void { set({ listing: false }); }

export async function openConversation(id: string): Promise<void> {
  try {
    const c = await api.assistantConversation(id);
    // Opened by the person from the list or a link: a setup conversation stays one, though the setup has ended.
    if (c.purpose === 'onboarding') setup.wanted = true;
    set({ listing: false, conversation: c.id, turns: c.turns, extra: [], pageOff: true, purpose: c.purpose, error: undefined });
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
    case 'terminal': withAi((t) => ({ ...t, terminal: e.request })); break;
    case 'refused': withAi((t) => ({ ...t, text: '', withdrawn: t.text, refused: e.message, ...(e.refusal ? { refusal: e.refusal } : {}) })); break;
    case 'replace': withAi((t) => ({ ...t, text: e.text })); break;
    case 'done': withAi((t) => ({ ...t, done: true })); break;
    case 'session': break;
  }
}

/** Sends a message with the page's reference (unless taken off) and the added ones; the answer streams into the last turn. */
export async function sendMessage(text: string, page: ContextRef | undefined): Promise<void> {
  if (state.sending || !text.trim() || uploading(state)) return;
  const { conversation, context } = messageOf(state, page);
  const at = new Date().toISOString();
  const attachments = state.files.map((f) => f.attachment!);
  state.files.forEach(forget);
  set({
    sending: true, error: undefined, extra: [], files: [], fileError: undefined, ...afterSend(state),
    turns: [...state.turns, { role: 'me', text, at, context, ...(attachments.length ? { attachments } : {}) }, { role: 'ai', text: '', at, tools: [], done: false }],
  });
  stop = new AbortController();
  try {
    const res = await apiFetch('/api/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: stop.signal,
      body: JSON.stringify({ conversation, text, context, ...(state.purpose && !conversation ? { purpose: state.purpose } : {}), ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}), language: language() }),
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
