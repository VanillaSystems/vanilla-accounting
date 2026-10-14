/**
 * The AI sidebar's server side: feat/chat's src/chat/claude.ts ported (spawn `claude -p
 * --output-format stream-json`, NDJSON ChatEvents, --resume), with three changes:
 *
 * 1. Conversations persist (data/assistant/<conversation>/meta.json + events.jsonl, outside git),
 *    so the sidebar lists them with title, time and context, and survives a reload.
 * 2. Context is a list of typed references, resolved to one line each in the prompt ("Lauf
 *    booking-3f2a…, waiting at classify"); the model reads the record itself through the read
 *    commands (ADR 0005) and every lookup shows as a tool event.
 * 3. Mode decides the tools, and the writable set is derived from LAYOUT, in one place:
 *      ask:    Read Glob Grep
 *      change: + Edit/Write on AI_WRITABLE (knowledge/**, workflows/**\/*.yaml, modules/**\/*.{yaml,html,svg,css})
 *    Never the books (they change through the write door only), never *.ts (new code goes to the
 *    maintainer, workflows.md), never git (the person saves). cwd = the app folder (vanilla-accounting/).
 *
 * Screen 6 ("Ablauf ändern") is this sidebar with a workflow/run context; after a change-mode turn
 * the server runs the draft check (checkDeclaration + replay of every kept test case on the DRAFT
 * source) and appends its result as a `check` event, so "13 Fälle abgespielt, 12 gleich, 1 jetzt
 * richtig" is computed, not written by the model.
 */
import type { Automation } from '../workflows/index.js';
import type { Workspace } from '../workspace/workspace.js';

import type { AssistantMode, ContextRef, Conversation, ModelChoice } from '../types/assistant.js';


export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail: string; denied?: boolean }
  /** Files the turn changed (working tree vs before the turn), each "nicht gespeichert". */
  | { type: 'files'; paths: string[] }
  | { type: 'check'; result: DraftCheck }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface DraftCheck {
  workflows: string[];
  problems: string[];
  replayed: number;
  same: number;
  /** Runs whose outcome changed: the "1 jetzt richtig". */
  changed: Array<{ run: string; before: string; after: string }>;
  route: 'apply' | 'apply-after-replay' | 'maintainer';
  figures: boolean;
}

export interface Assistant {
  conversations(limit: number): Conversation[];
  conversation(id: string): { meta: Conversation; events: Array<{ me: string } | AssistantEvent> };
  /** Streams one turn; a new conversation when `conversation` is absent. The context is fixed at the first message. */
  send(input: { conversation?: string; text: string; context: ContextRef[]; mode: AssistantMode; model: ModelChoice; language: string }, signal: AbortSignal): AsyncIterable<AssistantEvent & { conversation: string }>;
  status(): Promise<{ installed: boolean; signedIn: boolean }>;
}

export const AI_WRITABLE = ['knowledge/**', 'workflows/**/*.yaml', 'modules/**/*.yaml', 'modules/**/*.html', 'modules/**/*.svg', 'modules/**/*.css'] as const;

export function openAssistant(ws: Workspace, deps: { automation: Automation }): Assistant {
  throw new Error('not implemented');
}
