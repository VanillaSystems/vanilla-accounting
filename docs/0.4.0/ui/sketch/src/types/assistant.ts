/**
 * The assistant's wire and domain types: the one home of ContextRef, imported by the server's
 * assistant and the browser's sidebar alike (no second definition).
 */
export type ContextRef =
  | { kind: 'run'; id: string }
  | { kind: 'workflow'; id: string; step?: string }
  | { kind: 'entry'; id: string }
  | { kind: 'transaction'; ref: string }
  | { kind: 'receipt'; id: string }
  | { kind: 'period'; token: string }
  | { kind: 'file'; path: string }
  | { kind: 'changes' }
  | { kind: 'attachment'; id: string; name: string };

export type AssistantMode = 'change' | 'ask';
export type ModelChoice = 'auto' | 'sonnet' | 'opus';

export interface Conversation { id: string; title: string; updatedAt: string; context: ContextRef[]; mode: AssistantMode }
