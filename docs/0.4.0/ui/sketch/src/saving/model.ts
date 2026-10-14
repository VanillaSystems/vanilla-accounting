/**
 * Änderungen (saving.md) as data. Browser-safe.
 *
 * Single sources of truth:
 * - WHAT changed: the git working tree of the company's repository against HEAD. Nothing else
 *   records changes; a file the AI, a run, the UI or Claude Code wrote shows the same way.
 * - WHO wrote a books record: the run store's effect records (by record id), joined to the
 *   jsonl lines the diff adds or removes. Unclaimed lines are "direkt bearbeitet".
 * - The HISTORY and its metadata: git log, with trailers on each commit the app writes
 *   (Vanilla-Kind, Vanilla-Runs, Vanilla-Lock). No side table of saves.
 * - The only stored thing: the AI's proposal (data/saving/proposal.json, outside git), which
 *   carries the blob hash of every file it was made from; staleness is derived by comparing.
 */
import type { RunId } from '../workflows/model.js';

declare const brand: unique symbol;
export type CommitId = string & { readonly [brand]: 'CommitId' };
/** Relative to the repository root (the parent of vanilla-accounting/ since ADR 0013). */
export type RepoPath = string & { readonly [brand]: 'RepoPath' };
/** git blob sha of a file's working-tree content; 'absent' for a deleted file. */
export type BlobHash = string & { readonly [brand]: 'BlobHash' };

/** saving.md's two tags, derived from the path by LAYOUT (books part vs customizing), never chosen by the AI. */
export type SaveKind = 'books' | 'app';

export interface ChangedFile {
  path: RepoPath;
  kind: SaveKind;
  state: 'added' | 'modified' | 'deleted';
  hash: BlobHash;
  /** For a jsonl books file: record ids added / changed / removed. For others: line counts. */
  records?: { added: string[]; changed: string[]; removed: string[] };
  lines?: { added: number; removed: number };
}

/** "Seit dem letzten Speichern", without AI: what each run wrote, then every other changed file. */
export interface RawChanges {
  byRun: Array<{
    run: RunId;
    workflow: string;
    title: string;
    /** Grouped by kind with counts (saving.md "Large changes"): 500 new files in receipts/2026/, 512 lines in entries.jsonl. */
    groups: Array<{ label: 'receipts' | 'entries' | 'mappings' | 'transactions' | 'files'; path: RepoPath; n: number; change: 'new-files' | 'new-lines' | 'changed-lines' }>;
    /** Items of the run that wrote nothing (failed / waiting), with a link. */
    open: number;
  }>;
  /** Books records no run claims (a person's direct edit in the UI). */
  direct: ChangedFile[];
  /** Everything outside the books: workflows, knowledge, modules, settings, logos. */
  files: ChangedFile[];
  /** Saving is impossible while these hold (a filing or seal in progress, a closed year's file touched). */
  blockers: string[];
}

export interface PreparedSave {
  id: string;
  kind: SaveKind;
  message: string;
  /** The one-line reason; a save that alters figures says so and carries the replay result. */
  why: string;
  paths: RepoPath[];
  /**
   * For a books jsonl file several saves share (entries.jsonl gets lines from the import AND from
   * the FedEx run): the record ids this save takes. The committed blob is HEAD's records plus
   * exactly these, re-sorted by id; the file is one line per record sorted by id, so the blob is
   * deterministic and the next save of the same file starts from it. Absent: the whole file.
   */
  records?: Record<RepoPath, string[]>;
  runs: RunId[];
  figures: boolean;
  held: boolean;
}

export interface Proposal {
  /** Every path the proposal covers, with the hash it was made from. */
  basis: Record<RepoPath, BlobHash>;
  saves: PreparedSave[];
  /** The conversation that shaped it ("das Logo noch nicht"); kept across refreshes. */
  talk: Array<{ me: string; ai: string }>;
  madeAt: string;
}

/** Derived on every read: which paths changed since the proposal and which saves they touch. */
export type ProposalState =
  | { kind: 'none' }
  | { kind: 'preparing' }
  | { kind: 'ready'; proposal: Proposal }
  | { kind: 'stale'; proposal: Proposal; changed: RepoPath[]; affects: string[] };

export interface HistoryEntry {
  commit: CommitId;
  at: string;
  author: string;
  /** From trailers; a commit without them (Claude Code, Treuhänder) is 'outside'. */
  by: 'person' | 'auto' | 'outside';
  kind?: SaveKind;
  message: string;
  runs: RunId[];
  /** A filing, seal or year close: no undo (saving.md "Undo"). */
  locked: boolean;
  sync: 'synced' | 'local' | 'fetched';
}

export interface ChangesView {
  raw: RawChanges;
  proposal: ProposalState;
  history: HistoryEntry[];
  sync: { remote: boolean; ahead: number; behind: number; lastSync?: string };
  /** The dock badge: prepared saves not held, else changed files. */
  badge: number;
}

export type SavingCommand =
  | { kind: 'prepare' }
  /** The person talks instead of staging; the AI returns a new Proposal (hold, merge, split, explain). */
  | { kind: 'talk'; text: string }
  /** Re-prepares only the saves `stale.affects` names; talk and the other saves stay. */
  | { kind: 'refresh' }
  /** Commits every save not held, each as its own commit with trailers. Refused when stale. */
  | { kind: 'save'; sync: boolean }
  | { kind: 'sync' }
  /** Writes the inverse of a commit into the working tree (books through the write door); unsaved afterwards. */
  | { kind: 'undo'; commit: CommitId }
  | { kind: 'diff'; path: RepoPath; whole: boolean };

export type SavingResult =
  | { ok: true; view: ChangesView; diff?: FileDiff }
  | { ok: false; refusal: 'stale' | 'locked' | 'conflict' | 'nothing' | 'no-remote' | 'closed-year' | 'two-versions'; detail?: string; view: ChangesView };

export interface FileDiff {
  path: RepoPath;
  hunks: Array<{ at: number; lines: Array<[' ' | '+' | '-', string]> }>;
  /** With `whole`: the file, its changed lines marked. */
  whole?: { lines: string[]; added: number[] };
}
