/**
 * The chat composer as one state and its transitions: what the person drafts (text, a job,
 * files), the composer's phase (idle, recording, transcribing, sending) and the conversation.
 * The phase decides what may happen: one recording at a time, a send only from idle, a
 * transcript lands in the draft. An action the phase does not allow leaves the state as it is.
 */
import type { ChatEvent } from '../../../types/chat.js';

export type Phase =
  | { kind: 'idle' }
  | { kind: 'recording' }
  /** `progress`: 0..1 while the speech model downloads (the first time only). */
  | { kind: 'transcribing'; progress?: number }
  | { kind: 'sending' };

/** A file attached to the draft; `path` (in the workspace) once the server has it. */
export interface Attachment { id: string; name: string; path?: string; failed?: boolean }

export interface ToolUse { name: string; detail: string; denied?: boolean }

export type Turn =
  | { role: 'user'; text: string; skill?: string; files: string[] }
  | { role: 'assistant'; text: string; tools: ToolUse[]; error?: string; done: boolean };

export interface ChatState {
  phase: Phase;
  draft: string;
  skill?: string;
  files: Attachment[];
  conversation: string;
  /** Claude's session of the last answer: the next message continues it. */
  session?: string;
  turns: Turn[];
  /** The last recording or transcription that failed. */
  error?: string;
}

export type ChatAction =
  | { type: 'draft'; text: string }
  /** A job from the "/" menu: it replaces the typed "/…". */
  | { type: 'skill'; id: string | undefined }
  | { type: 'attach'; files: Attachment[] }
  | { type: 'stored'; id: string; path: string }
  | { type: 'storeFailed'; id: string }
  | { type: 'detach'; id: string }
  | { type: 'record' }
  | { type: 'discard' }
  | { type: 'accept' }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'transcribed'; text: string }
  | { type: 'failed'; message: string }
  | { type: 'send' }
  | { type: 'event'; event: ChatEvent }
  | { type: 'stop' }
  /** "Neu": a new conversation, with this id. */
  | { type: 'fresh'; conversation: string };

export const initialChat = (conversation: string): ChatState => ({ phase: { kind: 'idle' }, draft: '', files: [], conversation, turns: [] });

/** Whether Enter sends: idle, something to say, and every attached file stored. */
export function canSend(s: ChatState): boolean {
  return s.phase.kind === 'idle'
    && (!!s.draft.trim() || !!s.skill || s.files.length > 0)
    && s.files.every((f) => f.path || f.failed);
}

/** The "/" menu's query while the draft is a "/" and a word with no job chosen yet; undefined when the menu is closed. */
export function skillQuery(s: ChatState): string | undefined {
  if (s.skill || s.phase.kind === 'sending') return undefined;
  return /^\/(\S*)$/.exec(s.draft)?.[1];
}

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  const phase = s.phase.kind;
  switch (a.type) {
    case 'draft': return phase === 'sending' ? s : { ...s, draft: a.text };
    case 'skill': return phase === 'sending' ? s : { ...s, skill: a.id, draft: a.id && /^\/\S*$/.test(s.draft) ? '' : s.draft };
    case 'attach': return phase === 'sending' ? s : { ...s, files: [...s.files, ...a.files] };
    case 'stored': return { ...s, files: s.files.map((f) => (f.id === a.id ? { ...f, path: a.path } : f)) };
    case 'storeFailed': return { ...s, files: s.files.map((f) => (f.id === a.id ? { ...f, failed: true } : f)) };
    case 'detach': return phase === 'sending' ? s : { ...s, files: s.files.filter((f) => f.id !== a.id) };
    case 'record': return phase === 'idle' ? { ...s, phase: { kind: 'recording' }, error: undefined } : s;
    case 'discard': return phase === 'recording' ? { ...s, phase: { kind: 'idle' } } : s;
    case 'accept': return phase === 'recording' ? { ...s, phase: { kind: 'transcribing' } } : s;
    case 'progress': return phase === 'transcribing' ? { ...s, phase: { kind: 'transcribing', progress: a.total ? a.loaded / a.total : undefined } } : s;
    case 'transcribed': {
      if (phase !== 'transcribing') return s;
      const text = a.text.trim();
      return { ...s, phase: { kind: 'idle' }, draft: !text ? s.draft : s.draft.trim() ? `${s.draft.trimEnd()} ${text}` : text };
    }
    case 'failed': return phase === 'recording' || phase === 'transcribing' ? { ...s, phase: { kind: 'idle' }, error: a.message } : s;
    case 'send': {
      if (!canSend(s)) return s;
      const user: Turn = { role: 'user', text: s.draft.trim(), files: s.files.filter((f) => f.path).map((f) => f.name), ...(s.skill ? { skill: s.skill } : {}) };
      return { ...s, phase: { kind: 'sending' }, draft: '', skill: undefined, files: [], error: undefined, turns: [...s.turns, user, { role: 'assistant', text: '', tools: [], done: false }] };
    }
    case 'event': return phase === 'sending' ? answer(s, a.event) : s;
    case 'stop': return phase === 'sending' ? { ...withAnswer(s, (t) => ({ ...t, done: true })), phase: { kind: 'idle' } } : s;
    case 'fresh': return phase === 'sending' ? s : { ...initialChat(a.conversation), draft: s.draft, skill: s.skill };
  }
}

function withAnswer(s: ChatState, change: (t: Extract<Turn, { role: 'assistant' }>) => Turn): ChatState {
  const last = s.turns.at(-1);
  if (last?.role !== 'assistant') return s;
  return { ...s, turns: [...s.turns.slice(0, -1), change(last)] };
}

function answer(s: ChatState, e: ChatEvent): ChatState {
  switch (e.type) {
    case 'session': return { ...s, session: e.session };
    case 'text': return withAnswer(s, (t) => ({ ...t, text: t.text + e.text }));
    case 'tool': return withAnswer(s, (t) => ({ ...t, tools: [...t.tools, { name: e.name, detail: e.detail, ...(e.denied ? { denied: true } : {}) }] }));
    case 'error': return { ...withAnswer(s, (t) => ({ ...t, error: e.message, done: true })), phase: { kind: 'idle' } };
    case 'done': return { ...withAnswer(s, (t) => ({ ...t, done: true })), phase: { kind: 'idle' }, ...(e.session ? { session: e.session } : {}) };
  }
}
