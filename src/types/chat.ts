/**
 * The chat composer's wire format (src/server/routes/chat.ts, src/app/shell/chat/): a job from
 * processes/*.flow.yaml, a message sent to Claude and the events its answer streams as (NDJSON,
 * one event per line).
 */

/** A bookkeeping job the "/" menu offers: a flow of processes/. `name` and `line` are the flow's own (English) words. */
export interface ChatSkill { id: string; name: string; line: string }

/** POST /api/chat. `files`: paths relative to the workspace, from POST /api/chat/files. */
export interface ChatSend {
  conversation: string;
  /** Claude's session of the previous answer: the message continues it. */
  session?: string;
  text: string;
  skill?: string;
  files: string[];
  /** The UI's language: Claude answers in it. */
  language: string;
}

export type ChatEvent =
  | { type: 'session'; session: string }
  /** A piece of the answer, appended to what came before. */
  | { type: 'text'; text: string }
  /** Claude uses a tool (`detail`: the file, command or pattern); `denied` when its permissions refused it. */
  | { type: 'tool'; name: string; detail: string; denied?: boolean }
  | { type: 'done'; session?: string; isError: boolean }
  | { type: 'error'; message: string };

/** POST /api/chat/files answers with where the file lies. */
export interface ChatFile { path: string }
