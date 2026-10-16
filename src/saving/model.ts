/**
 * Änderungen as data (docs/0.4.0/ui/design.md; the mockup's screen 7). Browser-safe. Everything
 * that changed since the last save waits here until the person saves it: the books as the runs
 * and direct edits wrote them, the AI's draft (data/draft/, a copy of the files it changed) and
 * files changed outside the app (Claude Code, an editor). Workflows and the AI write; they do not
 * save. Verlauf is git's log.
 */

import type { JournalEntry } from '../types/index.js';

/** Where a change waits: the books (one item, written by runs and edits), the AI's draft, a file changed outside the app. */
export type ChangeSource = 'draft' | 'outside' | 'books';

/** The path that stands for the books in a prepared save. */
export const BOOKS = 'Bücher';

/** What one run wrote into the books since the last save. */
export interface RunWrote { run: string; workflow: string; label: string; at: string; entries: number; links: number; receipts: number }

/**
 * A booking a person changed or booked by hand since the last save (JournalEntry.by of kind
 * person), newest first; `saved` is the booking as the last save holds it (absent: booked since).
 */
/** A booking changed since the last save by hand, or by the AI sidebar on the person's wish (`ai`). */
/** A booking changed, made or deleted by hand since the last save; `saved`: as the save holds it (none for one made since); `deleted`: gone now, `saved` puts it back. */
export interface HandEdit { id: string; ref: string; date: string; text: string; at: string; ai?: true; deleted?: true; saved?: JournalEntry }

/** The books' changes since the last save. */
export interface BooksChange {
  /** The books' own files that differ from the last save (ledger, books/*.jsonl, run log, invoices). */
  files: number;
  /** The runs that wrote since the last save, newest first. A direct edit in the app has none. */
  runs: RunWrote[];
  /** The bookings a person changed or made by hand since the last save. */
  hand: HandEdit[];
}

/** How a saved change takes effect (workflows.md "Changing a workflow"): at once, once switched on, or after its maintainer's review. */
export type ChangeEffect = 'applies-now' | 'needs-switch-on' | 'needs-maintainer';

export interface FileChange {
  /** Relative to the app's folder (vanilla-accounting/). */
  path: string;
  state: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
  /** For a change waiting in Änderungen: how it will take effect once saved. */
  effect?: ChangeEffect;
}

export interface SaveSummary {
  oid: string;
  short: string;
  at: string;
  author: string;
  subject: string;
  /** From the commit's trailer: the app's records path, a saved change, or a commit made outside the app. */
  kind: 'books' | 'customizing' | 'outside';
  run?: string;
  /** A year close, a filing or a seal: never undone. */
  locked?: boolean;
}

export interface ChangesView {
  rev: string;
  /** No git repository holds the workspace: nothing to save, no history. */
  repository: boolean;
  draft: FileChange[];
  outside: FileChange[];
  books: BooksChange;
  history: SaveSummary[];
  proposal?: ProposalView;
  sync: SyncState;
}

/** One changed file a prepared save covers, with the hash of its content when the AI saw it. */
export interface CoveredFile { source: ChangeSource; path: string; basis: string }

/** A save the AI prepared: its message, why it holds what it holds, and its files. */
export interface PreparedSave {
  id: string;
  message: string;
  why: string;
  files: CoveredFile[];
  /** The person said "not yet": stays unsaved. */
  held?: boolean;
}

export interface TalkTurn { me: string; ai: string }

/** Stored in data/saving/proposal.json. Stale is never stored: it is derived from the files. */
export interface Proposal { at: string; saves: PreparedSave[]; talk: TalkTurn[] }

export interface ProposalView extends Proposal {
  /** Ids of the saves whose files changed since the AI prepared them. */
  stale: string[];
  /** Changed files no save covers (changed since the proposal). */
  uncovered: string[];
  /** Ready when nothing is stale or uncovered: only then may it be saved. */
  ready: boolean;
}

export interface SyncState {
  /** The repository has an upstream to sync with. */
  remote: boolean;
  /** Saves not yet synced. */
  ahead: number;
}

export type SavingCommand =
  | { kind: 'prepare' }
  | { kind: 'talk'; text: string }
  | { kind: 'refresh' }
  | { kind: 'save'; sync?: boolean }
  | { kind: 'sync' }
  | { kind: 'discard' }
  | { kind: 'undo'; oid: string };

export type SavingRefusal = 'no-repository' | 'nothing' | 'no-proposal' | 'stale' | 'not-customizing' | 'no-remote' | 'two-versions' | 'cannot-undo' | 'closed' | 'model' | 'rules';

export type SavingResult = { ok: true; reply?: string; saved?: number; reversed?: number } | { ok: false; refusal: SavingRefusal; message: string };

export interface SaveDetail extends SaveSummary {
  body: string;
  files: FileChange[];
  /** What Rückgängig would do: a customizing save goes back to the draft; a run's bookings are reversed. */
  undo?: 'draft' | 'reverse';
}

export interface FileDiff { path: string; before: string; after: string }

export type DiffLine = { kind: ' ' | '+' | '-'; text: string; old?: number; new?: number };

/**
 * A line diff by the longest common subsequence: every line of `before` and `after` once, in order,
 * kept, removed or added. Quadratic, so for the small files of customizing; a books file is summarized by count.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map((text, i): DiffLine => ({ kind: '-', text, old: i + 1 })), ...b.map((text, i): DiffLine => ({ kind: '+', text, new: i + 1 }))];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: ' ', text: a[i], old: i + 1, new: j + 1 }); i++; j++; }
    else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) { out.push({ kind: '-', text: a[i], old: i + 1 }); i++; }
    else { out.push({ kind: '+', text: b[j], new: j + 1 }); j++; }
  }
  return out;
}

/** The changed lines with `context` unchanged lines around each, gaps marked by null. */
export function hunks(lines: DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (l.kind !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k); });
  const out: Array<DiffLine | null> = [];
  lines.forEach((l, i) => {
    if (!keep.has(i)) return;
    if (out.length && !keep.has(i - 1)) out.push(null);
    out.push(l);
  });
  return out;
}

export const counts = (before: string, after: string): { added: number; removed: number } => {
  const d = diffLines(before, after);
  return { added: d.filter((l) => l.kind === '+').length, removed: d.filter((l) => l.kind === '-').length };
};
