/**
 * The AI sidebar's wire format (docs/0.4.0/views.md, "The AI, as a sidebar"; src/assistant/,
 * src/server/routes/assistant.ts, src/app/assistant/): what a message refers to, the two modes, a
 * stored conversation and the events an answer streams as (NDJSON, one event per line).
 */

/** What the person is looking at, referred to and never copied: the server reads it when the message is sent. */
export type ContextRef =
  | { kind: 'entry'; id: string; label: string }
  | { kind: 'payment'; id: string; label: string }
  | { kind: 'receipt'; id: string; label: string }
  | { kind: 'run'; id: string; label: string }
  | { kind: 'workflow'; id: string; label: string }
  | { kind: 'file'; id: string; label: string };

/** Fragen reads only; Ändern also writes, and only into the draft (data/draft/), which a person saves in Änderungen. */
export type AssistantMode = 'ask' | 'change';

/** POST /api/assistant. Without `conversation` a new one starts. */
export interface AssistantSend {
  conversation?: string;
  text: string;
  context: ContextRef[];
  mode: AssistantMode;
  /** The UI's language: the AI answers in it. */
  language: string;
}

export interface ToolUse { name: string; detail: string; denied?: boolean }

export type Turn =
  | { role: 'me'; text: string; at: string; mode: AssistantMode; context: ContextRef[] }
  | { role: 'ai'; text: string; at: string; tools: ToolUse[]; error?: string; done: boolean };

/** data/assistant/<id>.json: one conversation, its Claude session continued by every message. */
export interface Conversation {
  id: string;
  title: string;
  at: string;
  session?: string;
  turns: Turn[];
}

export interface ConversationSummary { id: string; title: string; at: string; context: string[] }

export type AssistantEvent =
  /** The first event of every answer: the conversation the message went into. */
  | { type: 'conversation'; id: string }
  | { type: 'session'; session: string }
  /** A piece of the answer, appended to what came before. */
  | { type: 'text'; text: string }
  /** The AI uses a tool (`detail`: the file, command or pattern); `denied` when its permissions refused it. */
  | { type: 'tool'; name: string; detail: string; denied?: boolean }
  | { type: 'done'; session?: string; isError: boolean }
  | { type: 'error'; message: string };
