/**
 * The AI sidebar's wire format (docs/0.4.0/views.md, "The AI, as a sidebar"; src/assistant/,
 * src/server/routes/assistant.ts, src/app/assistant/): what a message refers to, a stored
 * conversation, the changes an answer made to the books and the events it streams as (NDJSON).
 */
import type { JournalEntry, Receipt } from './index.js';

/** What the person is looking at, referred to and never copied: the server reads it when the message is sent. */
export type ContextRef =
  | { kind: 'entry'; id: string; label: string }
  | { kind: 'payment'; id: string; label: string }
  | { kind: 'receipt'; id: string; label: string }
  | { kind: 'run'; id: string; label: string }
  | { kind: 'workflow'; id: string; label: string }
  | { kind: 'file'; id: string; label: string };

/** A receipt's facts as a person sets them; `null` clears a date or an amount, `vat` replaces the VAT facts. */
export interface ReceiptSet {
  date?: string | null;
  amount?: number | null;
  currency?: string;
  description?: string;
  vat?: Pick<Receipt, 'hasSwissVat' | 'vatSummary' | 'vatId'>;
}

export type EntrySet = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'description' | 'amount' | 'origin'>>;

/** One change to the books (src/server/edits.ts): a receipt's facts, a link between receipt and payment, a booking. */
export type BookChange =
  | { kind: 'receipt'; id: string; set: ReceiptSet }
  | { kind: 'link' | 'unlink'; receipt: string; payment: string }
  | { kind: 'entry'; id: string; set: EntrySet };

/** A change an answer made, with what undoes it. */
export interface MadeChange { id: string; change: BookChange; undo: BookChange; undone?: boolean }

/** POST /api/assistant. Without `conversation` a new one starts. */
export interface AssistantSend {
  conversation?: string;
  text: string;
  context: ContextRef[];
  /** The UI's language: the AI answers in it. */
  language: string;
}

export interface ToolUse { name: string; detail: string; denied?: boolean }

export type Turn =
  | { role: 'me'; text: string; at: string; context: ContextRef[] }
  | { role: 'ai'; text: string; at: string; tools: ToolUse[]; changes?: MadeChange[]; refused?: string; error?: string; done: boolean };

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
  /** The changes the answer made to the books, all of them or, with `refused`, none. */
  | { type: 'changes'; changes: MadeChange[] }
  | { type: 'refused'; message: string }
  | { type: 'done'; session?: string; isError: boolean }
  | { type: 'error'; message: string };
